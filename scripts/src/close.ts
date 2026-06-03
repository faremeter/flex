import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { FLEX_PROGRAM_ADDRESS } from "@faremeter/flex-solana";
import { configureApp, getLogger } from "@faremeter/logs";
import path from "path";
import { type Cluster } from "./cluster.config";
import { squadsConfig } from "./squads.config";
import {
  createUpgradeProposal,
  getMultisigConfig,
  getVaultPda,
  guardNoOpenProposalsForProgram,
} from "./squads";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  deriveProgramDataAddress,
} from "./bpf-loader-pda";
import { buildCloseBufferIx, buildCloseProgramDataIx } from "./bpf-loader-ix";
import { readUpgradeAuthority } from "./program-version";
import { connectionFor, sendWeb3Tx } from "./solana";
import { parseSignerURL, requireSignerURL } from "./signer";
import {
  closePromptReadline,
  commandExists,
  emit,
  initStateFile as initStateFileShared,
  invocationName,
  parseCluster,
  prompt as promptOperator,
  stateSet,
} from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/close.ts");

const USAGE = `usage: ${PROGRAM} <cluster> --i-want-to-close-this-program [options]

Composes and submits a Squads vault proposal that invokes
bpf_loader_upgradeable::Close against the deployed Flex program's
program-data account. On execution, the program-data lamports are
reclaimed to the multisig vault and the program becomes permanently
uninvokable: the program ID cannot be re-deployed because the
program-data PDA was consumed by the original deploy and the loader
will refuse a fresh deploy under the same ID.

This is the TERMINAL retirement primitive. The default release flow
NEVER calls it. Reach for it only when the operator deliberately
wants to retire a program ID — at the end of a devnet rehearsal,
when sunsetting an old program ID after migrating users to a new
one, or as part of a security response that requires permanent
shutdown.

Arguments:
  cluster                          devnet | mainnet

Required confirmation:
  --i-want-to-close-this-program   explicit operator confirmation;
                                   the script refuses to compose the
                                   proposal without this flag

Other options:
  --payer <signer>                 Solana signer URL for the proposer
                                   (default: $OPERATOR_PAYER_KEYPAIR)
  --rpc-url <url>                  Override the cluster RPC URL
  --poll-timeout <seconds>         Override the post-execution poll
                                   timeout (default: 1800)
  --help | -h                      Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR    Operator payer keypair path; required.
  MAINNET_RPC_URL           Required when cluster=mainnet and no
                            --rpc-url override is supplied.

State file:
  target/program-close/<cluster>-<timestamp>.state.json captures the
  proposal PDA, transaction index, Squads UI URL, and post-execution
  status for the audit trail.

Inspection subcommands (rarely needed; the orchestrator is the default):

  resolve <cluster> <key> [<rpc>]
  assert-vault-is-authority <cluster> [<rpc>]
  guard-duplicate-proposal <cluster> [<rpc>]
  compose-close-proposal <cluster> <proposer-keypair> [<rpc>]
  poll-closed <cluster> <timeout-seconds> [<rpc>]
`;

await configureApp();
const logger = await getLogger(["flex", "program-close"]);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const STATE_DIR = path.join(REPO_ROOT, "target", "program-close");
const DEFAULT_POLL_TIMEOUT_SECONDS = 1800;

const POLL_INITIAL_BACKOFF_MS = 5_000;
const POLL_MAX_BACKOFF_MS = 60_000;

function getProgramId(): PublicKey {
  return new PublicKey(FLEX_PROGRAM_ADDRESS);
}

function sleepWithJitter(maxMs: number): Promise<void> {
  const jittered = Math.floor(Math.random() * maxMs);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

const CLOSE_BUFFER_USAGE = `usage: ${PROGRAM} <cluster> <buffer-pubkey> [--recipient <pubkey>] [--rpc-url <url>]

Composes a Squads vault proposal that invokes
bpf_loader_upgradeable::Close (the 3-account buffer form) against
the named upgrade-buffer account. The buffer's authority must be the
vault PDA (set after \`solana program write-buffer\` via
\`solana program set-buffer-authority\` during a normal deploy
cycle); the close instruction reclaims the buffer's rent to the
recipient (defaults to the vault) and deallocates the account.

Used to clean up after an upgrade proposal that was approved but
cannot execute — e.g. a buffer left over from a deploy whose
ProgramData was sized without enough headroom and whose upgrade
simulation fails. The default release flow consumes the buffer on
upgrade execute, so this command is only needed for these recovery
scenarios.

Arguments:
  cluster                 devnet | mainnet
  buffer-pubkey           Base58 pubkey of the buffer account

Options:
  --recipient <pubkey>    Override the rent recipient (defaults to
                          the vault PDA, which keeps the rent in the
                          multisig's custody for a follow-up
                          vault-drain)
  --rpc-url <url>         Override the cluster RPC URL
  --help | -h             Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR  Path to the keypair that submits the
                          proposal-creation transaction; must be a
                          member of the multisig. Required.
  MAINNET_RPC_URL         Required when cluster=mainnet and no --rpc-url
                          override is supplied.

The proposal still has to be approved and executed via
program-squads-approve and program-squads-execute. Output is a
single JSON line on stdout with proposal coordinates.
`;

async function cmdCloseBuffer(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(CLOSE_BUFFER_USAGE);
    return;
  }
  // Validate cluster before checking for buffer, so a missing cluster
  // surfaces "cluster must be devnet or mainnet" rather than the
  // misleading "missing <buffer-pubkey>" message.
  const cluster = parseCluster(args[0]);
  const bufferRaw = args[1];
  if (bufferRaw === undefined) {
    process.stderr.write(CLOSE_BUFFER_USAGE);
    throw new Error("close-buffer: missing <buffer-pubkey>");
  }
  const bufferAccount = new PublicKey(bufferRaw);

  let recipientOverride: PublicKey | undefined;
  let rpcOverride: string | undefined;
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    if (arg === "--recipient") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error("--recipient requires a value");
      }
      recipientOverride = new PublicKey(v);
      i += 1;
    } else if (arg === "--rpc-url") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error("--rpc-url requires a value");
      }
      rpcOverride = v;
      i += 1;
    } else {
      throw new Error(`close-buffer: unknown option: ${arg}`);
    }
  }

  const proposer = await parseSignerURL(
    requireSignerURL("OPERATOR_PAYER_KEYPAIR"),
  );
  try {
    const { multisig, vaultIndex } = squadsConfig[cluster];
    const vault = getVaultPda(multisig, vaultIndex);
    const recipient = recipientOverride ?? vault;
    const connection = connectionFor(cluster, rpcOverride);

    // Verify the buffer actually exists and that its authority is the
    // vault — composing a Squads proposal that references the wrong
    // buffer or whose ix would fail at simulation is wasted work.
    const bufferAccountInfo = await connection.getAccountInfo(
      bufferAccount,
      "confirmed",
    );
    if (bufferAccountInfo === null) {
      throw new Error(
        `buffer account ${bufferAccount.toBase58()} not found on ${cluster}`,
      );
    }
    if (!bufferAccountInfo.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
      throw new Error(
        `account ${bufferAccount.toBase58()} is not owned by BPF Loader Upgradeable (owner=${bufferAccountInfo.owner.toBase58()})`,
      );
    }

    logger.info(
      `close-buffer: cluster=${cluster} buffer=${bufferAccount.toBase58()} multisig=${multisig.toBase58()} vault=${vault.toBase58()} recipient=${recipient.toBase58()} bufferBalance=${String(bufferAccountInfo.lamports)}`,
    );

    const closeIx = buildCloseBufferIx({
      bufferAccount,
      authority: vault,
      recipient,
    });

    const proposal = await createUpgradeProposal({
      connection,
      multisig,
      vaultIndex,
      instructions: [closeIx],
      proposer: proposer.publicKey,
    });

    await sendWeb3Tx(
      connection,
      proposer,
      [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
      {
        blindSign: {
          label: "vaultTransactionCreate + proposalCreate (close-buffer)",
          multisig,
          vaultPDA: vault,
          proposalPDA: proposal.proposalPda,
          transactionPDA: proposal.transactionPda,
          transactionIndex: proposal.transactionIndex,
        },
      },
    );

    logger.info(
      `close-buffer: composed proposal txIndex=${proposal.transactionIndex.toString()} pda=${proposal.proposalPda.toBase58()}`,
    );
    emit({
      multisig: multisig.toBase58(),
      bufferAccount: bufferAccount.toBase58(),
      recipient: recipient.toBase58(),
      transactionIndex: proposal.transactionIndex.toString(),
      proposalPda: proposal.proposalPda.toBase58(),
      transactionPda: proposal.transactionPda.toBase58(),
      squadsUrl: proposal.squadsUrl,
      bufferLamports: bufferAccountInfo.lamports,
    });
  } finally {
    await proposer.close();
  }
}

async function cmdResolve(args: string[]): Promise<void> {
  const [clusterRaw, key, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!key) {
    throw new Error("resolve requires <key>");
  }
  switch (key) {
    case "rpc-url":
      emit({ value: connectionFor(cluster, rpcOverride).rpcEndpoint });
      return;
    case "program-id":
      emit({ value: getProgramId().toBase58() });
      return;
    case "program-data-pda":
      emit({ value: deriveProgramDataAddress(getProgramId()).toBase58() });
      return;
    case "multisig":
      emit({ value: squadsConfig[cluster].multisig.toBase58() });
      return;
    case "vault-pda": {
      const { multisig, vaultIndex } = squadsConfig[cluster];
      emit({ value: getVaultPda(multisig, vaultIndex).toBase58() });
      return;
    }
    case "time-lock":
      emit({ value: squadsConfig[cluster].timeLock });
      return;
    default:
      throw new Error(`resolve: unknown key ${key}`);
  }
}

async function cmdAssertVaultIsAuthority(args: string[]): Promise<void> {
  const [clusterRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  const connection = connectionFor(cluster, rpcOverride);
  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const expectedVault = getVaultPda(multisig, vaultIndex);

  const actualAuthority = await readUpgradeAuthority(connection, programId);
  if (actualAuthority === null) {
    throw new Error(
      `program ${programId.toBase58()} has no upgrade authority (already immutable); program-close cannot proceed`,
    );
  }
  if (!actualAuthority.equals(expectedVault)) {
    throw new Error(
      `upgrade-authority assertion failed: expected vault PDA ${expectedVault.toBase58()}, got ${actualAuthority.toBase58()}. program-close only operates against a program already handed off to the configured Squads vault.`,
    );
  }
  emit({ vaultPda: expectedVault.toBase58() });
}

async function cmdGuardDuplicateProposal(args: string[]): Promise<void> {
  const [clusterRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  const { multisig } = squadsConfig[cluster];
  const programId = getProgramId();
  const connection = connectionFor(cluster, rpcOverride);

  await guardNoOpenProposalsForProgram({
    connection,
    multisig,
    programId,
    errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before composing a close proposal`,
  });
  emit({ openProposals: 0 });
}

async function cmdComposeCloseProposal(args: string[]): Promise<void> {
  const [clusterRaw, proposerKeypairPath, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!proposerKeypairPath) {
    throw new Error("compose-close-proposal requires <proposer-keypair-path>");
  }

  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const connection = connectionFor(cluster, rpcOverride);

  const proposer = await parseSignerURL(proposerKeypairPath);
  try {
    // recipient = vault PDA: the reclaimed program-data rent flows back to
    // the multisig vault, not to an individual operator. This is the only
    // sensible default for a Squads-mediated close; the operator's payer
    // is just paying the proposal-creation fee, not collecting the rent.
    const closeIx = buildCloseProgramDataIx({
      programId,
      authority: vaultPda,
      recipient: vaultPda,
    });

    const proposal = await createUpgradeProposal({
      connection,
      multisig,
      vaultIndex,
      instructions: [closeIx],
      proposer: proposer.publicKey,
    });

    // Submit the proposal-creation transaction atomically with the index
    // prediction. Same rationale as program-deploy and program-verify:
    // splitting compose and submit lets unrelated multisig activity shift
    // the transaction index between them and invalidate the predicted
    // PDAs and Squads UI URL.
    await sendWeb3Tx(
      connection,
      proposer,
      [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
      {
        blindSign: {
          label: "vaultTransactionCreate + proposalCreate (close-program-data)",
          multisig,
          vaultPDA: vaultPda,
          proposalPDA: proposal.proposalPda,
          transactionPDA: proposal.transactionPda,
          transactionIndex: proposal.transactionIndex,
        },
      },
    );

    const { timeLock } = await getMultisigConfig(connection, multisig);
    const earliestLegalExecuteIso = new Date(
      Date.now() + timeLock * 1000,
    ).toISOString();

    emit({
      proposalPda: proposal.proposalPda.toBase58(),
      transactionPda: proposal.transactionPda.toBase58(),
      transactionIndex: proposal.transactionIndex.toString(),
      squadsUrl: proposal.squadsUrl,
      timeLockSeconds: timeLock,
      earliestLegalExecuteIso,
      programId: programId.toBase58(),
      programDataPda: deriveProgramDataAddress(programId).toBase58(),
      vaultPda: vaultPda.toBase58(),
    });
  } finally {
    await proposer.close();
  }
}

// Polls `programDataPda` until its on-chain account vanishes, signalling
// that the close-program-data proposal executed. Shared by `cmdPollClosed`
// (operator-facing CLI) and the orchestrator's post-execute wait so the
// poll cadence and timeout semantics stay consistent across both paths.
//
// Close reclaims lamports and zeroes the account; the runtime then
// garbage-collects an account with 0 lamports and 0 data, so the most
// stable cross-runtime indicator of "closed" is a null getAccountInfo
// result. The intermediate "owner=BPF Loader, 0 data, 0 lamports"
// window is rarely observable from a downstream client.
async function pollProgramDataClosed(args: {
  connection: Connection;
  programId: PublicKey;
  timeoutSec: number;
}): Promise<{ programDataPda: PublicKey }> {
  const programDataPda = deriveProgramDataAddress(args.programId);
  const deadlineMs = Date.now() + args.timeoutSec * 1000;
  let backoffMs = POLL_INITIAL_BACKOFF_MS;
  while (Date.now() < deadlineMs) {
    let info;
    try {
      info = await args.connection.getAccountInfo(programDataPda, "confirmed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warning(`poll-closed: RPC read failed transiently: ${msg}`);
      await sleepWithJitter(backoffMs);
      backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
      continue;
    }
    if (info === null) {
      return { programDataPda };
    }
    logger.info(
      `poll-closed: program-data ${programDataPda.toBase58()} still present (${info.data.byteLength} data bytes, ${info.lamports} lamports); waiting`,
    );
    await sleepWithJitter(backoffMs);
    backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
  }
  throw new Error(
    `poll-closed: timed out after ${String(args.timeoutSec)}s waiting for program-data ${programDataPda.toBase58()} to be closed. The close proposal may have been rejected, cancelled, or is still awaiting approvals; investigate via the Squads UI.`,
  );
}

async function cmdPollClosed(args: string[]): Promise<void> {
  const [clusterRaw, timeoutSecRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!timeoutSecRaw) {
    throw new Error("poll-closed requires <timeout-seconds>");
  }
  const timeoutSec = Number(timeoutSecRaw);
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw new Error(
      `timeout-seconds must be a positive integer; got ${timeoutSecRaw}`,
    );
  }
  const connection = connectionFor(cluster, rpcOverride);
  const programId = getProgramId();

  const { programDataPda } = await pollProgramDataClosed({
    connection,
    programId,
    timeoutSec,
  });
  emit({
    matched: true,
    programDataPda: programDataPda.toBase58(),
    programId: programId.toBase58(),
  });
}

// ---------- orchestrator ----------

type CloseOptions = {
  cluster: Cluster;
  confirmed: boolean;
  payer: string | undefined;
  rpcOverride: string | undefined;
  pollTimeoutSec: number;
};

function parseCloseArgs(args: string[]): CloseOptions {
  const cluster = parseCluster(args[0]);
  const opts: CloseOptions = {
    cluster,
    confirmed: false,
    payer: undefined,
    rpcOverride: undefined,
    pollTimeoutSec: DEFAULT_POLL_TIMEOUT_SECONDS,
  };
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--i-want-to-close-this-program":
        opts.confirmed = true;
        i += 1;
        break;
      case "--payer": {
        const v = args[i + 1];
        if (v === undefined) {
          throw new Error("--payer requires a value");
        }
        opts.payer = v;
        i += 2;
        break;
      }
      case "--rpc-url": {
        const v = args[i + 1];
        if (v === undefined) {
          throw new Error("--rpc-url requires a value");
        }
        opts.rpcOverride = v;
        i += 2;
        break;
      }
      case "--poll-timeout": {
        const v = args[i + 1];
        if (v === undefined) {
          throw new Error("--poll-timeout requires a value");
        }
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--poll-timeout must be a positive integer; got: ${v}`,
          );
        }
        opts.pollTimeoutSec = n;
        i += 2;
        break;
      }
      default:
        throw new Error(`unknown option: ${String(arg)}`);
    }
  }
  if (!opts.confirmed) {
    throw new Error(
      "refusing to proceed without --i-want-to-close-this-program; no proposal composed",
    );
  }
  return opts;
}

function initStateFile(cluster: Cluster): string {
  return initStateFileShared(logger, STATE_DIR, cluster);
}

function printRetireBanner(cluster: Cluster): void {
  const lines = [
    "================================================================",
    `RETIRE: closing Flex program-data on cluster=${cluster}`,
    "On execution the program will become PERMANENTLY uninvokable;",
    "the program ID CANNOT be re-deployed once program-data closes.",
    "================================================================",
  ];
  for (const line of lines) {
    logger.warning(line);
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const opts = parseCloseArgs(args);
  const { cluster } = opts;

  // ---- preflight ----
  if (!commandExists("bun")) {
    throw new Error("bun is required but not installed");
  }
  const operatorPayerURL = requireSignerURL("OPERATOR_PAYER_KEYPAIR");
  const payer = opts.payer ?? operatorPayerURL;

  // ---- resolve config ----
  const connection = connectionFor(cluster, opts.rpcOverride);
  const programId = getProgramId();
  const programDataPda = deriveProgramDataAddress(programId);
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const { timeLock } = await getMultisigConfig(connection, multisig);

  const stateFile = initStateFile(cluster);
  stateSet(stateFile, "rpc_url", connection.rpcEndpoint);
  stateSet(stateFile, "program_id", programId.toBase58());
  stateSet(stateFile, "program_data_pda", programDataPda.toBase58());
  stateSet(stateFile, "multisig", multisig.toBase58());
  stateSet(stateFile, "vault_pda", vaultPda.toBase58());
  stateSet(stateFile, "time_lock", timeLock);

  printRetireBanner(cluster);
  logger.info(`cluster:          ${cluster}`);
  logger.info(`rpc url:          ${connection.rpcEndpoint}`);
  logger.info(`program id:       ${programId.toBase58()}`);
  logger.info(`program-data pda: ${programDataPda.toBase58()}`);
  logger.info(`multisig:         ${multisig.toBase58()}`);
  logger.info(`vault pda:        ${vaultPda.toBase58()}`);
  logger.info(`time lock:        ${timeLock}s`);

  // ---- assert vault is the on-chain authority ----
  const actualAuthority = await readUpgradeAuthority(connection, programId);
  if (actualAuthority === null) {
    throw new Error(
      `program ${programId.toBase58()} has no upgrade authority (already immutable); program-close cannot proceed`,
    );
  }
  if (!actualAuthority.equals(vaultPda)) {
    throw new Error(
      `upgrade-authority assertion failed: expected vault PDA ${vaultPda.toBase58()}, got ${actualAuthority.toBase58()}. program-close only operates against a program already handed off to the configured Squads vault.`,
    );
  }
  logger.info(`upgrade authority verified: ${vaultPda.toBase58()}`);

  // ---- guard duplicate proposal ----
  await guardNoOpenProposalsForProgram({
    connection,
    multisig,
    programId,
    errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before composing a close proposal`,
  });
  logger.info("duplicate-proposal guard: clear");

  // ---- compose close proposal ----
  printRetireBanner(cluster);
  logger.warning("RETIRE: composing close proposal");

  const proposer = await parseSignerURL(payer);
  let proposal;
  try {
    const closeIx = buildCloseProgramDataIx({
      programId,
      authority: vaultPda,
      recipient: vaultPda,
    });
    proposal = await createUpgradeProposal({
      connection,
      multisig,
      vaultIndex,
      instructions: [closeIx],
      proposer: proposer.publicKey,
    });
    await sendWeb3Tx(
      connection,
      proposer,
      [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
      {
        blindSign: {
          label: "vaultTransactionCreate + proposalCreate (retire program)",
          multisig,
          vaultPDA: vaultPda,
          proposalPDA: proposal.proposalPda,
          transactionPDA: proposal.transactionPda,
          transactionIndex: proposal.transactionIndex,
        },
      },
    );
  } finally {
    await proposer.close();
  }
  const earliestLegalIso = new Date(Date.now() + timeLock * 1000).toISOString();

  stateSet(stateFile, "proposal_pda", proposal.proposalPda.toBase58());
  stateSet(stateFile, "transaction_pda", proposal.transactionPda.toBase58());
  stateSet(
    stateFile,
    "transaction_index",
    proposal.transactionIndex.toString(),
  );
  stateSet(stateFile, "squads_url", proposal.squadsUrl);
  stateSet(stateFile, "earliest_legal_execute", earliestLegalIso);

  logger.warning(`RETIRE: proposal pda:    ${proposal.proposalPda.toBase58()}`);
  logger.warning(
    `RETIRE: transaction pda: ${proposal.transactionPda.toBase58()}`,
  );
  logger.warning(
    `RETIRE: tx index:        ${proposal.transactionIndex.toString()}`,
  );
  logger.warning(`RETIRE: squads ui:       ${proposal.squadsUrl}`);
  logger.warning(`RETIRE: earliest legal execute time: ${earliestLegalIso}`);
  logger.warning(
    `RETIRE: members must now approve and execute the close proposal`,
  );
  logger.warning(
    `        (via the Squads UI, or via bin/program-squads-approve`,
  );
  logger.warning(`        and bin/program-squads-execute)`);

  const confirm = await promptOperator(
    "type 'closed' once the close proposal has been approved + executed: ",
  );
  if (confirm.trim() !== "closed") {
    throw new Error("operator did not confirm Squads execution; aborting");
  }

  // ---- poll for closed ----
  logger.warning(
    `RETIRE: polling program-data until it is closed (timeout ${String(opts.pollTimeoutSec)}s)`,
  );
  await pollProgramDataClosed({
    connection,
    programId,
    timeoutSec: opts.pollTimeoutSec,
  });
  logger.warning(
    `RETIRE: program-data ${programDataPda.toBase58()} is closed; program ${programId.toBase58()} is permanently uninvokable`,
  );
  stateSet(stateFile, "status", "closed");
}

// ---------- dispatch ----------

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  run: cmdRun,
  resolve: cmdResolve,
  "assert-vault-is-authority": cmdAssertVaultIsAuthority,
  "guard-duplicate-proposal": cmdGuardDuplicateProposal,
  "compose-close-proposal": cmdComposeCloseProposal,
  "poll-closed": cmdPollClosed,
  "close-buffer": cmdCloseBuffer,
};

const [, , firstArg, ...rest] = process.argv;

// Top-level -h/--help prints the orchestrator's USAGE only when the
// invocation is the orchestrator (cluster as firstArg) or when there
// is no firstArg at all. When the invocation routes to a specific
// subcommand — including a bin wrapper that hardcodes the subcommand
// name (`program-close-buffer` → `close.ts close-buffer ...`) — the
// help flag is forwarded to that subcommand so its own USAGE wins.
const isOrchestrator =
  firstArg === undefined ||
  firstArg === "devnet" ||
  firstArg === "mainnet" ||
  firstArg === "-h" ||
  firstArg === "--help";
if (isOrchestrator && (firstArg === "-h" || firstArg === "--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

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
