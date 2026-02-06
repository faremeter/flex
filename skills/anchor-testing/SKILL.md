---
name: anchor-testing
description: Testing strategies for Anchor programs including unit tests, integration tests, and transaction simulation. Load when writing or reviewing tests for Anchor programs.
---

# Anchor Testing

Testing patterns and strategies for Anchor programs using TypeScript/JavaScript clients. Covers test setup, account creation, instruction calls, assertions, and error testing.

## Quick Reference

### Basic Test Structure

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { MyProgram } from "../target/types/my_program";

describe("my-program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MyProgram as Program<MyProgram>;

  it("Initializes account", async () => {
    // Test implementation
  });
});
```

### Calling Instructions

```typescript
await program.methods
  .initialize(arg1, arg2)
  .accounts({
    account1: publicKey1,
    account2: publicKey2,
  })
  .signers([keypair])
  .rpc();
```

### PDA Derivation in Tests

```typescript
const [pda, bump] = await PublicKey.findProgramAddress(
  [
    Buffer.from("seed"),
    user.publicKey.toBuffer(),
  ],
  program.programId
);
```

### Fetching and Asserting

```typescript
const account = await program.account.myAccount.fetch(publicKey);
expect(account.value).to.equal(42);
```

## Test Environment Setup

**Source:** Working examples from [Anchor Book](https://github.com/coral-xyz/anchor-book)

### Provider and Program Access

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MyProgram } from "../target/types/my_program";

describe("my-program", () => {
  // Get provider from environment
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Access program from workspace
  const program = anchor.workspace.MyProgram as Program<MyProgram>;

  // Provider wallet
  const wallet = provider.wallet;
});
```

**What provider gives you:**
- Connection to Solana cluster
- Wallet for signing transactions
- Configuration for tests

### Accessing Multiple Programs

```typescript
const puppetProgram = anchor.workspace.Puppet as Program<Puppet>;
const puppetMasterProgram = anchor.workspace.PuppetMaster as Program<PuppetMaster>;
```

**Use when:** Testing CPIs between programs

## Account Setup

### Generating Keypairs

```typescript
import { Keypair } from "@solana/web3.js";

const myAccount = Keypair.generate();
const authority = Keypair.generate();
```

**Use for:** Accounts that need to be created (not PDAs)

### Deriving PDAs

```typescript
const [userStatsPDA, bump] = await PublicKey.findProgramAddress(
  [
    Buffer.from("user-stats"),
    user.publicKey.toBuffer(),
  ],
  program.programId
);
```

**Seed encoding:**
- Strings: `Buffer.from("string")` or `anchor.utils.bytes.utf8.encode("string")`
- Pubkeys: `.toBuffer()`
- Numbers: `Buffer.from(num.toString())` or converted to bytes

**Complete working example source:** [Anchor Book - PDA Test](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md)

### Funding Test Accounts

```typescript
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

// Request airdrop (localnet/devnet only)
await provider.connection.requestAirdrop(
  keypair.publicKey,
  LAMPORTS_PER_SOL
);

// Wait for confirmation
await new Promise(resolve => setTimeout(resolve, 1000));
```

## Calling Instructions

### Basic Pattern

```typescript
await program.methods
  .initialize(arg1, arg2)  // Handler function name and args
  .accounts({
    account1: publicKey1,
    account2: publicKey2,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .rpc();  // Send and confirm transaction
```

### With Signers

```typescript
await program.methods
  .initialize()
  .accounts({
    newAccount: myKeypair.publicKey,
    user: provider.wallet.publicKey,
  })
  .signers([myKeypair])  // Additional signers beyond wallet
  .rpc();
```

### Transaction vs RPC

```typescript
// RPC - sends and confirms automatically
await program.methods.initialize().accounts({...}).rpc();

// Transaction - build transaction for custom handling
const tx = await program.methods.initialize().accounts({...}).transaction();
// Sign and send manually
```

## Testing PDAs

**Source:** [Anchor Book - PDA Testing](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md)

### Complete PDA Test Example

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Game } from "../target/types/game";
import { expect } from "chai";

describe("game", async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Game as Program<Game>;

  it("Sets and changes name!", async () => {
    // Derive PDA
    const [userStatsPDA, _] = await PublicKey.findProgramAddress(
      [
        anchor.utils.bytes.utf8.encode("user-stats"),
        provider.wallet.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Initialize
    await program.methods
      .createUserStats("brian")
      .accounts({
        user: provider.wallet.publicKey,
        userStats: userStatsPDA,
      })
      .rpc();

    // Verify
    expect((await program.account.userStats.fetch(userStatsPDA)).name).to.equal(
      "brian"
    );

    // Update
    await program.methods
      .changeUserName("tom")
      .accounts({
        user: provider.wallet.publicKey,
        userStats: userStatsPDA,
      })
      .rpc();

    // Verify again
    expect((await program.account.userStats.fetch(userStatsPDA)).name).to.equal(
      "tom"
    );
  });
});
```

**Key patterns:**
- PDA derived client-side
- Same PDA used for init and update
- Fetch account to verify state changes

## Testing CPIs

**Source:** [Anchor Book - CPI Testing](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/CPIs.md)

### Multi-Program Test

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { Puppet } from "../target/types/puppet";
import { PuppetMaster } from "../target/types/puppet_master";

describe("puppet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const puppetProgram = anchor.workspace.Puppet as Program<Puppet>;
  const puppetMasterProgram = anchor.workspace
    .PuppetMaster as Program<PuppetMaster>;

  const puppetKeypair = Keypair.generate();

  it("Does CPI!", async () => {
    // Initialize puppet account
    await puppetProgram.methods
      .initialize()
      .accounts({
        puppet: puppetKeypair.publicKey,
        user: provider.wallet.publicKey,
      })
      .signers([puppetKeypair])
      .rpc();

    // Call puppet-master which does CPI to puppet
    await puppetMasterProgram.methods
      .pullStrings(new anchor.BN(42))
      .accounts({
        puppetProgram: puppetProgram.programId,
        puppet: puppetKeypair.publicKey,
      })
      .rpc();

    // Verify CPI worked
    expect(
      (
        await puppetProgram.account.data.fetch(puppetKeypair.publicKey)
      ).data.toNumber()
    ).to.equal(42);
  });
});
```

**Validates:**
- CPI correctly invokes target program
- State changes persist across programs
- Correct program IDs used

## Fetching Account Data

### Fetch Account

```typescript
const account = await program.account.myAccount.fetch(publicKey);
```

**Returns:** Deserialized account data matching your `#[account]` struct

### Fetch Multiple Accounts

```typescript
const accounts = await program.account.myAccount.all();
```

**Returns:** Array of all accounts of this type

### Fetch with Filters

```typescript
const accounts = await program.account.myAccount.all([
  {
    memcmp: {
      offset: 8,  // After discriminator
      bytes: anchor.utils.bytes.bs58.encode(authorityPublicKey.toBuffer()),
    }
  }
]);
```

**Use for:** Finding accounts by field values

## Assertions

### Using Chai

```typescript
import { expect } from "chai";

// Equality
expect(account.value).to.equal(42);

// Pubkey equality
expect(account.authority.toString()).to.equal(
  authority.publicKey.toString()
);

// Boolean
expect(account.initialized).to.be.true;

// Greater than
expect(account.balance).to.be.greaterThan(0);

// Array/object matching
expect(account.data).to.deep.equal({ field: value });
```

### BigNumber Assertions

```typescript
// Convert to number for comparison
expect(account.amount.toNumber()).to.equal(1000);

// Or use BN equality
expect(account.amount.eq(new anchor.BN(1000))).to.be.true;
```

## Error Testing

### Expecting Errors

```typescript
import { assert } from "chai";

try {
  await program.methods
    .invalidOperation()
    .accounts({...})
    .rpc();
  
  assert.fail("Expected error was not thrown");
} catch (error) {
  // Error was thrown as expected
  expect(error.message).to.include("custom error message");
}
```

### Testing Anchor Errors

```typescript
it("Fails with InvalidAmount error", async () => {
  try {
    await program.methods
      .transfer(0)  // Invalid amount
      .accounts({...})
      .rpc();
    
    assert.fail("Should have thrown InvalidAmount error");
  } catch (error) {
    // Check error code
    expect(error.error.errorCode.code).to.equal("InvalidAmount");
    expect(error.error.errorCode.number).to.equal(6000);
    expect(error.error.errorMessage).to.include("Amount must be greater than zero");
  }
});
```

### Testing Constraint Failures

```typescript
it("Fails when unauthorized", async () => {
  const unauthorizedKeypair = Keypair.generate();
  
  try {
    await program.methods
      .restrictedOperation()
      .accounts({
        account: accountPubkey,
        authority: unauthorizedKeypair.publicKey,
      })
      .signers([unauthorizedKeypair])
      .rpc();
    
    assert.fail("Should have failed authorization check");
  } catch (error) {
    expect(error).to.exist;
  }
});
```

## Testing Patterns for Escrow

### Testing Escrow Creation

```typescript
it("Creates escrow account", async () => {
  const [escrowPDA] = await PublicKey.findProgramAddress(
    [
      Buffer.from("escrow"),
      owner.publicKey.toBuffer(),
    ],
    program.programId
  );

  await program.methods
    .createEscrow(facilitator.publicKey, refundTimeout, deadmanTimeout)
    .accounts({
      escrow: escrowPDA,
      owner: owner.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([owner])
    .rpc();

  const escrow = await program.account.escrowAccount.fetch(escrowPDA);
  expect(escrow.owner.toString()).to.equal(owner.publicKey.toString());
  expect(escrow.facilitator.toString()).to.equal(facilitator.publicKey.toString());
  expect(escrow.pendingCount.toNumber()).to.equal(0);
});
```

### Testing Session Key Registration

```typescript
it("Registers session key", async () => {
  const sessionKey = Keypair.generate();
  
  const [sessionKeyPDA] = await PublicKey.findProgramAddress(
    [
      Buffer.from("session"),
      escrowPDA.toBuffer(),
      sessionKey.publicKey.toBuffer(),
    ],
    program.programId
  );

  await program.methods
    .registerSessionKey(
      sessionKey.publicKey,
      null,  // No expiration
      1000   // Grace period
    )
    .accounts({
      escrow: escrowPDA,
      sessionKey: sessionKeyPDA,
      owner: owner.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([owner])
    .rpc();

  const sessionKeyAccount = await program.account.sessionKey.fetch(sessionKeyPDA);
  expect(sessionKeyAccount.active).to.be.true;
});
```

### Testing Nonce Validation

```typescript
it("Enforces monotonic nonces", async () => {
  const validNonce = 1;
  const invalidNonce = 0;

  // First submission should work
  await program.methods
    .submitAuthorization(/* ... */, validNonce, /* ... */)
    .accounts({...})
    .rpc();

  // Second submission with lower nonce should fail
  try {
    await program.methods
      .submitAuthorization(/* ... */, invalidNonce, /* ... */)
      .accounts({...})
      .rpc();
    
    assert.fail("Should have rejected invalid nonce");
  } catch (error) {
    expect(error.error.errorCode.code).to.equal("InvalidNonce");
  }
});
```

### Testing Time-Based Logic

```typescript
it("Enforces refund window", async () => {
  // Submit authorization
  await program.methods
    .submitAuthorization(/* ... */)
    .accounts({...})
    .rpc();

  // Try to finalize immediately (should fail)
  try {
    await program.methods
      .finalize()
      .accounts({...})
      .rpc();
    
    assert.fail("Should enforce refund window");
  } catch (error) {
    expect(error.error.errorCode.code).to.equal("RefundWindowNotExpired");
  }

  // Note: Advancing time in tests requires special test framework support
  // In production tests, you might need to use mock time or wait
});
```

## Test Organization

### Grouping Related Tests

```typescript
describe("escrow-program", () => {
  describe("Escrow Creation", () => {
    it("Creates escrow with correct parameters", async () => {});
    it("Fails when facilitator is invalid", async () => {});
  });

  describe("Session Keys", () => {
    it("Registers session key", async () => {});
    it("Revokes session key", async () => {});
    it("Enforces grace period", async () => {});
  });

  describe("Settlements", () => {
    it("Submits authorization", async () => {});
    it("Finalizes after refund window", async () => {});
    it("Processes refunds", async () => {});
  });
});
```

### Setup and Teardown

```typescript
describe("escrow-program", () => {
  let escrowPDA: PublicKey;
  let owner: Keypair;
  let facilitator: Keypair;

  before(async () => {
    // One-time setup
    owner = Keypair.generate();
    facilitator = Keypair.generate();
  });

  beforeEach(async () => {
    // Before each test
    escrowPDA = await createEscrow(owner, facilitator);
  });

  it("Test 1", async () => {});
  it("Test 2", async () => {});
});
```

### Reusable Test Helpers

```typescript
async function createEscrow(
  owner: Keypair,
  facilitator: Keypair
): Promise<PublicKey> {
  const [escrowPDA] = await PublicKey.findProgramAddress(
    [Buffer.from("escrow"), owner.publicKey.toBuffer()],
    program.programId
  );

  await program.methods
    .createEscrow(facilitator.publicKey, 100, 1000)
    .accounts({
      escrow: escrowPDA,
      owner: owner.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([owner])
    .rpc();

  return escrowPDA;
}

async function registerSessionKey(
  escrowPDA: PublicKey,
  owner: Keypair
): Promise<PublicKey> {
  // Helper implementation
}
```

## Testing Frameworks

**Source:** [Anchor Testing Documentation](https://www.anchor-lang.com/docs/testing)

### Default: Mocha + Chai

Anchor projects use Mocha by default:

```json
{
  "scripts": {
    "test": "anchor test"
  }
}
```

### LiteSVM

Fast testing with minimal dependencies:

```typescript
// Requires anchor test framework configuration
// See: https://www.anchor-lang.com/docs/testing/litesvm
```

### Mollusk

Rust-native testing (not TypeScript):

```rust
// Rust tests in programs/*/tests/
// See: https://www.anchor-lang.com/docs/testing/mollusk
```

## Best Practices

### Test Coverage

Cover these scenarios:
- **Happy path:** Normal operation
- **Edge cases:** Boundary conditions
- **Error cases:** Invalid inputs, unauthorized access
- **State transitions:** Account lifecycle
- **Security:** Authorization, validation

### Independent Tests

Each test should:
- Set up its own state
- Not depend on other tests
- Clean up after itself (or use fresh accounts)

### Clear Test Names

```typescript
// Good - describes what is being tested
it("Rejects authorization with invalid nonce", async () => {});
it("Transfers tokens to merchant after refund window", async () => {});

// Bad - vague or unclear
it("Test 1", async () => {});
it("Works", async () => {});
```

### Arrange-Act-Assert Pattern

```typescript
it("Updates account value", async () => {
  // Arrange - set up
  const account = await createAccount();
  const newValue = 42;
  
  // Act - perform action
  await program.methods
    .update(newValue)
    .accounts({ account: account.publicKey })
    .rpc();
  
  // Assert - verify result
  const updatedAccount = await program.account.data.fetch(account.publicKey);
  expect(updatedAccount.value).to.equal(newValue);
});
```

## Skill Loading Guidance

### Load This Skill When
- Writing tests for Anchor programs
- Reviewing test coverage
- Debugging test failures
- Setting up test infrastructure
- Testing complex scenarios (escrow, vaults, etc.)

### Related Skills
- **anchor-core** - For understanding program structure being tested
- **anchor-pdas** - For testing PDA derivation
- **anchor-cpis** - For testing cross-program invocations
- **anchor-token-operations** - For testing token operations

## Reference Links

### Official Documentation
- [Anchor Testing Documentation](https://www.anchor-lang.com/docs/testing)
- [Anchor Testing - LiteSVM](https://www.anchor-lang.com/docs/testing/litesvm)
- [Anchor Testing - Mollusk](https://www.anchor-lang.com/docs/testing/mollusk)

### Source Material
- [Anchor Book - Testing Examples](https://github.com/coral-xyz/anchor-book) - Working test examples throughout
- [Anchor Book - PDA Tests](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/PDAs.md)
- [Anchor Book - CPI Tests](https://github.com/coral-xyz/anchor-book/blob/master/src/anchor_in_depth/CPIs.md)

### Testing Frameworks
- [Mocha Documentation](https://mochajs.org/)
- [Chai Assertion Library](https://www.chaijs.com/)

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the anchor-testing skill and understand how to write comprehensive tests for Anchor programs."
