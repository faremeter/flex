// Parse-only tests for the close.ts subcommands that don't already
// have coverage via the orchestrator. Behavior past arg parsing
// (account-info checks, Squads proposal composition, on-chain sends)
// is exercised by the devnet rehearsal in tmp/devnet-rehearsal/rehearse.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "src", "close.ts");

function runScript(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env };
  delete env.OPERATOR_PAYER_KEYPAIR;
  delete env.MAINNET_RPC_URL;
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("close-buffer subcommand", () => {
  test("--help prints CLOSE_BUFFER_USAGE on stdout and exits 0", () => {
    const r = runScript(["close-buffer", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Composes a Squads vault proposal that invokes");
    expect(r.stdout).toContain("bpf_loader_upgradeable::Close");
  });

  test("missing cluster surfaces the cluster error, not the buffer error", () => {
    // Regression guard: an earlier shape of this code validated the
    // buffer pubkey before the cluster, so a missing-cluster call
    // produced "missing <buffer-pubkey>" — misleading. Validate the
    // cluster first.
    const r = runScript(["close-buffer"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cluster must be "devnet" or "mainnet"');
  });

  test("invalid cluster is rejected", () => {
    const r = runScript(["close-buffer", "testnet", "AnyBufferPubkey"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cluster must be "devnet" or "mainnet"');
  });

  test("missing buffer-pubkey after a valid cluster fails with the buffer error", () => {
    const r = runScript(["close-buffer", "devnet"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("close-buffer: missing <buffer-pubkey>");
  });

  test("invalid buffer-pubkey is rejected before any chain interaction", () => {
    const r = runScript(["close-buffer", "devnet", "garbage"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("invalid public key");
  });

  test("unknown option fails with a specific error", () => {
    const r = runScript([
      "close-buffer",
      "devnet",
      "11111111111111111111111111111111",
      "--bogus",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("close-buffer: unknown option: --bogus");
  });

  test("--recipient without a value fails", () => {
    const r = runScript([
      "close-buffer",
      "devnet",
      "11111111111111111111111111111111",
      "--recipient",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--recipient requires a value");
  });

  test("--rpc-url without a value fails", () => {
    const r = runScript([
      "close-buffer",
      "devnet",
      "11111111111111111111111111111111",
      "--rpc-url",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--rpc-url requires a value");
  });
});

describe("close.ts top-level dispatcher", () => {
  test("--help with no subcommand prints the orchestrator USAGE", () => {
    const r = runScript(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("TERMINAL retirement primitive");
  });

  test("unknown subcommand prints subcommands list and exits 2", () => {
    const r = runScript(["does-not-exist"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand: does-not-exist");
    expect(r.stderr).toContain("close-buffer");
  });
});
