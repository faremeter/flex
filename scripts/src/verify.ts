import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { FLEX_PROGRAM_ADDRESS } from "@faremeter/flex-solana";
import { configureApp, getLogger } from "@faremeter/logs";
import { type Cluster } from "./cluster.config";
import { squadsConfig } from "./squads.config";

import {
  createUpgradeProposal,
  type UpgradeProposal,
  getMultisigConfig,
  getVaultPda,
  guardNoOpenProposalsForProgram,
} from "./squads";
import { OTTER_VERIFY_PROGRAM_ID, buildVerifyInitIx } from "./verify-init-ix";
import { submitVerifyJob } from "./otter-verify";

import {
  connectionFor,
  detectRepoURL,
  gitResolveCommit,
  sendWeb3Tx,
} from "./solana";
import { parseSignerURL } from "./signer";

import {
  closePromptReadline,
  commandExists,
  emit,
  invocationName,
  requireSignerURL,
  validateSignerURL,
  parseCluster,
  prompt as promptOperator,
} from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/verify.ts");

const USAGE = `usage: ${PROGRAM} <cluster> [options]

Composes and submits the OtterSec verification for a Flex program
release. Two scenarios:

  1. Separate-mode follow-up. After bin/program-deploy ran with
     --verify-mode=separate and the upgrade proposal executed, this
     script composes a STANDALONE Squads proposal containing only the
     otter_verify::Initialize instruction (no upgrade, no
     close_buffer). Once the proposal executes, the script POSTs the
     verification job to verify.osec.io/verify-with-signer so the
     OtterSec worker can match the deployed bytes against the source.

  2. Retry. Use the same script when a prior verification attempt
     failed: the OtterSec submit-job request errored (network, 5xx,
     rate limit), or the verify-init proposal landed on-chain but the
     OtterSec worker never picked up the job. The script detects
     idempotently whether the on-chain otter_verify PDA already exists
     for the vault uploader and, if it does, skips proposal composition
     and re-submits the OtterSec job directly.

Arguments:
  cluster                       devnet | mainnet

Options:
  --payer <signer>              Solana signer URL for the proposer
                                (default: $OPERATOR_PAYER_KEYPAIR)
  --rpc-url <url>               Override the cluster RPC URL
  --commit <rev>                git revision (tag, sha, branch) to pin
                                the OtterSec verification record to;
                                required (no default — an unpinned
                                record drifts as HEAD advances)
  --help | -h                   Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR        Operator payer keypair path; required.
  MAINNET_RPC_URL               Required when cluster=mainnet and no
                                --rpc-url override is supplied.

Inspection subcommands (rarely needed; the orchestrator is the default
entry point):

  resolve <cluster> <key> [<rpc>]
  guard-existing-proposal <cluster> <multisig> <program-id> [<rpc>]
  check-already-verified <cluster> <program-id> <uploader> [<rpc>]
  compose-proposal <cluster> <multisig> <proposer-signer-url> <program-id> [<rpc>]
  poll-verified <cluster> <program-id> <uploader> [<timeout>] [<rpc>]
  submit-verify <program-id> <uploader> <commit-or-tag>
`;

await configureApp();
const logger = await getLogger(["flex", "verify"]);

const DEFAULT_POLL_TIMEOUT_SECONDS = 1800;
const POLL_INITIAL_BACKOFF_MS = 5_000;
const POLL_MAX_BACKOFF_MS = 60_000;

const OTTER_VERIFY_PDA_SEED = "otter_verify";

function getProgramId(): PublicKey {
  return new PublicKey(FLEX_PROGRAM_ADDRESS);
}

function deriveOtterVerifyPda(
  uploader: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode(OTTER_VERIFY_PDA_SEED),
      uploader.toBuffer(),
      programId.toBuffer(),
    ],
    OTTER_VERIFY_PROGRAM_ID,
  );
  return pda;
}

async function otterVerifyPdaExists(
  connection: Connection,
  uploader: PublicKey,
  programId: PublicKey,
): Promise<{ pda: PublicKey; exists: boolean }> {
  const pda = deriveOtterVerifyPda(uploader, programId);
  const info = await connection.getAccountInfo(pda, "confirmed");
  return { pda, exists: info !== null };
}

function sleepWithJitter(maxMs: number): Promise<void> {
  const jittered = Math.floor(Math.random() * maxMs);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

async function cmdResolve(args: string[]): Promise<void> {
  const [clusterRaw, key, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!key) {
    throw new Error("resolve requires <key>");
  }
  switch (key) {
    case "rpc-url":
      emit({
        value: connectionFor(cluster, rpcOverride).rpcEndpoint,
      });
      return;
    case "program-id":
      emit({ value: getProgramId().toBase58() });
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
    case "repo-url":
      emit({ value: detectRepoURL() });
      return;
    default:
      throw new Error(`resolve: unknown key ${key}`);
  }
}

async function cmdGuardExistingProposal(args: string[]): Promise<void> {
  const [clusterRaw, multisigRaw, programIdRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!multisigRaw) {
    throw new Error("guard-existing-proposal requires <multisig>");
  }
  if (!programIdRaw) {
    throw new Error("guard-existing-proposal requires <program-id>");
  }
  const multisig = new PublicKey(multisigRaw);
  const programId = new PublicKey(programIdRaw);
  const connection = connectionFor(cluster, rpcOverride);
  await guardNoOpenProposalsForProgram({
    connection,
    multisig,
    programId,
    errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before retrying`,
  });
  emit({ openProposals: 0 });
}

async function cmdCheckAlreadyVerified(args: string[]): Promise<void> {
  const [clusterRaw, programIdRaw, uploaderRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!programIdRaw) {
    throw new Error("check-already-verified requires <program-id>");
  }
  if (!uploaderRaw) {
    throw new Error("check-already-verified requires <uploader>");
  }
  const programId = new PublicKey(programIdRaw);
  const uploader = new PublicKey(uploaderRaw);
  const connection = connectionFor(cluster, rpcOverride);
  const { pda, exists } = await otterVerifyPdaExists(
    connection,
    uploader,
    programId,
  );
  emit({ pda: pda.toBase58(), exists });
}

async function cmdComposeProposal(args: string[]): Promise<void> {
  const [
    clusterRaw,
    multisigRaw,
    proposerSignerURL,
    programIdRaw,
    rpcOverride,
  ] = args;
  const cluster = parseCluster(clusterRaw);
  if (!multisigRaw) {
    throw new Error("compose-proposal requires <multisig>");
  }
  if (!proposerSignerURL) {
    throw new Error("compose-proposal requires <proposer-signer-url>");
  }
  if (!programIdRaw) {
    throw new Error("compose-proposal requires <program-id>");
  }
  // buildVerifyInitIx shells out to `solana-verify export-pda-tx`;
  // fail fast at this entry point with the install hint rather than
  // surfacing a less actionable spawn error from inside the builder.
  if (!commandExists("solana-verify")) {
    throw new Error("solana-verify is required (cargo install solana-verify)");
  }
  const multisig = new PublicKey(multisigRaw);
  const programId = new PublicKey(programIdRaw);
  const { vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const connection = connectionFor(cluster, rpcOverride);

  const proposer = await parseSignerURL(proposerSignerURL);

  const repoURL = detectRepoURL();
  const verifyInitIx = await buildVerifyInitIx({
    programId,
    uploader: vaultPda,
    repoURL,
  });

  let proposal: UpgradeProposal;
  try {
    proposal = await createUpgradeProposal({
      connection,
      multisig,
      vaultIndex,
      instructions: [verifyInitIx],
      proposer: proposer.publicKey,
    });

    // Submit atomically with the index prediction. Same rationale as
    // deploy.ts's compose-proposal: splitting compose and submit lets
    // unrelated multisig activity shift the index between them, which
    // would invalidate the predicted proposal PDA and URL printed here.
    await sendWeb3Tx(
      connection,
      proposer,
      [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
      {
        blindSign: {
          label: "vaultTransactionCreate + proposalCreate (verify-init)",
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

  const { timeLock } = await getMultisigConfig(connection, multisig);
  const earliestLegalExecuteEpochMs = Date.now() + timeLock * 1000;
  const earliestLegalExecuteIso = new Date(
    earliestLegalExecuteEpochMs,
  ).toISOString();

  emit({
    proposalPda: proposal.proposalPda.toBase58(),
    transactionPda: proposal.transactionPda.toBase58(),
    transactionIndex: proposal.transactionIndex.toString(),
    squadsUrl: proposal.squadsUrl,
    timeLockSeconds: timeLock,
    earliestLegalExecuteIso,
    repoURL,
    uploader: vaultPda.toBase58(),
  });
}

// Poll until the otter_verify PDA exists for `uploader` × `programId`,
// using the same backoff schedule and transient-error tolerance as the
// rest of this module's polling. Shared by `cmdPollVerified` and the
// orchestrator's post-execute wait so a future tuning of either cadence
// or error handling lands in one place.
async function pollOtterVerifyPdaWritten(args: {
  connection: Connection;
  uploader: PublicKey;
  programId: PublicKey;
  timeoutSec: number;
}): Promise<{ pda: PublicKey }> {
  const deadlineMs = Date.now() + args.timeoutSec * 1000;
  let backoffMs = POLL_INITIAL_BACKOFF_MS;
  let lastPda: PublicKey | null = null;
  while (Date.now() < deadlineMs) {
    let snapshot;
    try {
      snapshot = await otterVerifyPdaExists(
        args.connection,
        args.uploader,
        args.programId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warning(`poll-verified: RPC read failed transiently: ${msg}`);
      await sleepWithJitter(backoffMs);
      backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
      continue;
    }
    lastPda = snapshot.pda;
    if (snapshot.exists) {
      return { pda: snapshot.pda };
    }
    logger.info(
      `poll-verified: otter_verify PDA ${snapshot.pda.toBase58()} not yet written; waiting`,
    );
    await sleepWithJitter(backoffMs);
    backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
  }
  throw new Error(
    `poll-verified: timed out after ${String(args.timeoutSec)}s waiting for otter_verify PDA ${lastPda === null ? "(unset)" : lastPda.toBase58()} to be written by uploader ${args.uploader.toBase58()} for program ${args.programId.toBase58()}. The Squads proposal may have been rejected, cancelled, or is still awaiting approvals; investigate via the Squads UI.`,
  );
}

async function cmdPollVerified(args: string[]): Promise<void> {
  const [clusterRaw, programIdRaw, uploaderRaw, timeoutSecRaw, rpcOverride] =
    args;
  const cluster = parseCluster(clusterRaw);
  if (!programIdRaw) {
    throw new Error("poll-verified requires <program-id>");
  }
  if (!uploaderRaw) {
    throw new Error("poll-verified requires <uploader>");
  }
  const timeoutSec =
    timeoutSecRaw === undefined || timeoutSecRaw === ""
      ? DEFAULT_POLL_TIMEOUT_SECONDS
      : Number(timeoutSecRaw);
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    throw new Error(
      `timeout-seconds must be a positive integer; got ${String(timeoutSecRaw)}`,
    );
  }
  const programId = new PublicKey(programIdRaw);
  const uploader = new PublicKey(uploaderRaw);
  const connection = connectionFor(cluster, rpcOverride);

  const { pda } = await pollOtterVerifyPdaWritten({
    connection,
    uploader,
    programId,
    timeoutSec,
  });
  emit({ matched: true, pda: pda.toBase58() });
}

async function cmdSubmitVerify(args: string[]): Promise<void> {
  const [programIdRaw, uploaderRaw, commitRev] = args;
  if (!programIdRaw) {
    throw new Error("submit-verify requires <program-id>");
  }
  if (!uploaderRaw) {
    throw new Error("submit-verify requires <uploader>");
  }
  if (!commitRev) {
    throw new Error(
      "submit-verify requires <commit-or-tag>; OtterSec pins each verification record to a commit hash, and an unpinned record drifts as HEAD advances",
    );
  }
  const programId = new PublicKey(programIdRaw);
  const uploader = new PublicKey(uploaderRaw);
  const repoURL = detectRepoURL();
  const commitHash = gitResolveCommit(commitRev);
  const jobId = await submitVerifyJob(uploader, programId, repoURL, commitHash);
  emit({ jobId, repoURL, commitHash });
}

// ---------- orchestrator ----------

type RunOptions = {
  cluster: Cluster;
  payer: string | undefined;
  rpcOverride: string | undefined;
  commitRev: string | undefined;
};

function parseRunArgs(args: string[]): RunOptions {
  const cluster = parseCluster(args[0]);
  const opts: RunOptions = {
    cluster,
    payer: undefined,
    rpcOverride: undefined,
    commitRev: undefined,
  };
  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
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
      case "--commit": {
        const v = args[i + 1];
        if (v === undefined) {
          throw new Error("--commit requires a value");
        }
        opts.commitRev = v;
        i += 2;
        break;
      }
      default:
        throw new Error(`unknown option: ${String(arg)}`);
    }
  }
  return opts;
}

async function cmdRun(args: string[]): Promise<void> {
  const opts = parseRunArgs(args);
  const { cluster } = opts;

  // ---- preflight ----
  if (!commandExists("bun")) {
    throw new Error("bun is required but not installed");
  }
  if (!commandExists("solana")) {
    throw new Error("solana CLI is required but not installed");
  }
  if (!commandExists("solana-verify")) {
    throw new Error("solana-verify is required (cargo install solana-verify)");
  }
  const operatorPayerURL = requireSignerURL("OPERATOR_PAYER_KEYPAIR");
  const payer =
    opts.payer === undefined
      ? operatorPayerURL
      : validateSignerURL("--payer", opts.payer);

  // ---- resolve config ----
  const connection = connectionFor(cluster, opts.rpcOverride);
  const rpcURL = connection.rpcEndpoint;
  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const repoURL = detectRepoURL();

  logger.info(`cluster:    ${cluster}`);
  logger.info(`rpc url:    ${rpcURL}`);
  logger.info(`program id: ${programId.toBase58()}`);
  logger.info(`multisig:   ${multisig.toBase58()}`);
  logger.info(`vault pda:  ${vaultPda.toBase58()}`);
  logger.info(`repo url:   ${repoURL}`);

  // ---- check-already-verified (idempotency) ----
  const otterStatus = await otterVerifyPdaExists(
    connection,
    vaultPda,
    programId,
  );
  let skipProposal = false;
  if (otterStatus.exists) {
    logger.info(
      `otter_verify PDA ${otterStatus.pda.toBase58()} already exists for uploader ${vaultPda.toBase58()}; skipping proposal composition`,
    );
    skipProposal = true;
  } else {
    logger.info(
      `otter_verify PDA ${otterStatus.pda.toBase58()} not yet written; proposal composition required`,
    );
  }

  if (!skipProposal) {
    // ---- guard duplicate proposal ----
    await guardNoOpenProposalsForProgram({
      connection,
      multisig,
      programId,
      errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before retrying`,
    });
    logger.info("duplicate-proposal guard: clear");

    // ---- compose + submit ----
    logger.info(
      "composing and submitting Squads verify-init proposal-creation transaction",
    );
    const proposer = await parseSignerURL(payer);
    let proposal: UpgradeProposal;
    try {
      const verifyInitIx = await buildVerifyInitIx({
        programId,
        uploader: vaultPda,
        repoURL,
      });
      proposal = await createUpgradeProposal({
        connection,
        multisig,
        vaultIndex,
        instructions: [verifyInitIx],
        proposer: proposer.publicKey,
      });
      await sendWeb3Tx(
        connection,
        proposer,
        [proposal.vaultTransactionCreateIx, proposal.proposalCreateIx],
        {
          blindSign: {
            label: "vaultTransactionCreate + proposalCreate (verify-init)",
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
    const { timeLock } = await getMultisigConfig(connection, multisig);
    const earliestLegalIso = new Date(
      Date.now() + timeLock * 1000,
    ).toISOString();

    logger.info(`proposal pda:    ${proposal.proposalPda.toBase58()}`);
    logger.info(`transaction pda: ${proposal.transactionPda.toBase58()}`);
    logger.info(`squads ui:       ${proposal.squadsUrl}`);
    logger.info(`earliest legal execute time: ${earliestLegalIso}`);
    logger.info(
      "proposal submitted on chain; multisig members must now approve and execute via the Squads UI.",
    );

    const confirm = await promptOperator(
      "type 'submitted' once the verify-init proposal has been approved + executed in the Squads UI: ",
    );
    if (confirm.trim() !== "submitted") {
      throw new Error("operator did not confirm Squads execution; aborting");
    }

    // ---- poll for otter_verify PDA on-chain ----
    logger.info(
      `polling for otter_verify PDA to be written by uploader ${vaultPda.toBase58()}`,
    );
    await pollOtterVerifyPdaWritten({
      connection,
      uploader: vaultPda,
      programId,
      timeoutSec: DEFAULT_POLL_TIMEOUT_SECONDS,
    });
    logger.info("otter_verify PDA confirmed on-chain");
  }

  // ---- submit OtterSec job ----
  logger.info("submitting OtterSec verification job");
  if (opts.commitRev === undefined) {
    throw new Error(
      "OtterSec job submission requires --commit <rev>; pin the verification record to the commit being verified rather than letting it drift with HEAD",
    );
  }
  const commitHash = gitResolveCommit(opts.commitRev);
  const jobId = await submitVerifyJob(vaultPda, programId, repoURL, commitHash);
  logger.info(`OtterSec job id: ${jobId} (commit ${commitHash})`);
  emit({ jobId, repoURL, commitHash });
}

// ---------- dispatch ----------

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  run: cmdRun,
  resolve: cmdResolve,
  "guard-existing-proposal": cmdGuardExistingProposal,
  "check-already-verified": cmdCheckAlreadyVerified,
  "compose-proposal": cmdComposeProposal,
  "poll-verified": cmdPollVerified,
  "submit-verify": cmdSubmitVerify,
};

const [, , firstArg, ...rest] = process.argv;

if (firstArg === "-h" || firstArg === "--help") {
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
