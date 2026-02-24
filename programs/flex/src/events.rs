use anchor_lang::prelude::*;

use crate::state::SplitEntry;

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    pub facilitator: Pubkey,
    pub index: u64,
    pub refund_timeout_slots: u64,
    pub deadman_timeout_slots: u64,
}

#[event]
pub struct EscrowClosed {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    pub index: u64,
    pub emergency: bool,
}

#[event]
pub struct Deposited {
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub depositor: Pubkey,
}

#[event]
pub struct SessionKeyRegistered {
    pub escrow: Pubkey,
    pub session_key: Pubkey,
    pub expires_at_slot: Option<u64>,
}

#[event]
pub struct SessionKeyRevoked {
    pub escrow: Pubkey,
    pub session_key: Pubkey,
    pub revoked_at_slot: u64,
}

#[event]
pub struct SessionKeyClosed {
    pub escrow: Pubkey,
    pub session_key: Pubkey,
}

#[event]
pub struct AuthorizationSubmitted {
    pub escrow: Pubkey,
    pub nonce: u64,
    pub mint: Pubkey,
    pub splits: Vec<SplitEntry>,
    pub max_amount: u64,
    pub settle_amount: u64,
    pub session_key: Pubkey,
}

#[event]
pub struct Refunded {
    pub escrow: Pubkey,
    pub nonce: u64,
    pub refund_amount: u64,
    pub remaining_amount: u64,
}

#[event]
pub struct Finalized {
    pub escrow: Pubkey,
    pub nonce: u64,
    pub mint: Pubkey,
    pub splits: Vec<SplitEntry>,
    pub total_amount: u64,
}
