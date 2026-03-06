import type { Address } from "@solana/kit";
import type { SplitInput } from "../authorization";

export type Hold = {
  escrow: Address;
  mint: Address;
  settleAmount: bigint;
  maxAmount: bigint;
  nonce: bigint;
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
  const lastAcceptedNonce = new Map<Address, bigint>();

  function key(escrow: Address, nonce: bigint): string {
    return `${escrow}:${nonce}`;
  }

  function recomputeLastAcceptedNonce(escrow: Address): void {
    let max: bigint | undefined;
    for (const h of holds.values()) {
      if (h.escrow === escrow && (max === undefined || h.nonce > max)) {
        max = h.nonce;
      }
    }
    if (max !== undefined) {
      lastAcceptedNonce.set(escrow, max);
    } else {
      lastAcceptedNonce.delete(escrow);
    }
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
    onChainLastNonce: bigint,
  ): HoldResult {
    const effectiveLastNonce =
      lastAcceptedNonce.get(params.escrow) ?? onChainLastNonce;

    if (params.nonce <= effectiveLastNonce) {
      return {
        ok: false,
        reason: "Nonce not greater than last accepted nonce",
      };
    }

    const inMemoryHeld = getHeldAmount(params.escrow, params.mint);
    const totalCommitted = onChainCommitted + inMemoryHeld;
    const available = vaultBalance - totalCommitted;

    if (available < params.settleAmount) {
      return { ok: false, reason: "Insufficient available balance for hold" };
    }

    holds.set(key(params.escrow, params.nonce), {
      ...params,
      status: "held",
      heldAt: Date.now(),
    });
    lastAcceptedNonce.set(params.escrow, params.nonce);

    return { ok: true };
  }

  function releaseHold(escrow: Address, nonce: bigint): void {
    holds.delete(key(escrow, nonce));
    recomputeLastAcceptedNonce(escrow);
  }

  function sweepExpired(currentSlot: bigint): Hold[] {
    const expired: Hold[] = [];
    const affectedEscrows = new Set<Address>();
    for (const [k, h] of holds) {
      if (h.validUntilSlot !== null && currentSlot >= h.validUntilSlot) {
        expired.push(h);
        holds.delete(k);
        affectedEscrows.add(h.escrow);
      }
    }
    for (const escrow of affectedEscrows) {
      recomputeLastAcceptedNonce(escrow);
    }
    return expired;
  }

  function drainSubmittable(currentSlot: bigint): Hold[] {
    sweepExpired(currentSlot);

    const byEscrow = new Map<Address, Hold[]>();
    for (const h of holds.values()) {
      if (h.status !== "held") continue;
      const group = byEscrow.get(h.escrow) ?? [];
      group.push(h);
      byEscrow.set(h.escrow, group);
    }

    const ready: Hold[] = [];
    for (const group of byEscrow.values()) {
      group.sort((a, b) =>
        a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0,
      );
      for (const h of group) {
        h.status = "submitting";
        ready.push(h);
      }
    }
    return ready;
  }

  function markSubmitted(escrow: Address, nonce: bigint): void {
    holds.delete(key(escrow, nonce));
  }

  function markFailed(escrow: Address, nonce: bigint): void {
    const hold = holds.get(key(escrow, nonce));
    if (hold) {
      hold.status = "held";
    }
  }

  function releaseEscrowHoldsFrom(escrow: Address, fromNonce: bigint): void {
    for (const [k, h] of holds) {
      if (h.escrow === escrow && h.nonce >= fromNonce) {
        holds.delete(k);
      }
    }
    recomputeLastAcceptedNonce(escrow);
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
    releaseEscrowHoldsFrom,
    getHeldAmount,
    getHolds,
    pendingCount,
  };
}

export type HoldManager = ReturnType<typeof createHoldManager>;
