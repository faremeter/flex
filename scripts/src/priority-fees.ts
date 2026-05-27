import { Connection, PublicKey } from "@solana/web3.js";

const DEFAULT_PERCENTILE = 0.75;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error(
      "samplePriorityFee: cannot compute percentile of empty sample",
    );
  }
  if (p < 0 || p > 1) {
    throw new Error(
      `samplePriorityFee: percentile must be in [0, 1]; got ${String(p)}`,
    );
  }
  if (sorted.length === 1) {
    const only = sorted[0];
    if (only === undefined) {
      throw new Error("samplePriorityFee: unreachable empty array");
    }
    return only;
  }
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  const v = sorted[idx];
  if (v === undefined) {
    throw new Error(`samplePriorityFee: percentile index ${idx} out of range`);
  }
  return v;
}

export async function samplePriorityFee(
  connection: Connection,
  accounts: PublicKey[],
): Promise<bigint> {
  if (accounts.length === 0) {
    throw new Error(
      "samplePriorityFee: at least one account must be supplied; an empty " +
        "list would sample the global pool which is not what callers want",
    );
  }
  if (accounts.length > 128) {
    throw new Error(
      `samplePriorityFee: getRecentPrioritizationFees accepts at most 128 ` +
        `addresses; got ${String(accounts.length)}`,
    );
  }

  const fees = await connection.getRecentPrioritizationFees({
    lockedWritableAccounts: accounts,
  });

  if (fees.length === 0) {
    throw new Error(
      "samplePriorityFee: RPC returned no recent prioritization fees; " +
        "cannot compute a sample",
    );
  }

  const samples = fees
    .map((entry) => entry.prioritizationFee)
    .sort((a, b) => a - b);

  const p75 = percentile(samples, DEFAULT_PERCENTILE);
  if (!Number.isFinite(p75) || p75 < 0) {
    throw new Error(
      `samplePriorityFee: computed percentile is invalid: ${String(p75)}`,
    );
  }
  return BigInt(Math.ceil(p75));
}
