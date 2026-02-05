# Flex Payment Scheme: Solana Implementation

This document describes the Solana implementation of the Flex Payment Scheme defined in [flex-scheme.md](./flex-scheme.md).

## Overview

The Solana implementation uses a custom Anchor program to manage escrow accounts, session keys, and pending settlements. The program enforces dual authorization between clients and facilitators while enabling off-chain payment authorizations for efficiency.

## Architecture

### Account Hierarchy

```
Escrow Account (per client)
├── Owner: Client pubkey
├── Facilitator: Single authorized facilitator
├── Token Accounts: One PDA per mint
├── Session Keys: Registered signing keys
└── Pending Settlements: Authorizations awaiting finalization
```

### Program-Derived Addresses

| Account Type | Seeds | Authority |
|--------------|-------|-----------|
| Escrow Account | `["escrow", owner]` | Owner + Facilitator |
| Token Account | `["token", escrow, mint]` | Program (PDA signer) |
| Session Key | `["session", escrow, session_key]` | Owner |
| Pending Settlement | `["pending", escrow, nonce]` | Facilitator |

### Dual Authorization Model

The escrow enforces dual authorization at the **instruction level**, not the token account level:

1. **Token accounts** are SPL token accounts with the program's PDA as the sole authority. The program can sign for transfers via PDA signing.

2. **Transfers require both parties**:
   - **Client authorization**: Off-chain Ed25519 signature from a registered session key, verified on-chain
   - **Facilitator authorization**: On-chain transaction signature from the registered facilitator

Neither the client nor the facilitator can unilaterally move funds. The client's session key signature authorizes the payment, and the facilitator's transaction signature submits it. The program PDA then signs the actual token transfer.

## Account Structures

### Escrow Account

```rust
pub struct EscrowAccount {
    /// Client who owns this escrow account
    pub owner: Pubkey,
    
    /// Authorized facilitator (single for v1)
    pub facilitator: Pubkey,
    
    /// Global nonce for replay protection
    pub last_nonce: u64,
    
    /// Number of open pending settlements
    pub pending_count: u64,
    
    /// Refund window duration in slots
    pub refund_timeout_slots: u64,
    
    /// Deadman switch timeout in slots
    pub deadman_timeout_slots: u64,
    
    /// Last activity slot (for deadman switch)
    pub last_activity_slot: u64,
    
    /// PDA bump seed
    pub bump: u8,
}
```

### Session Key

```rust
pub struct SessionKey {
    /// Parent escrow account
    pub escrow: Pubkey,
    
    /// The session key pubkey (Ed25519)
    pub key: Pubkey,
    
    /// Slot when created
    pub created_at_slot: u64,
    
    /// Optional expiration slot
    pub expires_at_slot: Option<u64>,
    
    /// Whether this key is active
    pub active: bool,
    
    /// Slot when revoked (if revoked)
    pub revoked_at_slot: Option<u64>,
    
    /// Grace period in slots after revocation during which authorizations remain valid for settlement
    pub revocation_grace_period_slots: u64,
    
    /// PDA bump seed
    pub bump: u8,
}
```

### Pending Settlement

```rust
pub struct PendingSettlement {
    /// Parent escrow account
    pub escrow: Pubkey,
    
    /// Token mint for this settlement
    pub mint: Pubkey,
    
    /// Recipient (merchant) token account
    pub recipient: Pubkey,
    
    /// Current amount (can be reduced by refunds)
    pub amount: u64,
    
    /// Original amount when submitted
    pub original_amount: u64,
    
    /// Authorization nonce
    pub nonce: u64,
    
    /// Slot when submitted
    pub submitted_at_slot: u64,
    
    /// Session key that signed this authorization
    pub session_key: Pubkey,
    
    /// Facilitator who submitted (receives rent back on finalize)
    pub submitter: Pubkey,
    
    /// PDA bump seed
    pub bump: u8,
}
```

## Instructions

### Account Management

#### `create_escrow`

Creates a new escrow account.

```rust
pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    facilitator: Pubkey,
    refund_timeout_slots: u64,
    deadman_timeout_slots: u64,
) -> Result<()>
```

**Signers**: Owner

**Accounts**:
- `owner` (signer, mut) - Client creating the account
- `escrow` (init, PDA)

**Notes**: The escrow account can hold multiple token types. Token accounts are created lazily on first deposit for each mint.

#### `deposit`

Deposits tokens into the escrow account.

```rust
pub fn deposit(
    ctx: Context<Deposit>,
    amount: u64,
) -> Result<()>
```

**Signers**: Anyone with tokens

**Accounts**:
- `escrow` - The escrow account
- `mint` - SPL token mint
- `token_account` (init_if_needed, PDA) - Created lazily if it doesn't exist
- `source` - Depositor's token account

**Notes**: Anyone can deposit to an escrow account. The token account PDA is created on first deposit for each mint.

#### `close_escrow`

Closes the escrow account and returns all funds to the owner.

```rust
pub fn close_escrow(
    ctx: Context<CloseEscrow>,
) -> Result<()>
```

**Signers**: Owner + Facilitator

**Constraints**: `pending_count == 0` (no pending settlements)

**Preconditions**: The owner must have existing token accounts for each mint held in the escrow. The instruction transfers remaining balances to these owner-provided destination accounts before closing the escrow's token account PDAs.

**Notes**: The facilitator verifies off-chain that no unsettled authorizations exist before co-signing. The on-chain check ensures no pending settlement PDAs remain. Closes all token account PDAs and the escrow account, returning all funds and rent to the owner.

### Session Key Management

#### `register_session_key`

Registers a session key for signing off-chain payment authorizations.

```rust
pub fn register_session_key(
    ctx: Context<RegisterSessionKey>,
    session_key: Pubkey,
    expires_at_slot: Option<u64>,
    revocation_grace_period_slots: u64,
) -> Result<()>
```

**Signers**: Owner

**Notes**: Session key registration is an on-chain transaction. The escrow account does not need to sign arbitrary off-chain messages. This allows smart wallets and multisigs to use the flex scheme.

Session keys intentionally have no spending limits - registering a session key grants full authorization over the escrow account's funds. Clients should treat session key generation with the same care as private key management. If per-key limits are needed, clients should create separate escrow accounts with limited funding.

#### `revoke_session_key`

Revokes a previously registered session key.

```rust
pub fn revoke_session_key(
    ctx: Context<RevokeSessionKey>,
) -> Result<()>
```

**Signers**: Owner

**Notes**: Revocation sets `revoked_at_slot` to the current slot. Authorizations signed with this key before revocation remain valid for settlement during the grace period (`revocation_grace_period_slots`). After the grace period expires, the session key account can be closed and authorizations signed with it become invalid.

#### `close_session_key`

Closes a session key account and reclaims rent.

```rust
pub fn close_session_key(
    ctx: Context<CloseSessionKey>,
) -> Result<()>
```

**Signers**: Owner

**Constraints**: Session key must be revoked and grace period must have elapsed.

### Settlement Flow

#### `submit_authorization`

Submits a client-signed authorization, creating a pending settlement.

```rust
pub fn submit_authorization(
    ctx: Context<SubmitAuthorization>,
    mint: Pubkey,
    recipient: Pubkey,
    amount: u64,
    nonce: u64,
    signature: [u8; 64],
) -> Result<()>
```

**Signers**: Facilitator

**Validation**:
1. Verify `nonce > escrow.last_nonce` (replay protection)
2. Verify Ed25519 signature over `(escrow, mint, recipient, amount, nonce)`
3. Verify session key is registered and valid (not expired, not revoked past grace period)
4. Verify token account has sufficient balance

**Effects**:
1. Create PendingSettlement PDA with `submitted_at_slot = current_slot`
2. Update `escrow.last_nonce = nonce`
3. Update `escrow.last_activity_slot`
4. Increment `escrow.pending_count`

#### `refund`

Reduces the amount of a pending settlement.

```rust
pub fn refund(
    ctx: Context<Refund>,
    refund_amount: u64,
) -> Result<()>
```

**Signers**: Facilitator

**Constraints**: 
- `refund_amount <= pending_settlement.amount`
- Refund window has not expired (`current_slot < submitted_at_slot + refund_timeout_slots`)

**Effects**:
1. Reduce `pending_settlement.amount` by `refund_amount`
2. If `amount` becomes zero (full refund):
   - Close the PendingSettlement PDA immediately
   - Return rent to `pending_settlement.submitter` (facilitator)
   - Decrement `escrow.pending_count`

**Notes**: A full refund closes the pending settlement immediately rather than leaving a zero-amount settlement to be finalized later. This saves a transaction and returns rent to the facilitator promptly.

#### `finalize`

Finalizes a pending settlement after the refund window expires.

```rust
pub fn finalize(
    ctx: Context<Finalize>,
) -> Result<()>
```

**Signers**: Anyone (permissionless crank)

**Constraints**: `current_slot >= submitted_at_slot + escrow.refund_timeout_slots`

**Effects**:
1. Transfer `pending_settlement.amount` from token account to `pending_settlement.recipient`
2. Close PendingSettlement PDA
3. Return rent to `pending_settlement.submitter` (the facilitator who submitted)
4. Decrement `escrow.pending_count`

**Notes**: The facilitator is incentivized to call finalize to reclaim their rent. Merchants can also call finalize to receive their funds promptly.

#### `emergency_close`

Closes the escrow account unilaterally after the deadman switch timeout expires.

```rust
pub fn emergency_close(
    ctx: Context<EmergencyClose>,
) -> Result<()>
```

**Signers**: Owner only

**Constraints**: `current_slot - escrow.last_activity_slot > escrow.deadman_timeout_slots`

**Accounts**: All PendingSettlement PDAs must be passed as remaining accounts.

**Validation**: Number of remaining accounts must equal `escrow.pending_count`.

**Effects**:
1. Close all PendingSettlement PDAs, returning rent to each `submitter`
2. Transfer all token account balances to owner
3. Close all token account PDAs and escrow account PDA

**Notes**: This allows clients to recover funds if a facilitator becomes unresponsive. Any pending settlements are voided - the facilitator loses the opportunity to finalize them, but gets their rent back.

**Transaction Size Consideration**: If an escrow has many pending settlements, they may not all fit in a single transaction. Clients with large numbers of pending settlements may need to use Address Lookup Tables (ALTs) to fit all account references. This is an accepted tradeoff; facilitators have business incentives to finalize settlements promptly rather than accumulate large numbers of pending settlements.

## Authorization Message Format

Off-chain authorizations are Ed25519 signatures over a structured message:

```rust
pub struct PaymentAuthorization {
    /// Escrow account pubkey
    pub escrow: Pubkey,
    
    /// Token mint
    pub mint: Pubkey,
    
    /// Recipient (merchant) token account
    pub recipient: Pubkey,
    
    /// Amount for this payment (in token base units)
    pub amount: u64,
    
    /// Monotonically increasing nonce (global, not per-recipient or per-mint)
    pub nonce: u64,
}
```

The message is serialized using Borsh and signed with the session key's Ed25519 private key.

## Signature Verification

The program uses Solana's native Ed25519 program for signature verification via instruction introspection:

1. The transaction includes an Ed25519 signature verification instruction (before the `submit_authorization` instruction)
2. The `submit_authorization` instruction reads the Instructions sysvar to introspect the preceding Ed25519 verification
3. Program verifies that:
   - An Ed25519 verification instruction exists in the transaction
   - The verified public key matches the registered session key
   - The verified message matches the expected `PaymentAuthorization` data
4. Submission proceeds only if the introspection confirms valid signature verification

This approach leverages Solana's native Ed25519 program rather than performing signature verification in the program itself, which would be prohibitively expensive.

Compute cost: ~25,000 CU per signature verification (in the Ed25519 program instruction).

## Security Model

### Dual Authorization

All transfers out of the escrow require both:
1. **Client authorization**: Via session key signature (registered on-chain)
2. **Facilitator authorization**: Via transaction signature

Neither party can unilaterally move funds (except via deadman switch after timeout).

### Replay Protection

The escrow account tracks a global `last_nonce`. Each authorization must have a nonce strictly greater than the last submitted nonce. This prevents:
- Replaying the same authorization multiple times
- Submitting authorizations out of order in a way that could benefit an attacker

### Refund Window

Pending settlements cannot be finalized until the refund timeout expires. During this window, the facilitator can reduce or cancel the pending amount. This protects against:
- Charges for undelivered services
- Erroneous or disputed transactions

### Deadman Switch

If `current_slot - last_activity_slot > deadman_timeout_slots`, the client can invoke `emergency_close` to recover funds without facilitator cooperation. This prevents facilitators from holding funds hostage.

### Session Key Revocation

When a client revokes a session key:
1. `revoked_at_slot` is set to the current slot
2. Authorizations signed before revocation remain valid during the grace period
3. After `revoked_at_slot + revocation_grace_period_slots`, the key becomes fully invalid
4. The session key account can then be closed to reclaim rent

This gives facilitators time to submit any outstanding authorizations while allowing clients to retire compromised or unused keys.

### Escrow Closure Gating

The `close_escrow` instruction checks on-chain that `pending_count == 0`. This ensures no pending settlements exist before the escrow can be closed normally. The facilitator must finalize all pending settlements before co-signing escrow closure.

## Transaction Batching

Multiple authorizations can be batched into a single transaction:

```rust
// Single transaction with multiple submit_authorization instructions
let tx = Transaction::new_with_payer(
    &[
        submit_authorization(mint_1, recipient_1, amount_1, nonce_1, sig_1),
        submit_authorization(mint_2, recipient_2, amount_2, nonce_2, sig_2),
        submit_authorization(mint_1, recipient_3, amount_3, nonce_3, sig_3),
    ],
    Some(&facilitator.pubkey()),
);
```

**Note**: Nonces must be strictly increasing within the batch (nonce_1 < nonce_2 < nonce_3). Clients must ensure atomic nonce generation to avoid gaps or conflicts when signing multiple authorizations concurrently.

Similarly, multiple `finalize` instructions can be batched to settle many pending payments at once.

### Batching Limits (Implementation Guidance)

The following are practical considerations for implementers, not protocol-level constraints. Facilitators determine their own batching strategies.

| Constraint | Limit | Practical Batch Size |
|------------|-------|---------------------|
| Transaction size | 1,232 bytes | ~8-10 submit_authorizations |
| With Address Lookup Tables | ~256 accounts | ~30+ submit_authorizations |
| Compute units | 1,400,000 max | ~50 operations |

Transaction size is typically the binding constraint for `submit_authorization` since each creates a new PDA. `finalize` operations are more compact since they close PDAs.

## Integration with x402

### Scheme Identifier

```
@faremeter/flex
```

### Payment Requirements

TBD

### Payment Payload

TBD

## Rent Considerations

| Account | Estimated Size | Rent-Exempt Minimum |
|---------|----------------|---------------------|
| Escrow Account | ~150 bytes | ~0.002 SOL |
| Token Account | 165 bytes | ~0.002 SOL |
| Session Key | ~120 bytes | ~0.001 SOL |
| Pending Settlement | ~200 bytes | ~0.002 SOL |

Closing accounts returns rent to:
- Escrow Account, Token Accounts, Session Key: Owner
- Pending Settlement: Submitter (facilitator)

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | SessionKeyExpired | Session key has expired |
| 6001 | SessionKeyRevoked | Session key revoked and grace period elapsed |
| 6002 | InvalidNonce | Nonce not strictly greater than last nonce |
| 6003 | InvalidSignature | Ed25519 signature verification failed |
| 6004 | InsufficientBalance | Token account balance insufficient |
| 6005 | DeadmanNotExpired | Cannot emergency close before timeout |
| 6006 | UnauthorizedFacilitator | Signer is not the registered facilitator |
| 6007 | SessionKeyGracePeriodActive | Cannot close session key during grace period |
| 6008 | PendingSettlementsExist | Cannot close escrow with pending settlements |
| 6009 | RefundWindowNotExpired | Cannot finalize before refund timeout |
| 6010 | RefundWindowExpired | Cannot refund after refund timeout |
| 6011 | RefundExceedsAmount | Cannot refund more than pending amount |
| 6012 | PendingCountMismatch | Remaining accounts count does not match pending_count |

## Implementation Notes

### Timing

All timing in this implementation uses slot-based measurement via Solana's `Clock` sysvar. Fields like `created_at_slot`, `expires_at_slot`, `submitted_at_slot`, `last_activity_slot`, and timeout durations are measured in slots rather than Unix timestamps. This provides more predictable behavior relative to on-chain state transitions.

### Insufficient Balance Handling

The behavior when `InsufficientBalance` (error 6004) occurs during `submit_authorization` is TBD. Key questions to resolve:

- Should the authorization be rejected entirely, or should a partial amount be accepted?
- How should clients be notified of balance issues?

For now, the implementation rejects authorizations when the token account has insufficient balance.

### Account Versioning

Future changes to account structures should follow Anchor's standard account versioning patterns. This typically involves adding a version discriminator field and migration instructions when account layouts change.

### Multi-Facilitator Support

The current implementation uses a single facilitator per escrow account. A future enhancement could support multiple facilitators with per-facilitator allowances. This would require:

- Changing `facilitator: Pubkey` to `facilitators: Vec<(Pubkey, u64)>` (facilitator, allowance)
- Tracking per-facilitator usage
- Modifying authorization validation to check against facilitator-specific limits

### On-Chain Settlement Record

The SPL token transfer history provides a complete on-chain record of all finalized settlements. Clients and facilitators can reconstruct per-recipient totals by querying the token account's transaction history.

## Future Extensions

### Planned

- **Per-facilitator allowances**: Limit how much each facilitator can settle

### Under Consideration

- **Cross-program invocation hooks**: Allow middleware to verify settlements via CPI
- **Compressed state**: Use state compression for high-volume session key tracking
- **Partial withdrawals**: Allow withdrawing a portion of funds without closing the escrow entirely
