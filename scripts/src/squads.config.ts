import { PublicKey } from "@solana/web3.js";

// Squads v4 caps timeLock at 90 days (7_776_000 seconds). The
// per-cluster timeLock value below is validated against this bound at
// module load so a misconfigured per-cluster setting fails at import
// rather than mid-deploy when the multisig program rejects it.
export const MAX_TIME_LOCK = 7_776_000;

export type VerifyMode = "batched" | "separate";

export type SquadsClusterConfig = {
  multisig: PublicKey;
  members: PublicKey[];
  threshold: number;
  vaultIndex: number;
  verifyMode: VerifyMode;
  timeLock: number;
};

export type SquadsConfig = {
  devnet: SquadsClusterConfig;
  mainnet: SquadsClusterConfig;
};

const PLACEHOLDER_MULTISIG = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);
const PLACEHOLDER_MEMBER_A = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
const PLACEHOLDER_MEMBER_B = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const PLACEHOLDER_MEMBER_C = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const squadsConfig: SquadsConfig = {
  devnet: {
    multisig: PLACEHOLDER_MULTISIG,
    members: [PLACEHOLDER_MEMBER_A, PLACEHOLDER_MEMBER_B, PLACEHOLDER_MEMBER_C],
    threshold: 2,
    vaultIndex: 0,
    verifyMode: "batched",
    timeLock: 0,
  },
  mainnet: {
    multisig: PLACEHOLDER_MULTISIG,
    members: [PLACEHOLDER_MEMBER_A, PLACEHOLDER_MEMBER_B, PLACEHOLDER_MEMBER_C],
    threshold: 2,
    vaultIndex: 0,
    verifyMode: "separate",
    timeLock: 86_400,
  },
};

function assertValidClusterConfig(
  cluster: keyof SquadsConfig,
  config: SquadsClusterConfig,
): void {
  const { members, threshold, vaultIndex, verifyMode, timeLock } = config;

  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(
      `squads.config.${cluster}.threshold must be a positive integer; got ${String(threshold)}`,
    );
  }

  if (!Array.isArray(members) || members.length < 1) {
    throw new Error(
      `squads.config.${cluster}.members must contain at least one member`,
    );
  }

  if (threshold > members.length) {
    throw new Error(
      `squads.config.${cluster}.threshold (${threshold}) exceeds member count (${members.length})`,
    );
  }

  const seen = new Set<string>();
  for (const member of members) {
    const memberStr = member.toBase58();
    if (seen.has(memberStr)) {
      throw new Error(
        `squads.config.${cluster}.members contains duplicate entry ${memberStr}`,
      );
    }
    seen.add(memberStr);
  }

  if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
    throw new Error(
      `squads.config.${cluster}.vaultIndex must be a non-negative integer; got ${String(vaultIndex)}`,
    );
  }

  if (verifyMode !== "batched" && verifyMode !== "separate") {
    throw new Error(
      `squads.config.${cluster}.verifyMode must be "batched" or "separate"; got ${String(verifyMode)}`,
    );
  }

  if (!Number.isInteger(timeLock) || timeLock < 0 || timeLock > MAX_TIME_LOCK) {
    throw new Error(
      `squads.config.${cluster}.timeLock must be an integer in [0, ${MAX_TIME_LOCK}]; got ${String(timeLock)}`,
    );
  }
}

export function assertValidConfig(config: SquadsConfig): void {
  assertValidClusterConfig("devnet", config.devnet);
  assertValidClusterConfig("mainnet", config.mainnet);
}

assertValidConfig(squadsConfig);
