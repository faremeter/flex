// Unit tests for the pure executability predicate that backs the
// duplicate-proposal guard. The point of this file is the stale-window
// status filter: a stale-Approved proposal targeting the program is
// executable in Squads v4 and MUST be flagged as blocking. The I/O
// wiring in listOpenProposals (getAccountInfo and the @sqds/multisig
// account deserializers) is left to the operator-driven devnet
// rehearsal documented in DEV.md.

import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { selectBlockingProposals, type ProposalSnapshot } from "./squads";

const PDA_1 = new PublicKey("11111111111111111111111111111112");
const PDA_2 = new PublicKey("11111111111111111111111111111113");
const PDA_3 = new PublicKey("11111111111111111111111111111114");
const PDA_4 = new PublicKey("11111111111111111111111111111115");

function snapshot(
  overrides: Partial<ProposalSnapshot> & Pick<ProposalSnapshot, "index">,
): ProposalSnapshot {
  return {
    proposalPda: PDA_1,
    status: "Approved",
    targetsProgram: true,
    ...overrides,
  };
}

describe("selectBlockingProposals — post-stale window (i > staleTransactionIndex)", () => {
  test("Draft targeting the program is blocking", () => {
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Draft" })],
      4n,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("Draft");
  });

  test("Active targeting the program is blocking", () => {
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Active" })],
      4n,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("Active");
  });

  test("Approved targeting the program is blocking", () => {
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Approved" })],
      4n,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("Approved");
  });

  test("not targeting the program is not blocking, regardless of status", () => {
    const result = selectBlockingProposals(
      [
        snapshot({ index: 5n, status: "Draft", targetsProgram: false }),
        snapshot({ index: 6n, status: "Active", targetsProgram: false }),
        snapshot({ index: 7n, status: "Approved", targetsProgram: false }),
      ],
      4n,
    );
    expect(result).toHaveLength(0);
  });
});

describe("selectBlockingProposals — stale window (i <= staleTransactionIndex)", () => {
  test("stale Approved targeting the program IS blocking (the bug this fix closes)", () => {
    // The stale-Approved-survives-config-change quirk: Squads v4's
    // vault_transaction_execute has no staleness check, so an
    // approved proposal that was staled by a membership/threshold
    // change can still execute later. The duplicate-proposal guard
    // must surface it.
    const result = selectBlockingProposals(
      [snapshot({ index: 3n, status: "Approved" })],
      5n,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.transactionIndex).toBe(3n);
    expect(result[0]?.status).toBe("Approved");
  });

  test("stale Approved at exactly the stale boundary IS blocking", () => {
    // invalidate_prior_transactions sets stale_transaction_index =
    // transaction_index, making the proposal at i == stale the last
    // one created before invalidation. The new code must include
    // that boundary in the stale-Approved sweep.
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Approved" })],
      5n,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.transactionIndex).toBe(5n);
  });

  test("stale Draft at exactly the stale boundary is NOT blocking", () => {
    // proposal_activate uses strict `>` against stale_transaction_index,
    // so a Draft at i == stale cannot be activated. Pin the boundary
    // direction explicitly.
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Draft" })],
      5n,
    );
    expect(result).toHaveLength(0);
  });

  test("stale Active at exactly the stale boundary is NOT blocking", () => {
    // proposal_vote uses strict `>` against stale_transaction_index,
    // so an Active at i == stale cannot collect further votes and
    // cannot reach Approved.
    const result = selectBlockingProposals(
      [snapshot({ index: 5n, status: "Active" })],
      5n,
    );
    expect(result).toHaveLength(0);
  });

  test("stale Draft is NOT blocking", () => {
    // proposal_activate rejects stale Drafts with StaleProposal, so
    // a stale Draft can never transition to Active or beyond.
    const result = selectBlockingProposals(
      [snapshot({ index: 3n, status: "Draft" })],
      5n,
    );
    expect(result).toHaveLength(0);
  });

  test("stale Active is NOT blocking", () => {
    // proposal_vote rejects Approve/Reject on stale proposals with
    // StaleProposal, so a stale Active can never reach Approved.
    const result = selectBlockingProposals(
      [snapshot({ index: 3n, status: "Active" })],
      5n,
    );
    expect(result).toHaveLength(0);
  });

  test("stale Approved not targeting the program is NOT blocking", () => {
    const result = selectBlockingProposals(
      [
        snapshot({
          index: 3n,
          status: "Approved",
          targetsProgram: false,
        }),
      ],
      5n,
    );
    expect(result).toHaveLength(0);
  });
});

describe("selectBlockingProposals — fresh multisig and mixed sets", () => {
  test("fresh multisig (stale=0): post-stale proposals dominate", () => {
    const result = selectBlockingProposals(
      [
        snapshot({ index: 1n, proposalPda: PDA_1, status: "Draft" }),
        snapshot({ index: 2n, proposalPda: PDA_2, status: "Active" }),
        snapshot({ index: 3n, proposalPda: PDA_3, status: "Approved" }),
      ],
      0n,
    );
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.transactionIndex)).toEqual([1n, 2n, 3n]);
  });

  test("empty snapshot list returns empty", () => {
    expect(selectBlockingProposals([], 0n)).toEqual([]);
    expect(selectBlockingProposals([], 100n)).toEqual([]);
  });

  test("mixed stale and post-stale: filters per-window and preserves input order", () => {
    const result = selectBlockingProposals(
      [
        // Stale window (i <= 5).
        snapshot({ index: 1n, proposalPda: PDA_1, status: "Draft" }), // dropped: stale Draft
        snapshot({ index: 2n, proposalPda: PDA_2, status: "Approved" }), // kept: stale Approved
        snapshot({ index: 3n, proposalPda: PDA_3, status: "Active" }), // dropped: stale Active
        // Post-stale window (i > 5).
        snapshot({ index: 6n, proposalPda: PDA_4, status: "Active" }), // kept: live Active
        snapshot({
          index: 7n,
          proposalPda: PDA_4,
          status: "Approved",
          targetsProgram: false, // dropped: doesn't target program
        }),
      ],
      5n,
    );
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.transactionIndex)).toEqual([2n, 6n]);
    expect(result[0]?.proposalPda).toEqual(PDA_2);
    expect(result[1]?.proposalPda).toEqual(PDA_4);
  });
});
