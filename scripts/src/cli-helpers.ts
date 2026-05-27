// Helpers shared by the TypeScript orchestrators in this directory
// (initial-deploy, deploy, rollback, verify, close, squads-cli, and
// bootstrap-multisig). Each orchestrator runs as its own bun process
// via a thin bin/ wrapper.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "@faremeter/logs";
import type { Cluster } from "./cluster.config";

// The bin wrapper exports this when invoking bun so the TypeScript
// orchestrator can interpolate the operator-facing name (e.g.
// "program-initial-deploy") into its USAGE string without each
// script hardcoding it.
export function invocationName(fallback: string): string {
  const v = process.env.FLEX_INVOCATION_NAME;
  if (v !== undefined && v.length > 0) {
    return v;
  }
  return fallback;
}

export function parseCluster(raw: string | undefined): Cluster {
  if (raw !== "devnet" && raw !== "mainnet") {
    throw new Error(
      `cluster must be "devnet" or "mainnet"; got ${String(raw)}`,
    );
  }
  return raw;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined) {
    throw new Error(`environment variable ${name} is required`);
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) {
    throw new Error(`environment variable ${name} is required`);
  }
  return trimmed;
}

export function requireEnvFile(name: string): string {
  const v = requireEnv(name);
  if (!fs.existsSync(v)) {
    throw new Error(`${name} does not point to a file: ${v}`);
  }
  return v;
}

export function commandExists(name: string): boolean {
  const which = spawnSync("which", [name], { stdio: "ignore" });
  return which.status === 0;
}

export function sha256OfFile(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

// JSON-line stdout emitter shared by every orchestrator script. The
// inspection subcommands and the operator-facing CLI handlers all
// communicate machine-readable results this way; centralizing the
// helper guarantees a single trailing-newline convention across the
// binaries.
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function runSolana(logger: Logger, args: string[]): string {
  logger.info(`solana ${args.join(" ")}`);
  const result = spawnSync("solana", args, {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `solana ${args.join(" ")} exited with status ${String(result.status)}`,
    );
  }
  return result.stdout;
}

// Persistent readline + a buffer that queues lines emitted faster than
// the caller consumes them. Creating a fresh readline.Interface per
// prompt loses any extra 'line' events that fire in the same tick as
// the one the prompt is waiting on (`rl.question` only registers a
// single one-shot listener), so back-to-back prompts against a piped
// input — e.g. a rehearsal feeder echoing two answers in succession —
// drop every answer after the first.
let promptReadline: readline.Interface | null = null;
const promptLineBuffer: string[] = [];
const promptWaiters: ((line: string) => void)[] = [];

function ensurePromptReadline(): readline.Interface {
  if (promptReadline !== null) {
    return promptReadline;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  rl.on("line", (line) => {
    const waiter = promptWaiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      promptLineBuffer.push(line);
    }
  });
  rl.on("close", () => {
    // Drain pending waiters so they resolve with "" rather than hang
    // forever when the input stream ends (FIFO closed, stdin EOF).
    while (promptWaiters.length > 0) {
      const waiter = promptWaiters.shift();
      waiter?.("");
    }
    promptReadline = null;
  });
  promptReadline = rl;
  return rl;
}

// prompt() is sequential-only. The singleton readline + waiter queue
// can technically serve concurrent callers, but the questions for
// later callers would have already been written to stderr in arrival
// order while the buffered-line shortcut would silently misroute
// input. Guard against that misuse here.
export async function prompt(question: string): Promise<string> {
  if (promptWaiters.length > 0) {
    throw new Error(
      "prompt() is sequential-only; a previous prompt is still awaiting input",
    );
  }
  ensurePromptReadline();
  if (promptLineBuffer.length > 0) {
    const buffered = promptLineBuffer.shift();
    if (buffered !== undefined) {
      return buffered;
    }
  }
  // Only write the question once we know we'll block on stdin; if we
  // had a buffered line we already returned above and writing the
  // prompt would surface a question whose answer is already in hand.
  process.stderr.write(question);
  return await new Promise<string>((resolve) => {
    promptWaiters.push(resolve);
  });
}

// Close the singleton readline so the script's event loop can drain.
// `rl.close()` removes the interface's own 'line' / 'close' listeners
// on stdin, which is enough for node/bun to exit cleanly once no other
// handles keep the loop alive. Each orchestrator calls this at the end
// of its successful path; on the error path the process exits non-zero
// via the dispatcher's catch and the loop tears down anyway.
//
// On node we additionally call `process.stdin.unref()` so any other
// holder of stdin (a test harness, dotenv) doesn't keep the loop alive
// on its own. bun does not implement `process.stdin.unref()` (it's a
// Node Readable-stream method that bun's stdin doesn't expose), so the
// call is guarded behind a typeof check.
export function closePromptReadline(): void {
  if (promptReadline !== null) {
    promptReadline.close();
  }
  const stdin: { unref?: () => void } = process.stdin;
  if (typeof stdin.unref === "function") {
    stdin.unref();
  }
}

// Process-local monotonic counter appended to state-file timestamps so
// two invocations within the same millisecond still produce distinct
// filenames; silently overwriting an audit-trail state file would be a
// quietly load-bearing defect. The counter resets per process but
// real-world operator runs span days, so wraparound is not a concern.
let stateFileCounter = 0;

export function initStateFile(
  logger: Logger,
  stateDir: string,
  cluster: Cluster,
): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  stateFileCounter += 1;
  const counter = String(stateFileCounter).padStart(4, "0");
  const file = path.join(stateDir, `${cluster}-${stamp}-${counter}.state.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ cluster, started: new Date().toISOString() }, null, 2) +
      "\n",
  );
  logger.info(`state file: ${file}`);
  return file;
}

export function stateSet(file: string, key: string, value: unknown): void {
  const current = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  current[key] = value;
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
}
