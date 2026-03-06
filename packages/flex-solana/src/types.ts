import { type } from "arktype";
import type { Address } from "@solana/kit";

export const FlexSplitEntry = type({
  recipient: "string",
  bps: "number",
});

export type FlexSplitEntry = typeof FlexSplitEntry.infer;

export const FlexPaymentPayload = type({
  escrow: "string",
  mint: "string",
  maxAmount: "string.numeric",
  nonce: "string.numeric",
  splits: FlexSplitEntry.array(),
  sessionKey: "string",
  signature: "string",
});

export type FlexPaymentPayload = typeof FlexPaymentPayload.infer;

export const FlexPaymentRequirementsExtra = type({
  facilitator: "string",
  "escrow?": "string",
  supportedMints: "string[]",
  splits: FlexSplitEntry.array(),
  "minGracePeriodSlots?": "string.numeric",
});

export type FlexPaymentRequirementsExtra =
  typeof FlexPaymentRequirementsExtra.infer;

export type EscrowAccountData = {
  version: number;
  owner: Address;
  facilitator: Address;
  index: bigint;
  lastNonce: bigint;
  pendingCount: bigint;
  mintCount: bigint;
  refundTimeoutSlots: bigint;
  deadmanTimeoutSlots: bigint;
  lastActivitySlot: bigint;
  maxSessionKeys: number;
  sessionKeyCount: number;
  bump: number;
};

export type SessionKeyData = {
  version: number;
  escrow: Address;
  key: Address;
  createdAtSlot: bigint;
  expiresAtSlot: bigint | null;
  active: boolean;
  revokedAtSlot: bigint | null;
  revocationGracePeriodSlots: bigint;
  bump: number;
};

export type PendingSettlementData = {
  version: number;
  escrow: Address;
  mint: Address;
  amount: bigint;
  originalAmount: bigint;
  maxAmount: bigint;
  nonce: bigint;
  submittedAtSlot: bigint;
  sessionKey: Address;
  splitCount: number;
  splits: { recipient: Address; bps: number }[];
  bump: number;
};
