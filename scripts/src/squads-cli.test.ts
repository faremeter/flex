// Parse-only tests for the squads-cli subcommands added beyond the
// initial approve/execute pair. The subcommands talk to mainnet/devnet
// in normal use; the tests here verify the argument-parsing branches
// without making network calls by invoking the script as a child
// process with a missing or invalid arg and asserting the error
// message. Behavior beyond arg parsing (proposal composition, on-chain
// sends) is covered by the devnet rehearsal driven from
// tmp/devnet-rehearsal/rehearse.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "src", "squads-cli.ts");

function runScript(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  // Don't inherit OPERATOR_PAYER_KEYPAIR or MAINNET_RPC_URL from the
  // host environment; the parser branches we want to cover surface
  // before any env-required check fires, so an unset env produces
  // a deterministic failure path the test can assert against.
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

describe("cancel subcommand", () => {
  test("--help prints CANCEL_USAGE on stdout and exits 0", () => {
    const r = runScript(["cancel", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "Casts a Cancel vote on a Squads vault proposal",
    );
    expect(r.stdout).toContain("OPERATOR_PAYER_KEYPAIR");
  });

  test("missing multisig argument fails with the documented error", () => {
    const r = runScript(["cancel", "devnet"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cancel requires <multisig>");
  });

  test("missing tx-index argument fails with the documented error", () => {
    const r = runScript([
      "cancel",
      "devnet",
      "11111111111111111111111111111111",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cancel requires <transaction-index>");
  });

  test("non-numeric tx-index is rejected with a specific error", () => {
    const r = runScript([
      "cancel",
      "devnet",
      "11111111111111111111111111111111",
      "notanumber",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("tx-index must be a non-negative integer");
  });

  test("invalid cluster name is rejected", () => {
    const r = runScript([
      "cancel",
      "testnet",
      "11111111111111111111111111111111",
      "1",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cluster must be "devnet" or "mainnet"');
  });
});

describe("vault-drain subcommand", () => {
  test("--help prints VAULT_DRAIN_USAGE on stdout and exits 0", () => {
    const r = runScript(["vault-drain", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "Composes a Squads vault proposal containing a single",
    );
    expect(r.stdout).toContain("SystemProgram.transfer");
  });

  test("missing cluster surfaces the cluster error, not a generic 'missing arguments'", () => {
    const r = runScript(["vault-drain"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cluster must be "devnet" or "mainnet"');
  });

  test("invalid cluster fails with a specific error", () => {
    const r = runScript(["vault-drain", "testnet"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cluster must be "devnet" or "mainnet"');
  });

  test("unknown option fails with a specific error", () => {
    const r = runScript(["vault-drain", "devnet", "--bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("vault-drain: unknown option: --bogus");
  });

  test("--recipient without a value fails", () => {
    const r = runScript(["vault-drain", "devnet", "--recipient"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--recipient requires a value");
  });

  test("--rpc-url without a value fails", () => {
    const r = runScript(["vault-drain", "devnet", "--rpc-url"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--rpc-url requires a value");
  });

  test("invalid --recipient pubkey is rejected before the env check fires", () => {
    const r = runScript(["vault-drain", "devnet", "--recipient", "garbage"]);
    expect(r.status).not.toBe(0);
    // PublicKey constructor throws on invalid base58; the exact wording
    // comes from @solana/web3.js so we match on the prefix only.
    expect(r.stderr.toLowerCase()).toContain("invalid public key");
  });
});

describe("unknown subcommand", () => {
  test("prints the available subcommands and exits 2", () => {
    const r = runScript(["does-not-exist"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand: does-not-exist");
    expect(r.stderr).toContain("subcommands:");
    expect(r.stderr).toContain("approve");
    expect(r.stderr).toContain("execute");
    expect(r.stderr).toContain("cancel");
    expect(r.stderr).toContain("vault-drain");
  });
});
