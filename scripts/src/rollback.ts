import { createHash } from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Buffer } from "node:buffer";
import { configureApp, getLogger } from "@faremeter/logs";
import { fetchArtifact } from "./github-release";
import { invocationName, sha256OfFile } from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/rollback.ts");

const USAGE = `usage: ${PROGRAM} <cluster> <tag> --yes-i-want-to-downgrade [--so-path <path>]

Rolls the deployed Flex program BACKWARD to a prior version. This is a
downgrade: the embedded FLEX_VERSION on-chain will move backward, the
monotonic-version guard inside bin/program-deploy will be skipped via
--allow-downgrade, and the audit trail will require cross-referencing
the rollback tag with the prior forward tag.

This is the ONLY sanctioned caller of bin/program-deploy's
--allow-downgrade flag. Do not invoke that flag directly.

Arguments:
  cluster                       devnet | mainnet
  tag                           prior version tag (e.g. v0.4.2), used
                                in logs and passed through to
                                bin/program-deploy --tag for audit
                                trail

Required confirmation:
  --yes-i-want-to-downgrade     explicit operator confirmation; the
                                script refuses to fetch the artifact
                                or invoke bin/program-deploy without
                                this flag

Other options:
  --so-path <path>              use a locally-staged .so instead of
                                fetching from a published GitHub
                                Release. The script still sha256s the
                                provided file and logs the digest, but
                                cannot cross-check against a published
                                sha256 — the operator is asserting
                                they have the right bytes. Useful when
                                replaying from a mirror, a release
                                that predates the publish-release
                                step, or a devnet rehearsal where no
                                Release was published.
  --help | -h                   print this usage and exit 0

Inspection subcommand (rare; the orchestrator is the default entry):

  fetch <tag> <out-so-path>     download flex.so + flex.so.sha256 from
                                the named GitHub Release, verify the
                                sha, and write flex.so to <out-so-path>
`;

const SO_ARTIFACT_NAME = "flex.so";
const SHA_ARTIFACT_NAME = "flex.so.sha256";

await configureApp();
const logger = await getLogger(["flex", "rollback"]);

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const PROGRAM_DEPLOY_TS = path.join(REPO_ROOT, "scripts", "src", "deploy.ts");

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sha256OfBuffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parsePublishedSha(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trimEnd();
  if (trimmed.length === 0) {
    throw new Error(
      `${SHA_ARTIFACT_NAME} artifact is empty; cannot extract published sha256`,
    );
  }
  const firstLine = trimmed.split("\n")[0];
  if (firstLine === undefined || firstLine.length === 0) {
    throw new Error(
      `${SHA_ARTIFACT_NAME} artifact has no parseable first line`,
    );
  }
  const match = /^([0-9a-fA-F]{64})(?:\s+(\S+))?$/.exec(firstLine.trim());
  if (match?.[1] === undefined) {
    throw new Error(
      `${SHA_ARTIFACT_NAME} artifact first line is not "<64-hex>  <filename>": ${JSON.stringify(firstLine)}`,
    );
  }
  const filename = match[2];
  if (filename !== undefined && filename !== SO_ARTIFACT_NAME) {
    throw new Error(
      `${SHA_ARTIFACT_NAME} names filename ${filename}; expected ${SO_ARTIFACT_NAME}`,
    );
  }
  return match[1].toLowerCase();
}

function printDowngradeBanner(cluster: string, tag: string): void {
  const lines = [
    "================================================================",
    `DOWNGRADE: rolling cluster=${cluster} BACKWARD to tag=${tag}`,
    "The monotonic-version guard in bin/program-deploy will be",
    "SKIPPED via --allow-downgrade. The on-chain FLEX_VERSION will",
    "move backward; reconstructing history requires cross-referencing",
    "this rollback with the prior forward tag.",
    "================================================================",
  ];
  for (const line of lines) {
    logger.warning(line);
  }
}

async function fetchAndVerify(tag: string, outPath: string): Promise<string> {
  process.stderr.write(
    `rollback: downloading ${SO_ARTIFACT_NAME} from release ${tag}\n`,
  );
  const soBytes = await fetchArtifact(tag, SO_ARTIFACT_NAME);
  process.stderr.write(
    `rollback: downloaded ${String(soBytes.length)} bytes for ${SO_ARTIFACT_NAME}\n`,
  );

  process.stderr.write(
    `rollback: downloading ${SHA_ARTIFACT_NAME} from release ${tag}\n`,
  );
  const shaBytes = await fetchArtifact(tag, SHA_ARTIFACT_NAME);
  const publishedSha = parsePublishedSha(shaBytes.toString("utf-8"));
  process.stderr.write(`rollback: published sha256 = ${publishedSha}\n`);

  const localSha = sha256OfBuffer(soBytes);
  process.stderr.write(`rollback: computed  sha256 = ${localSha}\n`);

  if (localSha !== publishedSha) {
    throw new Error(
      `sha256 mismatch for release ${tag}: ` +
        `published=${publishedSha} computed=${localSha}`,
    );
  }

  fs.writeFileSync(outPath, soBytes);
  process.stderr.write(
    `rollback: wrote verified ${SO_ARTIFACT_NAME} to ${outPath}\n`,
  );
  return publishedSha;
}

async function cmdFetch(args: string[]): Promise<void> {
  const [tag, outPath] = args;
  if (tag === undefined || tag.length === 0) {
    throw new Error("usage: rollback fetch <tag> <out-so-path>");
  }
  if (outPath === undefined || outPath.length === 0) {
    throw new Error("usage: rollback fetch <tag> <out-so-path>");
  }
  const sha = await fetchAndVerify(tag, outPath);
  emit({ tag, soPath: outPath, sha256: sha });
}

function invokeProgramDeploy(args: string[]): void {
  // Spawn `bun scripts/src/deploy.ts <args>` to drive the upgrade. We
  // don't import deploy.ts as a library because it has top-level
  // dispatch code that runs against process.argv on import; a separate
  // process is the clean delegation.
  logger.warning(`DOWNGRADE: invoking program-deploy ${args.join(" ")}`);
  const result = spawnSync("bun", [PROGRAM_DEPLOY_TS, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `program-deploy exited non-zero (${String(result.status)}); rollback aborted`,
    );
  }
}

type RollbackOptions = {
  cluster: "devnet" | "mainnet";
  tag: string;
  confirmed: boolean;
  prebuiltSoPath: string | undefined;
};

function parseRollbackArgs(argv: string[]): RollbackOptions {
  const [clusterRaw, tag, ...rest] = argv;
  if (clusterRaw !== "devnet" && clusterRaw !== "mainnet") {
    throw new Error(
      `cluster must be "devnet" or "mainnet"; got ${String(clusterRaw)}`,
    );
  }
  if (tag === undefined || tag.length === 0) {
    throw new Error("missing tag argument");
  }

  const opts: RollbackOptions = {
    cluster: clusterRaw,
    tag,
    confirmed: false,
    prebuiltSoPath: undefined,
  };

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case "--yes-i-want-to-downgrade":
        opts.confirmed = true;
        i += 1;
        break;
      case "--so-path": {
        const v = rest[i + 1];
        if (v === undefined) {
          throw new Error("--so-path requires a value");
        }
        opts.prebuiltSoPath = v;
        i += 2;
        break;
      }
      default:
        throw new Error(`unknown option: ${String(arg)}`);
    }
  }

  if (!opts.confirmed) {
    throw new Error(
      "refusing to proceed without --yes-i-want-to-downgrade; no artifact fetched, no deploy invoked",
    );
  }
  if (opts.prebuiltSoPath !== undefined) {
    if (!fs.existsSync(opts.prebuiltSoPath)) {
      throw new Error(`--so-path file does not exist: ${opts.prebuiltSoPath}`);
    }
  }

  return opts;
}

async function cmdRun(argv: string[]): Promise<void> {
  const opts = parseRollbackArgs(argv);
  printDowngradeBanner(opts.cluster, opts.tag);

  let soPath: string;
  let verifiedSha: string;
  if (opts.prebuiltSoPath !== undefined) {
    // Operator-supplied artifact path. No cross-check against a
    // published sha256 is possible — the operator is asserting these
    // are the right bytes (already gated by --yes-i-want-to-downgrade).
    // The script still hashes the file and logs the digest so the
    // audit trail captures exactly which bytes were replayed.
    soPath = opts.prebuiltSoPath;
    verifiedSha = sha256OfFile(soPath);
    logger.warning(`DOWNGRADE: using operator-supplied .so at ${soPath}`);
    logger.warning(
      `DOWNGRADE: sha256=${verifiedSha} (no published sha256 cross-check; operator asserts these bytes)`,
    );
  } else {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-"));
    soPath = path.join(workDir, SO_ARTIFACT_NAME);
    logger.warning(
      `DOWNGRADE: fetching .so and published sha256 for tag ${opts.tag}`,
    );
    verifiedSha = await fetchAndVerify(opts.tag, soPath);
    logger.warning(`DOWNGRADE: verified sha256=${verifiedSha} at ${soPath}`);
  }

  printDowngradeBanner(opts.cluster, opts.tag);
  invokeProgramDeploy([
    opts.cluster,
    "--allow-downgrade",
    "--so-path",
    soPath,
    "--tag",
    opts.tag,
  ]);
  logger.warning(
    `DOWNGRADE: program-deploy completed for tag ${opts.tag} on ${opts.cluster}`,
  );
}

// ---------- dispatch ----------

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  run: cmdRun,
  fetch: cmdFetch,
};

if (import.meta.main) {
  const [, , firstArg, ...rest] = process.argv;

  if (firstArg === "-h" || firstArg === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // When the first argument is a cluster name, run the orchestrator;
  // otherwise treat it as the explicit subcommand name.
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
}
