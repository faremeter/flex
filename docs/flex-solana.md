# Flex Payment Scheme: Solana Implementation

This document describes the Solana implementation of the Flex Payment Scheme defined in the [project README](../README.md).

## Overview

The Solana implementation uses a custom Anchor program to manage escrow accounts, session keys, and pending settlements. The program enforces dual authorization between clients and facilitators while enabling off-chain payment authorizations for efficiency.

## Architecture

### Account Hierarchy

```
Escrow Account (per client, indexed)
├── Owner: Client pubkey
├── Facilitator: Single authorized facilitator
├── Token Accounts: One PDA per mint
├── Session Keys: Registered signing keys
└── Pending Settlements: Authorizations awaiting finalization
```

### Program-Derived Addresses

| Account Type       | Seeds                                                                          | Authority            |
| ------------------ | ------------------------------------------------------------------------------ | -------------------- |
| Escrow Account     | `[b"escrow", owner.key().as_ref(), &index.to_le_bytes()]`                      | Owner + Facilitator  |
| Token Account      | `[b"token", escrow.key().as_ref(), mint.key().as_ref()]`                       | Program (PDA signer) |
| Session Key        | `[b"session", escrow.key().as_ref(), session_key.as_ref()]`                    | Owner                |
| Pending Settlement | `[b"pending", escrow.key().as_ref(), authorization_id.to_le_bytes().as_ref()]` | Facilitator          |

### Client Discovery

Because the escrow PDA includes a numeric `index`, clients cannot derive a single canonical address. Instead, clients discover their escrow accounts using `getProgramAccounts` with `memcmp` filters on the serialized account data.

**Byte offsets** (after the 8-byte Anchor discriminator):

| Field       | Type   | Offset | Size |
| ----------- | ------ | ------ | ---- |
| version     | u8     | 8      | 1    |
| owner       | Pubkey | 9      | 32   |
| facilitator | Pubkey | 41     | 32   |
| index       | u64    | 73     | 8    |

Common queries:

- **All escrows for an owner:** `memcmp` at offset 9 with the owner's pubkey (32 bytes).
- **Escrow for a specific owner + facilitator:** Two `memcmp` filters, one at offset 9 (owner) and one at offset 41 (facilitator).
- **Escrow by owner + index:** `memcmp` at offset 9 (owner) and `memcmp` at offset 73 (index as 8-byte little-endian).

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
    /// Account version for future migrations
    pub version: u8,

    /// Client who owns this escrow account
    pub owner: Pubkey,

    /// Authorized facilitator
    pub facilitator: Pubkey,

    /// Numeric index allowing multiple escrows per owner
    pub index: u64,

    /// Number of open pending settlements
    pub pending_count: u64,

    /// Number of active token account PDAs
    pub mint_count: u64,

    /// Refund window duration in slots
    pub refund_timeout_slots: u64,

    /// Deadman switch timeout in slots
    pub deadman_timeout_slots: u64,

    /// Last activity slot (for deadman switch)
    pub last_activity_slot: u64,

    /// Maximum number of session keys allowed (0 = unlimited)
    pub max_session_keys: u8,

    /// Current number of active session keys
    pub session_key_count: u8,

    /// PDA bump seed
    pub bump: u8,
}
```

**Activity Tracking:** The `last_activity_slot` field tracks facilitator activity for the deadman switch. It is updated by `submit_authorization` and `refund` (both require facilitator signature). It is NOT updated by `finalize` (permissionless crank) or `deposit` (anyone can deposit). This ensures the deadman timer reflects genuine facilitator engagement.

**Design Rationale:** The deadman switch protects clients from unresponsive facilitators. The activity tracking is intentionally asymmetric:

| Instruction            | Updates `last_activity_slot` | Rationale                                         |
| ---------------------- | ---------------------------- | ------------------------------------------------- |
| `submit_authorization` | Yes                          | Requires facilitator signature; proves engagement |
| `refund`               | Yes                          | Requires facilitator signature; proves engagement |
| `finalize`             | No                           | Permissionless crank; anyone can call it          |
| `deposit`              | No                           | Anyone can deposit; not facilitator action        |

**Why `finalize` doesn't reset the timer:** A facilitator who only finalizes existing settlements but refuses to process new authorizations is effectively unresponsive to the client. Allowing `finalize` to reset the timer would let a malicious facilitator keep the escrow locked indefinitely by periodically cranking finalizations while ignoring new business.

**Implication:** A facilitator must actively submit new authorizations or refunds to keep the escrow alive. Simply cranking `finalize` is not sufficient.

### Session Key

```rust
pub struct SessionKey {
    /// Account version for future migrations
    pub version: u8,

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

**Out of Scope:** Per-session-key spending limits (e.g., max amount per authorization, cumulative limits) are not included in this design. Clients who need to limit exposure should create separate escrow accounts with limited funding.

**Grace Period Selection:** The `revocation_grace_period_slots` balances facilitator settlement needs with client risk exposure. Suggested ranges:

- **Minimum:** 100 slots (~40 seconds) - allows facilitator to submit in-flight authorizations
- **Typical:** 200-300 slots (~80-120 seconds) - reasonable buffer for network congestion
- **Maximum recommended:** 500 slots (~3 minutes) - longer periods increase compromise exposure

A facilitator could intentionally delay settlement until just before grace period expiration. Clients should factor this into their risk assessment.

**Facilitator SLA Recommendations:** Facilitators should document their settlement SLAs to help clients choose appropriate grace periods:

| SLA Metric                          | Recommended Target    | Rationale                         |
| ----------------------------------- | --------------------- | --------------------------------- |
| Authorization-to-submission latency | < 30 seconds (p99)    | Allows 100-slot grace period      |
| Submission retry window             | < 60 seconds          | Handles transient network issues  |
| Maximum in-flight authorizations    | Documented per escrow | Bounds exposure during revocation |

Clients should set `revocation_grace_period_slots` to at least 2x the facilitator's documented submission latency to account for network variability.

### Split Entry

A split entry describes one recipient in a split payment. Authorizations use a vector of split entries to distribute funds to multiple recipients at finalize time.

```rust
pub struct SplitEntry {
    /// Recipient token account (must match settlement mint)
    pub recipient: Pubkey,

    /// Basis points allocated to this recipient (1-10000)
    pub bps: u16,
}
```

**Constant:** `MAX_SPLITS = 5` (covers platform fee + merchant + referral + royalties; keeps finalize batch-friendly)

**Invariants:**

- `splits.len() >= 1 && splits.len() <= MAX_SPLITS`
- `sum(splits[*].bps) == 10000`
- `splits[*].bps > 0` for each entry
- All recipients are unique (no duplicate pubkeys)

A single-recipient payment is expressed as `splits: [{recipient, 10000}]` (one entry at 100%).

Facilitator fees are also expressed as split entries. The facilitator and merchant agree on a fee off-chain, and the merchant includes the facilitator's token account in their declared split policy. For example, a 5% facilitator fee would appear as a 500 bps entry alongside the merchant's 9500 bps entry.

### Pending Settlement

```rust
pub struct PendingSettlement {
    /// Account version for future migrations
    pub version: u8,

    /// Parent escrow account
    pub escrow: Pubkey,

    /// Token mint for this settlement
    pub mint: Pubkey,

    /// Current amount (can be reduced by refunds)
    pub amount: u64,

    /// Original amount when submitted (settle_amount, not max_amount)
    pub original_amount: u64,

    /// Maximum amount authorized by the client (for audit trail)
    pub max_amount: u64,

    /// Unique authorization identifier (random u64)
    pub authorization_id: u64,

    /// Slot at which this authorization expires
    pub expires_at_slot: u64,

    /// Slot when submitted
    pub submitted_at_slot: u64,

    /// Session key that signed this authorization
    pub session_key: Pubkey,

    /// Number of valid entries in splits (1-5)
    pub split_count: u8,

    /// Fixed-size split array; first split_count entries are valid
    pub splits: [SplitEntry; 5],

    /// PDA bump seed
    pub bump: u8,
}
```

**Note:** Rent for pending settlement PDAs is returned to the escrow's facilitator on finalize or refund. Since only the registered facilitator can submit authorizations, tracking a separate submitter per settlement is unnecessary.

## Instructions

### Account Management

#### `create_escrow`

Creates a new escrow account.

```rust
pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    index: u64,
    facilitator: Pubkey,
    refund_timeout_slots: u64,
    deadman_timeout_slots: u64,
    max_session_keys: u8,
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

**Signers**: Depositor (anyone with tokens)

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `mint_count`)
- `depositor` (signer, mut) - Party depositing tokens; pays rent if token account is created
- `mint` - SPL token mint
- `token_account` (unchecked, mut, PDA) - Passed as `UncheckedAccount`; created via CPI if empty, validated if existing
- `source` - Depositor's token account (must have sufficient balance)
- `token_program` - SPL Token program
- `system_program` - System program (for account creation)

**Constraints**:

- `escrow.mint_count < 8` when creating a new token account (enforces mint limit)
- `amount > 0`

**Token Account Creation**:
The token account PDA is passed as an `UncheckedAccount` with seed validation. The handler checks `data_is_empty()` on the account to determine whether it needs to be created:

- **If empty** (account does not exist): the handler creates the token account via CPI (`create_account` + `initialize_account3`), with the depositor as payer and the escrow PDA as token authority. `escrow.mint_count` is incremented after validating the mint limit.
- **If not empty** (account exists): the handler deserializes the account as a `TokenAccount` and validates that its mint and authority match the expected values.

This approach avoids `init_if_needed`, which hides whether the account was created or already existed. Without reliable creation detection, `mint_count` could be incorrectly incremented when depositing into a vault that was previously drained to zero by `finalize` -- making the escrow uncloseable.

**Effects**:

1. If token account doesn't exist: create it via CPI, increment `mint_count`
2. Transfer `amount` tokens from `source` to escrow token account PDA
3. Emit `Deposited` event

**Notes**:

- Anyone can deposit to an escrow account (permissionless)
- The depositor pays rent for new token accounts, not the escrow owner
- Maximum 8 different mints per escrow (returns `MintLimitReached` if exceeded)
- Deposits do not update `last_activity_slot` (only facilitator actions do)

**Mint Griefing Consideration:** Since deposits are permissionless, a malicious actor could deposit tiny amounts of unwanted tokens to consume the 8-mint limit. Mitigations:

- The 8-mint limit is generous for typical use cases
- Each deposit requires the attacker to pay rent (~0.002 SOL per mint)
- Clients can create a new escrow if their mint limit is exhausted
- Future versions may add owner-controlled mint whitelisting if this becomes problematic

**Rent Ownership Trade-off:** When a depositor creates a new token account by depositing a mint for the first time, they pay the rent (~0.002 SOL). However, when the escrow is closed, this rent is returned to the escrow owner, not the original depositor. This design choice:

- Simplifies closure logic (all rent goes to one destination)
- Prevents griefing where attackers create token accounts to lock up the owner's SOL
- Means third-party depositors should understand they forfeit the rent
- Is acceptable because rent is minimal and depositors are typically the escrow owner anyway

#### `close_escrow`

Closes the escrow account and returns all funds to the owner.

```rust
pub fn close_escrow(
    ctx: Context<CloseEscrow>,
) -> Result<()>
```

**Signers**: Owner + Facilitator

**Accounts**:

- `escrow` (mut, close) - The escrow account to close
- `owner` (signer) - Must match `escrow.owner`
- `facilitator` (signer) - Must match `escrow.facilitator`
- `system_program` - System program
- `token_program` - SPL Token program
- Remaining accounts: Token account pairs (see below)

**Constraints**:

- `pending_count == 0` (no pending settlements)
- Number of token account pairs in remaining_accounts equals `mint_count * 2`

**Remaining Accounts**: Token accounts are passed as remaining accounts in pairs:

1. Escrow token account PDA (source, will be closed)
2. Owner's destination token account (receives balance)

The instruction validates each pair:

- Source is a valid token account PDA derived from `[b"token", escrow.key(), mint.key()]`
- Source is owned by the SPL Token program
- Source has the escrow PDA as its authority
- Destination is owned by the SPL Token program
- Destination has `escrow.owner` as its authority (token account owner field)
- Both accounts have the same mint

```rust
// Validation pseudo-code for each token account pair:
fn validate_token_pair(
    escrow: &EscrowAccount,
    source: &AccountInfo,
    destination: &AccountInfo,
) -> Result<()> {
    // 1. Verify source is the correct PDA
    let (expected_source, _) = Pubkey::find_program_address(
        &[b"token", escrow.key().as_ref(), source_mint.as_ref()],
        &program_id,
    );
    require_keys_eq!(source.key(), expected_source);

    // 2. Verify source is a token account owned by Token program
    require_keys_eq!(source.owner, &spl_token::ID);

    // 3. Deserialize and verify source authority is escrow PDA
    let source_token = TokenAccount::try_deserialize(&source.data.borrow())?;
    require_keys_eq!(source_token.owner, escrow.key());

    // 4. Verify destination is a token account owned by Token program
    require_keys_eq!(destination.owner, &spl_token::ID);

    // 5. Deserialize and verify destination authority is escrow owner
    let dest_token = TokenAccount::try_deserialize(&destination.data.borrow())?;
    require_keys_eq!(dest_token.owner, escrow.owner);

    // 6. Verify mints match
    require_keys_eq!(source_token.mint, dest_token.mint);

    Ok(())
}
```

**Validation**: The instruction requires exactly `mint_count * 2` remaining accounts. This ensures all token accounts are closed and no funds are stranded. The `mint_count` field is incremented on first deposit for each mint and cannot be decremented (token accounts can only be closed via `close_escrow` or `emergency_close`).

**Mint Uniqueness**: The instruction must validate that each token account pair has a unique mint. Without this check, an attacker could pass the same token account multiple times to satisfy the count requirement while leaving other token accounts unclosed. The implementation should track seen mints:

```rust
// Validate no duplicate mints in token account pairs
let mut seen_mints = std::collections::HashSet::new();
for (source, _destination) in token_account_pairs {
    let source_token = TokenAccount::try_deserialize(&source.data.borrow())?;
    require!(
        seen_mints.insert(source_token.mint),
        ErrorCode::DuplicateAccounts
    );
}
```

**Effects**:

1. For each token account pair: transfer full balance from escrow PDA to destination
2. Close each escrow token account PDA, returning rent to owner
3. Close escrow account PDA, returning rent to owner

**Notes**: The facilitator verifies off-chain that no unsettled authorizations exist before co-signing. The on-chain check ensures no pending settlement PDAs remain.

**Destination Token Account Requirements**: The owner must have existing token accounts for each mint held in the escrow before calling `close_escrow`. These are typically Associated Token Accounts (ATAs). If a destination account doesn't exist, the transaction fails. The owner should:

1. Query the escrow's token account PDAs to determine which mints are held
2. Create ATAs for any mints they don't already have accounts for
3. Call `close_escrow` with the complete set of token account pairs

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

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `session_key_count`)
- `owner` (signer, mut) - Must match `escrow.owner`; pays rent for session key PDA
- `session_key_account` (init, PDA) - New session key account
- `system_program` - System program (for account creation)

**Constraints**:

- `escrow.max_session_keys == 0 || escrow.session_key_count < escrow.max_session_keys` (session key limit not reached)

**Effects**:

1. Create SessionKey PDA
2. Increment `escrow.session_key_count`
3. Emit `SessionKeyRegistered` event

**Notes**: Session key registration is an on-chain transaction. The escrow account does not need to sign arbitrary off-chain messages. This allows smart wallets and multisigs to use the flex scheme.

**Session Key Count Semantics**: The `session_key_count` includes revoked-but-not-closed keys. A revoked key continues to count against the limit until its grace period expires and `close_session_key` is called. This is intentional: keys in grace period can still have authorizations settled, so they remain "active" from the protocol's perspective. If the owner needs to register a new key but has reached the limit with revoked keys in grace period, they must wait for the grace periods to expire and close the old keys first.

---

**SECURITY NOTE: Session Key Authorization Model**

Session keys authorize payments, but clients control all payment parameters in the signed message:

- **`splits`**: Who receives payment and in what proportion (client specifies)
- **`max_amount`**: Maximum amount for this authorization (client specifies)
- **`mint`**: Which token to pay (client specifies)

The facilitator can only submit what the client signed. They cannot modify the splits (recipients or proportions), increase the amount, or change the token. This means each authorization's exposure is limited to what the client explicitly approved.

| Compromised Parties                 | Severity     | Attack Vector                                                    | Funds at Risk                               |
| ----------------------------------- | ------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| Session key + Facilitator collusion | **CRITICAL** | Client signs splits with attacker recipient; facilitator submits | Up to signed `max_amount` per authorization |
| Session key alone                   | LOW          | Attacker can sign authorizations, but cannot submit them         | None without facilitator cooperation        |
| Middleware alone                    | NONE         | Middleware cannot sign; can only pass authorizations             | None                                        |

**Key insight:** A compromised session key alone cannot drain an escrow. The attacker would need to either:

1. Collude with the facilitator to submit fraudulent authorizations, OR
2. Trick an honest facilitator into submitting authorizations to attacker-controlled recipients

An honest facilitator performing proper validation (checking that all split recipients are known merchants) provides defense-in-depth against session key compromise.

**Recommended Client-Side Practices:**

- **Verify recipients**: Confirm all split recipients are known merchants before signing
- **Short-lived keys**: Set `expires_at_slot` to limit exposure window
- **Appropriate funding**: Fund escrow based on expected usage patterns
- **Balance monitoring**: Alert on unexpected pending settlements
- **Secure key storage**: Protect session key material appropriately

**Grace Period Considerations:**

When a session key is revoked, authorizations signed before revocation remain valid during `revocation_grace_period_slots`. This allows the facilitator to settle legitimate in-flight authorizations. Set the grace period based on operational needs (100-300 slots is typical).

---

#### `revoke_session_key`

Revokes a previously registered session key.

```rust
pub fn revoke_session_key(
    ctx: Context<RevokeSessionKey>,
) -> Result<()>
```

**Signers**: Owner

**Accounts**:

- `escrow` - The escrow account (for validation)
- `owner` (signer) - Must match `escrow.owner`
- `session_key` (mut) - The session key PDA to revoke

**Notes**: Revocation sets `revoked_at_slot` to the current slot. Authorizations signed with this key before revocation remain valid for settlement during the grace period (`revocation_grace_period_slots`). After the grace period expires, the session key account can be closed and authorizations signed with it become invalid.

#### `close_session_key`

Closes a session key account and reclaims rent.

```rust
pub fn close_session_key(
    ctx: Context<CloseSessionKey>,
) -> Result<()>
```

**Signers**: Owner

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `session_key_count`)
- `owner` (signer) - Must match `escrow.owner`; receives rent
- `session_key` (mut, close) - The session key PDA to close

**Constraints**: Session key must be revoked and grace period must have elapsed.

**Effects**:

1. Close SessionKey PDA, return rent to owner
2. Decrement `escrow.session_key_count`
3. Emit `SessionKeyClosed` event

### Settlement Flow

#### `submit_authorization`

Submits a client-signed authorization, creating a pending settlement.

```rust
pub fn submit_authorization(
    ctx: Context<SubmitAuthorization>,
    mint: Pubkey,
    max_amount: u64,
    settle_amount: u64,
    authorization_id: u64,
    expires_at_slot: u64,
    splits: Vec<SplitEntry>,
    signature: [u8; 64],
) -> Result<()>
```

**Signers**: Facilitator

**Accounts**:

- `escrow` (mut) - The escrow account
- `facilitator` (signer) - Must match `escrow.facilitator`
- `session_key` - SessionKey PDA for the signing key
- `token_account` - Escrow's token account PDA for the specified mint
- `pending` (init, PDA) - New pending settlement account
- `instructions_sysvar` - Instructions sysvar for Ed25519 introspection
- `system_program` - System program (for PDA creation)

**Parameters**:

- `max_amount`: The maximum amount the client authorized (what was signed)
- `settle_amount`: The actual amount to settle (must be <= `max_amount`)
- `splits`: The split distribution (recipients and basis points, signed by client)

**Validation**:

1. Verify `escrow.pending_count < 16` (pending limit not reached)
2. Verify `clock.slot < expires_at_slot` (authorization not expired)
3. Verify `expires_at_slot <= clock.slot + escrow.refund_timeout_slots` (expiry not too far in the future)
4. Verify Ed25519 signature over `(program_id, escrow, mint, max_amount, authorization_id, expires_at_slot, splits)`
5. Verify `settle_amount > 0` (returns `SettleAmountZero` if not)
6. Verify `settle_amount <= max_amount`
7. Verify `session_key.escrow == escrow.key()` (session key belongs to this escrow)
8. Verify session key is active (not expired, not revoked past grace period)
9. Verify token account has sufficient balance for `settle_amount`
10. Verify `splits.len() >= 1 && splits.len() <= MAX_SPLITS` (returns `InvalidSplitCount` if not)
11. Verify `sum(splits[*].bps) == 10000` (returns `InvalidSplitBps` if not)
12. Verify `splits[*].bps > 0` for each entry (returns `SplitBpsZero` if not)
13. Verify all `splits[*].recipient` are unique (returns `DuplicateSplitRecipient` if not)

Recipient token accounts are NOT validated at submit time. Validation is deferred to finalize to keep submit lean; the facilitator validates recipient accounts off-chain before submission.

**Effects**:

1. Create PendingSettlement PDA with `authorization_id`, `expires_at_slot`, `submitted_at_slot = current_slot`, `amount = settle_amount`, `max_amount = max_amount`, `split_count`, and `splits`
2. Update `escrow.last_activity_slot`
3. Increment `escrow.pending_count`

**Notes**: The separation of `max_amount` and `settle_amount` enables the off-chain hold workflow. The client signs an authorization for up to `max_amount`, and the facilitator settles for the actual amount consumed (`settle_amount`). This allows the middleware to request a hold, perform work, then settle for less than the hold without requiring a new client signature.

**Split Validation**: The `splits` vector is part of the client-signed authorization, preventing facilitators from altering the payment distribution. The client specifies all recipients and their proportions. BPS sum validation prevents tokens from being silently lost (sum < 10000) or over-transferred (sum > 10000). Duplicate recipients are rejected to keep finalize simple (each remaining account maps 1:1 to a split entry).

**Timing considerations:** Between off-chain validation and on-chain finalization, a recipient account's state may change:

| State Change   | When Detected | Impact                                    |
| -------------- | ------------- | ----------------------------------------- |
| Account closed | `finalize`    | Transfer CPI fails; entire finalize fails |
| Account frozen | `finalize`    | Transfer CPI fails; entire finalize fails |

With splits, finalize is all-or-nothing: if ANY recipient token account is frozen, closed, or invalid, the entire finalize fails. The facilitator must issue a full refund before the refund window expires, or the funds remain locked until the client can void via deadman switch.

**Frozen/Invalid Recipient Recovery:** When a `finalize` fails due to a problematic recipient, the facilitator has limited time to respond:

| Scenario                                            | Action Required                | Deadline                                          |
| --------------------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Any recipient frozen/invalid, refund window open    | Issue full refund via `refund` | Before `submitted_at_slot + refund_timeout_slots` |
| Any recipient frozen/invalid, refund window expired | No recovery possible           | Funds locked until deadman switch                 |

Facilitators should monitor `finalize` failures and alert on recipient errors. The recommended `refund_timeout_slots` should account for facilitator response time to recipient incidents (e.g., if facilitator SLA is 1 hour response time, refund timeout should be at least 2 hours of slots).

**Recommendations:**

- Facilitators must validate ALL split recipient accounts off-chain (not just the first) against the merchant's declared policy
- Prefer Associated Token Accounts (ATAs) as recipients since they are deterministic and unlikely to be closed
- Facilitators may want to check freeze authority status for high-value settlements

#### `refund`

Reduces the amount of a pending settlement.

```rust
pub fn refund(
    ctx: Context<Refund>,
    refund_amount: u64,
) -> Result<()>
```

**Signers**: Facilitator

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `pending_count` on full refund, `last_activity_slot`)
- `facilitator` (signer) - Must match `escrow.facilitator`
- `pending` (mut) - The pending settlement to refund (closed on full refund)

**Constraints**:

- `refund_amount <= pending_settlement.amount`
- Refund window has not expired (`current_slot < submitted_at_slot + refund_timeout_slots`)

**Effects**:

1. Reduce `pending_settlement.amount` by `refund_amount`
2. If `amount` becomes zero (full refund):
   - Close the PendingSettlement PDA immediately
   - Return rent to `escrow.facilitator`
   - Decrement `escrow.pending_count`

**Notes**: A full refund closes the pending settlement immediately rather than leaving a zero-amount settlement to be finalized later. This saves a transaction and returns rent to the facilitator promptly.

**Refund and Splits**: Refund reduces `pending.amount`. The split percentages (bps) remain constant. The reduced amount is distributed proportionally at finalize time. For example, if a 100-token settlement with a 70/30 split is partially refunded to 50 tokens, finalize distributes 35 tokens (70%) and 15 tokens (30%).

#### `finalize`

Finalizes a pending settlement after the refund window expires. Distributes funds to all split recipients proportionally.

```rust
pub fn finalize(
    ctx: Context<Finalize>,
) -> Result<()>
```

**Signers**: Anyone (permissionless crank)

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `pending_count`)
- `pending` (mut, close) - The pending settlement to finalize
- `token_account` (mut) - Escrow's token account PDA for the settlement's mint
- `facilitator` (mut) - Receives rent from closed pending settlement PDA
- `token_program` - SPL Token program
- Remaining accounts: `split_count` recipient token accounts (mut)

**Constraints**: `current_slot >= submitted_at_slot + escrow.refund_timeout_slots`

**Remaining Accounts**: The caller must pass exactly `pending.split_count` recipient token accounts as remaining accounts, in the same order as the `splits` array. Each account must be a valid SPL token account with a mint matching the settlement's mint.

**Effects**:

1. Validate `remaining_accounts.len() == pending.split_count`
2. Validate each `remaining_accounts[i].key() == pending.splits[i].recipient` (prevents fund redirection)
3. Validate each recipient is a valid token account with matching mint
4. For each split `i` in `0..split_count`:
   - Compute `transfer_amount = pending.amount * splits[i].bps / 10000`
   - If `i == split_count - 1`: assign remainder (`pending.amount - sum_of_previous_transfers`) to avoid rounding dust
   - Skip if `transfer_amount == 0` (can happen after heavy refunds)
   - Execute SPL token transfer CPI from vault to recipient
5. Close PendingSettlement PDA
6. Return rent to `escrow.facilitator`
7. Decrement `escrow.pending_count`

**All-or-Nothing**: If any recipient token account is frozen, closed, or otherwise invalid, the entire finalize fails. There is no partial distribution. The facilitator must issue a full refund if any recipient becomes unavailable.

**Notes**: The facilitator is incentivized to call finalize to reclaim their rent. Merchants can also call finalize to receive their funds promptly.

#### `void_pending`

Voids a single pending settlement after the deadman switch timeout expires. This is the first phase of emergency recovery.

```rust
pub fn void_pending(
    ctx: Context<VoidPending>,
) -> Result<()>
```

**Signers**: Owner only

**Constraints**: `current_slot - escrow.last_activity_slot > escrow.deadman_timeout_slots`

**Accounts**:

- `escrow` (mut) - The escrow account (for updating `pending_count`)
- `owner` (signer, mut) - Escrow owner; receives rent from closed pending settlement
- `pending` (mut, close) - The pending settlement to void

**Effects**:

1. Close the PendingSettlement PDA, returning rent to `escrow.owner`
2. Decrement `escrow.pending_count`

**Notes**: Call this instruction repeatedly to void all pending settlements before calling `emergency_close`. Each call handles one pending settlement, keeping transactions simple and under size limits. Rent is returned to the owner (not the facilitator) because emergency recovery occurs when the facilitator is unresponsive.

#### `emergency_close`

Closes the escrow account unilaterally after the deadman switch timeout expires. This is the second phase of emergency recovery.

```rust
pub fn emergency_close(
    ctx: Context<EmergencyClose>,
) -> Result<()>
```

**Signers**: Owner only

**Accounts**:

- `escrow` (mut, close) - The escrow account to close
- `owner` (signer, mut) - Escrow owner; receives all rent and token balances
- `token_program` - SPL Token program
- `system_program` - System program
- Remaining accounts: Token account pairs (see below)

**Constraints**:

- `current_slot - escrow.last_activity_slot > escrow.deadman_timeout_slots`
- `escrow.pending_count == 0` (all pending settlements must be voided first)

**Remaining Accounts**:

- All token account pairs as in `close_escrow` (count must equal `escrow.mint_count * 2`)

**Validation**:

- Total remaining accounts must equal `mint_count * 2`
- Token account pairs validated as in `close_escrow`

**Effects**:

1. Transfer all token account balances to owner destination accounts
2. Close all token account PDAs and escrow account PDA, returning rent to owner

**Notes**: This allows clients to recover funds if a facilitator becomes unresponsive. The two-phase approach (void pending, then close) ensures each transaction stays within size limits.

#### `force_close`

Last-resort escape hatch that closes the escrow even if `pending_count` is inconsistent with actual PDA state. This handles edge cases where accounting becomes corrupted.

```rust
pub fn force_close(
    ctx: Context<ForceClose>,
) -> Result<()>
```

**Signers**: Owner only

**Accounts**:

- `escrow` (mut, close) - The escrow account to close
- `owner` (signer, mut) - Escrow owner; receives all rent and token balances
- `token_program` - SPL Token program
- `system_program` - System program
- Remaining accounts: Token account pairs (as in `close_escrow`)

**Constraints**:

- `current_slot - escrow.last_activity_slot > escrow.deadman_timeout_slots * 2` (double the normal deadman timeout)

**Effects**:

1. Transfer all token account balances to owner destination accounts
2. Close all token account PDAs and escrow account PDA, returning rent to owner
3. Does NOT check `pending_count` (this is the key difference from `emergency_close`)

**When to use `force_close`:**

| Scenario                                     | Use                                    |
| -------------------------------------------- | -------------------------------------- |
| Normal unresponsive facilitator              | `void_pending` + `emergency_close`     |
| `pending_count` field corrupted              | `force_close` after 2x deadman timeout |
| Bug causes accounting mismatch               | `force_close` after 2x deadman timeout |
| PendingSettlement PDAs exist but not tracked | `force_close` after 2x deadman timeout |

**Security rationale:** The extended timeout (2x deadman) ensures this is truly a last resort. In normal operation, `void_pending` + `emergency_close` should always work. The `force_close` instruction exists only for catastrophic accounting failures.

**Warning:** Any pending settlement PDAs that exist when `force_close` is called become orphaned. Their rent is not recovered. This is acceptable because:

1. The scenario should be extremely rare
2. Rent is small (~0.002 SOL per PDA)
3. Recovering funds is more important than rent optimization

### Emergency Recovery Workflow

When a facilitator becomes unresponsive and the deadman timeout expires:

1. **Query pending settlements**: Use `getProgramAccounts` to find all pending settlements for the escrow
2. **Void each pending settlement**: Call `void_pending` for each one (can be batched, ~4-5 per transaction)
3. **Close the escrow**: Call `emergency_close` with all token account pairs

This two-phase approach:

- Keeps each transaction under size limits
- Allows progress even with many pending settlements
- Returns all rent to owner (facilitator is unresponsive)

**Protocol Limits**: To keep recovery manageable, the protocol enforces:

- **Maximum pending settlements**: 16 per escrow (enforced at `submit_authorization`)
- **Maximum mints**: 8 per escrow (enforced at `deposit`)
- **Maximum session keys**: Configurable per escrow (enforced at `register_session_key`)
- **Maximum splits**: 5 per authorization (enforced at `submit_authorization`)

| Resource            | Limit                      | Rationale                                                                               |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `pending_count`     | 16                         | Keeps void phase to ~4 transactions max                                                 |
| `mint_count`        | 8                          | 8 mint pairs (16 accounts) fits in single close transaction                             |
| `session_key_count` | Configurable (0=unlimited) | Prevents state bloat; recommended: 8-16                                                 |
| `MAX_SPLITS`        | 5                          | Covers practical use cases (platform + merchant + referral + royalties); batch-friendly |

**Implication**: When `pending_count` reaches 16, `submit_authorization` returns `PendingLimitReached` error. Facilitators must finalize existing settlements before submitting new ones. This creates back-pressure that prevents unbounded accumulation.

## Off-Chain Hold Workflow

The on-chain program does not track holds explicitly. Instead, holds are managed off-chain by the facilitator, with the on-chain settlement supporting partial fulfillment of authorizations.

### Workflow

1. **Hold Request**: The middleware responds to a client request with a hold amount (the estimated or maximum cost).

2. **Client Authorization**: The client signs a `PaymentAuthorization` with `max_amount` set to the hold ceiling (which may exceed the requested hold to reduce round-trips for variable costs). The authorization includes a random `authorization_id` and an `expires_at_slot`.

3. **Hold Validation (off-chain)**: The facilitator:
   - Verifies the Ed25519 signature
   - Checks the escrow's on-chain token balance
   - Records the authorization as an active hold in their database
   - Returns success to the middleware

4. **Service Delivery**: The middleware performs the requested work.

5. **Settlement**: After work completes, the middleware reports the actual amount consumed. The facilitator calls `submit_authorization` with:
   - `max_amount`: The original authorized ceiling (for signature verification)
   - `settle_amount`: The actual amount to settle (≤ `max_amount`)

### Hold Accounting

The facilitator must track active holds to prevent over-authorization:

```
available_balance = on_chain_balance - sum(active_holds) - sum(pending_settlements)
```

When validating a new hold, the facilitator checks that the escrow has sufficient `available_balance` for the requested hold amount.

### Hold Expiration

Holds are ephemeral facilitator state. The facilitator defines hold expiration policies (e.g., holds expire after 5 minutes if not settled). Expired holds are removed from the facilitator's accounting, and the client's signed authorization becomes unusable since the facilitator won't submit it.

**Facilitator Hold Expiration Requirements:** Since holds exist only in facilitator state, clients depend on facilitators properly expiring stale holds. Facilitators should:

| Requirement                       | Recommended Value        | Rationale                                               |
| --------------------------------- | ------------------------ | ------------------------------------------------------- |
| Hold expiration timeout           | 5-15 minutes             | Balances service completion time with fund availability |
| Expired hold cleanup frequency    | Every 60 seconds         | Prevents accounting drift                               |
| Client notification on expiration | Optional but recommended | Allows client to retry or escalate                      |

**Client Recovery:** If a facilitator accepts a hold but becomes unresponsive before settlement or expiration, the client's recourse is:

1. Wait for the facilitator's hold expiration timeout (off-chain)
2. If the facilitator remains unresponsive and the deadman timeout expires, use `emergency_close`

Clients should monitor their escrow's `last_activity_slot` and compare against the facilitator's documented SLAs to detect unresponsive facilitators early.

### Additional Authorization

If the middleware requires more than the initially authorized `max_amount` during service delivery, it requests a new authorization from the client:

1. The middleware sends the additional amount needed to the client
2. The client signs a new `PaymentAuthorization` with a new `authorization_id` and the additional `max_amount`
3. The facilitator validates and records the new hold
4. Service delivery continues

The original authorization remains valid and can still be settled for up to its `max_amount`. The new authorization covers the additional amount. Both settlements are independent and use separate `authorization_id` values.

To minimize round-trips, clients can authorize a higher ceiling than initially requested. For example, if the middleware requests a 100 token hold, the client might authorize 150 tokens to allow for 50% cost overrun without requiring additional authorization.

### Why Off-Chain?

On-chain holds would require:

- Additional account creation (rent costs)
- Two transactions per payment (create hold, then settle)
- Complex state management for hold modifications

The off-chain approach achieves the same user experience with lower costs and simpler on-chain logic. The security model remains intact because:

- The client's signature caps the maximum amount
- PDA uniqueness and expiry prevent replay
- The facilitator can only settle up to what was authorized

## Authorization Message Format

Off-chain authorizations are Ed25519 signatures over a structured message:

```rust
pub struct PaymentAuthorization {
    /// Program ID (prevents cross-chain/cross-program replay)
    pub program_id: Pubkey,

    /// Escrow account pubkey
    pub escrow: Pubkey,

    /// Token mint
    pub mint: Pubkey,

    /// Maximum amount authorized for this payment (in token base units)
    pub max_amount: u64,

    /// Unique authorization identifier (random u64)
    pub authorization_id: u64,

    /// Slot at which this authorization expires
    pub expires_at_slot: u64,

    /// Split distribution (1-5 entries, bps must sum to 10000)
    pub splits: Vec<SplitEntry>,
}
```

The message is serialized using Borsh and signed with the session key's Ed25519 private key. Because `splits` is a variable-length `Vec`, the serialized message includes a 4-byte length prefix followed by the split entries.

**Why `program_id` is included:** Without the program ID in the signed message, an authorization signed for a devnet escrow could theoretically be submitted on mainnet if the same escrow address and session key exist on both chains. Including the program ID binds the authorization to a specific deployment.

**Note**: The client signs `max_amount`, which represents the ceiling for this authorization. The facilitator may settle for any amount up to `max_amount` when submitting the authorization on-chain. This enables the off-chain hold workflow where the client authorizes a maximum before work begins, and the facilitator settles for the actual amount consumed.

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

**Sysvar Access:** The `submit_authorization` instruction accesses the Instructions sysvar via an `UncheckedAccount` with an `address = sysvar::instructions::ID` constraint. The Instructions sysvar does not implement the standard `Sysvar` trait for deserialization; it is accessed via `load_current_index_checked` and `load_instruction_at_checked` functions that take `AccountInfo` directly.

### Introspection Matching Algorithm

When `submit_authorization` executes, it must find and validate the corresponding Ed25519 verification instruction. The algorithm requires strict instruction ordering:

1. **Get current instruction index**: Use `load_current_index_checked` from the Instructions sysvar.

2. **Require immediate precedence**: The Ed25519 verification instruction MUST be at index `current_index - 1`. This eliminates ambiguity in batched transactions.

3. **Validate Ed25519 program**: Check that the preceding instruction's program ID equals `Ed25519Program` (`Ed25519SigVerify111111111111111111111111111`).

4. **Parse verification data**: The Ed25519 program instruction data contains:
   - Number of signatures (u8)
   - For each signature: pubkey offset, signature offset, message offset, message length

5. **Validate message content**: Reconstruct the expected `PaymentAuthorization` message from the `submit_authorization` parameters (program_id, escrow, mint, max_amount, authorization_id, expires_at_slot, splits) and serialize it with Borsh. The message in the Ed25519 instruction must match exactly. Because `splits` is variable-length, the message size varies; the Ed25519 instruction's message length field indicates the actual size.

6. **Validate pubkey**: Confirm the verified pubkey matches the `session_key` account passed to `submit_authorization`.

**Why immediate precedence?** Requiring the Ed25519 instruction at exactly `index - 1` provides several benefits:

- **Simplicity**: No scanning or searching required
- **Unambiguous matching**: Each `submit_authorization` has exactly one possible Ed25519 instruction
- **Prevents reuse**: An Ed25519 instruction cannot be "claimed" by a later `submit_authorization`
- **Easier auditing**: Transaction structure is predictable and verifiable

**Required Transaction Structure**: Each `submit_authorization` must be immediately preceded by its Ed25519 verification:

```
[Ed25519Verify(msg1), SubmitAuth(auth_id1), Ed25519Verify(msg2), SubmitAuth(auth_id2), ...]
```

Any other ordering will fail. For example, these structures are invalid:

```
// INVALID: Ed25519 instructions grouped at start
[Ed25519Verify(msg1), Ed25519Verify(msg2), SubmitAuth(auth_id1), SubmitAuth(auth_id2)]

// INVALID: Other instructions between Ed25519 and submit
[Ed25519Verify(msg1), SomeOtherInstruction, SubmitAuth(auth_id1)]
```

**Failure modes:**

| Condition                                            | Error                       |
| ---------------------------------------------------- | --------------------------- |
| No preceding instruction (index 0)                   | `InvalidEd25519Instruction` |
| Preceding instruction is not Ed25519 program         | `InvalidEd25519Instruction` |
| Ed25519 instruction message doesn't match            | `InvalidSignature`          |
| Ed25519 instruction pubkey doesn't match session key | `InvalidSignature`          |

### Compute Costs

| Operation                                       | Compute Units |
| ----------------------------------------------- | ------------- |
| Ed25519 signature verification (native program) | ~25,000 CU    |
| Instruction introspection + message comparison  | ~5,000 CU     |

## Security Model

### Dual Authorization

All transfers out of the escrow require both:

1. **Client authorization**: Via session key signature (registered on-chain)
2. **Facilitator authorization**: Via transaction signature

Neither party can unilaterally move funds (except via deadman switch after timeout).

### Replay Protection

Replay protection uses two complementary mechanisms:

1. **PDA uniqueness (during pending phase):** Each `PendingSettlement` PDA is derived from `[b"pending", escrow, authorization_id]`. Anchor's `init` constraint ensures that only one pending settlement per `authorization_id` can exist at a time. Attempting to reuse an `authorization_id` that has an active pending settlement fails at PDA creation.

2. **Expiry (after finalization):** Each authorization includes an `expires_at_slot` which is bounded by `clock.slot + escrow.refund_timeout_slots`. Once a pending settlement is finalized and its PDA is closed, the authorization cannot be replayed because `clock.slot >= expires_at_slot` by the time finalization occurs (the refund timeout must elapse before finalization). Any replay attempt fails with `AuthorizationExpired`.

This design enables parallel submission of authorizations since `authorization_id` values are random and independent rather than sequential.

**Anomaly Detection:** Clients should monitor on-chain pending settlements for unexpected activity:

| Condition                             | Severity | Action                                     |
| ------------------------------------- | -------- | ------------------------------------------ |
| Unknown pending settlements           | Critical | Revoke session key immediately             |
| Pending with unknown split recipients | Critical | Revoke session key; investigate compromise |

### Refund Window

Pending settlements cannot be finalized until the refund timeout expires. During this window, the facilitator can reduce or cancel the pending amount. This protects against:

- Charges for undelivered services
- Erroneous or disputed transactions

### Refund Authorization Model

**Important:** Refunds require only the facilitator's signature, not dual authorization. This differs from the payment authorization model intentionally:

| Operation            | Client Signature       | Facilitator Signature         | Rationale                                               |
| -------------------- | ---------------------- | ----------------------------- | ------------------------------------------------------- |
| Submit authorization | Required (session key) | Required (transaction)        | Protects client funds                                   |
| Refund               | Not required           | Required                      | Facilitator is returning funds they would have received |
| Finalize             | Not required           | Not required (permissionless) | Settlement already authorized                           |

**Security implications:**

- A facilitator can unilaterally reduce or cancel any pending settlement
- This is safe because refunds return funds to the escrow (benefiting the client)
- The facilitator has no economic incentive to issue fraudulent refunds
- If a facilitator issues unauthorized refunds, the merchant loses funds, not the client

**Trust model:** Clients trust that facilitators will honor legitimate settlements. Merchants trust that facilitators will not issue unauthorized refunds. This trust is established through off-chain agreements between facilitators and merchants, not enforced on-chain.

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

### Duplicate Account Prevention

Instructions that accept multiple accounts of the same type must validate that they are distinct. Passing the same account multiple times as mutable can cause unexpected state overwrites.

**Instructions requiring duplicate checks:**

| Instruction          | Accounts to Check            | Constraint                                          |
| -------------------- | ---------------------------- | --------------------------------------------------- |
| `close_escrow`       | Token account pairs          | Each source/destination pair must be unique         |
| `emergency_close`    | Pending settlements          | Each pending PDA must be unique                     |
| `finalize`           | Split recipient accounts     | Each recipient in remaining_accounts must be unique |
| `finalize` (batched) | Multiple pending settlements | Each settlement must be unique                      |

**Implementation pattern:**

```rust
// In account validation constraints
#[account(
    mut,
    constraint = account_a.key() != account_b.key() @ ErrorCode::DuplicateAccounts
)]
pub account_a: Account<'info, SomeType>,
#[account(mut)]
pub account_b: Account<'info, SomeType>,
```

For remaining accounts (variable-length arrays), validate uniqueness in the instruction handler:

```rust
// Validate no duplicate accounts in remaining_accounts
let mut seen_keys = std::collections::HashSet::new();
for account in ctx.remaining_accounts.iter() {
    require!(
        seen_keys.insert(account.key()),
        ErrorCode::DuplicateAccounts
    );
}
```

**Note:** PDA derivation with unique seeds (like `authorization_id`) naturally prevents duplicates for pending settlements, but explicit checks provide defense-in-depth.

## Transaction Batching

Multiple authorizations can be batched into a single transaction. Each `submit_authorization` requires a corresponding Ed25519 signature verification instruction preceding it:

```rust
// Single transaction with multiple submit_authorization instructions
// Each submit_authorization introspects its corresponding Ed25519 verification
let tx = Transaction::new_with_payer(
    &[
        // Verification and submission for authorization 1
        ed25519_verify(session_key_1, message_1, sig_1),
        submit_authorization(mint_1, max_1, settle_1, auth_id_1, expiry_1, splits_1, sig_1),
        // Verification and submission for authorization 2
        ed25519_verify(session_key_2, message_2, sig_2),
        submit_authorization(mint_2, max_2, settle_2, auth_id_2, expiry_2, splits_2, sig_2),
        // Verification and submission for authorization 3
        ed25519_verify(session_key_3, message_3, sig_3),
        submit_authorization(mint_1, max_3, settle_3, auth_id_3, expiry_3, splits_3, sig_3),
    ],
    Some(&facilitator.pubkey()),
);
```

Each `submit_authorization` instruction introspects the Instructions sysvar to find and validate its corresponding Ed25519 verification. The program matches verifications to submissions by checking that the verified message data matches the authorization parameters.

**Note**: Each authorization in the batch must have a unique `authorization_id`. Since IDs are random, there is no ordering constraint within a batch.

Similarly, multiple `finalize` instructions can be batched to settle many pending payments at once.

### Batching Limits (Implementation Guidance)

The following are practical considerations for implementers, not protocol-level constraints. Facilitators determine their own batching strategies.

| Constraint                 | Limit         | Practical Batch Size        |
| -------------------------- | ------------- | --------------------------- |
| Transaction size           | 1,232 bytes   | ~8-10 submit_authorizations |
| With Address Lookup Tables | ~256 accounts | ~30+ submit_authorizations  |
| Compute units              | 1,400,000 max | ~50 operations              |

Transaction size is typically the binding constraint for `submit_authorization` since each creates a new PDA. `finalize` operations with splits require additional remaining accounts (one per split recipient), reducing the batch size for multi-recipient settlements.

**Finalize Batching with Splits:**

Each additional SPL token transfer CPI adds ~5,000 CU. The base `finalize` overhead (account deserialization, validation, PDA close) is ~20,000 CU, plus ~5,000 CU per transfer.

| Metric              | Single Recipient | 5-Way Split |
| ------------------- | ---------------- | ----------- |
| finalize CU         | ~25,000          | ~45,000     |
| finalize accounts   | 6                | 10          |
| Finalize batch size | ~8-10            | ~6-7        |

## Integration with x402

### Scheme Identifier

```
@faremeter/flex
```

### Payment Requirements

The flex scheme extends standard x402 payment requirements with escrow-specific fields:

```typescript
type SplitEntry = {
  recipient: string; // token account pubkey (base58)
  bps: number; // basis points (1-10000, must sum to 10000)
};

type FlexPaymentRequirements = {
  // Standard x402 fields
  scheme: "@faremeter/flex";
  network: string; // e.g., "solana:mainnet", "solana:devnet"

  // Flex-specific fields
  facilitator: string; // Facilitator pubkey (base58)
  escrow?: string; // Client's escrow account if known (base58)
  supportedMints: string[]; // Accepted token mints (base58)

  // Hold parameters
  estimatedAmount: string; // Estimated cost (decimal string)
  maxAmount?: string; // Maximum authorized amount (decimal string)
  mint: string; // Preferred mint for this request (base58)

  // Split policy
  splits: SplitEntry[]; // Merchant's declared split distribution
};
```

**Discovery flow:**

1. Client requests resource, receives 402 with `FlexPaymentRequirements`
2. If client has no escrow with this facilitator, create one
3. Client signs authorization for `maxAmount` (or `estimatedAmount` if no max)
4. Client submits authorization in payment header

### Payment Payload

The payment payload contains the signed authorization:

```typescript
type FlexPaymentPayload = {
  scheme: "@faremeter/flex";

  // Escrow identification
  escrow: string; // Escrow account pubkey (base58)

  // Authorization details (matches PaymentAuthorization struct)
  mint: string; // Token mint (base58)
  maxAmount: string; // Maximum amount authorized (decimal string)
  authorizationId: string; // Random authorization ID (decimal string)
  expiresAtSlot: string; // Expiry slot (decimal string)
  splits: SplitEntry[]; // Split distribution (replaces single recipient)

  // Session key signature
  sessionKey: string; // Session key pubkey (base58)
  signature: string; // Ed25519 signature (base64)
};
```

**Validation flow (facilitator):**

1. Verify `escrow` exists and has this facilitator registered
2. Verify `sessionKey` is registered and valid for the escrow
3. Verify `signature` over Borsh-serialized `PaymentAuthorization`
4. Check escrow has sufficient balance (accounting for active holds)
5. Record authorization as active hold
6. Return success to middleware

### Settlement Communication

After service delivery, the middleware reports actual usage to the facilitator:

```typescript
type FlexSettlementRequest = {
  escrow: string; // Escrow account pubkey
  authorizationId: string; // Authorization ID
  settleAmount: string; // Actual amount to settle (<= maxAmount)
};
```

The facilitator batches settlements and submits them on-chain via `submit_authorization`.

## Compute Budget Estimates

Estimated compute units per instruction (excluding transaction overhead):

| Instruction            | Compute Units     | Notes                                         |
| ---------------------- | ----------------- | --------------------------------------------- |
| `create_escrow`        | ~15,000 CU        | PDA derivation + account init                 |
| `deposit`              | ~25,000 CU        | Token transfer CPI; +15,000 if init_if_needed |
| `close_escrow`         | ~20,000 CU base   | +10,000 per token account closed              |
| `register_session_key` | ~12,000 CU        | PDA derivation + account init                 |
| `revoke_session_key`   | ~8,000 CU         | Account update only                           |
| `close_session_key`    | ~10,000 CU        | Account close                                 |
| `submit_authorization` | ~35,000 CU        | Ed25519 introspection + PDA init              |
| `refund`               | ~12,000 CU        | +5,000 if full refund (close)                 |
| `finalize`             | ~25,000-45,000 CU | ~20,000 base + ~5,000 per split recipient     |
| `emergency_close`      | ~30,000 CU base   | +15,000 per pending settlement closed         |

## Rent Considerations

| Account            | Estimated Size | Rent-Exempt Minimum |
| ------------------ | -------------- | ------------------- |
| Escrow Account     | ~170 bytes     | ~0.002 SOL          |
| Token Account      | 165 bytes      | ~0.002 SOL          |
| Session Key        | ~120 bytes     | ~0.001 SOL          |
| Pending Settlement | ~310 bytes     | ~0.003 SOL          |

**Rent payers and recipients:**

| Account            | Rent Payer                   | Rent Returned To (normal) | Rent Returned To (emergency) |
| ------------------ | ---------------------------- | ------------------------- | ---------------------------- |
| Escrow Account     | Owner (at creation)          | Owner                     | Owner                        |
| Token Account      | Depositor (at first deposit) | Owner                     | Owner                        |
| Session Key        | Owner (at registration)      | Owner                     | Owner                        |
| Pending Settlement | Facilitator (at submission)  | Facilitator               | Owner                        |

**Notes:**

- Token account rent is paid by whoever first deposits that mint, not the escrow owner. This prevents griefing where someone creates many token accounts to lock up the owner's SOL.
- During emergency recovery (`void_pending`), pending settlement rent is returned to the owner rather than the facilitator, since the facilitator is unresponsive.

## Error Codes

| Code | Name                        | Description                                                                         |
| ---- | --------------------------- | ----------------------------------------------------------------------------------- |
| 6000 | SessionKeyExpired           | Session key has expired                                                             |
| 6001 | SessionKeyRevoked           | Session key revoked and grace period elapsed                                        |
| 6002 | AuthorizationExpired        | Authorization has expired                                                           |
| 6003 | InvalidSignature            | Ed25519 signature verification failed                                               |
| 6004 | InsufficientBalance         | Token account balance insufficient                                                  |
| 6005 | DeadmanNotExpired           | Cannot emergency close before timeout                                               |
| 6006 | UnauthorizedFacilitator     | Signer is not the registered facilitator                                            |
| 6007 | SessionKeyGracePeriodActive | Cannot close session key during grace period                                        |
| 6008 | PendingSettlementsExist     | Cannot close escrow with pending settlements                                        |
| 6009 | RefundWindowNotExpired      | Cannot finalize before refund timeout                                               |
| 6010 | RefundWindowExpired         | Cannot refund after refund timeout                                                  |
| 6011 | RefundExceedsAmount         | Cannot refund more than pending amount                                              |
| 6012 | PendingCountMismatch        | Remaining accounts count does not match pending_count                               |
| 6013 | PendingLimitReached         | Maximum pending settlements (16) reached                                            |
| 6014 | MintLimitReached            | Maximum mints (8) per escrow reached                                                |
| 6015 | InvalidTokenAccountPair     | Token account pair validation failed                                                |
| 6016 | UnsupportedAccountVersion   | Account version not supported by this program                                       |
| 6017 | DuplicateAccounts           | Same account passed multiple times                                                  |
| 6018 | SessionKeyLimitReached      | Maximum session keys per escrow reached                                             |
| 6019 | InvalidEd25519Instruction   | Ed25519 instruction malformed or missing required data                              |
| 6020 | InvalidSplitRecipient       | Recipient is not a valid token account for the specified mint (checked at finalize) |
| 6021 | ForceCloseTimeoutNotExpired | Cannot force close before extended timeout (2x deadman)                             |
| 6022 | InvalidSplitCount           | splits.len() < 1 or > MAX_SPLITS                                                    |
| 6023 | InvalidSplitBps             | Split bps do not sum to 10000                                                       |
| 6024 | SplitBpsZero                | A split entry has bps == 0                                                          |
| 6025 | DuplicateSplitRecipient     | Same recipient appears more than once in splits                                     |
| 6026 | SessionKeyStillActive       | Session key must be revoked before closing                                          |
| 6027 | SessionKeyCountUnderflow    | Session key count underflow                                                         |
| 6028 | SettleExceedsMax            | Settle amount exceeds max authorized amount                                         |
| 6029 | SettleAmountZero            | Settle amount must be greater than zero                                             |
| 6030 | ExpiryTooFar                | Authorization expiry exceeds refund timeout                                         |

## Event Emission

The program emits events via Anchor's `emit!` macro for indexer consumption. Events are logged as base64-encoded data in the transaction logs.

### Events

```rust
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
    /// True if closed via emergency_close, false if normal close
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
    pub authorization_id: u64,
    pub expires_at_slot: u64,
    pub mint: Pubkey,
    pub splits: Vec<SplitEntry>,
    pub max_amount: u64,
    pub settle_amount: u64,
    pub session_key: Pubkey,
}

#[event]
pub struct Refunded {
    pub escrow: Pubkey,
    pub authorization_id: u64,
    pub refund_amount: u64,
    pub remaining_amount: u64,
}

#[event]
pub struct Finalized {
    pub escrow: Pubkey,
    pub authorization_id: u64,
    pub mint: Pubkey,
    pub splits: Vec<SplitEntry>,
    pub total_amount: u64,
}
```

### Indexing Strategy

Indexers should:

1. Subscribe to program logs via `logsSubscribe` or poll `getSignaturesForAddress`
2. Parse Anchor event discriminators (first 8 bytes of SHA256 of event name)
3. Deserialize event data using Borsh
4. Maintain derived state: escrow balances, pending settlements, session key status

The combination of events and on-chain account state provides complete audit trails. Events capture the "what happened" while account queries provide current state.

## Implementation Notes

### Rate Limiting

The protocol enforces an on-chain limit for session key registrations via `max_session_keys`. Other rate limits are facilitator policy:

- **Session key registrations**: On-chain limit via `escrow.max_session_keys` (set at creation, 0=unlimited)
- **Authorization submissions**: Facilitators should limit submissions per escrow per time window to prevent spam
- **Hold requests**: Facilitators should limit concurrent active holds per escrow

Authorization and hold limits are facilitator policy decisions, not protocol constraints. Different facilitators may have different policies based on their trust model and use case.

### Timing

All timing in this implementation uses slot-based measurement via Solana's `Clock` sysvar. Fields like `created_at_slot`, `expires_at_slot`, `submitted_at_slot`, `last_activity_slot`, and timeout durations are measured in slots rather than Unix timestamps. This provides more predictable behavior relative to on-chain state transitions.

### Insufficient Balance Handling

When `InsufficientBalance` (error 6004) occurs during `submit_authorization`, the authorization is rejected entirely. No partial settlement occurs.

**Rationale:** The facilitator's off-chain hold accounting (see [Hold Accounting](#hold-accounting)) should ensure sufficient balance before settlement. If this error occurs, it indicates a bug in hold tracking or a race condition from concurrent submissions.

**Recovery:** The authorization remains unused (no pending settlement created). The client can sign a new authorization for a smaller amount, or the escrow can be topped up.

### Concurrent Submission Handling

Facilitators submitting multiple authorizations for the same escrow must handle concurrency carefully due to the pending count constraint.

**Single-Facilitator Constraint:** Each escrow has exactly one registered facilitator. This eliminates cross-facilitator race conditions entirely. Only that facilitator can submit authorizations, so all concurrency issues are internal to a single facilitator's systems. This simplifies the concurrency model significantly compared to multi-facilitator designs.

**Race Conditions:**

| Scenario                                          | Risk                                              | Mitigation                                                |
| ------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| Duplicate `authorization_id`                      | One fails at PDA init (account already exists)    | Use random u64 IDs (collision probability negligible)     |
| Pending limit reached mid-batch                   | Later submissions fail with `PendingLimitReached` | Check `pending_count` before batching                     |
| Balance changes between validation and submission | Fails with `InsufficientBalance`                  | Re-validate in same transaction or use conservative holds |

**Recommended Patterns:**

1. **Parallel submission**: Since `authorization_id` values are random, multiple authorizations for the same escrow can be submitted concurrently in separate transactions
2. **Batch size awareness**: Check `16 - pending_count` before building batch; submit only that many
3. **Individual failure handling**: On failure, release only the failed hold (not all holds for the escrow)

**Transaction Ordering:**

Since `authorization_id` values are random rather than sequential, there is no ordering constraint between transactions targeting the same escrow. Multiple transactions can be submitted concurrently without risk of ordering-related failures. The only constraint is the global `pending_count` limit of 16.

### Token-2022 Considerations

The initial implementation targets SPL Token (Token Program). Token-2022 support requires additional considerations:

| Extension              | Impact                           | Handling                                             |
| ---------------------- | -------------------------------- | ---------------------------------------------------- |
| Transfer fees          | Settlement amount reduced by fee | Facilitator must account for fees in settle_amount   |
| Transfer hooks         | Additional CPI during transfer   | Increased compute budget required (~50,000 CU extra) |
| Confidential transfers | Encrypted balances               | Not supported in initial implementation              |
| Non-transferable       | Tokens cannot be moved           | Reject at deposit time                               |
| Permanent delegate     | Third party can transfer         | Security risk; reject at deposit time                |

**Recommended approach:**

1. Initial release: SPL Token only (validate `token_program == TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
2. Future release: Add Token-2022 support with extension validation
3. Reject mints with dangerous extensions (permanent delegate, non-transferable)

**Compute budget for Token-2022:**

- Base transfer: ~25,000 CU
- With transfer hook: ~75,000 CU
- Facilitators should request higher compute budget when settling Token-2022 tokens

### Account Versioning

All account structures include a `version: u8` field (currently set to `1`) to facilitate future migrations. The Anchor discriminator identifies account _type_; the version field identifies _schema version_ within a type.

| Scenario               | Approach                                              |
| ---------------------- | ----------------------------------------------------- |
| Additive fields only   | Append new fields; old accounts work with defaults    |
| Breaking layout change | Deploy new program version with migration instruction |
| Emergency deprecation  | Reject old versions with clear error message          |

For breaking changes with pending settlements, drain all pending settlements (finalize or void) before migration to avoid time-sensitive constraint issues.

### On-Chain Settlement Record

The SPL token transfer history provides a complete on-chain record of all finalized settlements. Clients and facilitators can reconstruct per-recipient totals by querying the token account's transaction history.

## Known Limitations

This section documents accepted trade-offs and areas for future improvement. Each entry includes the rationale for accepting the limitation and conditions under which it should be revisited.

### Balance check does not account for existing pending settlements

`programs/flex/src/instructions/submit_authorization.rs`

The `submit_authorization` instruction checks `token_account.amount >= settle_amount` but does not subtract amounts already committed in other pending settlements. This is a floor check (the vault is not literally empty for this amount), not a committed-balance sufficiency check. A facilitator that submits authorizations totaling more than the vault balance will see later finalizations fail with an SPL token transfer error.

**Why this is accepted:** The facilitator is already deeply trusted -- it can unilaterally refund any pending settlement to zero. Over-commitment is a strictly less powerful attack than what the facilitator can already do with refunds. Adding on-chain committed tracking would require three instructions (`submit_authorization`, `finalize`, `refund`) to maintain a shared per-mint counter. This coupling is a classic source of accounting bugs in Solana programs: if the counter drifts, escrows become permanently stuck or silently leaky.

**Mitigation:** The facilitator SDK tracks available balance off-chain (`vault_balance - sum(pending_settlements) - sum(active_holds)`). Facilitators should monitor for drift between their accounting and on-chain state.

**Revisit when:** The trust model changes to support multiple facilitators per escrow or untrusted facilitators. At that point, on-chain committed-amount tracking (per-mint field on the escrow account, ~320 bytes additional state) becomes necessary.

### No minimum validation on timeout parameters

`programs/flex/src/instructions/create_escrow.rs`

`refund_timeout_slots` and `deadman_timeout_slots` accept zero with no on-chain minimum. A zero deadman timeout allows the owner to emergency-close immediately after a facilitator submits authorizations. A zero refund timeout allows immediate finalization with no refund window.

**Why this is accepted:** These are client-chosen parameters and the client bears the risk of dangerous values. The facilitator is expected to refuse to work with obviously misconfigured escrows.

**Mitigation:** Facilitators should validate timeout parameters before accepting an escrow. The SDK should warn or reject escrows with zero timeouts.

**Revisit when:** There is evidence of clients accidentally creating zero-timeout escrows in production.

### No Token-2022 support

The program uses `anchor_spl::token::Token` exclusively. Token-2022 accounts with transfer hooks, transfer fees, confidential transfers, or other extensions will not work. See [Token-2022 Considerations](#token-2022-considerations) for details on extension-specific impacts and a recommended phased approach.

### Account version field is unused

All accounts set `version = 1` but no instruction checks the version field. The `UnsupportedAccountVersion` error is defined but never referenced. Adding version checks before a second version exists would be dead code.

**Revisit when:** A state migration is needed. At that point, add version checks and a migration instruction.

### Manual account closure in refund does not zero discriminator

`programs/flex/src/instructions/refund.rs`

When a full refund closes the pending settlement account, it zeroes lamports, reassigns to the system program, and resizes to zero -- but does not write `CLOSED_ACCOUNT_DISCRIMINATOR` like Anchor's `close` constraint does. This is a defense-in-depth gap against revival attacks within the same transaction. The practical risk is minimal since the account is resized to zero and reassigned to the system program. The `finalize` path uses Anchor's `close` constraint properly.

**Revisit when:** An auditor flags this or if the refund instruction is modified to participate in larger composite transactions.

## Future Extensions

- **Cross-program invocation hooks**: Allow middleware to verify settlements via CPI
- **Compressed state**: Use state compression for high-volume session key tracking
- **Partial withdrawals**: Allow withdrawing a portion of funds without closing the escrow entirely
