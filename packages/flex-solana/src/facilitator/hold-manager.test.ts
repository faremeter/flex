import { describe, test, expect, beforeEach } from "bun:test";
import type { Address } from "@solana/kit";
import { createHoldManager, type TryHoldParams } from "./hold-manager";
import { MAX_PENDING_SETTLEMENTS } from "./accounting";

type HoldManager = ReturnType<typeof createHoldManager>;

const ESCROW = "escrow1" as Address;
const ESCROW_B = "escrow2" as Address;
const MINT = "mint1" as Address;
const MINT_B = "mint2" as Address;

let nextAuthId = 1000n;

function makeParams(overrides?: Partial<TryHoldParams>): TryHoldParams {
  return {
    escrow: ESCROW,
    mint: MINT,
    settleAmount: 100n,
    maxAmount: 200n,
    authorizationId: nextAuthId++,
    expiresAtSlot: 1000n,
    sessionKeyAddress: "sk1" as Address,
    sessionKeyPDA: "skpda1" as Address,
    vault: "vault1" as Address,
    splits: [{ recipient: "recipient1" as Address, bps: 10000 }],
    signatureBytes: new Uint8Array(64),
    message: new Uint8Array(32),
    payer: "payer1" as Address,
    validUntilSlot: 1000n,
    ...overrides,
  };
}

let mgr: HoldManager;

beforeEach(() => {
  mgr = createHoldManager();
});

describe("tryHold", () => {
  test("creates a hold in held state", () => {
    const result = mgr.tryHold(makeParams(), 1000n, 0n, 0n);
    expect(result.ok).toBe(true);
    const holds = mgr.getHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]?.status).toBe("held");
    expect(holds[0]?.retryCount).toBe(0);
    expect(holds[0]?.submittedAtSlot).toBeNull();
  });

  test("rejects duplicate authorization ID", () => {
    const params = makeParams({ authorizationId: 42n });
    mgr.tryHold(params, 1000n, 0n, 0n);
    const result = mgr.tryHold(params, 1000n, 0n, 0n);
    expect(result).toEqual({ ok: false, reason: "Duplicate authorization ID" });
  });

  test("allows same authorization ID on different escrows", () => {
    const r1 = mgr.tryHold(
      makeParams({ escrow: ESCROW, authorizationId: 1n }),
      1000n,
      0n,
      0n,
    );
    const r2 = mgr.tryHold(
      makeParams({ escrow: ESCROW_B, authorizationId: 1n }),
      1000n,
      0n,
      0n,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe("tryHold pending count", () => {
  test("rejects when on-chain pending count alone hits limit", () => {
    const result = mgr.tryHold(
      makeParams(),
      1000n,
      0n,
      BigInt(MAX_PENDING_SETTLEMENTS),
    );
    expect(result).toEqual({
      ok: false,
      reason: "Pending settlement limit reached",
    });
  });

  test("rejects when in-memory plus on-chain count hits limit", () => {
    for (let i = 0; i < MAX_PENDING_SETTLEMENTS - 1; i++) {
      mgr.tryHold(makeParams({ authorizationId: BigInt(i) }), 100000n, 0n, 0n);
    }
    const result = mgr.tryHold(
      makeParams({ authorizationId: 99n }),
      100000n,
      0n,
      1n,
    );
    expect(result).toEqual({
      ok: false,
      reason: "Pending settlement limit reached",
    });
  });

  test("does not count submitted holds toward pending limit", () => {
    const params = makeParams({ authorizationId: 1n });
    mgr.tryHold(params, 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(0);

    const result = mgr.tryHold(
      makeParams({ authorizationId: 2n }),
      1000n,
      0n,
      BigInt(MAX_PENDING_SETTLEMENTS - 1),
    );
    expect(result.ok).toBe(true);
  });

  test("counts held, settled, and submitting toward limit", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    mgr.tryHold(makeParams({ authorizationId: 3n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 3n, 100n);
    mgr.drainSubmittable(0n);

    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(3);
  });
});

describe("tryHold balance", () => {
  test("rejects when on-chain committed exceeds vault balance", () => {
    const result = mgr.tryHold(
      makeParams({ settleAmount: 1n }),
      100n,
      101n,
      0n,
    );
    expect(result).toEqual({
      ok: false,
      reason: "Insufficient available balance for hold",
    });
  });

  test("rejects when in-memory held leaves insufficient balance", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, settleAmount: 60n }),
      100n,
      0n,
      0n,
    );
    const result = mgr.tryHold(
      makeParams({ authorizationId: 2n, settleAmount: 50n }),
      100n,
      0n,
      0n,
    );
    expect(result).toEqual({
      ok: false,
      reason: "Insufficient available balance for hold",
    });
  });

  test("uses settleAmount not maxAmount for balance accounting", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, settleAmount: 10n, maxAmount: 100n }),
      50n,
      0n,
      0n,
    );
    const result = mgr.tryHold(
      makeParams({ authorizationId: 2n, settleAmount: 35n }),
      50n,
      0n,
      0n,
    );
    expect(result.ok).toBe(true);
  });

  test("does not double-count submitted or finalizing holds", () => {
    const params = makeParams({ authorizationId: 1n, settleAmount: 80n });
    mgr.tryHold(params, 100n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 80n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);

    expect(mgr.getHeldAmount(ESCROW, MINT)).toBe(0n);

    // onChainCommitted includes the submitted hold (80n). getHeldAmount excludes it.
    // So available = 1000 - 80 - 0 = 920, which is >= 90.
    const result = mgr.tryHold(
      makeParams({ authorizationId: 2n, settleAmount: 90n }),
      1000n,
      80n,
      1n,
    );
    expect(result.ok).toBe(true);
  });

  test("accounts for holds across mints independently", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, mint: MINT, settleAmount: 80n }),
      100n,
      0n,
      0n,
    );
    const result = mgr.tryHold(
      makeParams({ authorizationId: 2n, mint: MINT_B, settleAmount: 90n }),
      100n,
      0n,
      0n,
    );
    expect(result.ok).toBe(true);
  });

  test("accepts zero settleAmount without error", () => {
    const result = mgr.tryHold(makeParams({ settleAmount: 0n }), 100n, 0n, 0n);
    expect(result.ok).toBe(true);
  });

  test("accepts hold when settleAmount equals available balance", () => {
    const result = mgr.tryHold(
      makeParams({ settleAmount: 50n }),
      100n,
      50n,
      0n,
    );
    expect(result.ok).toBe(true);
  });
});

describe("releaseHold", () => {
  test("removes the hold entirely", () => {
    const params = makeParams({ authorizationId: 1n });
    mgr.tryHold(params, 1000n, 0n, 0n);
    mgr.releaseHold(ESCROW, 1n);
    expect(mgr.getHolds()).toHaveLength(0);
    expect(mgr.pendingCount()).toBe(0);
  });

  test("is a no-op for nonexistent hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.releaseHold(ESCROW, 999n);
    expect(mgr.getHolds()).toHaveLength(1);
  });
});

describe("updateSettleAmount", () => {
  test("transitions held to settled", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, maxAmount: 200n }),
      1000n,
      0n,
      0n,
    );
    const result = mgr.updateSettleAmount(ESCROW, 1n, 150n);
    expect(result.ok).toBe(true);
    expect(mgr.getHolds()[0]?.status).toBe("settled");
    expect(mgr.getHolds()[0]?.settleAmount).toBe(150n);
  });

  test("rejects if hold is not in held state", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    const result = mgr.updateSettleAmount(ESCROW, 1n, 50n);
    expect(result).toEqual({ ok: false, reason: "Hold is not in held state" });
  });

  test("rejects if settleAmount exceeds maxAmount", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, maxAmount: 50n }),
      1000n,
      0n,
      0n,
    );
    const result = mgr.updateSettleAmount(ESCROW, 1n, 51n);
    expect(result).toEqual({
      ok: false,
      reason: "Settle amount exceeds maxAmount",
    });
  });

  test("returns error for nonexistent hold", () => {
    const result = mgr.updateSettleAmount(ESCROW, 999n, 100n);
    expect(result).toEqual({ ok: false, reason: "Hold not found" });
  });

  test("allows settleAmount larger than original up to maxAmount", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, settleAmount: 50n, maxAmount: 200n }),
      1000n,
      0n,
      0n,
    );
    const result = mgr.updateSettleAmount(ESCROW, 1n, 180n);
    expect(result.ok).toBe(true);
    expect(mgr.getHeldAmount(ESCROW, MINT)).toBe(180n);
  });

  test("accepts settleAmount exactly equal to maxAmount", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, maxAmount: 100n }),
      1000n,
      0n,
      0n,
    );
    const result = mgr.updateSettleAmount(ESCROW, 1n, 100n);
    expect(result.ok).toBe(true);
  });
});

describe("sweepExpired", () => {
  test("removes held holds past their validUntilSlot", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    const expired = mgr.sweepExpired(100n);
    expect(expired).toHaveLength(1);
    expect(mgr.getHolds()).toHaveLength(0);
  });

  test("does not remove holds that are not in held state", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    const expired = mgr.sweepExpired(100n);
    expect(expired).toHaveLength(0);
    expect(mgr.getHolds()).toHaveLength(1);
  });

  test("does not remove holds before their expiry", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    const expired = mgr.sweepExpired(99n);
    expect(expired).toHaveLength(0);
  });

  test("handles multiple expired holds", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ authorizationId: 2n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ authorizationId: 3n, validUntilSlot: 100n }),
      1000n,
      0n,
      0n,
    );
    const expired = mgr.sweepExpired(100n);
    expect(expired).toHaveLength(3);
    expect(mgr.getHolds()).toHaveLength(0);
  });
});

describe("drainSubmittable", () => {
  test("transitions settled holds to submitting", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    const ready = mgr.drainSubmittable(0n);
    expect(ready).toHaveLength(2);
    expect(ready.every((h) => h.status === "submitting")).toBe(true);
    const ids = new Set(ready.map((h) => h.authorizationId));
    expect(ids.has(1n)).toBe(true);
    expect(ids.has(2n)).toBe(true);
  });

  test("does not touch held or submitted holds", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    mgr.tryHold(makeParams({ authorizationId: 3n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 3n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 3n, 50n);

    const ready = mgr.drainSubmittable(0n);
    expect(ready).toHaveLength(0);
  });

  test("sweeps expired holds first", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, validUntilSlot: 10n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    const ready = mgr.drainSubmittable(10n);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.authorizationId).toBe(2n);
    expect(mgr.getHolds()).toHaveLength(1);
  });

  test("drains settled holds across multiple escrows", () => {
    mgr.tryHold(
      makeParams({ escrow: ESCROW, authorizationId: 1n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.tryHold(
      makeParams({ escrow: ESCROW_B, authorizationId: 2n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW_B, 2n, 100n);
    mgr.tryHold(
      makeParams({ escrow: ESCROW, authorizationId: 3n }),
      1000n,
      0n,
      0n,
    );

    const ready = mgr.drainSubmittable(0n);
    expect(ready).toHaveLength(2);
    const escrows = new Set(ready.map((h) => h.escrow));
    expect(escrows.has(ESCROW)).toBe(true);
    expect(escrows.has(ESCROW_B)).toBe(true);
    const ids = new Set(ready.map((h) => h.authorizationId));
    expect(ids.has(1n)).toBe(true);
    expect(ids.has(2n)).toBe(true);
    expect(ids.has(3n)).toBe(false);
  });

  test("returns empty when no holds exist", () => {
    const ready = mgr.drainSubmittable(0n);
    expect(ready).toHaveLength(0);
  });
});

describe("markSubmitted", () => {
  test("transitions submitting to submitted and records slot", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    expect(mgr.markSubmitted(ESCROW, 1n, 500n)).toBe(true);
    const hold = mgr.getHolds()[0];
    expect(hold?.status).toBe("submitted");
    expect(hold?.submittedAtSlot).toBe(500n);
  });

  test("returns false for nonexistent hold", () => {
    expect(mgr.markSubmitted(ESCROW, 999n, 100n)).toBe(false);
  });
});

describe("markFailed", () => {
  test("transitions submitting to settled and increments retry count", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    const result = mgr.markFailed(ESCROW, 1n);
    expect(result).toBe(1);
    const hold = mgr.getHolds()[0];
    expect(hold?.status).toBe("settled");
    expect(hold?.retryCount).toBe(1);
  });

  test("increments retry count on each failure", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);

    mgr.drainSubmittable(0n);
    expect(mgr.markFailed(ESCROW, 1n)).toBe(1);
    mgr.drainSubmittable(0n);
    expect(mgr.markFailed(ESCROW, 1n)).toBe(2);
    mgr.drainSubmittable(0n);
    expect(mgr.markFailed(ESCROW, 1n)).toBe(3);
  });

  test("returns -1 if hold is not in submitting state", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    expect(mgr.markFailed(ESCROW, 1n)).toBe(-1);
    expect(mgr.getHolds()[0]?.status).toBe("held");
  });

  test("returns -1 for nonexistent hold", () => {
    expect(mgr.markFailed(ESCROW, 999n)).toBe(-1);
  });

  test("returns -1 for submitted hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    expect(mgr.markFailed(ESCROW, 1n)).toBe(-1);
    expect(mgr.getHolds()[0]?.status).toBe("submitted");
  });
});

describe("drainFinalizable", () => {
  test("transitions submitted holds past refund timeout to finalizing", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    const ready = mgr.drainFinalizable(200n, () => 50n);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.status).toBe("finalizing");
  });

  test("does not transition holds before timeout", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    const ready = mgr.drainFinalizable(149n, () => 50n);
    expect(ready).toHaveLength(0);
  });

  test("skips holds where getRefundTimeout returns null", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    const ready = mgr.drainFinalizable(999n, () => null);
    expect(ready).toHaveLength(0);
  });

  test("uses per-escrow refund timeout", () => {
    mgr.tryHold(
      makeParams({ escrow: ESCROW, authorizationId: 1n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);

    mgr.tryHold(
      makeParams({ escrow: ESCROW_B, authorizationId: 2n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW_B, 2n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW_B, 2n, 100n);

    const ready = mgr.drainFinalizable(150n, (escrow) =>
      escrow === ESCROW ? 50n : 200n,
    );
    expect(ready).toHaveLength(1);
    expect(ready[0]?.escrow).toBe(ESCROW);
  });
});

describe("resetToSubmitted", () => {
  test("transitions finalizing back to submitted", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    mgr.drainFinalizable(999n, () => 50n);
    expect(mgr.getHolds()[0]?.status).toBe("finalizing");

    mgr.resetToSubmitted(ESCROW, 1n);
    expect(mgr.getHolds()[0]?.status).toBe("submitted");
  });

  test("is a no-op if hold is not finalizing", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    mgr.resetToSubmitted(ESCROW, 1n);
    expect(mgr.getHolds()[0]?.status).toBe("submitted");
  });

  test("is a no-op for nonexistent hold", () => {
    mgr.resetToSubmitted(ESCROW, 999n);
    expect(mgr.getHolds()).toHaveLength(0);
  });
});

describe("markFinalized", () => {
  test("removes the hold entirely", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    mgr.drainFinalizable(999n, () => 50n);
    mgr.markFinalized(ESCROW, 1n);
    expect(mgr.getHolds()).toHaveLength(0);
  });
});

describe("state guards", () => {
  test("markSubmitted returns false for non-submitting hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    expect(mgr.markSubmitted(ESCROW, 1n, 100n)).toBe(false);
    expect(mgr.getHolds()[0]?.status).toBe("held");
  });

  test("markSubmitted returns true for submitting hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    expect(mgr.markSubmitted(ESCROW, 1n, 100n)).toBe(true);
    expect(mgr.getHolds()[0]?.status).toBe("submitted");
  });

  test("markFinalized returns false for non-finalizing hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    expect(mgr.markFinalized(ESCROW, 1n)).toBe(false);
    expect(mgr.getHolds()).toHaveLength(1);
  });

  test("markFinalized returns true for finalizing hold", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    mgr.drainFinalizable(999n, () => 50n);
    expect(mgr.markFinalized(ESCROW, 1n)).toBe(true);
    expect(mgr.getHolds()).toHaveLength(0);
  });

  test("releaseHold deletes hold in any status", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 1n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 1n, 100n);
    mgr.releaseHold(ESCROW, 1n);
    expect(mgr.getHolds()).toHaveLength(0);
  });
});

describe("getHeldAmount and getUnsubmittedCount", () => {
  test("getHeldAmount sums only held, settled, and submitting holds", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, settleAmount: 10n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ authorizationId: 2n, settleAmount: 20n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 2n, 20n);
    mgr.tryHold(
      makeParams({ authorizationId: 3n, settleAmount: 30n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 3n, 30n);
    mgr.drainSubmittable(0n);

    mgr.tryHold(
      makeParams({ authorizationId: 4n, settleAmount: 40n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 4n, 40n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 4n, 100n);

    mgr.tryHold(
      makeParams({ authorizationId: 5n, settleAmount: 50n }),
      1000n,
      0n,
      0n,
    );
    mgr.updateSettleAmount(ESCROW, 5n, 50n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 5n, 100n);
    mgr.drainFinalizable(999n, () => 50n);

    // held(10) + settled(20) + submitting(30) = 60. submitted(40) and finalizing(50) excluded.
    expect(mgr.getHeldAmount(ESCROW, MINT)).toBe(60n);
  });

  test("getHeldAmount returns zero for unknown escrow", () => {
    expect(mgr.getHeldAmount("unknown" as Address, MINT)).toBe(0n);
  });

  test("getHeldAmount separates by mint", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, mint: MINT, settleAmount: 10n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ authorizationId: 2n, mint: MINT_B, settleAmount: 20n }),
      1000n,
      0n,
      0n,
    );
    expect(mgr.getHeldAmount(ESCROW, MINT)).toBe(10n);
    expect(mgr.getHeldAmount(ESCROW, MINT_B)).toBe(20n);
  });

  test("getUnsubmittedCount counts held, settled, and submitting", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    mgr.tryHold(makeParams({ authorizationId: 3n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 3n, 100n);
    mgr.drainSubmittable(0n);

    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(3);
  });

  test("getUnsubmittedCount separates by escrow", () => {
    mgr.tryHold(
      makeParams({ escrow: ESCROW, authorizationId: 1n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ escrow: ESCROW_B, authorizationId: 2n }),
      1000n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ escrow: ESCROW_B, authorizationId: 3n }),
      1000n,
      0n,
      0n,
    );
    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(1);
    expect(mgr.getUnsubmittedCount(ESCROW_B)).toBe(2);
  });

  test("pendingCount includes all statuses while getUnsubmittedCount excludes submitted and finalizing", () => {
    mgr.tryHold(makeParams({ authorizationId: 1n }), 1000n, 0n, 0n);
    mgr.tryHold(makeParams({ authorizationId: 2n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 2n, 100n);
    mgr.tryHold(makeParams({ authorizationId: 3n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 3n, 100n);
    mgr.drainSubmittable(0n);
    mgr.tryHold(makeParams({ authorizationId: 4n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 4n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 4n, 100n);
    mgr.tryHold(makeParams({ authorizationId: 5n }), 1000n, 0n, 0n);
    mgr.updateSettleAmount(ESCROW, 5n, 100n);
    mgr.drainSubmittable(0n);
    mgr.markSubmitted(ESCROW, 5n, 100n);
    mgr.drainFinalizable(999n, () => 50n);

    expect(mgr.pendingCount()).toBe(5);
    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(3);
  });

  test("pending count and balance are independent across mints on same escrow", () => {
    mgr.tryHold(
      makeParams({ authorizationId: 1n, mint: MINT, settleAmount: 80n }),
      100n,
      0n,
      0n,
    );
    mgr.tryHold(
      makeParams({ authorizationId: 2n, mint: MINT_B, settleAmount: 90n }),
      100n,
      0n,
      0n,
    );
    expect(mgr.getUnsubmittedCount(ESCROW)).toBe(2);
    expect(mgr.getHeldAmount(ESCROW, MINT)).toBe(80n);
    expect(mgr.getHeldAmount(ESCROW, MINT_B)).toBe(90n);
  });
});
