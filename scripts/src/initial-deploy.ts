import { PublicKey } from "@solana/web3.js";
import { FLEX_PROGRAM_ADDRESS } from "@faremeter/flex-solana";
import { configureApp, getLogger } from "@faremeter/logs";
import fs from "fs";
import path from "path";
import { type Cluster } from "./cluster.config";
import { squadsConfig } from "./squads.config";
import {
  createUpgradeProposal,
  getVaultPda,
  guardNoOpenProposalsForProgram,
} from "./squads";
import { buildUpgradeIx } from "./bpf-loader-ix";
import {
  readUpgradeAuthority,
  sha256OfDeployedProgram,
} from "./program-version";
import { connectionFor, sendWeb3Tx } from "./solana";
import { parseSignerURL } from "./signer";
import {
  closePromptReadline,
  initStateFile as initStateFileShared,
  invocationName,
  requireSignerURL,
  parseCluster,
  prompt,
  runSolana as runSolanaShared,
  sha256OfFile,
  stateSet,
} from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/initial-deploy.ts");

const USAGE = `usage: ${PROGRAM} <cluster>

  cluster: devnet | mainnet

Executes the four-phase initial deploy for the Flex Anchor program:

  Phase 1 - Deploy with operator authority.
            \`solana program deploy\` using the operator payer; verifies
            the deployed program sha matches the local .so.

  Phase 2 - Hand-off to the Squads vault PDA.
            Re-derives the vault PDA from scripts/src/squads.config.ts,
            prints it for operator verification, requires the operator
            to retype the PDA, then invokes
            \`solana program set-upgrade-authority\`.

  Phase 3 - Liveness test.
            Writes an upgrade buffer with the same .so bytes, transfers
            buffer authority to the vault PDA, composes a Squads upgrade
            proposal and submits the proposal-creation transaction.
            Operator approves/executes in the Squads UI. The script then
            polls program data until the deployed sha matches the local
            .so sha.

  Phase 4 - Witnessed key destruction (logged, not executed).
            Prints the witnessed key-destruction procedure. The script
            does not delete the keypair file; that is the operator's
            responsibility.

Environment:

  OPERATOR_PAYER_KEYPAIR  Signer URL for the operator payer. Required.
                          Accepts a filesystem path to a JSON keypair,
                          or usb://ledger?key=N[&change=M] for a
                          Ledger device.

  MAINNET_RPC_URL         Required when cluster is \`mainnet\`.

Inspection subcommands (rarely needed by operators; the bin script
invokes the orchestrator by default):

  rpc-url <cluster>                 print resolved RPC endpoint
  program-id                        print the declared program ID
  vault-pda <cluster>               print the configured vault PDA
  multisig <cluster>                print the configured multisig PDA
  local-sha <so-path>               sha256 of a local .so
  assert-sha-match <cluster> <so>   verify deployed == local sha
  assert-upgrade-authority <cluster> <expected>
                                    verify on-chain authority == expected
`;

await configureApp();
const logger = await getLogger(["flex", "initial-deploy"]);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SO_PATH = path.join(REPO_ROOT, "target", "deploy", "flex.so");
const KEYPAIR_PATH = path.join(
  REPO_ROOT,
  "target",
  "deploy",
  "flex-keypair.json",
);
const STATE_DIR = path.join(REPO_ROOT, "target", "program-initial-deploy");
const LIVENESS_TIMEOUT_SECONDS = 900;

function initStateFile(cluster: Cluster): string {
  return initStateFileShared(logger, STATE_DIR, cluster);
}

function emit(value: string): void {
  process.stdout.write(`${value}\n`);
}

function getProgramId(): PublicKey {
  return new PublicKey(FLEX_PROGRAM_ADDRESS);
}

function runSolana(args: string[]): string {
  return runSolanaShared(logger, args);
}

// Controls the --max-len multiplier passed to `solana program deploy`
// in phase 1. The on-chain ProgramData allocation = multiplier *
// program_size, providing headroom for future upgrades that grow the
// ELF. Production default is 2.0 (doubles ProgramData rent for
// permanent room to grow). Override via env var when running tooling
// against constrained budgets (e.g. devnet rehearsal).
const DEFAULT_MAX_LEN_MULTIPLIER = 2.0;

function parseMaxLenMultiplier(): number {
  const raw = process.env.FLEX_INITIAL_DEPLOY_MAX_LEN_MULTIPLIER;
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_MAX_LEN_MULTIPLIER;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1.0) {
    throw new Error(
      `FLEX_INITIAL_DEPLOY_MAX_LEN_MULTIPLIER must be a finite number >= 1.0; got ${raw}`,
    );
  }
  return parsed;
}

const BUFFER_ADDRESS_PATTERN = /Buffer:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/;

function extractBufferAddress(writeBufferOutput: string): PublicKey {
  const match = BUFFER_ADDRESS_PATTERN.exec(writeBufferOutput);
  if (!match) {
    throw new Error(
      `failed to parse buffer address from solana program write-buffer output:\n${writeBufferOutput}`,
    );
  }
  const [, addr] = match;
  if (!addr) {
    throw new Error("buffer address capture group empty");
  }
  return new PublicKey(addr);
}

// ---------- internal verification + work helpers (reused by cmdRun) ----------

async function assertShaMatch(cluster: Cluster, soPath: string): Promise<void> {
  const localSha = sha256OfFile(soPath);
  const localSize = fs.statSync(soPath).size;
  const connection = connectionFor(cluster);
  const programId = getProgramId();
  const deployedSha = await sha256OfDeployedProgram(
    connection,
    programId,
    localSize,
  );
  if (localSha !== deployedSha) {
    throw new Error(
      `program sha mismatch: local=${localSha} deployed=${deployedSha}`,
    );
  }
  logger.info(`program sha verified: ${localSha}`);
}

async function assertUpgradeAuthority(
  cluster: Cluster,
  expected: PublicKey,
): Promise<void> {
  const connection = connectionFor(cluster);
  const programId = getProgramId();
  const actual = await readUpgradeAuthority(connection, programId);
  if (actual === null) {
    throw new Error(
      `program ${programId.toBase58()} has no upgrade authority (already immutable)`,
    );
  }
  if (!actual.equals(expected)) {
    throw new Error(
      `upgrade authority mismatch: expected ${expected.toBase58()}, got ${actual.toBase58()}`,
    );
  }
  logger.info(`upgrade authority verified: ${actual.toBase58()}`);
}

type LivenessTestResult = {
  proposalPda: PublicKey;
  transactionPda: PublicKey;
  transactionIndex: bigint;
  bufferAddress: PublicKey;
  squadsUrl: string;
};

async function runLivenessTest(
  cluster: Cluster,
  soPath: string,
): Promise<LivenessTestResult> {
  const operatorPayerURL = requireSignerURL("OPERATOR_PAYER_KEYPAIR");
  const resolvedSoPath = path.resolve(soPath);
  if (!fs.existsSync(resolvedSoPath)) {
    throw new Error(`shared object not found: ${resolvedSoPath}`);
  }

  const connection = connectionFor(cluster);
  const rpcURL = connection.rpcEndpoint;
  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPDA = getVaultPda(multisig, vaultIndex);

  // Fail before the write-buffer spend if the multisig already has an
  // open vault proposal targeting this program. Same guard the other
  // program-* operator commands run; here it also protects against a
  // re-run of initial-deploy after a partial earlier attempt left a
  // stale-Approved upgrade proposal behind.
  await guardNoOpenProposalsForProgram({
    connection,
    multisig,
    programId,
    errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before re-running`,
  });

  logger.info(`phase 3: writing upgrade buffer for ${programId.toBase58()}`);
  const writeBufferOutput = runSolana([
    "program",
    "write-buffer",
    "--url",
    rpcURL,
    "--keypair",
    operatorPayerURL,
    resolvedSoPath,
  ]);
  const bufferAddress = extractBufferAddress(writeBufferOutput);
  logger.info(`buffer written: ${bufferAddress.toBase58()}`);

  logger.info(
    `transferring buffer authority to vault PDA ${vaultPDA.toBase58()}`,
  );
  runSolana([
    "program",
    "set-buffer-authority",
    "--url",
    rpcURL,
    "--keypair",
    operatorPayerURL,
    bufferAddress.toBase58(),
    "--new-buffer-authority",
    vaultPDA.toBase58(),
  ]);

  const upgradeIx = buildUpgradeIx({
    programId,
    bufferAccount: bufferAddress,
    authority: vaultPDA,
  });

  const operator = await parseSignerURL(operatorPayerURL);
  try {
    const proposal = await createUpgradeProposal({
      connection,
      multisig,
      vaultIndex,
      instructions: [upgradeIx],
      proposer: operator.publicKey,
    });

    logger.info(
      `submitting Squads proposal-creation transaction (proposer=${operator.publicKey.toBase58()})`,
    );
    await sendWeb3Tx(
      connection,
      operator,
      [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
      {
        blindSign: {
          label: "vaultTransactionCreate + proposalCreate (initial-deploy)",
          multisig,
          vaultPDA,
          proposalPDA: proposal.proposalPda,
          transactionPDA: proposal.transactionPda,
          transactionIndex: proposal.transactionIndex,
        },
      },
    );

    return {
      proposalPda: proposal.proposalPda,
      transactionPda: proposal.transactionPda,
      transactionIndex: proposal.transactionIndex,
      bufferAddress,
      squadsUrl: proposal.squadsUrl,
    };
  } finally {
    await operator.close();
  }
}

async function pollDeployedShaMatches(
  cluster: Cluster,
  soPath: string,
  timeoutSec: number,
): Promise<void> {
  const targetSha = sha256OfFile(soPath);
  const targetSize = fs.statSync(soPath).size;
  const connection = connectionFor(cluster);
  const programId = getProgramId();

  const deadlineMs = Date.now() + timeoutSec * 1000;
  let lastSha = "";
  while (Date.now() < deadlineMs) {
    const deployedSha = await sha256OfDeployedProgram(
      connection,
      programId,
      targetSize,
    );
    if (deployedSha === targetSha) {
      logger.info(`deployed sha matches local: ${deployedSha}`);
      return;
    }
    lastSha = deployedSha;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `timed out after ${timeoutSec}s waiting for deployed sha to match local ${targetSha} (last seen: ${lastSha})`,
  );
}

// ---------- the orchestrator (the bin script's entire payload) ----------

function preflight(cluster: Cluster): {
  operatorPayerURL: string;
  rpcURL: string;
  programId: PublicKey;
  vaultPDA: PublicKey;
  multisig: PublicKey;
} {
  if (!fs.existsSync(SO_PATH)) {
    throw new Error(
      `shared object not found: ${SO_PATH} (run \`anchor build\` first)`,
    );
  }
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(
      `program keypair not found: ${KEYPAIR_PATH}; if you relocated the keypair out-of-band after the original keygen, copy it back to that path before running initial-deploy`,
    );
  }
  const operatorPayerURL = requireSignerURL("OPERATOR_PAYER_KEYPAIR");

  const connection = connectionFor(cluster);
  const rpcURL = connection.rpcEndpoint;
  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPDA = getVaultPda(multisig, vaultIndex);

  logger.info(`cluster:    ${cluster}`);
  logger.info(`rpc url:    ${rpcURL}`);
  logger.info(`program id: ${programId.toBase58()}`);
  logger.info(`multisig:   ${multisig.toBase58()}`);
  logger.info(`vault pda:  ${vaultPDA.toBase58()}`);

  return { operatorPayerURL, rpcURL, programId, vaultPDA, multisig };
}

async function phase1Deploy(
  cluster: Cluster,
  rpcURL: string,
  operatorPayerURL: string,
  programId: PublicKey,
): Promise<void> {
  logger.info(
    `phase 1: deploying ${programId.toBase58()} with operator authority`,
  );

  // `solana program deploy` defaults --max-len to the .so size with no
  // headroom; the first upgrade that grows the program by even one
  // byte then fails simulation with "ProgramData account not large
  // enough". Allocate `multiplier * program_size` at initial deploy so
  // routine upgrades have room to grow. The cost is paid once in
  // additional ProgramData rent (linear in multiplier). 2.0x is the
  // production default; the devnet rehearsal overrides this to a
  // smaller value via FLEX_INITIAL_DEPLOY_MAX_LEN_MULTIPLIER so it can
  // run within devnet airdrop budget.
  const programSize = fs.statSync(SO_PATH).size;
  const multiplier = parseMaxLenMultiplier();
  const maxLen = Math.ceil(programSize * multiplier);
  logger.info(
    `program size: ${String(programSize)} bytes; allocating ProgramData with --max-len ${String(maxLen)} (multiplier ${String(multiplier)}) for upgrade headroom`,
  );

  runSolana([
    "program",
    "deploy",
    "--url",
    rpcURL,
    "--keypair",
    operatorPayerURL,
    "--program-id",
    KEYPAIR_PATH,
    "--max-len",
    String(maxLen),
    SO_PATH,
  ]);

  logger.info(`verifying deployed program bytes match local ${SO_PATH}`);
  await assertShaMatch(cluster, SO_PATH);
}

async function phase2Handoff(
  cluster: Cluster,
  rpcURL: string,
  operatorPayerURL: string,
  programId: PublicKey,
  vaultPDA: PublicKey,
): Promise<void> {
  logger.info(`phase 2: handing upgrade authority off to the Squads vault PDA`);
  logger.info(`vault PDA to receive authority: ${vaultPDA.toBase58()}`);
  logger.warning(
    `a mis-derived PDA bricks the program irrecoverably; verify the PDA above against an independently-derived copy.`,
  );

  const answer = await prompt("retype the vault PDA exactly to proceed: ");
  if (answer.trim() !== vaultPDA.toBase58()) {
    throw new Error(
      "vault PDA confirmation mismatch; aborting before set-upgrade-authority",
    );
  }

  // The Squads vault is a PDA (program-derived address) and cannot
  // sign as a keypair. The solana CLI's default safety gate refuses to
  // hand authority to a non-signing pubkey to prevent accidental
  // brick-by-typo; --skip-new-upgrade-authority-signer-check waives
  // that gate. The retype-the-PDA prompt above is the operator-level
  // confirmation that replaces it.
  runSolana([
    "program",
    "set-upgrade-authority",
    "--url",
    rpcURL,
    "--keypair",
    operatorPayerURL,
    "--new-upgrade-authority",
    vaultPDA.toBase58(),
    "--skip-new-upgrade-authority-signer-check",
    programId.toBase58(),
  ]);

  logger.info(`verifying on-chain upgrade authority equals vault PDA`);
  await assertUpgradeAuthority(cluster, vaultPDA);
}

async function phase3Liveness(
  cluster: Cluster,
  stateFile: string,
): Promise<void> {
  logger.info(
    `phase 3: running Squads liveness test (no-op upgrade redeploying the same bytes)`,
  );

  const result = await runLivenessTest(cluster, SO_PATH);

  // Persist the proposal coordinates before the prompt blocks so a
  // co-signer or automated rehearsal harness can locate and approve the
  // pending proposal from a separate process.
  stateSet(stateFile, "proposal_pda", result.proposalPda.toBase58());
  stateSet(stateFile, "transaction_pda", result.transactionPda.toBase58());
  stateSet(stateFile, "transaction_index", result.transactionIndex.toString());
  stateSet(stateFile, "buffer_address", result.bufferAddress.toBase58());
  stateSet(stateFile, "squads_url", result.squadsUrl);

  logger.info(`proposal pda:    ${result.proposalPda.toBase58()}`);
  logger.info(`transaction pda: ${result.transactionPda.toBase58()}`);
  logger.info(`buffer address:  ${result.bufferAddress.toBase58()}`);
  logger.info(`squads ui:       ${result.squadsUrl}`);
  logger.info(
    `approve and execute the proposal in the Squads UI above (requires a quorum of co-signers).`,
  );

  const answer = await prompt(
    "type 'executed' once the Squads UI shows the proposal as executed: ",
  );
  if (answer.trim() !== "executed") {
    throw new Error("operator did not confirm Squads execution; aborting");
  }

  logger.info(
    `polling program data until sha matches local ${SO_PATH} (timeout ${LIVENESS_TIMEOUT_SECONDS}s)`,
  );
  await pollDeployedShaMatches(cluster, SO_PATH, LIVENESS_TIMEOUT_SECONDS);

  logger.info(`phase 3 complete: Squads upgrade authority verified end-to-end`);
}

async function phase4KeyDestructionProcedure(
  cluster: Cluster,
  programId: PublicKey,
): Promise<void> {
  logger.info(
    `phase 4: witnessed key-destruction procedure (logged; the script does NOT delete the keypair)`,
  );

  process.stderr.write(`
================================================================
  WITNESSED PROGRAM KEYPAIR DESTRUCTION PROCEDURE
================================================================

The program keypair secret at:

  ${KEYPAIR_PATH}

must be cryptographically destroyed once Phase 3 has succeeded.
The pubkey (${programId.toBase58()}) is committed at
keypairs/flex-program.pub and will continue to be referenced by
declare_id! and Anchor.toml; only the secret half is destroyed.

  1. Identify the keypair file path above (the one supplied to
     Phase 1). Confirm the file you are about to destroy is the
     active program keypair, not an unrelated wallet file.

  2. Conduct the destruction with a second team member present
     as witness.

  3. Cryptographically wipe the file:
       Linux:  shred -uvz "${KEYPAIR_PATH}"
       macOS:  rm -P "${KEYPAIR_PATH}"
     Choose the command matching the host operating system.

  4. Verify the file no longer exists:
       test ! -e "${KEYPAIR_PATH}" && echo "destroyed"

  5. Record in the operational runbook:
       - Date and time (UTC)
       - Witness name
       - Method used (shred / rm -P)
       - Program ID: ${programId.toBase58()}
       - Cluster of initial deploy: ${cluster}

The script will NOT perform any of the above steps; the keypair
lifecycle is the operator's responsibility.
================================================================

`);

  const answer = await prompt(
    "type 'read' to confirm you have read the procedure above: ",
  );
  if (answer.trim() !== "read") {
    throw new Error(
      "operator did not confirm reading the key-destruction procedure",
    );
  }

  logger.info(
    `initial deploy complete for ${cluster}. Destroy the program keypair per the procedure above.`,
  );
}

async function cmdRun(args: string[]): Promise<void> {
  const cluster = parseCluster(args[0]);
  const config = preflight(cluster);

  const stateFile = initStateFile(cluster);
  stateSet(stateFile, "rpc_url", config.rpcURL);
  stateSet(stateFile, "program_id", config.programId.toBase58());
  stateSet(stateFile, "multisig", config.multisig.toBase58());
  stateSet(stateFile, "vault_pda", config.vaultPDA.toBase58());

  await phase1Deploy(
    cluster,
    config.rpcURL,
    config.operatorPayerURL,
    config.programId,
  );
  stateSet(stateFile, "phase1_complete", true);

  await phase2Handoff(
    cluster,
    config.rpcURL,
    config.operatorPayerURL,
    config.programId,
    config.vaultPDA,
  );
  stateSet(stateFile, "phase2_complete", true);

  await phase3Liveness(cluster, stateFile);
  stateSet(stateFile, "phase3_complete", true);

  await phase4KeyDestructionProcedure(cluster, config.programId);
  stateSet(stateFile, "status", "complete");
}

// ---------- inspection subcommands (kept for ad-hoc operator queries) ----------

async function cmdRpcURL(args: string[]): Promise<void> {
  emit(connectionFor(parseCluster(args[0])).rpcEndpoint);
}

async function cmdProgramId(_args: string[]): Promise<void> {
  emit(getProgramId().toBase58());
}

async function cmdVaultPDA(args: string[]): Promise<void> {
  const cluster = parseCluster(args[0]);
  const { multisig, vaultIndex } = squadsConfig[cluster];
  emit(getVaultPda(multisig, vaultIndex).toBase58());
}

async function cmdMultisig(args: string[]): Promise<void> {
  emit(squadsConfig[parseCluster(args[0])].multisig.toBase58());
}

async function cmdLocalSHA(args: string[]): Promise<void> {
  const [soPath] = args;
  if (!soPath) {
    throw new Error("local-sha requires <so-path>");
  }
  emit(sha256OfFile(soPath));
}

async function cmdAssertSHAMatch(args: string[]): Promise<void> {
  const [clusterRaw, soPath] = args;
  if (!soPath) {
    throw new Error("assert-sha-match requires <so-path>");
  }
  await assertShaMatch(parseCluster(clusterRaw), soPath);
}

async function cmdAssertUpgradeAuthority(args: string[]): Promise<void> {
  const [clusterRaw, expected] = args;
  if (!expected) {
    throw new Error("assert-upgrade-authority requires <expected-authority>");
  }
  await assertUpgradeAuthority(
    parseCluster(clusterRaw),
    new PublicKey(expected),
  );
}

// ---------- dispatch ----------

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  run: cmdRun,
  "rpc-url": cmdRpcURL,
  "program-id": cmdProgramId,
  "vault-pda": cmdVaultPDA,
  multisig: cmdMultisig,
  "local-sha": cmdLocalSHA,
  "assert-sha-match": cmdAssertSHAMatch,
  "assert-upgrade-authority": cmdAssertUpgradeAuthority,
};

const [, , firstArg, ...rest] = process.argv;

if (firstArg === "-h" || firstArg === "--help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

// When the first argument is a cluster name, run the orchestrator. The
// bin script delegates directly: `bin/program-initial-deploy devnet`
// becomes `program-initial-deploy.ts devnet`. Inspection subcommands
// keep their explicit names; an operator querying "vault-pda devnet"
// passes the subcommand name as the first argument.
let subcommandName = firstArg;
let subcommandArgs = rest;
if (firstArg === "devnet" || firstArg === "mainnet") {
  subcommandName = "run";
  subcommandArgs = [firstArg, ...rest];
}

if (!subcommandName) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const handler = subcommands[subcommandName];
if (!handler) {
  logger.error(
    `unknown subcommand: ${subcommandName}\nsubcommands: ${Object.keys(subcommands).join(", ")}`,
  );
  process.exit(2);
}

try {
  await handler(subcommandArgs);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  process.exit(1);
}

// Close the cli-helpers prompt singleton so its readline releases
// stdin and the event loop can drain.
closePromptReadline();
