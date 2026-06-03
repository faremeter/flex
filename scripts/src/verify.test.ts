import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Regression guard: both bin/program-deploy and bin/program-verify went out
// with a "compose without send" bug in early branch commits. The helper
// computed a Squads proposal PDA but never submitted the underlying
// vault-transaction-create / proposal-create instructions to the chain,
// leaving the operator to "approve" a proposal that did not yet exist.
//
// The fix in both cases is the same: resolve the proposer's signer (now
// via parseSignerURL, so the operator can supply a Ledger URL), then
// sendWeb3Tx the two proposal instructions atomically with the index
// prediction. These assertions encode the post-fix shape so any future
// edit that drops the submission step (or reverts the proposer arg to a
// raw PublicKey) trips a loud test failure.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

describe("compose-proposal helpers submit the proposal-create ixs", () => {
  test("verify.ts imports sendWeb3Tx and parseSignerURL", () => {
    const src = read("scripts/src/verify.ts");
    expect(src).toMatch(/\bsendWeb3Tx\b/);
    expect(src).toMatch(/\bparseSignerURL\b/);
  });

  test("verify.ts cmdComposeProposal accepts a signer URL, not a raw PublicKey", () => {
    const src = read("scripts/src/verify.ts");
    expect(src).toMatch(/parseSignerURL\(proposerSignerURL\)/);
    expect(src).not.toMatch(/const proposer = new PublicKey\(proposerRaw\)/);
  });

  test("verify.ts calls sendWeb3Tx with vaultTransactionCreateIx + proposalCreateIx", () => {
    const src = read("scripts/src/verify.ts");
    expect(src).toMatch(/sendWeb3Tx\(\s*connection,\s*proposer,/);
    expect(src).toMatch(/proposal\.vaultTransactionCreateIx/);
    expect(src).toMatch(/proposal\.proposalCreateIx/);
  });

  test("deploy.ts calls sendWeb3Tx with vaultTransactionCreateIx + proposalCreateIx", () => {
    const src = read("scripts/src/deploy.ts");
    expect(src).toMatch(/sendWeb3Tx\(\s*connection,\s*proposer,/);
    expect(src).toMatch(/proposal\.vaultTransactionCreateIx/);
    expect(src).toMatch(/proposal\.proposalCreateIx/);
  });

  test("bin/program-verify no longer claims the proposal-create is unsubmitted", () => {
    const src = read("bin/program-verify");
    expect(src).not.toMatch(
      /the proposal-creation transaction itself is not submitted/,
    );
  });

  test("bin/program-deploy no longer claims the proposal-create is unsubmitted", () => {
    const src = read("bin/program-deploy");
    expect(src).not.toMatch(
      /the proposal-creation transaction itself must be submitted by the proposer/,
    );
  });
});
