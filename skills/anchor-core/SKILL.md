---
name: anchor-core
description: Core Anchor programming patterns including program structure, account types, constraints, space calculation, and error handling. Always load this skill when writing or reviewing any Anchor program code.
---

# Anchor Core

Core Anchor programming patterns for building secure Solana programs. This skill covers program structure, account types, constraints, space calculation, and error handling.

## Quick Reference

### Minimal Program Template

```rust
use anchor_lang::prelude::*;

declare_id!("YourProgramIDHere");

#[program]
mod your_program {
    use super::*;
    
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 8)]
    pub my_account: Account<'info, MyAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct MyAccount {
    pub data: u64,
}
```

### Common Account Types

| Type | Purpose | Example |
|------|---------|---------|
| `Account<'info, T>` | Owned program account | `Account<'info, EscrowAccount>` |
| `Signer<'info>` | Signature verification | `pub authority: Signer<'info>` |
| `Program<'info, T>` | Program validation | `Program<'info, System>` |
| `SystemProgram` | System program reference | `pub system_program: Program<'info, System>` |
| `UncheckedAccount<'info>` | No automatic checks | Requires `/// CHECK:` comment |

### Most-Used Constraints

| Constraint | Purpose | Example |
|------------|---------|---------|
| `mut` | Account is mutable | `#[account(mut)]` |
| `signer` | Account must sign | `#[account(signer)]` (use `Signer` type instead) |
| `init` | Initialize new account | `#[account(init, payer = user, space = 8 + 32)]` |
| `has_one` | Validate relationship | `#[account(has_one = authority)]` |
| `constraint` | Custom validation | `#[account(constraint = amount > 0)]` |
| `seeds`, `bump` | PDA validation | `#[account(seeds = [b"escrow"], bump)]` |
| `close` | Close account | `#[account(mut, close = destination)]` |

### Error Handling Quick Pattern

```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
}

// Use in handler:
require!(amount > 0, ErrorCode::InvalidAmount);
```

## Program Structure

### The Three Components

Every Anchor program has three essential parts:

1. **`declare_id!`** - Stores your program's on-chain address
2. **`#[program]`** - Contains your business logic (handler functions)
3. **`#[derive(Accounts)]`** - Validates incoming accounts

**Source:** [Anchor Book - High-level Overview](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/high-level_overview.md)

### Program ID Declaration

```rust
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
```

The `declare_id!` macro creates an `ID` field that stores your program's address. Anchor uses this for:
- Security checks (verifying account ownership)
- Allowing other programs to reference your program
- PDA derivation

### Program Module

```rust
#[program]
mod hello_anchor {
    use super::*;
    
    pub fn set_data(ctx: Context<SetData>, data: u64) -> Result<()> {
        ctx.accounts.my_account.data = data;
        Ok(())
    }
}
```

**Handler Function Signature:**
- First argument: `ctx: Context<T>` where `T` is your Accounts struct
- Additional arguments: Instruction data (automatically deserialized)
- Return type: `Result<()>` or `Result<T>` for return values

**Source:** [Anchor Book - The Program Module](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/the_program_module.md)

### Context Access

Through the `ctx` argument you can access:

```rust
ctx.accounts           // The validated accounts struct
ctx.program_id         // Your program's ID
ctx.remaining_accounts // Accounts not in the struct (for variable account counts)
ctx.bumps              // PDA bumps (when using seeds + bump)
```

### Instruction Data

Add arguments after `ctx` for instruction data:

```rust
pub fn transfer(ctx: Context<Transfer>, amount: u64, memo: String) -> Result<()> {
    // Anchor automatically deserializes amount and memo
    Ok(())
}
```

For custom types, derive `AnchorSerialize` and `AnchorDeserialize`:

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TransferData {
    pub amount: u64,
    pub memo: String,
}

pub fn transfer(ctx: Context<Transfer>, data: TransferData) -> Result<()> {
    // Use data.amount and data.memo
    Ok(())
}
```

**Note:** The `#[account]` macro automatically implements these traits, so you can use account structs directly as instruction data.

## Account Types Reference

**Source:** [Anchor Accounts Documentation](https://docs.rs/anchor-lang/latest/anchor_lang/accounts/)  
**Source:** [Anchor Book - The Accounts Struct](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/the_accounts_struct.md)

### Account<'info, T>

The most common account type. Validates that an account is owned by your program and deserializes its data.

```rust
#[derive(Accounts)]
pub struct SetData<'info> {
    #[account(mut)]
    pub my_account: Account<'info, MyAccount>,
}

#[account]
pub struct MyAccount {
    pub data: u64,
    pub authority: Pubkey,
}
```

**Account<'info, T> automatically checks:**
- Account is owned by the program declared in the crate where `T` is defined
- Account discriminator matches `T` (prevents type cosplay attacks)
- Account data deserializes correctly to `T`

**When to use:** Any account owned by your program that stores structured data.

### Signer<'info>

Validates that an account signed the transaction.

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
}
```

**Automatically checks:**
- Account's `is_signer` flag is true

**When to use:** Any account that must provide a signature (user authority, payer, etc.).

**Note:** Using `Signer<'info>` is preferred over `#[account(signer)]` constraint for clarity.

### Program<'info, T>

Validates that an account is a specific program.

```rust
use anchor_spl::token::Token;

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    pub token_program: Program<'info, Token>,
}
```

**Automatically checks:**
- Account address matches the expected program ID

**When to use:** Validating programs before making CPIs (prevents arbitrary CPI attacks).

### SystemProgram

Type alias for `Program<'info, System>`.

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    pub system_program: Program<'info, System>,
}
```

**When to use:** When you need to make CPIs to the system program (create accounts, transfer SOL).

### UncheckedAccount<'info>

No automatic validation. Requires documentation explaining why checks aren't needed.

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// CHECK: This account is only used as a signing PDA
    pub authority: UncheckedAccount<'info>,
}
```

**Checks:** None (you must validate manually if needed)

**When to use:**
- PDA signers (accounts that will sign via CPI)
- Accounts where you only need the address
- Accounts you'll validate manually

**IMPORTANT:** Must include `/// CHECK:` doc comment explaining why no checks are needed, or compilation will fail.

### AccountInfo<'info>

Raw Solana account. Similar to `UncheckedAccount` but provides direct access to account fields.

```rust
#[derive(Accounts)]
pub struct RawAccess<'info> {
    /// CHECK: Manual validation in handler
    pub raw_account: AccountInfo<'info>,
}
```

**When to use:** Advanced cases requiring direct account manipulation.

**IMPORTANT:** Also requires `/// CHECK:` documentation.

### Using Non-Anchor Program Accounts

Anchor provides wrapper types for common programs (SPL Token, Associated Token, etc.):

```rust
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct CheckBalance<'info> {
    #[account(constraint = token_account.amount > 0)]
    pub token_account: Account<'info, TokenAccount>,
}
```

The `TokenAccount` type is a wrapper that:
- Validates the account is owned by the Token program
- Deserializes the account data
- Provides typed access to fields (amount, mint, owner, etc.)

## Constraints Catalog

**Complete Reference:** [Anchor Account Constraints](https://www.anchor-lang.com/docs/references/account-constraints)

Constraints validate accounts before your handler runs. Apply them with `#[account(...)]`:

```rust
#[account(<constraint1>, <constraint2>, ...)]
pub account_name: AccountType
```

### Account Validation Constraints

#### `mut` - Account is Mutable

```rust
#[account(mut)]
pub my_account: Account<'info, MyAccount>,
```

Checks that `is_writable` is true. Required for any account that will be modified.

#### `signer` - Account Must Sign

```rust
#[account(signer)]
pub authority: AccountInfo<'info>,
```

Checks that `is_signer` is true.

**Note:** Using `Signer<'info>` type is preferred over this constraint.

#### `owner = <expr>` - Validate Owner

```rust
#[account(owner = token_program.key())]
pub token_account: AccountInfo<'info>,
```

Checks that `account.owner == <expr>`.

**Note:** `Account<'info, T>` automatically validates owner, so this is mainly for `AccountInfo` or `UncheckedAccount`.

#### `address = <expr>` - Exact Address Check

```rust
#[account(address = expected_address)]
pub special_account: AccountInfo<'info>,
```

Checks that `account.key() == <expr>`.

Common uses:
- Validating sysvar addresses
- Hardcoded authority addresses
- Program-specific constants

#### `executable` - Account is a Program

```rust
#[account(executable)]
pub program: AccountInfo<'info>,
```

Checks that `executable` flag is true.

### Relationship Validation Constraints

#### `has_one = <target>` - Validate Account Relationship

```rust
#[account(has_one = authority)]
pub my_account: Account<'info, MyAccount>,
pub authority: Signer<'info>,
```

Checks that `my_account.authority == authority.key()`.

This is equivalent to:
```rust
#[account(constraint = my_account.authority == authority.key())]
```

**Critical for security:** Prevents unauthorized access by validating account relationships.

**Example from sealevel-attacks:**
```rust
#[derive(Accounts)]
pub struct UpdateUser<'info> {
    #[account(has_one = authority)]
    user: Account<'info, User>,
    authority: Signer<'info>,
}
```

**Source:** [Sealevel Attacks - Account Data Matching](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/1-account-data-matching)

#### `constraint = <expr>` - Custom Validation

```rust
#[account(
    constraint = amount > 0,
    constraint = amount <= max_amount
)]
pub transfer: Account<'info, Transfer>,
```

Arbitrary boolean expressions. All must evaluate to true.

**With custom error:**
```rust
#[account(
    constraint = amount > 0 @ ErrorCode::InvalidAmount
)]
```

**Common patterns:**
- Numeric validations: `amount > 0`, `balance >= amount`
- Key comparisons: `account_a.key() != account_b.key()`
- State checks: `escrow.status == Status::Active`

### Lifecycle Constraints

#### `init` - Initialize New Account

```rust
#[account(
    init,
    payer = user,
    space = 8 + 32 + 8
)]
pub new_account: Account<'info, MyAccount>,
#[account(mut)]
pub user: Signer<'info>,
pub system_program: Program<'info, System>,
```

**Required with init:**
- `payer = <account>` - Who pays for account creation
- `space = <bytes>` - Account size (must include 8-byte discriminator)

**Automatically:**
- Creates account via CPI to system program
- Sets account owner to your program
- Writes discriminator
- Initializes account data

**Security:** Prevents reinitialization attacks (account can only be init once).

#### `init_if_needed` - Conditional Initialization

```rust
#[account(
    init_if_needed,
    payer = user,
    space = 8 + 32
)]
pub maybe_account: Account<'info, MyAccount>,
```

Initializes only if account doesn't exist. If it exists, validates like normal.

**Requires:** `init-if-needed` feature in Cargo.toml

**Use with caution:** Can have unexpected behavior if account data is important.

#### `close = <target>` - Close Account

```rust
#[account(mut, close = destination)]
pub account_to_close: Account<'info, MyAccount>,
#[account(mut)]
pub destination: AccountInfo<'info>,
```

**At end of instruction:**
- Transfers all lamports from account to destination
- Zeroes account data
- Resets account owner to system program

**Security:** Prevents account revival attacks. Rent is returned to destination.

**Source:** [Sealevel Attacks - Closing Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/9-closing-accounts)

#### `realloc` - Resize Account

```rust
#[account(
    mut,
    realloc = new_size,
    realloc::payer = payer,
    realloc::zero = false
)]
pub my_account: Account<'info, MyAccount>,
```

Resizes account at beginning of instruction.

**Parameters:**
- `realloc = <size>` - New size in bytes
- `realloc::payer = <account>` - Who pays/receives if size changes
- `realloc::zero = <bool>` - Whether to zero new space

### PDA Constraints

#### `seeds` + `bump` - PDA Derivation and Validation

```rust
#[account(
    seeds = [b"escrow", owner.key().as_ref()],
    bump
)]
pub escrow: Account<'info, EscrowAccount>,
```

**With init (finds canonical bump):**
```rust
#[account(
    init,
    payer = owner,
    space = 8 + EscrowAccount::INIT_SPACE,
    seeds = [b"escrow", owner.key().as_ref()],
    bump
)]
```

Access the bump: `ctx.bumps.escrow`

**With stored bump (more efficient):**
```rust
#[account(
    seeds = [b"escrow", owner.key().as_ref()],
    bump = escrow.bump
)]
pub escrow: Account<'info, EscrowAccount>,
```

**Seeds can be:**
- Byte literals: `b"escrow"`
- Account keys: `owner.key().as_ref()`
- Numbers: `&id.to_le_bytes()`
- Account data: `escrow.nonce.to_le_bytes()`

**See:** `anchor-pdas` skill for comprehensive PDA patterns.

#### `seeds::program = <expr>` - Cross-Program PDA

```rust
#[account(
    seeds = [b"metadata", mint.key().as_ref()],
    bump,
    seeds::program = metadata_program.key()
)]
pub metadata: AccountInfo<'info>,
```

Derives PDA using a different program ID (not current program).

### Token-Specific Constraints

#### `token::mint` and `token::authority` - Token Account Validation

```rust
use anchor_spl::token::TokenAccount;

#[account(
    token::mint = mint,
    token::authority = authority
)]
pub token_account: Account<'info, TokenAccount>,
pub mint: Account<'info, Mint>,
pub authority: Signer<'info>,
```

Validates token account's mint and authority fields.

**See:** `anchor-token-operations` skill for complete token patterns.

### Constraint Custom Errors

Add custom errors to most constraints:

```rust
#[account(
    has_one = authority @ ErrorCode::UnauthorizedAccess,
    constraint = amount > 0 @ ErrorCode::InvalidAmount
)]
```

## Space Calculation

**Source:** [Anchor Space Reference](https://www.anchor-lang.com/docs/references/space)  
**Source:** [Anchor Book - Space Reference](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_references/space.md)

When using `init`, you must specify the account size. **Always add 8 bytes** for the discriminator.

### Type Size Reference

| Type | Bytes | Notes |
|------|-------|-------|
| `bool` | 1 | |
| `u8`, `i8` | 1 | |
| `u16`, `i16` | 2 | |
| `u32`, `i32` | 4 | |
| `u64`, `i64` | 8 | |
| `u128`, `i128` | 16 | |
| `f32` | 4 | Serialization fails for NaN |
| `f64` | 8 | Serialization fails for NaN |
| `Pubkey` | 32 | |
| `[T; N]` | `size(T) * N` | Fixed array |
| `Vec<T>` | `4 + size(T) * count` | Must allocate max size upfront |
| `String` | `4 + byte_length` | Must allocate max size upfront |
| `Option<T>` | `1 + size(T)` | |
| `Enum` | `1 + largest_variant` | |

### Manual Calculation Example

```rust
#[account]
pub struct MyData {
    pub val: u16,              // 2 bytes
    pub state: GameState,      // 1 + 32 = 33 bytes (enum with Pubkey variant)
    pub players: Vec<Pubkey>,  // 4 + (32 * 10) = 324 bytes (max 10 players)
}

impl MyData {
    pub const MAX_SIZE: usize = 2 + 33 + 324;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum GameState {
    Active,                    // No data
    Tie,                       // No data
    Won { winner: Pubkey },    // 32 bytes (largest)
}

#[derive(Accounts)]
pub struct InitializeMyData<'info> {
    #[account(init, payer = signer, space = 8 + MyData::MAX_SIZE)]
    pub acc: Account<'info, MyData>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

### The InitSpace Macro

Anchor can calculate space automatically:

```rust
#[account]
#[derive(InitSpace)]
pub struct MyAccount {
    pub data: u64,
    #[max_len(50)]
    pub name: String,
    #[max_len(10, 5)]
    pub nested: Vec<Vec<u8>>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + MyAccount::INIT_SPACE)]
    pub my_account: Account<'info, MyAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

**Notes:**
- `#[max_len(n)]` for `String` and `Vec` specifies max element count
- For nested collections: `#[max_len(outer_count, inner_count)]`
- `INIT_SPACE` constant is automatically generated
- Still need to add 8 for discriminator in `space` constraint

**Important:** `max_len` is element count, not bytes. For `Vec<u32>` with `#[max_len(10)]`:
- Element count: 10
- Bytes per element: 4
- Total: 4 (length prefix) + (10 * 4) = 44 bytes

## Error Handling

**Source:** [Anchor Book - Errors](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/errors.md)  
**Source:** [Anchor Error Documentation](https://www.anchor-lang.com/docs/features/errors)

### Defining Custom Errors

```rust
#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Session key has expired")]
    SessionKeyExpired,
    #[msg("Nonce must be strictly greater than last nonce")]
    InvalidNonce,
    #[msg("Insufficient balance in escrow account")]
    InsufficientBalance,
}
```

**Automatic:**
- Error codes start at 6000 (custom error offset)
- Each variant gets sequential number (6000, 6001, 6002, ...)
- Message attribute provides user-friendly error text

### Using Errors with `require!`

```rust
pub fn transfer(ctx: Context<Transfer>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    require!(
        ctx.accounts.escrow.balance >= amount,
        ErrorCode::InsufficientBalance
    );
    
    // Proceed with transfer
    Ok(())
}
```

The `require!` macro:
- Checks the condition
- If false, returns the error
- If true, continues execution

### Using Errors with `err!`

```rust
pub fn set_data(ctx: Context<SetData>, data: u64) -> Result<()> {
    if data >= 100 {
        return err!(ErrorCode::DataTooLarge);
    }
    
    ctx.accounts.my_account.data = data;
    Ok(())
}
```

### Require Macro Family

| Macro | Purpose | Example |
|-------|---------|---------|
| `require!` | General condition | `require!(amount > 0, ErrorCode)` |
| `require_eq!` | Equality (non-Pubkey) | `require_eq!(a, b, ErrorCode)` |
| `require_neq!` | Inequality (non-Pubkey) | `require_neq!(a, b, ErrorCode)` |
| `require_keys_eq!` | Pubkey equality | `require_keys_eq!(key1, key2, ErrorCode)` |
| `require_keys_neq!` | Pubkey inequality | `require_keys_neq!(key1, key2, ErrorCode)` |
| `require_gt!` | Greater than | `require_gt!(a, b, ErrorCode)` |
| `require_gte!` | Greater or equal | `require_gte!(balance, amount, ErrorCode)` |

**Important:** Use `require_keys_eq!` for Pubkey comparisons (more efficient than `require_eq!`).

### Error Number Scheme

| Range | Type |
|-------|------|
| >= 100 | Instruction errors |
| >= 1000 | IDL errors |
| >= 2000 | Constraint errors |
| >= 3000 | Account errors |
| >= 4100 | Misc errors |
| >= 6000 | **Custom user errors (your errors)** |

## Safety Checks

**Source:** [Anchor Book - Safety Checks](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/the_accounts_struct.md#safety-checks)

### The CHECK Requirement

`UncheckedAccount` and `AccountInfo` require documentation:

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// CHECK: This account is only used as a signing PDA and does not store data
    pub authority_pda: UncheckedAccount<'info>,
    
    /// CHECK: Validated via constraint below
    #[account(constraint = metadata.owner == metadata_program.key())]
    pub metadata: AccountInfo<'info>,
}
```

**Without `/// CHECK:` comment, compilation fails:**

```
Error: Struct field "authority_pda" is unsafe, but is not documented.
Please add a `/// CHECK:` doc comment explaining why no checks through types are necessary.
```

**Must be a doc comment:**
- `///` (line doc comment) - Valid
- `/** */` (block doc comment) - Valid
- `//` (regular comment) - Invalid (not a doc comment)

### When to Use UncheckedAccount vs AccountInfo

**Use `UncheckedAccount<'info>` when:**
- Account will be a PDA signer in a CPI
- You only need the account address
- Account will be validated via custom constraints
- Account is from a non-Anchor program without a wrapper type

**Use `AccountInfo<'info>` when:**
- You need direct access to account fields (lamports, data, owner)
- Performing manual deserialization
- Advanced account manipulation

**Prefer typed accounts when possible:**
- `Account<'info, T>` - Program-owned accounts
- `Signer<'info>` - Signature verification
- `Program<'info, T>` - Program validation

## Best Practices

### Constraint Organization

Order constraints logically:

```rust
#[account(
    // 1. Lifecycle (init, close, realloc)
    init,
    payer = owner,
    space = 8 + EscrowAccount::INIT_SPACE,
    
    // 2. PDA (seeds, bump)
    seeds = [b"escrow", owner.key().as_ref()],
    bump,
    
    // 3. Validation (mut, has_one, constraint)
    // (not needed here, but would go here)
)]
pub escrow: Account<'info, EscrowAccount>,
```

### Account Struct Organization

Group related accounts and add comments:

```rust
#[derive(Accounts)]
pub struct SubmitAuthorization<'info> {
    // Escrow state accounts
    #[account(
        mut,
        has_one = facilitator,
        seeds = [b"escrow", owner.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,
    
    #[account(
        init,
        payer = facilitator,
        space = 8 + PendingSettlement::INIT_SPACE,
        seeds = [b"pending", escrow.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub pending: Account<'info, PendingSettlement>,
    
    // Signers and authority
    pub facilitator: Signer<'info>,
    
    // Programs
    pub system_program: Program<'info, System>,
}
```

### Handler Function Design

Keep handlers focused and readable:

```rust
pub fn submit_authorization(
    ctx: Context<SubmitAuthorization>,
    mint: Pubkey,
    recipient: Pubkey,
    amount: u64,
    nonce: u64,
    signature: [u8; 64],
) -> Result<()> {
    // 1. Validate inputs
    require!(nonce > ctx.accounts.escrow.last_nonce, ErrorCode::InvalidNonce);
    require!(amount > 0, ErrorCode::InvalidAmount);
    
    // 2. Verify signature
    // (signature verification logic)
    
    // 3. Update state
    let escrow = &mut ctx.accounts.escrow;
    escrow.last_nonce = nonce;
    escrow.pending_count += 1;
    
    let pending = &mut ctx.accounts.pending;
    pending.amount = amount;
    pending.nonce = nonce;
    // ... set other fields
    
    Ok(())
}
```

### When to Use Custom Constraints vs Built-in

**Use built-in constraints:**
- `has_one` for simple field equality
- `mut`, `signer` for standard checks
- `seeds`, `bump` for PDAs

**Use custom constraints when:**
- Comparing multiple fields
- Complex boolean logic
- Calculations or transformations
- Not expressible with built-in constraints

```rust
// Good - use has_one
#[account(has_one = authority)]

// Good - use custom constraint for complex logic
#[account(
    constraint = account.start_time < clock.slot 
        && account.end_time > clock.slot
        @ ErrorCode::OutsideTimeWindow
)]
```

## Skill Loading Guidance

### Always Load With
- **anchor-security** - Security is paramount; always load together

### Commonly Paired With
- **anchor-pdas** - Most programs use PDAs
- **anchor-cpis** - Most programs make cross-program invocations
- **anchor-token-operations** - For token-related programs

### Load This Skill When
- Writing any Anchor program code
- Reviewing Anchor program implementations
- Designing account structures
- Implementing error handling
- Calculating account space

### Related Skills
- **anchor-pdas** - For PDA-specific patterns (seeds, bumps, program signing)
- **anchor-security** - For security constraints and validation patterns
- **anchor-cpis** - For cross-program invocation patterns
- **anchor-token-operations** - For SPL token account patterns
- **anchor-testing** - For testing Anchor programs
- **rust-solana** - For Solana-specific Rust patterns

## Reference Links

### Official Documentation
- [Anchor Documentation](https://www.anchor-lang.com/docs)
- [Anchor Account Constraints](https://www.anchor-lang.com/docs/references/account-constraints)
- [Anchor Account Types](https://www.anchor-lang.com/docs/references/account-types)
- [Anchor Space Reference](https://www.anchor-lang.com/docs/references/space)
- [Anchor Error Handling](https://www.anchor-lang.com/docs/features/errors)
- [Anchor Rust Docs](https://docs.rs/anchor-lang/latest/anchor_lang/)

### Source Material
- [Anchor Book](https://github.com/coral-xyz/anchor-book) - Complete tutorial guide
  - [High-level Overview](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/high-level_overview.md)
  - [The Accounts Struct](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/the_accounts_struct.md)
  - [The Program Module](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/the_program_module.md)
  - [Errors](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/errors.md)
  - [Space Reference](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_references/space.md)

- [Sealevel Attacks](https://github.com/coral-xyz/sealevel-attacks) - Security examples
  - [Account Data Matching](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/1-account-data-matching)
  - [Closing Accounts](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/9-closing-accounts)

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the anchor-core skill and am ready to build secure Solana programs."
