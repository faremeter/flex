import type { Address } from "@solana/kit";
import type { SplitInput } from "../authorization";
import { MAX_PENDING_SETTLEMENTS } from "./accounting";

export type Hold = {
  escrow: Address;
  mint: Address;
  settleAmount: bigint;
  maxAmount: bigint;
  authorizationId: bigint;
  expiresAtSlot: bigint;
  sessionKeyAddress: Address;
  sessionKeyPDA: Address;
  vault: Address;
  splits: SplitInput[];
  signatureBytes: Uint8Array;
  message: Uint8Array;
  payer: Address;
  validUntilSlot: bigint | null;
  status: "held" | "settled" | "submitting" | "submitted" | "finalizing";
  heldAt: number;
  submittedAtSlot: bigint | null;
};

export type TryHoldParams = Omit<Hold, "status" | "heldAt" | "submittedAtSlot">;

export type HoldResult = { ok: true } | { ok: false; reason: string };

export function createHoldManager() {
  const holds = new Map<string, Hold>();

  function key(escrow: Address, authorizationId: bigint): string {
    return `${escrow}:${authorizationId}`;
  }

  function getHeldAmount(escrow: Address, mint: Address): bigint {
    let total = 0n;
    for (const h of holds.values()) {
      if (
        h.escrow === escrow &&
        h.mint === mint &&
        (h.status === "held" || h.status === "settled" || h.status === "submitting")
      ) {
        total += h.settleAmount;
      }
    }
    return total;
  }

  function getUnsubmittedCount(escrow: Address): number {
    let count = 0;
    for (const h of holds.values()) {
      if (
        h.escrow === escrow &&
        (h.status === "held" || h.status === "settled" || h.status === "submitting")
      ) {
        count++;
      }
    }
    return count;
  }

  function tryHold(
    params: TryHoldParams,
    vaultBalance: bigint,
    onChainCommitted: bigint,
    onChainPendingCount: bigint,
  ): HoldResult {
    const k = key(params.escrow, params.authorizationId);
    if (holds.has(k)) {
      return { ok: false, reason: "Duplicate authorization ID" };
    }

    const totalPending =
      Number(onChainPendingCount) + getUnsubmittedCount(params.escrow);
    if (totalPending >= MAX_PENDING_SETTLEMENTS) {
      return { ok: false, reason: "Pending settlement limit reached" };
    }

    const inMemoryHeld = getHeldAmount(params.escrow, params.mint);
    const totalCommitted = onChainCommitted + inMemoryHeld;

    if (totalCommitted > vaultBalance) {
      return { ok: false, reason: "Insufficient available balance for hold" };
    }

    const available = vaultBalance - totalCommitted;
    if (available < params.settleAmount) {
      return { ok: false, reason: "Insufficient available balance for hold" };
    }

    holds.set(k, {
      ...params,
      status: "held",
      heldAt: Date.now(),
      submittedAtSlot: null,
    });

    return { ok: true };
  }

  function releaseHold(escrow: Address, authorizationId: bigint): void {
    holds.delete(key(escrow, authorizationId));
  }

  function updateSettleAmount(
    escrow: Address,
    authorizationId: bigint,
    settleAmount: bigint,
  ): HoldResult {
    const hold = holds.get(key(escrow, authorizationId));
    if (!hold) {
      return { ok: false, reason: "Hold not found" };
    }
    if (hold.status !== "held") {
      return { ok: false, reason: "Hold is not in held state" };
    }
    if (settleAmount > hold.maxAmount) {
      return { ok: false, reason: "Settle amount exceeds maxAmount" };
    }
    hold.settleAmount = settleAmount;
    hold.status = "settled";
    return { ok: true };
  }

  function sweepExpired(currentSlot: bigint): Hold[] {
    const expired: Hold[] = [];
    for (const [k, h] of holds) {
      if (h.status !== "held") continue;
      if (h.validUntilSlot !== null && currentSlot >= h.validUntilSlot) {
        expired.push(h);
        holds.delete(k);
      }
    }
    return expired;
  }

  function drainSubmittable(currentSlot: bigint): Hold[] {
    sweepExpired(currentSlot);

    const ready: Hold[] = [];
    for (const h of holds.values()) {
      if (h.status !== "settled") continue;
      h.status = "submitting";
      ready.push(h);
    }
    return ready;
  }

  function markSubmitted(
    escrow: Address,
    authorizationId: bigint,
    currentSlot: bigint,
  ): void {
    const hold = holds.get(key(escrow, authorizationId));
    if (hold) {
      hold.status = "submitted";
      hold.submittedAtSlot = currentSlot;
    }
  }

  function markFailed(escrow: Address, authorizationId: bigint): void {
    const hold = holds.get(key(escrow, authorizationId));
    if (hold) {
      hold.status = "settled";
    }
  }

  function drainFinalizable(
    currentSlot: bigint,
    getRefundTimeout: (escrow: Address) => bigint | null,
  ): Hold[] {
    const ready: Hold[] = [];
    for (const h of holds.values()) {
      if (h.status !== "submitted" || h.submittedAtSlot === null) continue;
      const timeout = getRefundTimeout(h.escrow);
      if (timeout === null) continue;
      if (currentSlot >= h.submittedAtSlot + timeout) {
        h.status = "finalizing";
        ready.push(h);
      }
    }
    return ready;
  }

  function markFinalized(escrow: Address, authorizationId: bigint): void {
    holds.delete(key(escrow, authorizationId));
  }

  function getHolds(): Hold[] {
    return [...holds.values()];
  }

  function pendingCount(): number {
    return holds.size;
  }

  return {
    tryHold,
    releaseHold,
    updateSettleAmount,
    sweepExpired,
    drainSubmittable,
    markSubmitted,
    markFailed,
    drainFinalizable,
    markFinalized,
    getHeldAmount,
    getUnsubmittedCount,
    getHolds,
    pendingCount,
  };
}

export type HoldManager = ReturnType<typeof createHoldManager>;
