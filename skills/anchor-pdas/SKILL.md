---
name: anchor-pdas
description: Program Derived Address patterns for creating deterministic accounts, hashmap-like structures, and program signing. Load when implementing PDAs or working with seeds and bumps.
---

# Anchor PDAs

Program Derived Addresses (PDAs) are one of the most important concepts in Solana programming. They enable deterministic account derivation, hashmap-like data structures, and allow programs to sign transactions.

## Quick Reference

### PDA Creation (Init)

```rust
#[account(
    init,
    payer = user,
    space = 8 + UserStats::INIT_SPACE,
    seeds = [b"user-stats", user.key().as_ref()],
    bump
)]
pub user_stats: Account<'info, UserStats>,
```

Access bump: `ctx.bumps.user_stats`

### PDA Validation (Use)

```rust
// With stored bump (efficient)
#[account(
    seeds = [b"user-stats", user.key().as_ref()],
    bump = user_stats.bump
)]
pub user_stats: Account<'info, UserStats>,
```

### Program Signing with PDA

```rust
let seeds = &[
    b"authority".as_ref(),
    &[authority_bump],
];
let signer_seeds = &[&seeds[..]];

token::transfer(
    ctx.accounts.transfer_ctx().with_signer(signer_seeds),
    amount
)?;
```

### Client-Side PDA Derivation (TypeScript)

```typescript
const [userStatsPDA, bump] = await PublicKey.findProgramAddress(
  [Buffer.from("user-stats"), user.publicKey.toBuffer()],
  program.programId,
);
```

## PDA Fundamentals

**Source:** [Anchor Book - PDAs](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md)

### What are PDAs?

PDAs (Program Derived Addresses) are addresses with special properties:

1. **Not public keys** - No associated private key exists
2. **Deterministically derived** - Same inputs always produce same address
3. **Program-specific** - Derived from seeds + program ID

**Two primary use cases:**

1. Creating hashmap-like structures on-chain
2. Allowing programs to sign instructions

### How PDAs are Created

PDAs are created by hashing seeds with a program ID:

```rust
// Pseudo code
let pda = hash(seeds, program_id);
```

**The Bump:** There's a 50% chance the hash produces a public key (invalid for PDA). A bump seed (0-255) is tried until a valid PDA is found:

```rust
// Pseudo code
fn find_pda(seeds, program_id) {
    for bump in 0..256 {
        let potential_pda = hash(seeds, bump, program_id);
        if is_pubkey(potential_pda) {
            continue;  // This is a public key, try next bump
        }
        return (potential_pda, bump);  // Found valid PDA
    }
    panic!("Could not find pda after 256 tries.");
}
```

The first bump that results in a PDA is called the **canonical bump**.

### Canonical Bump

**Always use the canonical bump** (first valid bump) for consistency:

- Prevents multiple PDAs from same seeds
- Security best practice
- Anchor finds canonical bump automatically with empty `bump` constraint

**Source:** [Sealevel Attacks - Bump Seed Canonicalization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/7-bump-seed-canonicalization)

## Creating PDAs with Anchor

### PDA Initialization

When using `init` with `seeds` and `bump`, Anchor automatically finds the canonical bump:

```rust
use anchor_lang::prelude::*;

#[program]
mod game {
    use super::*;

    pub fn create_user_stats(ctx: Context<CreateUserStats>, name: String) -> Result<()> {
        let user_stats = &mut ctx.accounts.user_stats;
        user_stats.level = 0;
        user_stats.name = name;
        // Store the bump for efficient future lookups
        user_stats.bump = ctx.bumps.user_stats;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct UserStats {
    pub level: u16,
    #[max_len(200)]
    pub name: String,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateUserStats<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + UserStats::INIT_SPACE,
        seeds = [b"user-stats", user.key().as_ref()],
        bump  // Anchor finds canonical bump
    )]
    pub user_stats: Account<'info, UserStats>,
    pub system_program: Program<'info, System>,
}
```

**Key points:**

- Empty `bump` constraint tells Anchor to find canonical bump
- Access found bump via `ctx.bumps.<account_name>`
- **Best practice:** Store bump in account data for efficiency

**Complete working example source:** [Anchor Book - PDAs Hashmap Example](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md#how-to-build-pda-hashmaps-in-anchor)

### Using PDAs in Subsequent Instructions

When using an existing PDA, provide the stored bump for efficiency:

```rust
#[derive(Accounts)]
pub struct ChangeUserName<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user-stats", user.key().as_ref()],
        bump = user_stats.bump  // Use stored bump
    )]
    pub user_stats: Account<'info, UserStats>,
}

pub fn change_user_name(ctx: Context<ChangeUserName>, new_name: String) -> Result<()> {
    ctx.accounts.user_stats.name = new_name;
    Ok(())
}
```

**Why store bumps?**

- **Efficiency:** Using stored bump avoids re-searching for canonical bump
- **Performance:** Significantly faster verification (single hash vs up to 256)
- **Standard pattern:** Recommended by Anchor documentation

## Hashmap-Like Structures with PDAs

### The Problem PDAs Solve

Without PDAs, linking accounts requires either:

1. Storing addresses in a global registry (expensive, complex)
2. Clients tracking relationships off-chain (fragile, unreliable)

**Example problem:** Given a user's address, how do you find their stats account?

### The PDA Solution

Encode the relationship in the address itself using seeds:

```rust
// Seeds define the mapping
let seeds = [b"user-stats", authority];
let (pda, bump) = find_pda(seeds, program_id);
```

**Now the mapping is deterministic:**

- Input: User address
- Output: User stats PDA (always the same)
- **No storage needed** - just recompute the derivation

### Seed Design Patterns

#### Pattern 1: One-to-One Mapping

Map each authority to their unique account:

```rust
seeds = [b"user-stats", user.key().as_ref()]
```

**Use case:** User profiles, vaults, configuration accounts

#### Pattern 2: Multiple Account Types Per Authority

Use different prefixes for different account types:

```rust
// User stats account
seeds = [b"user-stats", user.key().as_ref()]

// User inventory account
seeds = [b"inventory", user.key().as_ref()]

// User achievements account
seeds = [b"achievements", user.key().as_ref()]
```

**Use case:** When each user has multiple related accounts

#### Pattern 3: Nested Relationships

Derive accounts from other account addresses:

```rust
// Escrow account (per owner, per index)
seeds = [b"escrow", owner.key().as_ref(), &index.to_le_bytes()]

// Token account (per escrow, per mint)
seeds = [b"token", escrow.key().as_ref(), mint.key().as_ref()]

// Pending settlement (per escrow, per authorization_id)
seeds = [b"pending", escrow.key().as_ref(), &authorization_id.to_le_bytes()]
```

**Use case:** Hierarchical data structures, sub-accounts

### Enforcing Uniqueness

A powerful side effect of PDA init: **automatic uniqueness enforcement**.

When you use `init` with `seeds` and `bump`, the account can only be created once. Second call fails because PDA already exists.

**Example: Decentralized Exchange Markets**

```rust
#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        // Market PDA is unique per token pair (in sorted order)
        seeds = [
            b"market",
            min(token_a.key(), token_b.key()).as_ref(),
            max(token_a.key(), token_b.key()).as_ref(),
        ],
        bump
    )]
    pub market: Account<'info, Market>,
    // ...
}
```

**Result:** Only one market can exist per token pair, concentrating liquidity.

**Source:** [Anchor Book - PDAs Enforcing Uniqueness](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md#enforcing-uniqueness)

### Client-Side PDA Derivation

Clients can derive PDAs to find account addresses:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const [userStatsPDA, bump] = await PublicKey.findProgramAddress(
  [anchor.utils.bytes.utf8.encode("user-stats"), user.publicKey.toBuffer()],
  program.programId,
);

// Use the PDA in instruction
await program.methods
  .createUserStats("Alice")
  .accounts({
    user: user.publicKey,
    userStats: userStatsPDA,
  })
  .rpc();
```

**Complete working test source:** [Anchor Book - PDAs Test Example](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md#how-to-build-pda-hashmaps-in-anchor)

## Programs as Signers

**Source:** [Anchor Book - PDAs Programs as Signers](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md#programs-as-signers)

PDAs enable programs to sign CPIs, giving programs authority over assets.

### How PDA Signing Works

PDAs can "pseudo sign" by providing seeds to CPI calls:

```rust
CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds)
```

When the CPI is invoked:

1. Runtime checks: `hash(seeds, current_program_id) == account address`
2. If match, sets account's `is_signer` flag to true
3. Target program sees account as having signed

**Critical security property:** A PDA can only be used to sign CPIs originating from the program that derived it.

### Basic Program Signing Pattern

```rust
use anchor_lang::prelude::*;
use puppet::cpi::accounts::SetData;
use puppet::program::Puppet;
use puppet::{self, Data};

#[program]
mod puppet_master {
    use super::*;

    pub fn pull_strings(ctx: Context<PullStrings>, bump: u8, data: u64) -> Result<()> {
        let bump = &[bump];
        let seeds = &[&bump[..]];
        let signer_seeds = &[&seeds[..]];

        puppet::cpi::set_data(
            ctx.accounts.set_data_ctx().with_signer(signer_seeds),
            data,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PullStrings<'info> {
    #[account(mut)]
    pub puppet: Account<'info, Data>,
    pub puppet_program: Program<'info, Puppet>,
    /// CHECK: Only used as a signing PDA
    pub authority: UncheckedAccount<'info>,
}

impl<'info> PullStrings<'info> {
    pub fn set_data_ctx(&self) -> CpiContext<'_, '_, '_, 'info, SetData<'info>> {
        let cpi_program = self.puppet_program.to_account_info();
        let cpi_accounts = SetData {
            puppet: self.puppet.to_account_info(),
            authority: self.authority.to_account_info(),
        };
        CpiContext::new(cpi_program, cpi_accounts)
    }
}
```

**Note:** `authority` is `UncheckedAccount` because it's not a signer yet when passed in. The program adds the signature via `with_signer`.

**Complete working example source:** [Anchor Book - Puppet Master Example](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md#programs-as-signers)

### Signer Seeds Format

The seeds must be provided as a specific nested slice format:

```rust
let seeds = &[
    seed1,          // &[u8]
    seed2,          // &[u8]
    &[bump],        // &[u8]
];
let signer_seeds = &[&seeds[..]];  // &[&[&[u8]]]

// Use with CPI
cpi_ctx.with_signer(signer_seeds)
```

**Common patterns:**

```rust
// Simple bump-only PDA
let seeds = &[&[bump]];
let signer_seeds = &[&seeds[..]];

// With static seed
let seeds = &[b"authority".as_ref(), &[bump]];
let signer_seeds = &[&seeds[..]];

// With dynamic seed
let seeds = &[
    b"vault".as_ref(),
    escrow.key().as_ref(),
    &[vault_bump],
];
let signer_seeds = &[&seeds[..]];
```

### Complete Token Transfer Example

Program controlling a token account via PDA:

```rust
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn withdraw_tokens(ctx: Context<WithdrawTokens>) -> Result<()> {
    let amount = ctx.accounts.vault.amount;

    let seeds = &[
        ctx.accounts.pool.withdraw_destination.as_ref(),
        &[ctx.accounts.pool.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        ctx.accounts.transfer_ctx().with_signer(signer_seeds),
        amount
    )?;
    Ok(())
}

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
    pub fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let program = self.token_program.to_account_info();
        let accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.withdraw_destination.to_account_info(),
            authority: self.pool.to_account_info(),  // Pool PDA signs
        };
        CpiContext::new(program, accounts)
    }
}

#[account]
pub struct TokenPool {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub withdraw_destination: Pubkey,
    pub bump: u8,
}
```

**Source:** [Sealevel Attacks - PDA Sharing Recommended](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/8-pda-sharing/recommended)

## Seed Selection Best Practices

### Static Prefix for Account Type

Always start with a static prefix to distinguish account types:

```rust
seeds = [b"escrow", ...]         // Escrow account
seeds = [b"session-key", ...]    // Session key account
seeds = [b"pending", ...]        // Pending settlement account
```

**Why?** Prevents collisions between different account types.

### Dynamic Seeds for Relationships

Use account addresses or unique identifiers:

```rust
// Per-user, per-index account
seeds = [b"escrow", owner.key().as_ref(), &index.to_le_bytes()]

// Per-escrow, per-mint account
seeds = [b"token", escrow.key().as_ref(), mint.key().as_ref()]

// Per-escrow, per-authorization_id account
seeds = [b"pending", escrow.key().as_ref(), &authorization_id.to_le_bytes()]
```

### Number Serialization

Use little-endian for numeric seeds:

```rust
// Good
seeds = [b"pending", &authorization_id.to_le_bytes()]

// Bad - different byte order may cause issues
seeds = [b"pending", &authorization_id.to_be_bytes()]
```

### Avoiding Collisions

**Collision risk:** Different seed combinations that hash to same address.

**Prevention strategies:**

1. Use typed prefixes (different byte literals)
2. Include account type in seeds
3. Order seeds consistently
4. Use account addresses (inherently unique)

```rust
// Good - clear separation
seeds = [b"user-stats", user.key().as_ref()]
seeds = [b"user-inventory", user.key().as_ref()]

// Risky - could potentially collide if not careful
seeds = [user.key().as_ref(), b"stats"]
seeds = [user.key().as_ref(), b"inventory"]
```

## Common PDA Patterns

### Pattern: User Account Mapping

```rust
#[derive(Accounts)]
pub struct InitializeUser<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + User::INIT_SPACE,
        seeds = [b"user", authority.key().as_ref()],
        bump
    )]
    pub user: Account<'info, User>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

### Pattern: Escrow Account

```rust
#[derive(Accounts)]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", owner.key().as_ref(), &index.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}
```

### Pattern: Token Account PDA

```rust
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = escrow,  // Escrow PDA is authority
        seeds = [b"vault", escrow.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub escrow: Account<'info, EscrowAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

### Pattern: Unique Authorization Accounts

Each pending settlement is keyed by a random `authorization_id`. The `init` constraint ensures that no two pending settlements can share the same `authorization_id` within an escrow, providing replay protection while the settlement is pending. Expiry-based validation (`expires_at_slot`) prevents replay after finalization.

```rust
#[derive(Accounts)]
#[instruction(authorization_id: u64, expires_at_slot: u64)]
pub struct CreatePendingSettlement<'info> {
    #[account(
        mut,
        seeds = [b"escrow", owner.key().as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,
    #[account(
        init,
        payer = facilitator,
        space = 8 + PendingSettlement::INIT_SPACE,
        seeds = [
            b"pending",
            escrow.key().as_ref(),
            &authorization_id.to_le_bytes()
        ],
        bump
    )]
    pub pending: Account<'info, PendingSettlement>,
    // ...
}
```

## Bump Seed Canonicalization

**Security Pattern:** Always use canonical bumps to prevent account confusion.

**Source:** [Sealevel Attacks - Bump Seed Canonicalization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/7-bump-seed-canonicalization)

### The Recommended Pattern

```rust
#[derive(Accounts)]
#[instruction(key: u64)]
pub struct UsePDA<'info> {
    // On init: find and store canonical bump
    #[account(
        init,
        payer = payer,
        space = 8 + Data::INIT_SPACE,
        seeds = [key.to_le_bytes().as_ref()],
        bump  // Anchor finds canonical bump
    )]
    pub data: Account<'info, Data>,
}

#[account]
pub struct Data {
    pub value: u64,
    pub bump: u8,  // Store the bump
}

// Store it in handler
pub fn initialize(ctx: Context<UsePDA>, key: u64) -> Result<()> {
    ctx.accounts.data.bump = ctx.bumps.data;
    Ok(())
}

// Later use with stored bump
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
```

**Why this matters:**

- Non-canonical bumps could create multiple PDAs from same seeds
- Using stored canonical bump ensures consistency
- More efficient than re-searching for canonical bump

**Note from source material:**

> When using a PDA, it's usually recommend to store the bump seed in the account data, so that you can use it as demonstrated in 2), which will provide a more efficient check.

## Advanced: Combining State and Signing

A PDA can serve both purposes simultaneously:

1. Store program state
2. Sign CPIs

```rust
#[derive(Accounts)]
pub struct WithdrawFromPool<'info> {
    #[account(
        mut,
        has_one = vault,
        seeds = [b"pool", pool.id.to_le_bytes().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,  // Stores state AND signs
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    // ...
}

pub fn withdraw_from_pool(ctx: Context<WithdrawFromPool>, amount: u64) -> Result<()> {
    // Pool account is used for both:
    // 1. Storing and checking state (has_one = vault)
    // 2. Signing the token transfer CPI

    let seeds = &[
        b"pool".as_ref(),
        &ctx.accounts.pool.id.to_le_bytes(),
        &[ctx.accounts.pool.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        ctx.accounts.transfer_ctx().with_signer(signer_seeds),
        amount
    )?;
    Ok(())
}
```

**Benefit:** Reduces account count, simplifies design.

## Skill Loading Guidance

### Always Load With

- **anchor-core** - Core Anchor patterns are prerequisite
- **anchor-security** - Security implications of PDAs

### Commonly Paired With

- **anchor-cpis** - PDAs often used for program signing in CPIs
- **anchor-token-operations** - Token account PDAs

### Load This Skill When

- Implementing account derivation logic
- Creating hashmap-like data structures
- Implementing program signing for CPIs
- Designing escrow or vault programs
- Working with session keys or authorization schemes
- Building multi-account hierarchies

### Related Skills

- **anchor-core** - For basic constraints and account types
- **anchor-security** - For PDA security patterns (bump canonicalization, PDA sharing)
- **anchor-cpis** - For using PDAs as signers in cross-program invocations
- **anchor-token-operations** - For token account PDAs
- **rust-solana** - For byte conversions and seed formatting

## Reference Links

### Official Documentation

- [Anchor PDA Documentation](https://www.anchor-lang.com/docs/basics/pda)
- [Solana PDA Documentation](https://docs.solana.com/developing/programming-model/calling-between-programs#program-derived-addresses)
- [Anchor Account Constraints - Seeds & Bump](https://www.anchor-lang.com/docs/references/account-constraints#seeds-bump)

### Source Material

- [Anchor Book - PDAs Chapter](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md) - Complete PDA tutorial with working examples
- [Sealevel Attacks - Bump Seed Canonicalization](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/7-bump-seed-canonicalization) - Canonical bump security
- [Sealevel Attacks - PDA Sharing](https://github.com/coral-xyz/sealevel-attacks/tree/master/programs/8-pda-sharing) - PDA validation patterns

### Additional Resources

- [Pencilflip's Twitter Thread on PDAs](https://twitter.com/pencilflip/status/1455948263853600768) - Conceptual explanation
- [Jarry Xiao's Talk on PDAs and CPIs](https://www.youtube.com/watch?v=iMWaQRyjpl4) - Video explanation
- [PaulX's Guide to Solana Programming](https://paulx.dev/blog/2021/01/14/programming-on-solana-an-introduction/) - Comprehensive Solana guide

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the anchor-pdas skill and understand how to use Program Derived Addresses for account derivation and program signing."
