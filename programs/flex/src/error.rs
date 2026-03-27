use anchor_lang::prelude::*;

#[error_code]
pub enum FlexError {
    #[msg("Session key has expired")]
    SessionKeyExpired,

    #[msg("Session key revoked and grace period elapsed")]
    SessionKeyRevoked,

    #[msg("Authorization has expired")]
    AuthorizationExpired,

    #[msg("Ed25519 signature verification failed")]
    InvalidSignature,

    #[msg("Token account balance insufficient")]
    InsufficientBalance,

    #[msg("Cannot emergency close before timeout")]
    DeadmanNotExpired,

    #[msg("Signer is not the registered facilitator")]
    UnauthorizedFacilitator,

    #[msg("Cannot close session key during grace period")]
    SessionKeyGracePeriodActive,

    #[msg("Cannot close escrow with pending settlements")]
    PendingSettlementsExist,

    #[msg("Cannot finalize before refund timeout")]
    RefundWindowNotExpired,

    #[msg("Cannot refund after refund timeout")]
    RefundWindowExpired,

    #[msg("Cannot refund more than pending amount")]
    RefundExceedsAmount,

    #[msg("Remaining accounts count does not match pending_count")]
    PendingCountMismatch,

    #[msg("Maximum pending settlements reached")]
    PendingLimitReached,

    #[msg("Maximum mints per escrow reached")]
    MintLimitReached,

    #[msg("Token account pair validation failed")]
    InvalidTokenAccountPair,

    #[msg("Account version not supported by this program")]
    UnsupportedAccountVersion,

    #[msg("Same account passed multiple times")]
    DuplicateAccounts,

    #[msg("Maximum session keys per escrow reached")]
    SessionKeyLimitReached,

    #[msg("Ed25519 instruction malformed or missing")]
    InvalidEd25519Instruction,

    #[msg("Recipient is not a valid token account for the specified mint")]
    InvalidSplitRecipient,

    #[msg("Cannot force close before extended timeout")]
    ForceCloseTimeoutNotExpired,

    #[msg("Split count must be between 1 and 5")]
    InvalidSplitCount,

    #[msg("Split bps do not sum to 10000")]
    InvalidSplitBps,

    #[msg("A split entry has bps of zero")]
    SplitBpsZero,

    #[msg("Duplicate recipient in splits")]
    DuplicateSplitRecipient,

    #[msg("Session key must be revoked before closing")]
    SessionKeyStillActive,

    #[msg("Session key count underflow")]
    SessionKeyCountUnderflow,

    #[msg("Settle amount exceeds max authorized amount")]
    SettleExceedsMax,

    #[msg("Settle amount must be greater than zero")]
    SettleAmountZero,

    #[msg("Authorization expiry exceeds refund timeout")]
    ExpiryTooFar,

    #[msg("Refund amount must be greater than zero")]
    RefundAmountZero,
}
