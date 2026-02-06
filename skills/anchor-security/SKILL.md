---
name: anchor-security
description: Security patterns from sealevel-attacks repository and Anchor best practices. Always load this skill when writing or reviewing Anchor programs to prevent common vulnerabilities.
---

# Anchor Security

Security patterns and anti-patterns for building secure Anchor programs. This skill covers all 11 common security exploits from the sealevel-attacks repository and recommended fixes.

**CRITICAL:** Always load this skill when writing or reviewing Anchor code. Security is not optional.

## Quick Reference - Security Checklist

Use this checklist for every instruction:

- [ ] **Signer checks:** All authorities use `Signer<'info>` type
- [ ] **Account relationships:** Use `has_one` for field equality checks
- [ ] **Owner validation:** Use `Account<'info, T>` for automatic owner checks
- [ ] **Type safety:** Use typed accounts with `#[account]` discriminator
- [ ] **Initialization:** Use `init` constraint, not manual initialization
- [ ] **CPI targets:** Use `Program<'info, T>` to validate program addresses
- [ ] **Duplicate accounts:** Add constraints to prevent same account passed twice
- [ ] **PDA bumps:** Use canonical bumps (empty `bump` or stored bump)
- [ ] **PDA validation:** Verify PDA relationships with `has_one` or constraints
- [ ] **Account closure:** Use `close` constraint, zero data, check for revival
- [ ] **Sysvar addresses:** Use `Sysvar<'info, T>` or validate addresses

## Security Pattern 1: Signer Authorization

**Attack:** Missing signature verification allows unauthorized account modifications.

**Source:** [Sealevel Attacks - Signer Authorization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/0-signer-authorization)

### The Vulnerability

```rust
// INSECURE - No signature check
#[derive(Accounts)]
pub struct LogMessage<'info> {
    authority: AccountInfo<'info>,  // Anyone can pass any account
}

pub fn log_message(ctx: Context<LogMessage>) -> ProgramResult {
    msg!("GM {}", ctx.accounts.authority.key().to_string());
    Ok(())
}
```

**Problem:** Any caller can pass any account as `authority`. No verification that the account actually signed.

### The Fix: Use Signer Type

```rust
// SECURE - Signature verified
#[derive(Accounts)]
pub struct LogMessage<'info> {
    authority: Signer<'info>,  // Must have signed the transaction
}

pub fn log_message(ctx: Context<LogMessage>) -> ProgramResult {
    msg!("GM {}", ctx.accounts.authority.key().to_string());
    Ok(())
}
```

**Why it works:** `Signer<'info>` automatically checks that `is_signer` flag is true.

### Alternative: signer Constraint

```rust
#[account(signer)]
pub authority: AccountInfo<'info>,
```

**But prefer `Signer<'info>` type** for clarity and intent.

### Critical Use Cases

Always verify signatures when:
- Transferring funds
- Modifying account data
- Closing accounts
- Granting permissions
- Any state change requiring authorization

## Security Pattern 2: Account Data Matching

**Attack:** Not validating relationships between accounts allows unauthorized access.

**Source:** [Sealevel Attacks - Account Data Matching](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/1-account-data-matching)

### The Vulnerability

```rust
// INSECURE - No relationship verification
#[derive(Accounts)]
pub struct LogMessage<'info> {
    token: Account<'info, TokenAccount>,
    authority: Signer<'info>,  // Could be anyone
}

pub fn log_message(ctx: Context<LogMessage>) -> ProgramResult {
    msg!("Your account balance is: {}", ctx.accounts.token.amount);
    Ok(())
}
```

**Problem:** Anyone can pass any token account and claim to be its authority.

### The Fix: Verify Relationships

**Option 1: Use has_one constraint (recommended)**

```rust
// SECURE - Relationship verified
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct LogMessage<'info> {
    #[account(has_one = authority)]
    token: Account<'info, TokenAccount>,
    authority: Signer<'info>,
}
```

**How it works:** Anchor checks `token.authority == authority.key()` automatically.

**Option 2: Use custom constraint**

```rust
#[account(constraint = authority.key == &token.owner)]
token: Account<'info, TokenAccount>,
authority: Signer<'info>,
```

### Critical Use Cases

Always validate relationships when:
- Checking account ownership
- Verifying token account authority
- Validating vault ownership
- Confirming metadata linkage
- Any operation requiring account relationship

**Pattern for escrow:** Verify facilitator relationship

```rust
#[account(
    has_one = facilitator,
    seeds = [b"escrow", owner.key().as_ref()],
    bump = escrow.bump
)]
pub escrow: Account<'info, EscrowAccount>,
pub facilitator: Signer<'info>,
```

## Security Pattern 3: Owner Checks

**Attack:** Accepting accounts owned by wrong program leads to type confusion and exploits.

**Source:** [Sealevel Attacks - Owner Checks](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/2-owner-checks)

### The Vulnerability

```rust
// INSECURE - No owner validation
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct LogMessage<'info> {
    token: AccountInfo<'info>,  // Could be owned by any program
    authority: Signer<'info>,
}

pub fn log_message(ctx: Context<LogMessage>) -> ProgramResult {
    // Trying to deserialize as TokenAccount without checking owner
    let token_data = TokenAccount::try_deserialize(
        &mut &ctx.accounts.token.data.borrow()[..]
    )?;
    msg!("Balance: {}", token_data.amount);
    Ok(())
}
```

**Problem:** Account could be owned by malicious program with fake data layout.

### The Fix: Use Account Type

```rust
// SECURE - Owner automatically verified
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct LogMessage<'info> {
    #[account(constraint = authority.key == &token.owner)]
    token: Account<'info, TokenAccount>,  // Validates owner is Token Program
    authority: Signer<'info>,
}

pub fn log_message(ctx: Context<LogMessage>) -> ProgramResult {
    msg!("Your account balance is: {}", ctx.accounts.token.amount);
    Ok(())
}
```

**Why it works:** `Account<'info, TokenAccount>` automatically checks that account is owned by SPL Token program.

### How Account Type Validates Ownership

When using `Account<'info, T>`:

1. Checks account owner matches program that defined `T`
2. Verifies discriminator matches `T` type
3. Deserializes data into `T` struct

For SPL Token accounts, Anchor validates owner is `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.

### Critical Use Cases

Always use typed accounts for:
- SPL token accounts (`TokenAccount`, `Mint`)
- Program-owned accounts
- Associated token accounts
- Metadata accounts
- Any account storing structured data

## Security Pattern 4: Type Cosplay

**Attack:** Passing wrong account type with similar data layout to fool deserialization.

**Source:** [Sealevel Attacks - Type Cosplay](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/3-type-cosplay)

### The Vulnerability

```rust
// INSECURE - Two account types with same initial fields
#[account]
pub struct User {
    authority: Pubkey,  // First field
}

#[account]
pub struct Metadata {
    account: Pubkey,  // First field (same layout!)
}

#[derive(Accounts)]
pub struct UpdateUser<'info> {
    #[account(has_one = authority)]
    user: Account<'info, User>,  // Could receive Metadata account instead
    authority: Signer<'info>,
}
```

**Problem:** If `Metadata.account` happens to equal `authority.key()`, the check passes even though it's the wrong account type.

### The Fix: Discriminator Checks

```rust
// SECURE - Discriminator prevents type confusion
#[account]
pub struct User {
    authority: Pubkey,
}

#[account]
pub struct Metadata {
    account: Pubkey,
}
```

**Why it works:** The `#[account]` macro adds an 8-byte discriminator:
- User discriminator: `hash("account:User")`
- Metadata discriminator: `hash("account:Metadata")`

When using `Account<'info, User>`, Anchor:
1. Reads first 8 bytes
2. Compares to User discriminator
3. Rejects if mismatch

**Even with identical data layouts, discriminator differs.**

### How Discriminators are Calculated

```rust
// Discriminator = first 8 bytes of SHA256("account:<StructName>")
User discriminator:     hash("account:User")[..8]
Metadata discriminator: hash("account:Metadata")[..8]
```

### Critical Use Cases

Discriminators protect against:
- Malicious account substitution
- Accidental type confusion
- Cross-account type attacks
- Data structure confusion

**Always use `#[account]` macro** for program-owned account types.

## Security Pattern 5: Account Initialization

**Attack:** Re-initializing existing accounts overwrites data or bypasses security checks.

**Source:** [Sealevel Attacks - Initialization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/4-initialization)

### The Vulnerability

```rust
// INSECURE - Manual initialization without checking if already initialized
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    user: Account<'info, User>,
    authority: Signer<'info>,
    system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
    // No check if already initialized
    ctx.accounts.user.authority = authority;
    Ok(())
}
```

**Problem:** Can be called multiple times, potentially changing authority or corrupting state.

### The Fix: Use init Constraint

```rust
// SECURE - init prevents re-initialization
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 32)]
    user: Account<'info, User>,
    #[account(mut)]
    authority: Signer<'info>,
    system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    ctx.accounts.user.authority = ctx.accounts.authority.key();
    Ok(())
}

#[account]
pub struct User {
    authority: Pubkey,
}
```

**Why it works:** The `init` constraint:
1. Checks account doesn't exist (lamports == 0 or data is empty)
2. Creates account via system program CPI
3. Sets discriminator
4. Can only succeed once per account

### Alternative: Manual Check with Discriminator

If not using `init`, check discriminator manually:

```rust
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    // Check if already initialized by verifying discriminator
    let discriminator = User::discriminator();
    let account_discriminator = &ctx.accounts.user.to_account_info().data.borrow()[..8];
    
    require!(
        account_discriminator != discriminator,
        ErrorCode::AlreadyInitialized
    );
    
    // Now safe to initialize
    ctx.accounts.user.authority = ctx.accounts.authority.key();
    Ok(())
}
```

**But prefer `init` constraint** for safety and convenience.

### Critical Use Cases

Use `init` for:
- Account creation
- First-time setup
- Escrow account creation
- Session key registration
- Any account that should only be initialized once

## Security Pattern 6: Arbitrary CPI

**Attack:** Making CPIs to unverified programs allows malicious program execution.

**Source:** [Sealevel Attacks - Arbitrary CPI](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/5-arbitrary-cpi)

### The Vulnerability

```rust
// INSECURE - No validation of token program
use anchor_spl::token;

#[derive(Accounts)]
pub struct Cpi<'info> {
    source: Account<'info, TokenAccount>,
    destination: Account<'info, TokenAccount>,
    authority: Signer<'info>,
    token_program: AccountInfo<'info>,  // Could be any program!
}

pub fn cpi(ctx: Context<Cpi>, amount: u64) -> ProgramResult {
    token::transfer(
        ctx.accounts.transfer_ctx(),
        amount
    )
}
```

**Problem:** Attacker can pass malicious program as `token_program`, bypassing real token checks.

### The Fix: Use Program Type

```rust
// SECURE - Program address validated
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Cpi<'info> {
    source: Account<'info, TokenAccount>,
    destination: Account<'info, TokenAccount>,
    authority: Signer<'info>,
    token_program: Program<'info, Token>,  // Validates address
}

impl<'info> Cpi<'info> {
    pub fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let program = self.token_program.to_account_info();
        let accounts = Transfer {
            from: self.source.to_account_info(),
            to: self.destination.to_account_info(),
            authority: self.authority.to_account_info(),
        };
        CpiContext::new(program, accounts)
    }
}

pub fn cpi(ctx: Context<Cpi>, amount: u64) -> ProgramResult {
    token::transfer(ctx.accounts.transfer_ctx(), amount)
}
```

**Why it works:** `Program<'info, Token>` checks that account address matches expected Token program ID.

### Anchor's CPI Helpers Also Validate

When using Anchor's generated CPI functions (with `cpi` feature):

```rust
token::transfer(cpi_ctx, amount)?;
```

The function automatically validates program ID matches expected address.

### Critical Use Cases

Always validate program addresses for:
- Token transfers
- Associated token account creation
- System program calls
- Any cross-program invocation
- Metadata program operations

**For escrow:** Validate token program when transferring to merchants

```rust
pub token_program: Program<'info, Token>,
```

## Security Pattern 7: Duplicate Mutable Accounts

**Attack:** Passing same account multiple times as mutable causes unexpected state changes.

**Source:** [Sealevel Attacks - Duplicate Mutable Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/6-duplicate-mutable-accounts)

### The Vulnerability

```rust
// INSECURE - No uniqueness check
#[derive(Accounts)]
pub struct Update<'info> {
    #[account(mut)]
    user_a: Account<'info, User>,
    #[account(mut)]
    user_b: Account<'info, User>,
}

pub fn update(ctx: Context<Update>, a: u64, b: u64) -> ProgramResult {
    ctx.accounts.user_a.data = a;
    ctx.accounts.user_b.data = b;  // If same account, b overwrites a
    Ok(())
}
```

**Problem:** If `user_a` and `user_b` are the same account, only the last write (`b`) persists.

### The Fix: Add Uniqueness Constraint

```rust
// SECURE - Duplicate check enforced
#[derive(Accounts)]
pub struct Update<'info> {
    #[account(
        mut,
        constraint = user_a.key() != user_b.key()
    )]
    user_a: Account<'info, User>,
    #[account(mut)]
    user_b: Account<'info, User>,
}

pub fn update(ctx: Context<Update>, a: u64, b: u64) -> ProgramResult {
    ctx.accounts.user_a.data = a;
    ctx.accounts.user_b.data = b;
    Ok(())
}
```

**Why it works:** Constraint explicitly checks accounts are different before instruction executes.

### Alternative: Use require! in Handler

```rust
pub fn update(ctx: Context<Update>, a: u64, b: u64) -> ProgramResult {
    require_keys_neq!(
        ctx.accounts.user_a.key(),
        ctx.accounts.user_b.key(),
        ErrorCode::DuplicateAccounts
    );
    
    ctx.accounts.user_a.data = a;
    ctx.accounts.user_b.data = b;
    Ok(())
}
```

### When Duplicates are Intentional

Some cases allow duplicates (e.g., readonly accounts). Use the `dup` constraint:

```rust
#[account(mut, dup)]
pub account: Account<'info, Data>,
```

**Note:** `dup` only applies to mutable accounts. Readonly accounts naturally allow duplicates.

### Critical Use Cases

Check for duplicates when:
- Multiple accounts of same type
- Transfer between accounts
- Batch operations on accounts
- Any case where same account twice would cause issues

## Security Pattern 8: Bump Seed Canonicalization

**Attack:** Using non-canonical bumps creates multiple PDAs from same seeds.

**Source:** [Sealevel Attacks - Bump Seed Canonicalization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/7-bump-seed-canonicalization)

### The Issue

PDAs can be derived with different bumps, but only one (canonical) bump should be used consistently.

### The Recommended Pattern

**On initialization (find canonical bump):**

```rust
#[derive(Accounts)]
#[instruction(key: u64)]
pub struct InitializePDA<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Data::INIT_SPACE,
        seeds = [key.to_le_bytes().as_ref()],
        bump  // Anchor finds canonical bump
    )]
    pub data: Account<'info, Data>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<InitializePDA>, key: u64) -> Result<()> {
    ctx.accounts.data.value = 0;
    ctx.accounts.data.bump = ctx.bumps.data;  // Store canonical bump
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Data {
    pub value: u64,
    pub bump: u8,
}
```

**On subsequent use (use stored bump):**

```rust
#[derive(Accounts)]
#[instruction(key: u64)]
pub struct UpdatePDA<'info> {
    #[account(
        mut,
        seeds = [key.to_le_bytes().as_ref()],
        bump = data.bump  // Use stored canonical bump
    )]
    pub data: Account<'info, Data>,
}

pub fn set_value(ctx: Context<UpdatePDA>, key: u64, new_value: u64) -> Result<()> {
    ctx.accounts.data.value = new_value;
    Ok(())
}
```

### Why This Matters

**Security:** Ensures consistent PDA derivation  
**Efficiency:** Stored bump avoids recomputing canonical bump  
**Consistency:** One address per seed combination

### Note from Anchor Book

> When using a PDA, it's usually recommend to store the bump seed in the account data, so that you can use it as demonstrated in 2), which will provide a more efficient check.

**Already covered in anchor-pdas skill** - this is reinforcement of security importance.

## Security Pattern 9: PDA Sharing

**Attack:** Using PDAs without proper validation allows unauthorized access to shared resources.

**Source:** [Sealevel Attacks - PDA Sharing](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/8-pda-sharing)

### The Vulnerability

```rust
// INSECURE - Pool PDA not validated
#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    #[account(mut)]
    vault: Account<'info, TokenAccount>,
    #[account(mut)]
    withdraw_destination: Account<'info, TokenAccount>,
    authority: Signer<'info>,
}
```

**Problem:** No verification that vault belongs to the right pool or that withdraw_destination is authorized.

### The Fix: Validate PDA Relationships

```rust
// SECURE - Relationships validated
use anchor_spl::token::{self, Token, TokenAccount};

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    #[account(
        has_one = vault,
        has_one = withdraw_destination,
        seeds = [withdraw_destination.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, TokenPool>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub withdraw_destination: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> WithdrawTokens<'info> {
    pub fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, token::Transfer<'info>> {
        let program = self.token_program.to_account_info();
        let accounts = token::Transfer {
            from: self.vault.to_account_info(),
            to: self.withdraw_destination.to_account_info(),
            authority: self.authority.to_account_info(),
        };
        CpiContext::new(program, accounts)
    }
}

pub fn withdraw_tokens(ctx: Context<WithdrawTokens>) -> Result<()> {
    let amount = ctx.accounts.vault.amount;
    let seeds = &[
        ctx.accounts.pool.withdraw_destination.as_ref(),
        &[ctx.accounts.pool.bump],
    ];
    token::transfer(ctx.accounts.transfer_ctx().with_signer(&[seeds]), amount)
}

#[account]
pub struct TokenPool {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub withdraw_destination: Pubkey,
    pub bump: u8,
}
```

**Why it works:**
- `has_one = vault` checks `pool.vault == vault.key()`
- `has_one = withdraw_destination` checks `pool.withdraw_destination == withdraw_destination.key()`
- `seeds` constraint validates PDA derivation

### Critical Use Cases for Escrow

**Validate all PDA relationships:**

```rust
#[account(
    has_one = escrow,
    has_one = session_key,
    seeds = [b"pending", escrow.key().as_ref(), &nonce.to_le_bytes()],
    bump = pending.bump
)]
pub pending: Account<'info, PendingSettlement>,
```

**Validates:**
1. Pending settlement belongs to correct escrow
2. Uses correct session key
3. Derived with correct seeds

## Security Pattern 10: Closing Accounts

**Attack:** Improperly closed accounts can be revived with different data.

**Source:** [Sealevel Attacks - Closing Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/9-closing-accounts)

### The Vulnerability

Multiple attack vectors exist with improper account closure:

1. **Not zeroing data** - Account can be revived with old data
2. **Not returning rent** - Rent is lost
3. **Revival attacks** - Account recreated in same transaction

### The Secure Pattern: Use close Constraint

```rust
// SECURE - Proper account closure
#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut, close = destination)]
    account: Account<'info, Data>,
    #[account(mut)]
    destination: AccountInfo<'info>,
}

pub fn close(ctx: Context<Close>) -> Result<()> {
    Ok(())
}

#[account]
pub struct Data {
    data: u64,
}
```

**What `close` does:**
1. Transfers all lamports to `destination`
2. Zeroes all account data
3. Sets account owner to system program

**Prevents:**
- Account revival attacks
- Data leakage after closure
- Rent not being returned

### Manual Closure (if needed)

If manually closing (avoid if possible):

```rust
pub fn close_manually(ctx: Context<CloseManual>) -> Result<()> {
    let dest_starting_lamports = ctx.accounts.destination.lamports();
    
    // Transfer lamports
    **ctx.accounts.destination.lamports.borrow_mut() = dest_starting_lamports
        .checked_add(ctx.accounts.account.to_account_info().lamports())
        .unwrap();
    **ctx.accounts.account.to_account_info().lamports.borrow_mut() = 0;
    
    // Zero data
    let mut data = ctx.accounts.account.to_account_info().data.borrow_mut();
    for byte in data.deref_mut().iter_mut() {
        *byte = 0;
    }
    
    Ok(())
}
```

**But always prefer `close` constraint.**

### Critical Use Cases for Escrow

When closing escrow account:

```rust
#[account(
    mut,
    close = owner,
    constraint = escrow.pending_count == 0 @ ErrorCode::PendingSettlementsExist
)]
pub escrow: Account<'info, EscrowAccount>,
```

**Ensures:**
- No pending settlements remain
- Rent returned to owner
- Account properly closed

## Security Pattern 11: Sysvar Address Checking

**Attack:** Passing fake sysvar accounts with manipulated data.

**Source:** [Sealevel Attacks - Sysvar Address Checking](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/10-sysvar-address-checking)

### The Vulnerability

```rust
// INSECURE - No validation of sysvar address
#[derive(Accounts)]
pub struct CheckSysvar<'info> {
    rent: AccountInfo<'info>,  // Could be any account!
}
```

**Problem:** Attacker passes account with fake rent data.

### The Fix: Use Sysvar Type

```rust
// SECURE - Sysvar type validates address
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CheckSysvar<'info> {
    rent: Sysvar<'info, Rent>,  // Validates address
}

pub fn check_sysvar_address(ctx: Context<CheckSysvar>) -> Result<()> {
    msg!("Rent Key -> {}", ctx.accounts.rent.key().to_string());
    Ok(())
}
```

**Why it works:** `Sysvar<'info, Rent>` checks that account address equals `sysvar::rent::ID`.

### Alternative: Manual Address Check

```rust
#[account(address = sysvar::clock::ID)]
pub clock: AccountInfo<'info>,
```

### Common Sysvars

```rust
use anchor_lang::solana_program::sysvar;

// Clock (for time/slot)
Sysvar<'info, Clock>
// or
#[account(address = sysvar::clock::ID)]

// Rent (for rent calculations)
Sysvar<'info, Rent>
// or
#[account(address = sysvar::rent::ID)]
```

### Critical Use Cases

Validate sysvar addresses when using:
- Clock (for time-based logic)
- Rent (for rent calculations)
- Slot hashes
- Recent blockhashes
- Any sysvar data

**For escrow time-based validation:**

```rust
let clock = Clock::get()?;
require!(
    clock.slot >= pending.submitted_at_slot + escrow.refund_timeout_slots,
    ErrorCode::RefundWindowNotExpired
);
```

Clock is accessed via syscall, not account, so validation not needed. But if passing as account:

```rust
pub clock: Sysvar<'info, Clock>,
```

## Escrow-Specific Security Patterns

Beyond the 11 core patterns, additional security considerations for escrow programs:

### Dual Authorization Validation

```rust
#[derive(Accounts)]
pub struct SubmitAuthorization<'info> {
    #[account(
        mut,
        has_one = facilitator,  // Validates facilitator relationship
        seeds = [b"escrow", owner.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub facilitator: Signer<'info>,  // Facilitator must sign
    // Session key signature verified in handler via Ed25519 program
}
```

### Nonce Monotonicity

```rust
pub fn submit_authorization(
    ctx: Context<SubmitAuthorization>,
    nonce: u64,
    // ... other params
) -> Result<()> {
    require!(
        nonce > ctx.accounts.escrow.last_nonce,
        ErrorCode::InvalidNonce
    );
    
    ctx.accounts.escrow.last_nonce = nonce;
    // ...
}
```

### Session Key Expiration Validation

```rust
let clock = Clock::get()?;

// Check not expired
if let Some(expires_at) = ctx.accounts.session_key.expires_at_slot {
    require!(
        clock.slot < expires_at,
        ErrorCode::SessionKeyExpired
    );
}

// Check not revoked (or within grace period)
if let Some(revoked_at) = ctx.accounts.session_key.revoked_at_slot {
    require!(
        clock.slot < revoked_at + ctx.accounts.session_key.revocation_grace_period_slots,
        ErrorCode::SessionKeyRevoked
    );
}
```

### Pending Settlement Count Tracking

```rust
// On submit
ctx.accounts.escrow.pending_count += 1;

// On finalize
ctx.accounts.escrow.pending_count -= 1;

// On close - ensure no pending settlements
require!(
    escrow.pending_count == 0,
    ErrorCode::PendingSettlementsExist
);
```

### Refund Window Enforcement

```rust
let clock = Clock::get()?;

// For refund - must be within window
require!(
    clock.slot < pending.submitted_at_slot + escrow.refund_timeout_slots,
    ErrorCode::RefundWindowExpired
);

// For finalize - must be after window
require!(
    clock.slot >= pending.submitted_at_slot + escrow.refund_timeout_slots,
    ErrorCode::RefundWindowNotExpired
);
```

### Deadman Switch Validation

```rust
let clock = Clock::get()?;

require!(
    clock.slot > escrow.last_activity_slot + escrow.deadman_timeout_slots,
    ErrorCode::DeadmanNotExpired
);
```

## Security Review Checklist

Use this comprehensive checklist when reviewing Anchor programs:

### Account Validation
- [ ] All authorities use `Signer<'info>` type
- [ ] Account relationships verified with `has_one` or `constraint`
- [ ] Account owners validated (use `Account<'info, T>` for program accounts)
- [ ] Account types protected with discriminators (use `#[account]` macro)
- [ ] All accounts have appropriate type (not just `AccountInfo`)

### PDA Security
- [ ] PDAs use canonical bumps (empty `bump` on init, stored bump on use)
- [ ] PDA seeds properly validated with `seeds` constraint
- [ ] PDA relationships verified with `has_one`
- [ ] PDA bumps stored in account data for efficiency
- [ ] Cross-program PDAs use `seeds::program` if needed

### Initialization and Lifecycle
- [ ] Accounts initialized with `init` constraint
- [ ] No manual initialization without discriminator check
- [ ] Account closure uses `close` constraint
- [ ] Closed accounts have data zeroed
- [ ] Rent returned to proper destination
- [ ] Revival attacks prevented

### CPI Security
- [ ] CPI target programs validated with `Program<'info, T>`
- [ ] No arbitrary CPIs to unverified programs
- [ ] CPI signers properly configured with seeds
- [ ] Privilege extension understood and intentional

### Input Validation
- [ ] No duplicate mutable accounts (unless intentional with `dup`)
- [ ] Numeric bounds checked (amounts, indices, etc.)
- [ ] Nonces monotonically increasing
- [ ] Time-based constraints enforced (slots, timeouts)
- [ ] String/Vec lengths bounded

### Sysvar Usage
- [ ] Sysvar accounts use `Sysvar<'info, T>` type
- [ ] Sysvar addresses validated with `address` constraint
- [ ] Clock used correctly for time-based logic

### Error Handling
- [ ] All errors have descriptive messages
- [ ] Custom error codes start at 6000
- [ ] Constraints use custom errors where appropriate
- [ ] Critical conditions checked with `require!`

### State Management
- [ ] Counter fields updated atomically
- [ ] State transitions validated
- [ ] Account relationships maintained
- [ ] No data races possible

## Skill Loading Guidance

### ALWAYS Load With
- **anchor-core** - Core patterns prerequisite
- **This skill should ALWAYS be loaded** - Security is not optional

### Load Before Writing
- Any Anchor program code
- Any Anchor program review
- Any security-critical operation

### Related Skills
- **anchor-core** - For constraint syntax and account types
- **anchor-pdas** - For PDA security (canonical bumps, validation)
- **anchor-cpis** - For CPI security (program validation)
- **anchor-token-operations** - For token account security (owner checks)

## Reference Links

### Official Documentation
- [Anchor Security Documentation](https://www.anchor-lang.com/docs/references/security-exploits)
- [Solana Security Best Practices](https://docs.solana.com/developing/programming-model/security)

### Source Material
- [Sealevel Attacks Repository](https://github.com/coral-xyz/sealevel-attacks) - Complete security examples
  - [0-Signer Authorization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/0-signer-authorization)
  - [1-Account Data Matching](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/1-account-data-matching)
  - [2-Owner Checks](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/2-owner-checks)
  - [3-Type Cosplay](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/3-type-cosplay)
  - [4-Initialization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/4-initialization)
  - [5-Arbitrary CPI](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/5-arbitrary-cpi)
  - [6-Duplicate Mutable Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/6-duplicate-mutable-accounts)
  - [7-Bump Seed Canonicalization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/7-bump-seed-canonicalization)
  - [8-PDA Sharing](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/8-pda-sharing)
  - [9-Closing Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/9-closing-accounts)
  - [10-Sysvar Address Checking](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/10-sysvar-address-checking)

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the anchor-security skill and will apply all security patterns to prevent common vulnerabilities."
