import { type } from "arktype";
import type { Address } from "@solana/kit";

/** Runtime validator for a single split entry in a Flex payment payload. */
export const FlexSplitEntry = type({
  recipient: "string",
  bps: "number",
});

export type FlexSplitEntry = typeof FlexSplitEntry.infer;

/** Runtime validator for the client-submitted Flex payment payload. */
export const FlexPaymentPayload = type({
  escrow: "string",
  mint: "string",
  maxAmount: "string.numeric",
  authorizationId: "string.numeric",
  expiresAtSlot: "string.numeric",
  splits: FlexSplitEntry.array(),
  sessionKey: "string",
  signature: "string",
});

export type FlexPaymentPayload = typeof FlexPaymentPayload.infer;

/** Runtime validator for the `extra` field in Flex payment requirements. */
export const FlexPaymentRequirementsExtra = type({
  facilitator: "string",
  "escrow?": "string",
  supportedMints: "string[]",
  splits: FlexSplitEntry.array(),
  "minGracePeriodSlots?": "string.numeric",
});

export type FlexPaymentRequirementsExtra =
  typeof FlexPaymentRequirementsExtra.infer;

/** Decoded on-chain state of a Flex escrow account. */
export type EscrowAccountData = {
  version: number;
  owner: Address;
  facilitator: Address;
  index: bigint;
  pendingCount: bigint;
  mintCount: bigint;
  refundTimeoutSlots: bigint;
  deadmanTimeoutSlots: bigint;
  lastActivitySlot: bigint;
  maxSessionKeys: number;
  sessionKeyCount: number;
  bump: number;
};

/** Decoded on-chain state of a session key registered to an escrow. */
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

/** Decoded on-chain state of a pending settlement awaiting finalization. */
export type PendingSettlementData = {
  version: number;
  escrow: Address;
  mint: Address;
  amount: bigint;
  originalAmount: bigint;
  maxAmount: bigint;
  authorizationId: bigint;
  expiresAtSlot: bigint;
  submittedAtSlot: bigint;
  sessionKey: Address;
  splitCount: number;
  splits: { recipient: Address; bps: number }[];
  bump: number;
};
