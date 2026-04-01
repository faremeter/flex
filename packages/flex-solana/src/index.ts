export { FLEX_SCHEME } from "./scheme";
export { FLEX_PROGRAM_ADDRESS } from "./generated";
export {
  serializePaymentAuthorization,
  signPaymentAuthorization,
  createEd25519VerifyInstruction,
} from "./authorization";
export type { SplitInput } from "./authorization";
export {
  fetchEscrowAccount,
  fetchSessionKey,
  fetchPendingSettlement,
  findEscrowsByOwner,
  findEscrowsByFacilitator,
  findPendingSettlementsByEscrow,
} from "./query";
export {
  FlexSplitEntry,
  FlexPaymentPayload,
  FlexPaymentRequirementsExtra,
} from "./types";
export type {
  EscrowAccountData,
  SessionKeyData,
  PendingSettlementData,
} from "./types";
export * as client from "./client/index";
export * as facilitator from "./facilitator/index";

export {
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  getRevokeSessionKeyInstruction,
  getCloseSessionKeyInstruction,
  getSubmitAuthorizationInstructionAsync,
  getRefundInstruction,
  getFinalizeInstruction,
  getCloseEscrowInstruction,
  getVoidPendingInstruction,
  getEmergencyCloseInstruction,
  getForceCloseInstruction,
  getFlexErrorMessage,
} from "./generated";
export type { FlexError, SplitEntry } from "./generated";
export {
  FLEX_ERROR__SESSION_KEY_EXPIRED,
  FLEX_ERROR__SESSION_KEY_REVOKED,
  FLEX_ERROR__AUTHORIZATION_EXPIRED,
  FLEX_ERROR__INVALID_SIGNATURE,
  FLEX_ERROR__INSUFFICIENT_BALANCE,
  FLEX_ERROR__DEADMAN_NOT_EXPIRED,
  FLEX_ERROR__UNAUTHORIZED_FACILITATOR,
  FLEX_ERROR__SESSION_KEY_GRACE_PERIOD_ACTIVE,
  FLEX_ERROR__PENDING_SETTLEMENTS_EXIST,
  FLEX_ERROR__REFUND_WINDOW_NOT_EXPIRED,
  FLEX_ERROR__REFUND_WINDOW_EXPIRED,
  FLEX_ERROR__REFUND_EXCEEDS_AMOUNT,
  FLEX_ERROR__PENDING_LIMIT_REACHED,
  FLEX_ERROR__MINT_LIMIT_REACHED,
  FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR,
  FLEX_ERROR__DUPLICATE_ACCOUNTS,
  FLEX_ERROR__SESSION_KEY_LIMIT_REACHED,
  FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
  FLEX_ERROR__FORCE_CLOSE_TIMEOUT_NOT_EXPIRED,
  FLEX_ERROR__INVALID_SPLIT_BPS,
  FLEX_ERROR__SPLIT_BPS_ZERO,
  FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT,
  FLEX_ERROR__SESSION_KEY_STILL_ACTIVE,
  FLEX_ERROR__SETTLE_EXCEEDS_MAX,
  FLEX_ERROR__SETTLE_AMOUNT_ZERO,
  FLEX_ERROR__EXPIRY_TOO_FAR,
  FLEX_ERROR__INVALID_SPLIT_COUNT,
  FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
  FLEX_ERROR__REFUND_AMOUNT_ZERO,
  FLEX_ERROR__REFUND_TIMEOUT_TOO_SHORT,
  FLEX_ERROR__DEADMAN_TIMEOUT_TOO_SHORT,
  FLEX_ERROR__REFUND_TIMEOUT_TOO_LONG,
  FLEX_ERROR__DEADMAN_TIMEOUT_TOO_LONG,
  FLEX_ERROR__DEADMAN_TOO_CLOSE_TO_REFUND,
} from "./generated";
