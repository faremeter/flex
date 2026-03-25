import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

import { fetchEscrowAccount, findPendingSettlementsByEscrow } from "../query";
import { FLEX_PROGRAM_ADDRESS } from "../generated";
import { logger } from "../logger";

export type HoldEntry = {
  authorizationId: bigint;
  mint: Address;
  amount: bigint;
  maxAmount: bigint;
  submittedAtSlot: bigint;
  sessionKey: Address;
  splits: { recipient: Address; bps: number }[];
  pendingAddress: Address;
};

export type EscrowAccounting = {
  escrow: Address;
  vaultBalances: Map<Address, bigint>;
  holds: HoldEntry[];
  totalPendingByMint: Map<Address, bigint>;
  pendingCount: bigint;
  maxPending: number;
  availableByMint: Map<Address, bigint>;
  canSubmit: boolean;
};

export const MAX_PENDING_SETTLEMENTS = 16;

async function deriveVaultAddress(
  escrow: Address,
  mint: Address,
): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [addr] = await getProgramDerivedAddress({
    programAddress: FLEX_PROGRAM_ADDRESS,
    seeds: [
      new TextEncoder().encode("token"),
      addressEncoder.encode(escrow),
      addressEncoder.encode(mint),
    ],
  });
  return addr;
}

export async function fetchEscrowAccounting(
  rpc: Rpc<SolanaRpcApi>,
  escrowAddress: Address,
  mints: Address[],
): Promise<EscrowAccounting> {
  const [escrowAccount, pendingResults] = await Promise.all([
    fetchEscrowAccount(rpc, escrowAddress),
    findPendingSettlementsByEscrow(rpc, escrowAddress),
  ]);

  if (!escrowAccount) {
    throw new Error("Escrow account not found");
  }

  const holds: HoldEntry[] = pendingResults.map((p) => ({
    authorizationId: p.account.authorizationId,
    mint: p.account.mint,
    amount: p.account.amount,
    maxAmount: p.account.maxAmount,
    submittedAtSlot: p.account.submittedAtSlot,
    sessionKey: p.account.sessionKey,
    splits: p.account.splits,
    pendingAddress: p.address,
  }));

  const totalPendingByMint = new Map<Address, bigint>();
  for (const hold of holds) {
    const current = totalPendingByMint.get(hold.mint) ?? 0n;
    totalPendingByMint.set(hold.mint, current + hold.amount);
  }

  const vaultBalances = new Map<Address, bigint>();
  const balancePromises = mints.map(async (mint) => {
    const vault = await deriveVaultAddress(escrowAddress, mint);
    try {
      const balance = await rpc.getTokenAccountBalance(vault).send();
      return { mint, amount: BigInt(balance.value.amount) };
    } catch (cause) {
      logger.warning("failed to fetch vault balance, assuming zero", {
        escrow: escrowAddress,
        mint,
        vault,
        cause,
      });
      return { mint, amount: 0n };
    }
  });

  const balances = await Promise.all(balancePromises);
  for (const { mint, amount } of balances) {
    vaultBalances.set(mint, amount);
  }

  const availableByMint = new Map<Address, bigint>();
  for (const mint of mints) {
    const vaultBalance = vaultBalances.get(mint) ?? 0n;
    const pending = totalPendingByMint.get(mint) ?? 0n;
    const available = vaultBalance - pending;
    availableByMint.set(mint, available > 0n ? available : 0n);
  }

  const pendingCount = escrowAccount.pendingCount;

  return {
    escrow: escrowAddress,
    vaultBalances,
    holds,
    totalPendingByMint,
    pendingCount,
    maxPending: MAX_PENDING_SETTLEMENTS,
    availableByMint,
    canSubmit: pendingCount < BigInt(MAX_PENDING_SETTLEMENTS),
  };
}
