---
name: anchor-token-operations
description: SPL Token and Token-2022 patterns for managing token accounts, transfers, and associated token accounts. Load when working with SPL tokens in Anchor programs.
---

# Anchor Token Operations

Patterns for working with SPL tokens in Anchor programs, including token account validation, transfers, mints, and associated token accounts.

## Quick Reference

### Token Account Validation

```rust
use anchor_spl::token::TokenAccount;

#[account(
    token::mint = mint,
    token::authority = authority
)]
pub token_account: Account<'info, TokenAccount>,
```

### Mint Validation

```rust
use anchor_spl::token::Mint;

#[account(
    mint::authority = authority,
    mint::decimals = 6
)]
pub mint: Account<'info, Mint>,
```

### Associated Token Account

```rust
#[account(
    init_if_needed,
    payer = payer,
    associated_token::mint = mint,
    associated_token::authority = authority
)]
pub associated_token: Account<'info, TokenAccount>,
```

### Token Transfer CPI

```rust
use anchor_spl::token::{self, Transfer};

token::transfer(
    CpiContext::new(
        token_program.to_account_info(),
        Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: authority.to_account_info(),
        },
    ),
    amount
)?;
```

## SPL Token Fundamentals

### Token Program Overview

The SPL Token program provides:

- **Mints:** Token type definitions (like ERC-20 contracts)
- **Token Accounts:** Hold tokens for a specific mint and owner
- **Instructions:** Transfer, mint, burn, approve, etc.

**Program IDs:**

- SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Token-2022 (Token Extensions): `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

### Account Types

**Mint Account:**

- Defines a token type
- Stores supply, decimals, authorities
- Owned by Token Program

**Token Account:**

- Holds tokens of a specific mint
- Has an owner (can be user or PDA)
- Owned by Token Program

**Associated Token Account (ATA):**

- Special token account with deterministic address
- Derived from owner + mint
- One per owner per mint

## Token Account Constraints

**Source:** [Anchor Account Constraints - Token](https://www.anchor-lang.com/docs/references/account-constraints#accounttoken)

### token::mint - Validate Mint

```rust
use anchor_spl::token::{Mint, TokenAccount};

#[derive(Accounts)]
pub struct ValidateTokenAccount<'info> {
    pub mint: Account<'info, Mint>,
    #[account(token::mint = mint)]
    pub token_account: Account<'info, TokenAccount>,
}
```

**Checks:** `token_account.mint == mint.key()`

**Use when:** Ensuring token account holds correct token type

### token::authority - Validate Authority

```rust
#[derive(Accounts)]
pub struct ValidateAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        token::mint = mint,
        token::authority = authority
    )]
    pub token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
}
```

**Checks:** `token_account.authority == authority.key()`

**Use when:** Verifying who controls the token account

### Combined Validation

```rust
#[account(
    mut,
    token::mint = mint,
    token::authority = owner
)]
pub user_token: Account<'info, TokenAccount>,
pub owner: Signer<'info>,
pub mint: Account<'info, Mint>,
```

**Ensures:**

- Token account holds tokens of correct mint
- Owner has authority over account
- Account is mutable for transfers

### token::token_program - Specify Token Program

```rust
#[account(
    token::mint = mint,
    token::authority = authority,
    token::token_program = token_program
)]
pub token_account: Account<'info, TokenAccount>,
pub token_program: Program<'info, Token>,
```

**Use when:** Working with both SPL Token and Token-2022

## Mint Account Constraints

**Source:** [Anchor Account Constraints - Mint](https://www.anchor-lang.com/docs/references/account-constraints#accountmint)

### mint::authority - Mint Authority

```rust
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct CreateMint<'info> {
    #[account(
        init,
        payer = payer,
        mint::authority = mint_authority,
        mint::decimals = 9,
    )]
    pub mint: Account<'info, Mint>,
    pub mint_authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
```

**Sets:** Mint authority (can mint new tokens)

### mint::decimals - Token Decimals

```rust
#[account(
    init,
    payer = payer,
    mint::authority = authority,
    mint::decimals = 6,  // USDC uses 6 decimals
)]
pub mint: Account<'info, Mint>,
```

**Sets:** Number of decimal places for token amounts

**Common values:**

- Native SOL: 9 decimals
- USDC: 6 decimals
- USDT: 6 decimals
- Bitcoin-style: 8 decimals

### mint::freeze_authority - Freeze Authority

```rust
#[account(
    init,
    payer = payer,
    mint::authority = mint_authority,
    mint::decimals = 9,
    mint::freeze_authority = freeze_authority,
)]
pub mint: Account<'info, Mint>,
```

**Sets:** Authority that can freeze token accounts (optional)

## Associated Token Account Constraints

**Source:** [Anchor Account Constraints - Associated Token](https://www.anchor-lang.com/docs/references/account-constraints#accountassociated_token)

### Creating Associated Token Accounts

```rust
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, TokenAccount, Token},
};

#[derive(Accounts)]
pub struct CreateATA<'info> {
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = authority,
    )]
    pub associated_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
```

**Creates ATA with address:**

```
find_program_address(
    &[
        authority.key().as_ref(),
        token_program.key().as_ref(),
        mint.key().as_ref(),
    ],
    associated_token_program.key()
)
```

### Lazy Initialization with init_if_needed

```rust
#[account(
    init_if_needed,
    payer = payer,
    associated_token::mint = mint,
    associated_token::authority = user,
)]
pub user_ata: Account<'info, TokenAccount>,
```

**Behavior:**

- If ATA doesn't exist: Creates it
- If ATA exists: Uses existing account

**Requires:** `init-if-needed` feature in Cargo.toml

**Use when:** User might or might not have ATA for this mint

### Validating Existing ATA

```rust
#[account(
    associated_token::mint = mint,
    associated_token::authority = user,
)]
pub user_ata: Account<'info, TokenAccount>,
```

**Validates:**

- Account is an ATA for this mint and authority
- Account exists and is correctly derived

## Token Account PDAs

### Pattern: Program-Owned Token Account

```rust
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        seeds = [b"vault", escrow.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,  // Escrow PDA controls vault
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"escrow", owner.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

**Benefits of Token Account PDAs:**

- Program controls the tokens
- Deterministic address derivation
- No need for user to create account
- Can derive multiple vaults per escrow (one per mint)

### Transferring from PDA Token Account

```rust
use anchor_spl::token::{self, Transfer};

pub fn withdraw_from_vault(
    ctx: Context<WithdrawFromVault>,
    amount: u64,
) -> Result<()> {
    let seeds = &[
        b"vault".as_ref(),
        ctx.accounts.escrow.key().as_ref(),
        ctx.accounts.mint.key().as_ref(),
        &[ctx.accounts.vault_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),  // Vault PDA signs
            },
        ).with_signer(signer_seeds),
        amount
    )?;
    Ok(())
}
```

**Pattern for escrow:**

- Vault PDA holds tokens
- Escrow PDA is vault authority
- Escrow PDA signs transfers using seeds

## Token Transfers

### Basic Transfer

```rust
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn transfer_tokens(
    ctx: Context<TransferTokens>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(
        mut,
        token::authority = authority
    )]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
```

### Transfer with Balance Check

```rust
pub fn safe_transfer(
    ctx: Context<TransferTokens>,
    amount: u64,
) -> Result<()> {
    // Validate sufficient balance
    require!(
        ctx.accounts.from.amount >= amount,
        ErrorCode::InsufficientBalance
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount
    )?;
    Ok(())
}
```

### Transfer to Merchant (Escrow Pattern)

```rust
pub fn finalize_settlement(ctx: Context<Finalize>) -> Result<()> {
    let amount = ctx.accounts.pending.amount;

    // Vault PDA signs the transfer
    let seeds = &[
        b"vault".as_ref(),
        ctx.accounts.escrow.key().as_ref(),
        ctx.accounts.pending.mint.as_ref(),
        &[ctx.accounts.vault_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
        ).with_signer(signer_seeds),
        amount
    )?;

    Ok(())
}
```

## Owner Checks

**Critical security pattern for token accounts.**

**Source:** [Sealevel Attacks - Owner Checks](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/2-owner-checks)

### The Security Issue

Token accounts owned by malicious programs can have fake data.

### The Solution: Account Type

```rust
use anchor_spl::token::TokenAccount;

#[derive(Accounts)]
pub struct SecureTokenOp<'info> {
    #[account(constraint = authority.key == &token.owner)]
    pub token: Account<'info, TokenAccount>,  // Validates owner is Token Program
    pub authority: Signer<'info>,
}
```

**Account<'info, TokenAccount> checks:**

1. Account owner is SPL Token program
2. Account data deserializes to TokenAccount struct
3. No fake token accounts accepted

### Alternative: Manual Owner Check

```rust
#[account(
    owner = token_program.key() @ ErrorCode::InvalidTokenAccountOwner
)]
pub token: AccountInfo<'info>,
pub token_program: Program<'info, Token>,
```

**But prefer `Account<'info, TokenAccount>` for automatic validation.**

## Depositing to Escrow

```rust
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    // Transfer from user to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref(), mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"escrow", user.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    pub mint: Account<'info, Mint>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
```

**Validates:**

- User owns source token account
- Vault is correct PDA for escrow + mint
- Escrow PDA controls vault
- Transfer uses correct token program

## Token Extensions (Token-2022)

**Source:** [Anchor Account Constraints - Token Extensions](https://www.anchor-lang.com/docs/references/account-constraints#token-extensions-constraints)

Token-2022 introduces extensions for enhanced functionality:

### Available Extensions

```rust
// Close Authority
#[account(
    init,
    payer = payer,
    mint::authority = authority,
    mint::decimals = 9,
    extensions::close_authority::authority = close_authority,
)]
pub mint: Account<'info, Mint>,

// Permanent Delegate
#[account(
    extensions::permanent_delegate::delegate = delegate,
)]
pub mint: Account<'info, Mint>,

// Transfer Hook
#[account(
    extensions::transfer_hook::authority = hook_authority,
    extensions::transfer_hook::program_id = hook_program,
)]
pub mint: Account<'info, Mint>,

// Group Pointer
#[account(
    extensions::group_pointer::authority = group_authority,
    extensions::group_pointer::group_address = group_address,
)]
pub mint: Account<'info, Mint>,

// Metadata Pointer
#[account(
    extensions::metadata_pointer::authority = metadata_authority,
    extensions::metadata_pointer::metadata_address = metadata_address,
)]
pub mint: Account<'info, Mint>,
```

### Using Token-2022

```rust
use anchor_spl::token_2022::Token2022;

#[derive(Accounts)]
pub struct Token2022Operation<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
}
```

**Note:** Token-2022 has separate program ID but similar account structures.

## Balance Validation

### Checking Balances

```rust
pub fn validate_balance(ctx: Context<ValidateBalance>, required: u64) -> Result<()> {
    require!(
        ctx.accounts.token_account.amount >= required,
        ErrorCode::InsufficientBalance
    );
    Ok(())
}
```

### Before Submission (Escrow Pattern)

```rust
pub fn submit_authorization(
    ctx: Context<SubmitAuth>,
    amount: u64,
    // ... other params
) -> Result<()> {
    // Verify vault has sufficient balance
    require!(
        ctx.accounts.vault.amount >= amount,
        ErrorCode::InsufficientBalance
    );

    // Create pending settlement
    // ...
    Ok(())
}
```

## Common Patterns for Escrow

### Multi-Mint Vault Support

```rust
// Each mint gets its own vault PDA
#[account(
    init_if_needed,
    payer = payer,
    seeds = [b"vault", escrow.key().as_ref(), mint.key().as_ref()],
    bump,
    token::mint = mint,
    token::authority = escrow,
)]
pub vault: Account<'info, TokenAccount>,
```

**Benefits:**

- Single escrow supports multiple token types
- Vaults created lazily as needed
- Deterministic vault addresses

### Validating Mint on Settlement

```rust
#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(
        has_one = escrow,
        constraint = pending.mint == vault.mint @ ErrorCode::MintMismatch
    )]
    pub pending: Account<'info, PendingSettlement>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref(), pending.mint.as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    // ...
}
```

**Ensures:** Correct vault for the mint being settled.

## Skill Loading Guidance

### Always Load With

- **anchor-core** - Core patterns prerequisite
- **anchor-security** - Owner checks (pattern 3)

### Commonly Paired With

- **anchor-cpis** - Token transfer CPIs
- **anchor-pdas** - Token account PDAs

### Load This Skill When

- Working with SPL tokens
- Implementing token transfers
- Creating vaults or escrow accounts
- Managing token account authorities
- Validating token account ownership

### Related Skills

- **anchor-core** - For constraint syntax
- **anchor-security** - For owner checks and validation
- **anchor-cpis** - For transfer implementation
- **anchor-pdas** - For vault PDA patterns

## Reference Links

### Official Documentation

- [Anchor Token Constraints](https://www.anchor-lang.com/docs/references/account-constraints#spl-constraints)
- [SPL Token Documentation](https://spl.solana.com/token)
- [Token-2022 Documentation](https://spl.solana.com/token-2022)
- [Associated Token Account](https://spl.solana.com/associated-token-account)

### Source Material

- [Anchor Account Constraints](https://www.anchor-lang.com/docs/references/account-constraints)
- [Sealevel Attacks - Owner Checks](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/2-owner-checks)
- [Sealevel Attacks - Arbitrary CPI](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/5-arbitrary-cpi)

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the anchor-token-operations skill and understand how to safely work with SPL tokens."
