import type { Address } from "@solana/kit";
import type { SplitInput } from "../authorization";

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
  status: "held" | "submitting";
  heldAt: number;
};

export type TryHoldParams = Omit<Hold, "status" | "heldAt">;

export type HoldResult = { ok: true } | { ok: false; reason: string };

export function createHoldManager() {
  const holds = new Map<string, Hold>();

  function key(escrow: Address, authorizationId: bigint): string {
    return `${escrow}:${authorizationId}`;
  }

  function getHeldAmount(escrow: Address, mint: Address): bigint {
    let total = 0n;
    for (const h of holds.values()) {
      if (h.escrow === escrow && h.mint === mint) {
        total += h.settleAmount;
      }
    }
    return total;
  }

  function tryHold(
    params: TryHoldParams,
    vaultBalance: bigint,
    onChainCommitted: bigint,
  ): HoldResult {
    const k = key(params.escrow, params.authorizationId);
    if (holds.has(k)) {
      return { ok: false, reason: "Duplicate authorization ID" };
    }

    const inMemoryHeld = getHeldAmount(params.escrow, params.mint);
    const totalCommitted = onChainCommitted + inMemoryHeld;
    const available = vaultBalance - totalCommitted;

    if (available < params.settleAmount) {
      return { ok: false, reason: "Insufficient available balance for hold" };
    }

    holds.set(k, {
      ...params,
      status: "held",
      heldAt: Date.now(),
    });

    return { ok: true };
  }

  function releaseHold(escrow: Address, authorizationId: bigint): void {
    holds.delete(key(escrow, authorizationId));
  }

  function sweepExpired(currentSlot: bigint): Hold[] {
    const expired: Hold[] = [];
    for (const [k, h] of holds) {
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
      if (h.status !== "held") continue;
      h.status = "submitting";
      ready.push(h);
    }
    return ready;
  }

  function markSubmitted(escrow: Address, authorizationId: bigint): void {
    holds.delete(key(escrow, authorizationId));
  }

  function markFailed(escrow: Address, authorizationId: bigint): void {
    const hold = holds.get(key(escrow, authorizationId));
    if (hold) {
      hold.status = "held";
    }
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
    sweepExpired,
    drainSubmittable,
    markSubmitted,
    markFailed,
    getHeldAmount,
    getHolds,
    pendingCount,
  };
}

export type HoldManager = ReturnType<typeof createHoldManager>;
