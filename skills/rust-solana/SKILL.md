---
name: rust-solana
description: Rust patterns specific to Solana development including serialization, compute optimization, and Solana-specific types. Load when optimizing Solana programs or working with low-level Solana features.
---

# Rust for Solana

Rust patterns and idioms specific to Solana program development, including serialization, time handling, signature verification, and compute optimization.

## Quick Reference

### Borsh Serialization

```rust
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PaymentAuthorization {
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}
```

### Slot-Based Timing

```rust
let clock = Clock::get()?;
require!(
    clock.slot >= start_slot + timeout_slots,
    ErrorCode::TimeoutNotExpired
);
```

### Byte Conversions for Seeds

```rust
// Numbers to bytes
let seeds = [
    b"pending".as_ref(),
    &nonce.to_le_bytes(),  // u64 to [u8; 8]
];

// Pubkey to bytes
let seeds = [
    b"vault".as_ref(),
    escrow.key().as_ref(),  // &Pubkey to &[u8]
];
```

### Ed25519 Signature Verification

```rust
// Construct message
let message = PaymentAuthorization {
    escrow: ctx.accounts.escrow.key(),
    mint,
    recipient,
    amount,
    nonce,
};
let message_bytes = message.try_to_vec()?;

// Verify signature (via Ed25519 program or custom logic)
// Implementation depends on requirements
```

## Borsh Serialization

### The AnchorSerialize and AnchorDeserialize Traits

Anchor uses Borsh (Binary Object Representation Serializer for Hashing) for serialization.

**For custom types:**

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CustomData {
    pub value: u64,
    pub active: bool,
}
```

**For instruction arguments:**

```rust
pub fn process_data(ctx: Context<Process>, data: CustomData) -> Result<()> {
    // `data` is automatically deserialized from instruction data
    msg!("Value: {}", data.value);
    Ok(())
}
```

**The `#[account]` macro automatically includes:**

```rust
#[account]
pub struct MyAccount {
    pub data: u64,
}
// Automatically derives AnchorSerialize, AnchorDeserialize, and more
```

### Manual Serialization

When you need to serialize data manually:

```rust
use anchor_lang::prelude::*;

let data = PaymentAuthorization {
    escrow: escrow_pubkey,
    mint: mint_pubkey,
    recipient: recipient_pubkey,
    amount: 1000,
    nonce: 1,
};

// Serialize to Vec<u8>
let serialized = data.try_to_vec()?;

// Deserialize from &[u8]
let deserialized = PaymentAuthorization::try_from_slice(&serialized)?;
```

### Common Serialization Patterns

**For PDA seeds (numbers):**

```rust
&nonce.to_le_bytes()  // u64 → [u8; 8]
```

**For signatures (messages):**

```rust
let message = authorization.try_to_vec()?;
```

**For account data:**

```rust
// Account macro handles this automatically
#[account]
pub struct Data {
    pub field: u64,
}
```

## Solana Native Types

### Pubkey

Public key type (32 bytes):

```rust
use anchor_lang::solana_program::pubkey::Pubkey;

// In account structs
pub authority: Pubkey,

// Getting key from account
let key = ctx.accounts.escrow.key();

// Converting to bytes for seeds
key.as_ref()  // &[u8; 32]
key.to_bytes()  // [u8; 32]
```

### Slot

Blockchain slot number (u64):

```rust
// From Clock sysvar
let clock = Clock::get()?;
let current_slot = clock.slot;

// In account data
pub submitted_at_slot: u64,

// Slot-based timeouts
let expired = current_slot >= start_slot + timeout_slots;
```

### Lamports

Native SOL amount (u64):

```rust
// 1 SOL = 1_000_000_000 lamports
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// Account lamports
let balance = ctx.accounts.account.to_account_info().lamports();

// Transfer lamports (via System Program CPI)
```

### AccountInfo

Low-level account access:

```rust
use anchor_lang::prelude::*;

let account_info = ctx.accounts.my_account.to_account_info();

// Access fields
account_info.key       // Pubkey
account_info.lamports  // RefCell<&mut u64>
account_info.data      // RefCell<&mut [u8]>
account_info.owner     // &Pubkey
account_info.is_signer // bool
account_info.is_writable // bool
```

**Use when:** Need direct account manipulation

## Slot-Based Timing

**Why slots instead of timestamps?**

- More predictable
- Tied to chain state
- No clock drift issues

### Getting Current Slot

```rust
use anchor_lang::solana_program::clock::Clock;

let clock = Clock::get()?;
let current_slot = clock.slot;
```

### Timeout Calculations

```rust
pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
    let clock = Clock::get()?;

    // Check timeout elapsed
    require!(
        clock.slot >= ctx.accounts.pending.submitted_at_slot
            + ctx.accounts.escrow.refund_timeout_slots,
        ErrorCode::RefundWindowNotExpired
    );

    // Proceed with finalization
    Ok(())
}
```

### Storing Time in Accounts

```rust
#[account]
pub struct PendingSettlement {
    pub submitted_at_slot: u64,  // When created
    // ...
}

// On creation
pub fn submit(ctx: Context<Submit>) -> Result<()> {
    let clock = Clock::get()?;
    ctx.accounts.pending.submitted_at_slot = clock.slot;
    Ok(())
}
```

### Timeout Patterns

**Refund window:**

```rust
// Can refund only before timeout
require!(
    clock.slot < submitted_at + refund_timeout,
    ErrorCode::RefundWindowExpired
);
```

**Finalization:**

```rust
// Can finalize only after timeout
require!(
    clock.slot >= submitted_at + refund_timeout,
    ErrorCode::RefundWindowNotExpired
);
```

**Deadman switch:**

```rust
// Emergency action after long inactivity
require!(
    clock.slot > last_activity + deadman_timeout,
    ErrorCode::DeadmanNotExpired
);
```

## Ed25519 Signature Verification

### Why Ed25519 for Session Keys?

Session keys in escrow allow off-chain signature creation:

1. Client signs authorization with session key (Ed25519 keypair)
2. Facilitator submits authorization + signature on-chain
3. Program verifies signature matches session key

**Compute cost:** ~25,000 CU per verification

### Message Construction

```rust
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PaymentAuthorization {
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

// In handler
pub fn submit_authorization(
    ctx: Context<SubmitAuth>,
    mint: Pubkey,
    recipient: Pubkey,
    amount: u64,
    nonce: u64,
    signature: [u8; 64],
) -> Result<()> {
    // Construct message
    let message = PaymentAuthorization {
        escrow: ctx.accounts.escrow.key(),
        mint,
        recipient,
        amount,
        nonce,
    };

    // Serialize for verification
    let message_bytes = message.try_to_vec()?;

    // Verify signature (implementation below)
    verify_ed25519_signature(
        &message_bytes,
        &signature,
        ctx.accounts.session_key.key.as_ref(),
    )?;

    Ok(())
}
```

### Signature Verification Methods

**Method 1: Ed25519 Program Instruction (Recommended for Solana)**

```rust
use anchor_lang::solana_program::sysvar::instructions;

// Requires Ed25519 program instruction in same transaction
// Client creates Ed25519 verify instruction, then calls this
pub fn submit_with_ed25519_ix(ctx: Context<Submit>) -> Result<()> {
    // Get instructions sysvar
    let ix_sysvar = &ctx.accounts.instruction_sysvar;

    // Verify Ed25519 instruction exists and validates
    // (Implementation details depend on instruction format)

    Ok(())
}

#[derive(Accounts)]
pub struct Submit<'info> {
    // ...
    /// CHECK: Instructions sysvar
    #[account(address = instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}
```

**Method 2: Manual Verification (If needed)**

For custom signature verification (note: requires ed25519 crate):

```rust
// This is example - actual implementation depends on dependencies
use ed25519_dalek::{PublicKey, Signature, Verifier};

fn verify_signature(
    message: &[u8],
    signature: &[u8; 64],
    public_key: &[u8; 32],
) -> Result<()> {
    let pubkey = PublicKey::from_bytes(public_key)
        .map_err(|_| error!(ErrorCode::InvalidPublicKey))?;
    let sig = Signature::from_bytes(signature);

    pubkey
        .verify(message, &sig)
        .map_err(|_| error!(ErrorCode::InvalidSignature))?;

    Ok(())
}
```

**Note:** Ed25519 verification is compute-intensive. Consider using Solana's native Ed25519 program for efficiency.

## Byte Conversions

### Numbers to Bytes (for PDA seeds)

**Always use little-endian:**

```rust
// u64 to bytes
let nonce: u64 = 123;
let bytes = nonce.to_le_bytes();  // [u8; 8]

// In seeds
seeds = [b"pending", &nonce.to_le_bytes()]

// Other integer types
let id: u32 = 456;
let bytes = id.to_le_bytes();  // [u8; 4]
```

**Why little-endian?**

- Solana uses little-endian architecture
- Consistency with on-chain data layout
- Standard in Solana ecosystem

### Pubkeys to Bytes

```rust
// Pubkey to &[u8]
let pubkey: Pubkey = /* ... */;
let bytes = pubkey.as_ref();  // &[u8; 32]

// For owned bytes
let bytes = pubkey.to_bytes();  // [u8; 32]

// In seeds
seeds = [b"escrow", owner.key().as_ref()]
```

### Strings to Bytes

```rust
// Static strings
b"user-stats"  // &[u8; 10]

// Dynamic strings
let name = "alice";
let bytes = name.as_bytes();  // &[u8]
```

## Account Data Layouts

### Discriminator (8 bytes)

Every `#[account]` struct starts with 8-byte discriminator:

```rust
// Discriminator = hash("account:AccountName")[..8]
// Added automatically by #[account] macro
```

**Space calculation:**

```rust
#[account]
pub struct MyAccount {
    pub value: u64,  // 8 bytes
}

// Total space: 8 (discriminator) + 8 (value) = 16 bytes
space = 8 + 8
```

### Field Alignment

Anchor serializes fields in order:

```rust
#[account]
pub struct Example {
    pub a: u8,      // Offset 8 (after discriminator)
    pub b: u64,     // Offset 9
    pub c: Pubkey,  // Offset 17
}
// Total: 8 + 1 + 8 + 32 = 49 bytes
```

**No padding** - fields are packed sequentially.

### Dynamic Size Fields

```rust
#[account]
#[derive(InitSpace)]
pub struct Dynamic {
    pub fixed: u64,
    #[max_len(100)]
    pub name: String,      // 4 (length) + 100 (max bytes)
    #[max_len(10)]
    pub items: Vec<u32>,   // 4 (length) + (10 * 4)
}
```

**String:** 4 bytes length + max bytes  
**Vec:** 4 bytes length + (max count \* item size)

## Compute Unit Optimization

### Understanding Compute Units (CU)

Solana transactions have compute budget:

- Default: 200,000 CU per transaction
- Maximum: 1,400,000 CU (with compute budget program)

**Common operation costs:**

- Account read: ~1,000 CU
- Ed25519 verify: ~25,000 CU
- SHA256 hash: ~500 CU
- CPI: ~1,000 CU base + callee cost

### Optimization Strategies

**1. Minimize allocations:**

```rust
// Good - reuse buffers
let mut buffer = Vec::with_capacity(100);

// Avoid - allocating each time
for _ in 0..100 {
    let buffer = Vec::new();  // Expensive
}
```

**2. Use references:**

```rust
// Good
fn process(account: &Account<'info, MyAccount>) -> Result<()> { }

// Avoid copying
fn process_copy(account: Account<'info, MyAccount>) -> Result<()> { }
```

**3. Efficient deserialization:**

```rust
// Anchor handles this efficiently with Account<'info, T>
// Avoid manual deserialization unless necessary
```

**4. Batch operations:**

```rust
// Good - single transaction with multiple instructions
// Bad - multiple transactions

// In client:
const tx = new Transaction();
tx.add(instruction1, instruction2, instruction3);
```

## Memory Management

### Stack vs Heap in BPF

Solana's BPF VM has limited stack (4KB).

**For large structs, use Box:**

```rust
// Large struct
pub struct LargeData {
    pub array: [u8; 1000],
}

// Good - allocate on heap
let data = Box::new(LargeData { array: [0; 1000] });

// Avoid - stack overflow risk
let data = LargeData { array: [0; 1000] };
```

**Anchor accounts are heap-allocated automatically:**

```rust
#[account]
pub struct MyAccount {
    pub large_array: [u8; 1000],  // Heap-allocated via Account type
}
```

### Zero-Copy Deserialization

For very large accounts (>10KB), use zero-copy:

```rust
use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct LargeAccount {
    pub data: [u8; 100000],
}
```

**Benefits:**

- No deserialization cost
- Direct memory access
- Lower compute usage

**Trade-offs:**

- Unsafe access patterns
- Manual validation needed

**Reference:** [Anchor Zero-Copy](https://www.anchor-lang.com/docs/features/zero-copy)

## Working with AccountInfo

### When to Use AccountInfo

Use `AccountInfo` when you need:

- Direct lamport manipulation
- Raw data access
- Owner changes
- Advanced account operations

```rust
let account_info = ctx.accounts.account.to_account_info();

// Read lamports
let balance = account_info.lamports();

// Modify lamports (requires mut)
**account_info.lamports.borrow_mut() += 1000;

// Read data
let data = account_info.data.borrow();

// Check owner
if account_info.owner == &system_program::ID {
    // System-owned account
}
```

### Safety Considerations

```rust
// Unsafe - direct data manipulation
let mut data = account_info.data.borrow_mut();
data[0] = 42;  // Could corrupt discriminator!

// Safer - use typed Account
ctx.accounts.my_account.value = 42;
```

**Prefer typed accounts when possible.**

## Common Patterns for Escrow

### Nonce Serialization

```rust
pub fn submit_authorization(
    ctx: Context<Submit>,
    nonce: u64,
    // ...
) -> Result<()> {
    // Use in PDA derivation
    let seeds = [
        b"pending".as_ref(),
        ctx.accounts.escrow.key().as_ref(),
        &nonce.to_le_bytes(),  // u64 → [u8; 8]
    ];

    Ok(())
}
```

### Message Serialization for Signatures

```rust
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PaymentAuthorization {
    pub escrow: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

// Serialize for signing
let message = PaymentAuthorization { /* ... */ };
let bytes = message.try_to_vec()?;

// Client signs `bytes` with session key
// Program verifies signature against `bytes`
```

### Slot-Based Timeout Validation

```rust
pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        clock.slot >= ctx.accounts.pending.submitted_at_slot
            + ctx.accounts.escrow.refund_timeout_slots,
        ErrorCode::RefundWindowNotExpired
    );

    // Finalize settlement
    Ok(())
}
```

## Skill Loading Guidance

### Load This Skill When

- Implementing signature verification
- Working with slot-based timing
- Optimizing compute usage
- Serializing complex data structures
- Working with low-level account operations

### Related Skills

- **anchor-core** - For integration with Anchor patterns
- **anchor-pdas** - For byte conversions in seeds
- **anchor-security** - For security implications of timing

## Reference Links

### Official Documentation

- [Solana Rust Documentation](https://docs.rs/solana-program/latest/solana_program/)
- [Solana Clock Sysvar](https://docs.rs/solana-program/latest/solana_program/clock/struct.Clock.html)
- [Borsh Specification](https://borsh.io/)
- [Anchor Zero-Copy](https://www.anchor-lang.com/docs/features/zero-copy)

### Solana Architecture

- [Solana BPF](https://docs.solana.com/developing/on-chain-programs/overview)
- [Solana Compute Budget](https://docs.solana.com/developing/programming-model/runtime#compute-budget)

### Source Material

- Design document: `/docs/flex-solana.md` - Escrow-specific patterns
- Solana Program Library examples

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the rust-solana skill and understand Solana-specific Rust patterns for program development."
