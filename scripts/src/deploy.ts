import "dotenv/config";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { FLEX_PROGRAM_ADDRESS } from "@faremeter/flex-solana";
import { configureApp, getLogger } from "@faremeter/logs";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { Buffer } from "node:buffer";
import { type Cluster } from "./cluster.config";
import { squadsConfig, type VerifyMode } from "./squads.config";
import {
  createUpgradeProposal,
  getMultisigConfig,
  getVaultPda,
  guardNoOpenProposalsForProgram,
} from "./squads";
import { buildUpgradeIx, buildCloseBufferIx } from "./bpf-loader-ix";
import { buildVerifyInitIx } from "./verify-init-ix";
import {
  readDeployedVersion,
  readProgramDataSlot,
  sha256OfDeployedProgram,
} from "./program-version";
import { samplePriorityFee } from "./priority-fees";
import { publishRelease, type ReleaseArtifact } from "./github-release";
import { submitVerifyJob } from "./otter-verify";
import { signArtifact } from "./gpg";
import {
  connectionFor,
  detectRepoURL,
  gitResolveCommit,
  loadWeb3Keypair,
  sendWeb3Tx,
} from "./solana";
import {
  closePromptReadline,
  commandExists,
  emit,
  initStateFile as initStateFileShared,
  invocationName,
  parseCluster,
  prompt,
  requireEnvFile,
  runSolana as runSolanaShared,
  sha256OfFile,
  stateSet,
} from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/deploy.ts");

const USAGE = `usage: ${PROGRAM} <cluster> [options]

Standard release flow for the Flex Anchor program. Builds the program
with solana-verify, gates against duplicate proposals and downgrades,
writes an upgrade buffer, transfers buffer authority to the Squads
vault PDA, wraps the upgrade (and optional verify-init) in a Squads
proposal, polls for execution, and publishes a GitHub Release with
GPG-signed artifacts.

Arguments:
  cluster                       devnet | mainnet

Options:
  --verify-mode=batched|separate  (default: per squads.config.ts)
  --payer <signer>                Solana signer URL for the payer
                                  (default: solana CLI default)
  --priority-fee <microlamports>  Override the sampled priority fee
  --rpc-url <url>                 Override the cluster RPC URL
  --allow-downgrade               Skip the monotonic-version guard
                                  (reserved for bin/program-rollback)
  --so-path <path>                Use a pre-built .so instead of running
                                  solana-verify build; implies
                                  --allow-downgrade, --verify-mode=
                                  separate, and skips the
                                  publish-release step. Reserved for
                                  bin/program-rollback.
  --tag <tag>                     Release tag (default: latest git tag)
  --poll-timeout <seconds>        Override the post-execute poll timeout
                                  (default: 1800)
  --help | -h                     Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR    Operator payer keypair path; required.
  MAINNET_RPC_URL           Required when cluster=mainnet and no
                            --rpc-url override is supplied.
  GITHUB_TOKEN              Required when \`gh\` is not installed.
  FLEX_RELEASE_GPG_KEY      Optional GPG signing key override.

State file:
  target/program-deploy/<cluster>-<timestamp>.state.json captures every
  state transition; consult it during partial-execution recovery (see
  DEV.md > Partial-execution recovery).

Inspection subcommands (rarely needed by operators; the orchestrator
is the default entry point):

  resolve <cluster> <key> [<rpc>]    print a config value
  compute-local-sha <so-path>        sha256 of the local .so
  compare-deployed <cluster> <program-id> <local-sha> <local-size-bytes> [<rpc>]
                                     compare on-chain sha to local
  guard-duplicate <cluster> <multisig> <program-id> [<rpc>]
                                     fail if any open proposal targets program
  guard-version <cluster> <program-id> <new-version> [<rpc>]
                                     monotonic-version guard
  sample-priority-fee <cluster> <multisig> <program-id> [<rpc>]
                                     sampled p75 fee per CU
  assert-buffer-authority <cluster> <buffer> <expected> [<rpc>]
                                     verify buffer authority
  size-guard <cluster> <verify-mode> <buffer> <multisig> <program-id>
                                     refuse oversized batched proposals
  compose-proposal <cluster> <verify-mode> <buffer> <multisig> <proposer-keypair> <program-id> [<rpc>]
                                     build + submit the upgrade proposal
  poll <cluster> <program-id> <expected-sha> <expected-size-bytes> [<timeout>] [<rpc>]
                                     poll until deployed sha matches
  publish-release <cluster> <tag> <slot> <state-file> <so-path> <idl-path>
                                     publish the GitHub Release
  submit-verify <program-id> <vault-pda> <commit-or-tag>
                                     submit the OtterSec verify job
`;

await configureApp();
const logger = await getLogger(["flex", "deploy"]);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SO_PATH = path.join(REPO_ROOT, "target", "deploy", "flex.so");
const IDL_PATH = path.join(REPO_ROOT, "target", "idl", "flex.json");
const STATE_DIR = path.join(REPO_ROOT, "target", "program-deploy");

const SIZE_GUARD_LIMIT_BYTES = 1100;
const DEFAULT_POLL_TIMEOUT_SECONDS = 1800;
const POLL_INITIAL_BACKOFF_MS = 5_000;
const POLL_MAX_BACKOFF_MS = 60_000;

function parseVerifyMode(raw: string | undefined): VerifyMode {
  if (raw !== "batched" && raw !== "separate") {
    throw new Error(
      `verify-mode must be "batched" or "separate"; got ${String(raw)}`,
    );
  }
  return raw;
}

function getProgramId(): PublicKey {
  return new PublicKey(FLEX_PROGRAM_ADDRESS);
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const stripped = v.startsWith("v") ? v.slice(1) : v;
    const parts = stripped.split(".");
    if (parts.length !== 3) {
      throw new Error(
        `version ${v} is not a three-component semver; cannot compare`,
      );
    }
    return parts.map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`version ${v} has non-integer component ${p}`);
      }
      return n;
    });
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const aPart = av[i];
    const bPart = bv[i];
    if (aPart === undefined || bPart === undefined) {
      throw new Error(`internal: parsed version has missing component`);
    }
    if (aPart !== bPart) {
      return aPart - bPart;
    }
  }
  return 0;
}

async function buildInstructionsForMode(args: {
  programId: PublicKey;
  bufferAccount: PublicKey;
  vaultPda: PublicKey;
  verifyMode: VerifyMode;
  repoURL: string;
}): Promise<TransactionInstruction[]> {
  const upgradeIx = buildUpgradeIx({
    programId: args.programId,
    bufferAccount: args.bufferAccount,
    authority: args.vaultPda,
  });
  const closeBufferIx = buildCloseBufferIx({
    bufferAccount: args.bufferAccount,
    authority: args.vaultPda,
    recipient: args.vaultPda,
  });
  if (args.verifyMode === "separate") {
    return [upgradeIx, closeBufferIx];
  }
  const verifyInitIx = await buildVerifyInitIx({
    programId: args.programId,
    uploader: args.vaultPda,
    repoURL: args.repoURL,
  });
  return [upgradeIx, closeBufferIx, verifyInitIx];
}

function projectExecuteTxSize(
  vaultPda: PublicKey,
  instructions: TransactionInstruction[],
): number {
  // Compile the inner vault-message to a v0 message and measure its
  // serialized length. The actual on-the-wire EXECUTE transaction is
  // longer (it wraps this message inside vaultTransactionExecute with
  // signatures), so this is a conservative lower bound on the limit.
  const message = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  return message.serialize().length;
}

async function cmdComputeLocalSHA(args: string[]): Promise<void> {
  const [soPath] = args;
  if (!soPath) {
    throw new Error("compute-local-sha requires <so-path>");
  }
  emit({ sha256: sha256OfFile(soPath) });
}

async function cmdCompareDeployed(args: string[]): Promise<void> {
  const [clusterRaw, programIdRaw, localSha, localSizeRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!programIdRaw) {
    throw new Error("compare-deployed requires <program-id>");
  }
  if (!localSha) {
    throw new Error("compare-deployed requires <local-sha>");
  }
  if (!localSizeRaw) {
    throw new Error("compare-deployed requires <local-size-bytes>");
  }
  const localSize = Number(localSizeRaw);
  if (!Number.isInteger(localSize) || localSize <= 0) {
    throw new Error(
      `local-size-bytes must be a positive integer; got ${localSizeRaw}`,
    );
  }
  const programId = new PublicKey(programIdRaw);
  const connection = connectionFor(cluster, rpcOverride);
  const deployedSha = await sha256OfDeployedProgram(
    connection,
    programId,
    localSize,
  );
  emit({ deployedSha, localSha, equal: deployedSha === localSha });
}

async function cmdGuardDuplicate(args: string[]): Promise<void> {
  const [clusterRaw, multisigRaw, programIdRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!multisigRaw) {
    throw new Error("guard-duplicate requires <multisig>");
  }
  if (!programIdRaw) {
    throw new Error("guard-duplicate requires <program-id>");
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

async function cmdGuardVersion(args: string[]): Promise<void> {
  const [clusterRaw, programIdRaw, newVersion, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!programIdRaw) {
    throw new Error("guard-version requires <program-id>");
  }
  if (!newVersion) {
    throw new Error("guard-version requires <new-version>");
  }
  const programId = new PublicKey(programIdRaw);
  const connection = connectionFor(cluster, rpcOverride);
  const deployedVersion = await readDeployedVersion(connection, programId);
  if (compareVersions(newVersion, deployedVersion) <= 0) {
    throw new Error(
      `monotonic-version guard: new version ${newVersion} is not greater than deployed ${deployedVersion}. Re-run with --allow-downgrade if this is intentional (rollback only).`,
    );
  }
  emit({ deployedVersion, newVersion });
}

async function cmdSamplePriorityFee(args: string[]): Promise<void> {
  const [clusterRaw, multisigRaw, programIdRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!multisigRaw) {
    throw new Error("sample-priority-fee requires <multisig>");
  }
  if (!programIdRaw) {
    throw new Error("sample-priority-fee requires <program-id>");
  }
  const multisig = new PublicKey(multisigRaw);
  const programId = new PublicKey(programIdRaw);
  const { vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const connection = connectionFor(cluster, rpcOverride);
  const fee = await samplePriorityFee(connection, [
    programId,
    multisig,
    vaultPda,
  ]);
  emit({ microLamportsPerCU: fee.toString() });
}

// Reads the on-chain buffer account and throws if its authority does
// not equal `expected`. Shared by `cmdAssertBufferAuthority` and the
// orchestrator's post-set-buffer-authority check so the byte-layout
// expectations stay in one place.
async function assertBufferAuthority(args: {
  connection: Connection;
  bufferAccount: PublicKey;
  expected: PublicKey;
}): Promise<{ bufferAuthority: PublicKey }> {
  const info = await args.connection.getAccountInfo(
    args.bufferAccount,
    "confirmed",
  );
  if (info === null) {
    throw new Error(
      `buffer account ${args.bufferAccount.toBase58()} not found`,
    );
  }
  const bytes = info.data;
  if (bytes.byteLength < 5) {
    throw new Error(`buffer account too short: ${bytes.byteLength} bytes`);
  }
  const discriminator = bytes.readUInt32LE(0);
  const BPF_BUFFER_DISCRIMINATOR = 1;
  if (discriminator !== BPF_BUFFER_DISCRIMINATOR) {
    throw new Error(
      `buffer discriminator mismatch: expected ${BPF_BUFFER_DISCRIMINATOR}, got ${discriminator}`,
    );
  }
  const tag = bytes.readUInt8(4);
  if (tag !== 1) {
    throw new Error(
      `buffer has no authority (tag=${tag}); transfer was not effective`,
    );
  }
  if (bytes.byteLength < 5 + 32) {
    throw new Error(
      `buffer account too short for authority: ${bytes.byteLength} bytes`,
    );
  }
  const actual = new PublicKey(bytes.subarray(5, 5 + 32));
  if (!actual.equals(args.expected)) {
    throw new Error(
      `buffer authority mismatch: expected ${args.expected.toBase58()}, got ${actual.toBase58()}`,
    );
  }
  return { bufferAuthority: actual };
}

async function cmdAssertBufferAuthority(args: string[]): Promise<void> {
  const [clusterRaw, bufferRaw, expectedRaw, rpcOverride] = args;
  const cluster = parseCluster(clusterRaw);
  if (!bufferRaw) {
    throw new Error("assert-buffer-authority requires <buffer-pda>");
  }
  if (!expectedRaw) {
    throw new Error("assert-buffer-authority requires <expected-authority>");
  }
  const bufferAccount = new PublicKey(bufferRaw);
  const expected = new PublicKey(expectedRaw);
  const connection = connectionFor(cluster, rpcOverride);
  const { bufferAuthority } = await assertBufferAuthority({
    connection,
    bufferAccount,
    expected,
  });
  emit({ bufferAuthority: bufferAuthority.toBase58() });
}

// Computes the projected execute-tx size for the named verify mode and
// throws if it exceeds the size-guard limit. Returns a structured
// result so callers can record it in their state file or emit JSON;
// returning `null` from the size field signals the separate-mode skip
// path. Shared by `cmdSizeGuard` and the orchestrator's pre-compose
// check.
async function sizeGuard(args: {
  programId: PublicKey;
  bufferAccount: PublicKey;
  vaultPda: PublicKey;
  verifyMode: VerifyMode;
  repoURL: string;
}): Promise<{ size: number | null; limit: number; skipped: boolean }> {
  if (args.verifyMode === "separate") {
    return { size: null, limit: SIZE_GUARD_LIMIT_BYTES, skipped: true };
  }
  const instructions = await buildInstructionsForMode(args);
  const size = projectExecuteTxSize(args.vaultPda, instructions);
  if (size > SIZE_GUARD_LIMIT_BYTES) {
    throw new Error(
      `Projected execute-tx size: ${String(size)} bytes (limit: ${String(SIZE_GUARD_LIMIT_BYTES)}). Re-run with --verify-mode=separate.`,
    );
  }
  return { size, limit: SIZE_GUARD_LIMIT_BYTES, skipped: false };
}

async function cmdSizeGuard(args: string[]): Promise<void> {
  const [clusterRaw, verifyModeRaw, bufferRaw, multisigRaw, programIdRaw] =
    args;
  const cluster = parseCluster(clusterRaw);
  const verifyMode = parseVerifyMode(verifyModeRaw);
  if (!bufferRaw) {
    throw new Error("size-guard requires <buffer-pda>");
  }
  if (!multisigRaw) {
    throw new Error("size-guard requires <multisig>");
  }
  if (!programIdRaw) {
    throw new Error("size-guard requires <program-id>");
  }

  const bufferAccount = new PublicKey(bufferRaw);
  const multisig = new PublicKey(multisigRaw);
  const programId = new PublicKey(programIdRaw);
  const { vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const repoURL = detectRepoURL();

  const result = await sizeGuard({
    programId,
    bufferAccount,
    vaultPda,
    verifyMode,
    repoURL,
  });
  if (result.skipped) {
    emit({ skipped: true, reason: "size guard only applies in batched mode" });
    return;
  }
  emit({ size: result.size, limit: result.limit });
}

async function cmdComposeProposal(args: string[]): Promise<void> {
  const [
    clusterRaw,
    verifyModeRaw,
    bufferRaw,
    multisigRaw,
    proposerKeypairPath,
    programIdRaw,
    rpcOverride,
  ] = args;
  const cluster = parseCluster(clusterRaw);
  const verifyMode = parseVerifyMode(verifyModeRaw);
  if (!bufferRaw) {
    throw new Error("compose-proposal requires <buffer-pda>");
  }
  if (!multisigRaw) {
    throw new Error("compose-proposal requires <multisig>");
  }
  if (!proposerKeypairPath) {
    throw new Error("compose-proposal requires <proposer-keypair-path>");
  }
  if (!programIdRaw) {
    throw new Error("compose-proposal requires <program-id>");
  }

  const bufferAccount = new PublicKey(bufferRaw);
  const multisig = new PublicKey(multisigRaw);
  const programId = new PublicKey(programIdRaw);
  const { vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const connection = connectionFor(cluster, rpcOverride);

  const proposer = loadWeb3Keypair(proposerKeypairPath);

  const repoURL = detectRepoURL();
  const instructions = await buildInstructionsForMode({
    programId,
    bufferAccount,
    vaultPda,
    verifyMode,
    repoURL,
  });

  const proposal = await createUpgradeProposal({
    connection,
    multisig,
    vaultIndex,
    instructions,
    proposer: proposer.publicKey,
  });

  // Submit the proposal-creation transaction atomically with the
  // index prediction. Splitting compose and submit lets unrelated
  // multisig activity shift the index and invalidate the predicted
  // PDAs/URL between the two — the operator would then approve a
  // proposal at a different PDA than what was printed.
  await sendWeb3Tx(connection, proposer, [
    proposal.vaultTransactionCreateIx,
    proposal.proposalCreateIx,
  ]);

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
  });
}

// Poll the deployed program's ProgramData sha until it matches
// `expectedSha`. Shared by `cmdPoll` (operator-facing CLI) and the
// orchestrator's post-execute wait so both paths use the same backoff
// schedule, transient-error tolerance, and timeout semantics. On match
// the helper reads the slot from the ProgramData account itself (the
// slot at which the upgrade actually landed, not the current cluster
// tip) so the caller can record it in release metadata.
async function pollDeployedShaMatches(args: {
  connection: Connection;
  programId: PublicKey;
  expectedSha: string;
  expectedSize: number;
  timeoutSec: number;
}): Promise<{ deployedSha: string; slot: bigint }> {
  const deadlineMs = Date.now() + args.timeoutSec * 1000;
  let backoffMs = POLL_INITIAL_BACKOFF_MS;
  let lastSha = "";
  while (Date.now() < deadlineMs) {
    let deployedSha: string;
    try {
      deployedSha = await sha256OfDeployedProgram(
        args.connection,
        args.programId,
        args.expectedSize,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warning(`poll: RPC read failed transiently: ${msg}`);
      await sleepWithJitter(backoffMs);
      backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
      continue;
    }
    if (deployedSha === args.expectedSha) {
      const slot = await readProgramDataSlot(args.connection, args.programId);
      return { deployedSha, slot };
    }
    lastSha = deployedSha;
    logger.info(
      `poll: deployed sha=${deployedSha} (target=${args.expectedSha}); waiting`,
    );
    await sleepWithJitter(backoffMs);
    backoffMs = Math.min(POLL_MAX_BACKOFF_MS, backoffMs * 2);
  }
  throw new Error(
    `poll: timed out after ${String(args.timeoutSec)}s waiting for deployed sha to match ${args.expectedSha} (last seen: ${lastSha}). Investigate proposal status in the Squads UI and consult DEV.md "Partial-execution recovery".`,
  );
}

async function cmdPoll(args: string[]): Promise<void> {
  const [
    clusterRaw,
    programIdRaw,
    expectedSha,
    expectedSizeRaw,
    timeoutSecRaw,
    rpcOverride,
  ] = args;
  const cluster = parseCluster(clusterRaw);
  if (!programIdRaw) {
    throw new Error("poll requires <program-id>");
  }
  if (!expectedSha) {
    throw new Error("poll requires <expected-sha>");
  }
  if (!expectedSizeRaw) {
    throw new Error("poll requires <expected-size-bytes>");
  }
  const expectedSize = Number(expectedSizeRaw);
  if (!Number.isInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(
      `expected-size-bytes must be a positive integer; got ${expectedSizeRaw}`,
    );
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
  const connection = connectionFor(cluster, rpcOverride);

  const { deployedSha, slot } = await pollDeployedShaMatches({
    connection,
    programId,
    expectedSha,
    expectedSize,
    timeoutSec,
  });
  emit({ matched: true, deployedSha, slot: slot.toString() });
}

function sleepWithJitter(maxMs: number): Promise<void> {
  const jittered = Math.floor(Math.random() * maxMs);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

// Reads the four release artifacts (.so, IDL, state file, sha256
// digest, cluster metadata), signs each with the operator's GPG key,
// and publishes a GitHub Release at `tag`. Returns the resulting
// Release URL so callers can record it in their state file or emit
// JSON. Shared by `cmdPublishRelease` and the orchestrator's
// release-publication step.
async function publishReleaseArtifacts(args: {
  cluster: Cluster;
  tag: string;
  slot: string;
  stateFilePath: string;
  soPath: string;
  idlPath: string;
}): Promise<URL> {
  const soBytes = Buffer.from(fs.readFileSync(args.soPath));
  const idlBytes = Buffer.from(fs.readFileSync(args.idlPath));
  const stateBytes = Buffer.from(fs.readFileSync(args.stateFilePath));
  const shaText = `${sha256OfFile(args.soPath)}  flex.so\n`;
  const shaBytes = Buffer.from(shaText, "utf-8");
  const clusterMeta = Buffer.from(
    JSON.stringify(
      { cluster: args.cluster, tag: args.tag, slot: args.slot },
      null,
      2,
    ),
    "utf-8",
  );

  const soName = path.basename(args.soPath);
  const idlName = path.basename(args.idlPath);
  const stateName = path.basename(args.stateFilePath);

  const artifacts: ReleaseArtifact[] = [
    { name: soName, bytes: soBytes, gpgSig: await signArtifact(soBytes) },
    { name: idlName, bytes: idlBytes, gpgSig: await signArtifact(idlBytes) },
    {
      name: `${soName}.sha256`,
      bytes: shaBytes,
      gpgSig: await signArtifact(shaBytes),
    },
    {
      name: stateName,
      bytes: stateBytes,
      gpgSig: await signArtifact(stateBytes),
    },
    {
      name: "release-meta.json",
      bytes: clusterMeta,
      gpgSig: await signArtifact(clusterMeta),
    },
  ];

  return await publishRelease(args.tag, artifacts);
}

async function cmdPublishRelease(args: string[]): Promise<void> {
  const [clusterRaw, tag, slotRaw, stateFilePath, soPath, idlPath] = args;
  const cluster = parseCluster(clusterRaw);
  if (!tag) {
    throw new Error("publish-release requires <tag>");
  }
  if (!slotRaw) {
    throw new Error("publish-release requires <slot>");
  }
  if (!stateFilePath) {
    throw new Error("publish-release requires <state-file>");
  }
  if (!soPath) {
    throw new Error("publish-release requires <so-path>");
  }
  if (!idlPath) {
    throw new Error("publish-release requires <idl-path>");
  }
  const url = await publishReleaseArtifacts({
    cluster,
    tag,
    slot: slotRaw,
    stateFilePath,
    soPath,
    idlPath,
  });
  emit({ releaseUrl: url.toString() });
}

async function cmdSubmitVerify(args: string[]): Promise<void> {
  const [programIdRaw, vaultPdaRaw, commitRev] = args;
  if (!programIdRaw) {
    throw new Error("submit-verify requires <program-id>");
  }
  if (!vaultPdaRaw) {
    throw new Error("submit-verify requires <vault-pda>");
  }
  if (!commitRev) {
    throw new Error(
      "submit-verify requires <commit-or-tag>; OtterSec pins each verification record to a commit hash, and an unpinned record drifts as HEAD advances",
    );
  }
  const programId = new PublicKey(programIdRaw);
  const vaultPda = new PublicKey(vaultPdaRaw);
  const repoURL = detectRepoURL();
  const commitHash = gitResolveCommit(commitRev);
  const jobId = await submitVerifyJob(vaultPda, programId, repoURL, commitHash);
  emit({ jobId, repoURL, commitHash });
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
    case "verify-mode":
      emit({ value: squadsConfig[cluster].verifyMode });
      return;
    case "time-lock":
      emit({ value: squadsConfig[cluster].timeLock });
      return;
    default:
      throw new Error(`resolve: unknown key ${key}`);
  }
}

// ---------- orchestrator (the bin script's entire payload) ----------

type RunOptions = {
  cluster: Cluster;
  verifyMode: VerifyMode | undefined;
  payer: string | undefined;
  priorityFeeOverride: bigint | undefined;
  rpcOverride: string | undefined;
  allowDowngrade: boolean;
  releaseTag: string | undefined;
  prebuiltSoPath: string | undefined;
  pollTimeoutSec: number;
};

function parseRunArgs(args: string[]): RunOptions {
  const cluster = parseCluster(args[0]);
  const opts: RunOptions = {
    cluster,
    verifyMode: undefined,
    payer: undefined,
    priorityFeeOverride: undefined,
    rpcOverride: undefined,
    allowDowngrade: false,
    releaseTag: undefined,
    prebuiltSoPath: undefined,
    pollTimeoutSec: DEFAULT_POLL_TIMEOUT_SECONDS,
  };

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const consumeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error(`option ${name} requires a value`);
      }
      i += 1;
      return v;
    };
    switch (name) {
      case "--verify-mode":
        opts.verifyMode = parseVerifyMode(consumeValue());
        break;
      case "--payer":
        opts.payer = consumeValue();
        break;
      case "--priority-fee":
        opts.priorityFeeOverride = BigInt(consumeValue());
        break;
      case "--rpc-url":
        opts.rpcOverride = consumeValue();
        break;
      case "--allow-downgrade":
        opts.allowDowngrade = true;
        break;
      case "--tag":
        opts.releaseTag = consumeValue();
        break;
      case "--so-path":
        opts.prebuiltSoPath = consumeValue();
        break;
      case "--poll-timeout": {
        const raw = consumeValue();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--poll-timeout requires a positive integer (seconds); got ${raw}`,
          );
        }
        opts.pollTimeoutSec = n;
        break;
      }
      default:
        throw new Error(`unknown option: ${name}`);
    }
    i += 1;
  }

  if (opts.prebuiltSoPath !== undefined && opts.prebuiltSoPath.length > 0) {
    if (!fs.existsSync(opts.prebuiltSoPath)) {
      throw new Error(`--so-path file does not exist: ${opts.prebuiltSoPath}`);
    }
    if (opts.verifyMode !== undefined && opts.verifyMode !== "separate") {
      throw new Error(
        "--so-path requires --verify-mode=separate (rollback cannot batch verify-init against HEAD source); re-run without --verify-mode or with --verify-mode=separate",
      );
    }
    // The monotonic-version guard reads the working tree's
    // programs/flex/Cargo.toml, not the version embedded in the
    // rolled-back .so, so the comparison is meaningless under
    // --so-path. Auto-imply --allow-downgrade in that case (rollback
    // is the only sanctioned caller).
    opts.allowDowngrade = true;
  }

  return opts;
}

function runSolana(args: string[]): string {
  return runSolanaShared(logger, args);
}

function runSolanaVerifyBuild(): void {
  logger.info("building program via solana-verify");
  const result = spawnSync("solana-verify", ["build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("solana-verify build failed");
  }
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

function initStateFile(cluster: Cluster): string {
  return initStateFileShared(logger, STATE_DIR, cluster);
}

function gitDescribeLatestTag(): string {
  const result = spawnSync(
    "git",
    ["-C", REPO_ROOT, "describe", "--tags", "--abbrev=0"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error("no git tags found; supply --tag explicitly");
  }
  return result.stdout.trim();
}

function readCargoVersion(): string {
  const cargoToml = fs.readFileSync(
    path.join(REPO_ROOT, "programs", "flex", "Cargo.toml"),
    "utf-8",
  );
  const m = /^version = "(.*)"/m.exec(cargoToml);
  if (!m?.[1]) {
    throw new Error("could not read version from programs/flex/Cargo.toml");
  }
  return m[1];
}

async function cmdRun(args: string[]): Promise<void> {
  const opts = parseRunArgs(args);
  const { cluster } = opts;
  const usingPrebuiltSo =
    opts.prebuiltSoPath !== undefined && opts.prebuiltSoPath.length > 0;

  // ---- Step 10: parse_flags / resolve config + state init ----
  if (!commandExists("bun")) {
    throw new Error("bun is required but not installed");
  }
  const operatorKeypair = requireEnvFile("OPERATOR_PAYER_KEYPAIR");
  const payer = opts.payer ?? operatorKeypair;

  const connection = connectionFor(cluster, opts.rpcOverride);
  const rpcURL = connection.rpcEndpoint;
  const programId = getProgramId();
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vaultPda = getVaultPda(multisig, vaultIndex);
  const verifyMode = opts.verifyMode ?? squadsConfig[cluster].verifyMode;
  const { timeLock } = await getMultisigConfig(connection, multisig);

  const stateFile = initStateFile(cluster);
  stateSet(stateFile, "rpc_url", rpcURL);
  stateSet(stateFile, "program_id", programId.toBase58());
  stateSet(stateFile, "multisig", multisig.toBase58());
  stateSet(stateFile, "vault_pda", vaultPda.toBase58());
  stateSet(stateFile, "verify_mode", verifyMode);
  stateSet(stateFile, "time_lock", timeLock);

  logger.info(`cluster:      ${cluster}`);
  logger.info(`rpc url:      ${rpcURL}`);
  logger.info(`program id:   ${programId.toBase58()}`);
  logger.info(`multisig:     ${multisig.toBase58()}`);
  logger.info(`vault pda:    ${vaultPda.toBase58()}`);
  logger.info(`verify mode:  ${verifyMode}`);
  logger.info(`time lock:    ${timeLock}s`);
  logger.info(`allow dgrade: ${opts.allowDowngrade}`);

  // ---- Step 20: check_prerequisites ----
  if (!commandExists("solana")) {
    throw new Error("solana CLI is required but not installed");
  }
  if (!commandExists("solana-verify")) {
    throw new Error("solana-verify is required (cargo install solana-verify)");
  }
  if (!commandExists("gh")) {
    logger.warning(
      "gh CLI not found; GITHUB_TOKEN will be required for publishing",
    );
  }
  if (!commandExists("gpg")) {
    throw new Error("gpg is required for signing release artifacts");
  }

  // ---- Step 30: build_so (skipped under --so-path) ----
  let resolvedSoPath: string;
  if (opts.prebuiltSoPath !== undefined && opts.prebuiltSoPath.length > 0) {
    resolvedSoPath = opts.prebuiltSoPath;
    logger.info(
      `using pre-built .so from --so-path: ${resolvedSoPath} (skipping solana-verify build)`,
    );
    if (!fs.existsSync(resolvedSoPath)) {
      throw new Error(`pre-built .so vanished: ${resolvedSoPath}`);
    }
  } else {
    runSolanaVerifyBuild();
    if (!fs.existsSync(SO_PATH)) {
      throw new Error(`built shared object not found at ${SO_PATH}`);
    }
    if (!fs.existsSync(IDL_PATH)) {
      throw new Error(
        `IDL not found at ${IDL_PATH}; publish-release would fail`,
      );
    }
    resolvedSoPath = SO_PATH;
  }

  // ---- Step 40: compute_local_sha ----
  const localSha = sha256OfFile(resolvedSoPath);
  const localSize = fs.statSync(resolvedSoPath).size;
  logger.info(`local sha256: ${localSha}`);
  stateSet(stateFile, "local_sha", localSha);
  stateSet(stateFile, "local_size", localSize);

  // ---- Step 50: compare_to_deployed (early-exit if match) ----
  const deployedShaInitial = await sha256OfDeployedProgram(
    connection,
    programId,
    localSize,
  );
  if (deployedShaInitial === localSha) {
    logger.info("deployed program already matches local sha; nothing to do");
    stateSet(stateFile, "status", "nochange");
    return;
  }
  logger.info("deployed sha differs from local; proceeding");

  // ---- Step 60: guard_duplicate_proposal ----
  await guardNoOpenProposalsForProgram({
    connection,
    multisig,
    programId,
    errorPreamble: `duplicate-proposal guard (${PROGRAM}): resolve via the Squads UI before retrying`,
  });
  logger.info("duplicate-proposal guard: clear");

  // ---- Step 70: guard_monotonic_version ----
  if (opts.allowDowngrade) {
    logger.warning("monotonic-version guard skipped via --allow-downgrade");
  } else {
    const cargoVersion = readCargoVersion();
    const deployedVersion = await readDeployedVersion(connection, programId);
    if (compareVersions(cargoVersion, deployedVersion) <= 0) {
      throw new Error(
        `monotonic-version guard: new version ${cargoVersion} is not greater than deployed ${deployedVersion}. Re-run with --allow-downgrade if this is intentional (rollback only).`,
      );
    }
    logger.info(`monotonic-version guard: clear (${cargoVersion})`);
    stateSet(stateFile, "new_version", cargoVersion);
  }

  // ---- Step 80: sample_priority_fee ----
  let priorityFee: bigint;
  if (opts.priorityFeeOverride !== undefined) {
    priorityFee = opts.priorityFeeOverride;
    logger.info(
      `using operator-supplied priority fee: ${priorityFee.toString()} microlamports/CU`,
    );
  } else {
    priorityFee = await samplePriorityFee(connection, [
      programId,
      multisig,
      vaultPda,
    ]);
    logger.info(
      `sampled priority fee (p75): ${priorityFee.toString()} microlamports/CU`,
    );
  }
  stateSet(stateFile, "priority_fee", priorityFee.toString());

  // ---- Step 90: write_buffer ----
  logger.info(
    "writing upgrade buffer (this can take several minutes on mainnet)",
  );
  const writeBufferOutput = runSolana([
    "program",
    "write-buffer",
    "--url",
    rpcURL,
    "--keypair",
    payer,
    "--with-compute-unit-price",
    priorityFee.toString(),
    resolvedSoPath,
  ]);
  process.stdout.write(writeBufferOutput);
  const bufferAddress = extractBufferAddress(writeBufferOutput);
  logger.info(`buffer address: ${bufferAddress.toBase58()}`);
  stateSet(stateFile, "buffer_address", bufferAddress.toBase58());

  // ---- Step 100: transfer_buffer_authority ----
  logger.info("transferring buffer authority to vault PDA");
  runSolana([
    "program",
    "set-buffer-authority",
    "--url",
    rpcURL,
    "--keypair",
    payer,
    bufferAddress.toBase58(),
    "--new-buffer-authority",
    vaultPda.toBase58(),
  ]);
  stateSet(stateFile, "buffer_authority_transferred", "true");

  // ---- Step 110: assert_buffer_authority ----
  await assertBufferAuthority({
    connection,
    bufferAccount: bufferAddress,
    expected: vaultPda,
  });
  logger.info(`buffer authority verified: ${vaultPda.toBase58()}`);

  // ---- Step 120: size_guard ----
  const repoURL = detectRepoURL();
  await sizeGuard({
    programId,
    bufferAccount: bufferAddress,
    vaultPda,
    verifyMode,
    repoURL,
  });
  logger.info("size guard: clear");

  // ---- Step 130: compose_proposal ----
  logger.info("composing and submitting Squads proposal-creation transaction");
  const proposer = loadWeb3Keypair(payer);
  const instructions = await buildInstructionsForMode({
    programId,
    bufferAccount: bufferAddress,
    vaultPda,
    verifyMode,
    repoURL,
  });
  const proposal = await createUpgradeProposal({
    connection,
    multisig,
    vaultIndex,
    instructions,
    proposer: proposer.publicKey,
  });
  await sendWeb3Tx(connection, proposer, [
    proposal.vaultTransactionCreateIx,
    proposal.proposalCreateIx,
  ]);
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

  logger.info(`proposal pda:    ${proposal.proposalPda.toBase58()}`);
  logger.info(`transaction pda: ${proposal.transactionPda.toBase58()}`);
  logger.info(`squads ui:       ${proposal.squadsUrl}`);
  logger.info(`earliest legal execute time: ${earliestLegalIso}`);
  logger.info(
    "proposal submitted on chain; multisig members must now approve and execute via the Squads UI.",
  );

  const confirm = await prompt(
    "type 'submitted' once the proposal has been approved + executed in the Squads UI: ",
  );
  if (confirm.trim() !== "submitted") {
    throw new Error("operator did not confirm Squads execution; aborting");
  }

  // ---- Step 140: poll_for_execution ----
  logger.info(
    `polling deployed program data until sha matches local (timeout ${String(opts.pollTimeoutSec)}s)`,
  );
  const { slot: executionSlot } = await pollDeployedShaMatches({
    connection,
    programId,
    expectedSha: localSha,
    expectedSize: localSize,
    timeoutSec: opts.pollTimeoutSec,
  });
  stateSet(stateFile, "execution_slot", executionSlot.toString());
  logger.info(`upgrade landed at slot ${executionSlot.toString()}`);

  // ---- Step 150: publish_release (skipped under --so-path) ----
  if (usingPrebuiltSo) {
    logger.info(
      "skipping publish-release (--so-path supplied; this is a rollback replay)",
    );
    stateSet(stateFile, "release_url", "skipped");
  } else {
    const tag = opts.releaseTag ?? gitDescribeLatestTag();
    stateSet(stateFile, "tag", tag);
    logger.info(`publishing GitHub Release ${tag}`);
    const releaseUrl = await publishReleaseArtifacts({
      cluster,
      tag,
      slot: executionSlot.toString(),
      stateFilePath: stateFile,
      soPath: SO_PATH,
      idlPath: IDL_PATH,
    });
    stateSet(stateFile, "release_url", releaseUrl.toString());
    logger.info(`release published: ${releaseUrl.toString()}`);
  }

  // ---- Step 160: submit_verify_job ----
  if (usingPrebuiltSo) {
    logger.info(
      "skipping submit-verify (--so-path; rollback runs OtterSec verification separately via bin/program-verify against the rollback tag's source)",
    );
    stateSet(stateFile, "verify_status", "skipped-so-path");
  } else if (verifyMode === "separate") {
    logger.info(
      `verify-mode=separate: OtterSec submission deferred to bin/program-verify ${cluster}`,
    );
    stateSet(stateFile, "verify_status", "pending-separate");
  } else {
    logger.info("submitting OtterSec verification job");
    const releaseTag = opts.releaseTag ?? gitDescribeLatestTag();
    const commitHash = gitResolveCommit(releaseTag);
    const jobId = await submitVerifyJob(
      vaultPda,
      programId,
      repoURL,
      commitHash,
    );
    stateSet(stateFile, "verify_job_id", jobId);
    stateSet(stateFile, "verify_commit_hash", commitHash);
    logger.info(`OtterSec job id: ${jobId} (commit ${commitHash})`);
  }

  stateSet(stateFile, "status", "complete");
  logger.info(`deploy complete for ${cluster}`);
}

// ---------- dispatch ----------

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  run: cmdRun,
  resolve: cmdResolve,
  "compute-local-sha": cmdComputeLocalSHA,
  "compare-deployed": cmdCompareDeployed,
  "guard-duplicate": cmdGuardDuplicate,
  "guard-version": cmdGuardVersion,
  "sample-priority-fee": cmdSamplePriorityFee,
  "assert-buffer-authority": cmdAssertBufferAuthority,
  "size-guard": cmdSizeGuard,
  "compose-proposal": cmdComposeProposal,
  poll: cmdPoll,
  "publish-release": cmdPublishRelease,
  "submit-verify": cmdSubmitVerify,
};

const [, , firstArg, ...rest] = process.argv;

if (firstArg === "-h" || firstArg === "--help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

// When the first argument is a cluster name, run the orchestrator;
// otherwise treat it as the explicit subcommand name for inspection.
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
