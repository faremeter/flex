# Flex Code Conventions

This document describes the coding conventions, patterns, and best practices used in the Flex codebase. Follow these guidelines when contributing to ensure consistency across the project.

## Table of Contents

- [Repository Structure](#repository-structure)
- [Build and Development Commands](#build-and-development-commands)
- [Quick Reference](#quick-reference)
- [Philosophy](#philosophy)
- [Documentation](#documentation)
- [Git Workflow](#git-workflow)
- [TypeScript Conventions](#typescript-conventions)
- [Rust/Anchor Conventions](#rustanchor-conventions)

---

## Repository Structure

This is a hybrid TypeScript (bun) and Rust/Anchor project:

- **programs/** - Anchor programs (Rust)
- **packages/** - Shared TypeScript libraries
- **apps/** - TypeScript applications
- **tests/** - Integration tests
- **scripts/** - Utility scripts
- **skills/** - Agent skills for AI assistants
- **docs/** - Design documentation

Do not create standalone TypeScript files in the repository root.

---

## Build and Development Commands

```bash
# Full build pipeline (lint, build, test)
make

# Individual commands
make build         # Build all (TypeScript + Anchor)
make lint          # Run format/lint checks (both languages)
make test          # Run all tests
make format        # Auto-format all files
make clean         # Remove build artifacts

# Language-specific commands
make build-ts      # Build TypeScript only
make build-anchor  # Build Anchor program only
make lint-ts       # Lint TypeScript only
make lint-anchor   # Lint Rust only
```

See [DEV.md](./DEV.md) for complete development setup instructions.

---

## Quick Reference

### Do

- Always run `make` before considering changes complete or committing
- Use `import type` for type-only imports (TypeScript)
- Use `#[account]` for all program-owned data (Anchor)
- Create factory functions with `create*` prefix
- Return `null` from handlers when request doesn't match
- Use `{ cause }` when re-throwing errors
- Use the package logger, never `console` (TypeScript) or `println!` (Rust)
- Co-locate tests with source files
- Run `make format` before committing
- Let compilers infer types when obvious
- Prefix unused parameters with `_`

### Don't

- Mix refactors/whitespace changes with functional changes
- Use `console.log` (use logger) or `println!` (use `msg!`)
- Use default exports (TypeScript)
- Create classes unless necessary (prefer factory functions)
- Ignore validation errors (always check with `isValidationError`)
- Use `any` type (use `unknown` and narrow)
- Use type assertions (`as Type`) - they indicate interface problems
- Use `unwrap()` in production Rust code
- Skip runtime validation in favor of type assertions
- Commit without running `make lint`
- Over-type code with explicit annotations the compiler can infer

---

## Philosophy

The codebase follows these core principles:

- **Composability** - Components work together flexibly
- **Extensibility** - Easy to add new payment schemes and wallets
- **Standards Agnostic** - Support multiple payment standards (x402, L402, etc.)
- **Pragmatic** - Interface-driven design with loose coupling

Key design decisions:

- Prefer interfaces over concrete implementations
- Use plugins for payment handlers and wallet adapters
- Minimize dependencies between packages
- Enable developers to import only what they need

---

## Documentation

### Avoiding Redundant Comments

Code should be self-documenting. Do not add comments that describe what the code obviously does:

```typescript
// Bad - obvious comments
// Base configuration type for all backends
BaseConfigArgs = { level: LogLevel };

// Good - let code speak for itself
BaseConfigArgs = { level: LogLevel };
```

Decorative comment blocks (ASCII art dividers, section headers) add visual noise without providing meaningful information.

**Do not reference external tracking artifacts in code comments.** Comments like `// Issue 1: ...` or `// Fixes JIRA-1234` are meaningless to future readers who lack the context of the original tracking document. The code and its test names should be self-explanatory without cross-referencing external sources. An exception is URLs that point at long-lived resources (e.g., RFCs, specification documents, upstream bug reports).

**When comments ARE useful:**

- Complex algorithms that aren't immediately obvious
- Non-obvious workarounds or edge cases
- TODO/FIXME/XXX markers for future work
- Business logic that requires explanation

```typescript
// XXX - Temporary workaround until upstream fix
// TODO - Switch to newMethod when minimum version is bumped
result = await legacyMethod();
```

### Documentation Maintenance

When making changes to code, check whether related documentation needs updating:

- README files that reference changed functionality
- API documentation for modified interfaces
- Inline comments that describe changed behavior
- Configuration examples that no longer apply

Update documentation in the same commit as the code change, not as a separate task.

---

## Git Workflow

### Setup

Configure git hooks before making commits: `git config core.hooksPath .githooks`

### Commit Messages

- **Summary line**: Max 72 characters, non-empty
- **Blank line**: Required between summary and body (if body exists)
- **Body lines**: Max 72 characters each

Summary lines MUST be english sentences with no abbreviations, no markup (e.g. feat, chore), and not end with any punctuation. Commits messages should not be overly verbose. DO NOT include feature/change lists in the commit body; the code already shows this.

**Format:**

- Write concise messages (1-2 sentences) that explain why, not what
- Do not use bullet points or feature lists in commit messages
- Focus on the purpose and context of the change
- Do not include filenames in commit messages

**Good examples:**

```
Add retry logic for failed network requests

Fix race condition in transaction verification

Document API response format
```

**Bad examples:**

```
feat: add retry logic
Update code (too vague)
Fix bug in server.ts (includes filename)
```

### Commit Organization

- Separate refactoring from feature additions (distinct commits)
- Separate formatting/whitespace fixes from logical changes
- Each commit should represent one logical unit of work

### Build Verification

Always run the full build command (`make`) before declaring any task complete.

- Individual package builds do not guarantee the full tree will build
- Do not work around a failing build by running individual targets and treating their success as equivalent
- If the build fails, report the failure and identify the cause
- If the failure is pre-existing and unrelated to your changes, say so explicitly

Never silently skip a failing step or substitute a partial build.

---

## TypeScript Conventions

### TypeScript Configuration

The project uses strict TypeScript settings defined in [`tsconfig.base.json`](./tsconfig.base.json). Key implications:

- **Strict mode enabled**: All strict type-checking options are active
- **`noUncheckedIndexedAccess`**: Array/object index access may return `undefined`. Always check before using.
- **`exactOptionalPropertyTypes`**: Optional properties cannot be explicitly set to `undefined`.
- **`verbatimModuleSyntax`**: Use `import type` for type-only imports.
- **ESNext target**: Modern JavaScript features are available; no need for polyfills.

### Code Formatting

Formatting is enforced via Prettier. See [`.prettierrc.json`](./.prettierrc.json) for the configuration.

Key formatting rules:

- **Indentation**: 2 spaces (no tabs)
- **Quotes**: Double quotes `"` for strings
- **Semicolons**: Required
- **Trailing commas**: Always (including function parameters)

Run `make format` to auto-format all files.

### Naming Conventions

#### Files

| Type                | Convention                        | Example                                 |
| ------------------- | --------------------------------- | --------------------------------------- |
| Regular modules     | Lowercase, hyphens for multi-word | `token-payment.ts`, `server-express.ts` |
| Single-word modules | Lowercase                         | `solana.ts`, `common.ts`, `index.ts`    |
| Test files          | `{name}.test.ts`                  | `cache.test.ts`, `facilitator.test.ts`  |

#### Functions

| Pattern     | Use Case                       | Example                                         |
| ----------- | ------------------------------ | ----------------------------------------------- |
| `camelCase` | All functions                  | `handleMiddlewareRequest`                       |
| `create*`   | Factory functions              | `createFacilitatorHandler`, `createLocalWallet` |
| `is*`       | Boolean predicates             | `isValidationError`, `isKnownCluster`           |
| `get*`      | Retrieval without side effects | `getTokenBalance`, `getSupported`               |
| `lookup*`   | Search/lookup operations       | `lookupKnownSPLToken`, `lookupX402Network`      |
| `generate*` | Builder/generator functions    | `generateMatcher`, `generateDomain`             |
| `handle*`   | Event/request handlers         | `handleSettle`, `handleVerify`                  |

#### Variables

| Pattern                | Use Case                    | Example                                      |
| ---------------------- | --------------------------- | -------------------------------------------- |
| `camelCase`            | Regular variables           | `paymentRequiredResponse`, `recentBlockhash` |
| `SCREAMING_SNAKE_CASE` | Constants, environment vars | `X402_EXACT_SCHEME`, `PAYER_KEYPAIR_PATH`    |
| `_` prefix             | Unused parameters           | `_ctx`, `_unused`                            |

#### Acronyms in Names

When using acronyms in camelCase or PascalCase names, preserve the acronym's capitalization based on the position:

- **If the acronym starts with an uppercase letter**, keep it fully capitalized
- **If the acronym starts with a lowercase letter**, keep it fully lowercase

**Good:**

```typescript
// Acronyms at start of name
function getURLFromRequestInfo(input: RequestInfo | URL): string { ... }
const URLParser = { ... };

// Acronyms in middle/end of name (starts uppercase)
const requestURL = "https://example.com";
const parseHTTPHeaders = () => { ... };
```

**Bad:**

```typescript
// Don't mix case within acronyms when the leading character would be uppercase
function getUrlFromRequestInfo(input: RequestInfo | URL): string { ... } // Should be getURLFromRequestInfo
const requestUrl = "..."; // Should be requestURL
```

**Common acronyms to watch:** URL, HTTP, HTTPS, JSON, API, RPC, HTML, XML

**Note:** "ID" is an abbreviation (not an acronym), so use standard camelCase rules: `userId`, `requestId`, `getId()`.

#### Types and Interfaces

| Pattern           | Use Case                 | Example                                   |
| ----------------- | ------------------------ | ----------------------------------------- |
| `PascalCase`      | Interfaces, type aliases | `FacilitatorHandler`, `PaymentExecer`     |
| `lowercase`       | Protocol-specific types  | `x402PaymentRequirements`, `eip712Domain` |
| `*Args` / `*Opts` | Function arguments       | `CreatePaymentHandlerOpts`                |
| `*Response`       | API responses            | `x402SettleResponse`                      |
| `*Info`           | Data structures          | `ChainInfo`, `SPLTokenInfo`               |
| `*Handler`        | Handler interfaces       | `FacilitatorHandler`, `PaymentHandler`    |

### Type System Patterns

#### Runtime Validation with arktype

Use `arktype` for runtime type validation. Define the validator and TypeScript type together:

```typescript
import { type } from "arktype";

// Define runtime validator
export const x402PaymentRequirements = type({
  scheme: "string",
  network: "string",
  maxAmountRequired: "string.numeric",
  resource: "string.url",
});

// Derive TypeScript type from validator
export type x402PaymentRequirements = typeof x402PaymentRequirements.infer;
```

#### Type Guards

Create type guards using validation functions:

```typescript
import { isValidationError } from "@faremeter/types";

export function isAddress(maybe: unknown): maybe is Address {
  return !isValidationError(Address(maybe));
}
```

#### Interfaces vs Types

- **`type`**: Use for data structures, unions, and arktype-derived types
- **`interface`**: Use for behavioral contracts (objects with methods)

```typescript
// Type for data structure
export type RequestContext = {
  request: RequestInfo | URL;
};

// Interface for behavioral contract
export interface FacilitatorHandler {
  getSupported?: () => Promise<x402SupportedKind>[];
  getRequirements: (
    req: x402PaymentRequirements[],
  ) => Promise<x402PaymentRequirements[]>;
  handleSettle: (requirements, payment) => Promise<x402SettleResponse | null>;
}
```

#### Const Assertions for Exhaustive Types

Use `as const` for exhaustive literal types:

```typescript
const PaymentMode = {
  ToSpec: "toSpec",
  SettlementAccount: "settlementAccount",
} as const;

type PaymentMode = (typeof PaymentMode)[keyof typeof PaymentMode];
```

#### Type-Only Imports

Use `import type` for type-only imports (required by `verbatimModuleSyntax`):

```typescript
import type { x402PaymentRequirements } from "@faremeter/types/x402";
import type { Hex, Account } from "viem";

// Mixed imports
import {
  type Rpc,
  type Transaction,
  createTransactionMessage, // value import
} from "@solana/kit";
```

#### Avoid Over-Typing

Let TypeScript infer types when they are obvious:

```typescript
// Good - return type is obvious from the implementation
const createHandler = async (network: string) => {
  const config = { network, enabled: true };
  return {
    getConfig: () => config,
    isEnabled: () => config.enabled,
  };
};

// Unnecessary - the return type is obvious
const createHandler = async (
  network: string,
): Promise<{
  getConfig: () => { network: string; enabled: boolean };
  isEnabled: () => boolean;
}> => { ... };
```

**When to add explicit types:**

- Public API boundaries where the type serves as documentation
- When the inferred type would be too wide
- When TypeScript cannot infer the type correctly

#### Avoiding `any` and Type Assertions

The `any` type defeats TypeScript's type safety and should not be used unless absolutely required. Similarly, type assertions (`as Type`) are usually a sign of a problem with the interfaces being used.

**Bad - Using `any`:**

```typescript
function processData(data: any) {
  return data.value; // No type safety
}
```

**Good - Using `unknown` with validation:**

```typescript
function processData(data: unknown) {
  const validated = MyDataType(data);
  if (isValidationError(validated)) {
    throw new Error(`Invalid data: ${validated.summary}`);
  }
  return validated.value; // Type-safe
}
```

### Import/Export Patterns

#### Barrel Exports

Use `index.ts` files to re-export from modules:

```typescript
// packages/types/src/index.ts

// Namespaced exports for grouped functionality
export * as x402 from "./x402";
export * as client from "./client";
export * as solana from "./solana";

// Flat exports for utilities
export * from "./validation";
```

#### Named Exports (Preferred)

Prefer named exports over default exports:

```typescript
// Good
export function createMiddleware(args: CreateMiddlewareArgs) { ... }
export const X402_EXACT_SCHEME = "exact";

// Avoid
export default function createMiddleware(args: CreateMiddlewareArgs) { ... }
```

#### Import Ordering

Order imports by category:

1. External library imports
2. Internal package imports (`@faremeter/*`)
3. Relative imports

```typescript
// External libraries
import { type } from "arktype";
import { Hono } from "hono";

// Internal packages
import { isValidationError } from "@faremeter/types";
import type { FacilitatorHandler } from "@faremeter/types/facilitator";

// Relative imports
import { isValidTransaction } from "./verify";
import { logger } from "./logger";
```

### Error Handling

#### Validation Errors

Check arktype validation errors before proceeding:

```typescript
const paymentPayload = x402PaymentHeaderToPayload(paymentHeader);

if (isValidationError(paymentPayload)) {
  logger.debug(`couldn't validate client payload: ${paymentPayload.summary}`);
  return sendPaymentRequired();
}

// paymentPayload is now typed correctly
```

#### Error Chaining

Use `{ cause }` when re-throwing errors to preserve the error chain:

```typescript
try {
  transaction = paymentPayload.transaction;
} catch (cause) {
  throw new Error("Failed to get compiled transaction message", { cause });
}
```

#### Return `null` for "Not My Responsibility"

Handlers should return `null` when a request doesn't match their criteria:

```typescript
const handleVerify = async (requirements, payment) => {
  if (!isMatchingRequirement(requirements)) {
    return null; // Let another handler try
  }
  // Handle the request...
};
```

### Async Patterns

#### Factory Functions

Use async factory functions that return objects with async methods:

```typescript
export const createFacilitatorHandler = async (
  network: string,
  rpc: Rpc<SolanaRpcApi>,
  feePayerKeypair: Keypair,
  mint: PublicKey,
  config?: FacilitatorOptions,
): Promise<FacilitatorHandler> => {
  // Async initialization
  const mintInfo = await fetchMint(rpc, address(mint.toBase58()));

  // Return object with async methods
  return {
    getSupported,
    getRequirements,
    handleVerify,
    handleSettle,
  };
};
```

#### Parallel Execution

Use `Promise.all` for independent parallel operations:

```typescript
const [tokenName, tokenVersion] = await Promise.all([
  publicClient.readContract({ ...functionName: "name" }),
  publicClient.readContract({ ...functionName: "version" }),
]);
```

### Module Organization

Each package follows this structure:

```
packages/<name>/
├── package.json         # Package metadata and exports
├── tsconfig.json        # Extends tsconfig.base.json
├── README.md            # API documentation
└── src/
    ├── index.ts         # Public exports (barrel file)
    ├── internal.ts      # Internal utilities (optional)
    ├── common.ts        # Shared logic
    ├── logger.ts        # Package-specific logger
    ├── *.test.ts        # Tests co-located with source
    └── <feature>/       # Feature-specific subdirectories
```

### Testing

Tests use the `bun test` framework. Key patterns:

- Start test files with appropriate imports
- Use `describe` and `test` blocks
- Co-locate tests with source files (`*.test.ts`)

### Logging

Use the package logger, never `console`:

```typescript
import { logger } from "./logger";

logger.info("Server started");
logger.debug("Processing request");
logger.error("Failed to connect");
```

### ESLint Rules

Key rules and their implications:

- **No console**: `console.log` and similar are errors. Use the package logger instead.
- **Unused variables**: Must be prefixed with `_` (e.g., `_ctx`, `_unused`).

---

## Rust/Anchor Conventions

### Cargo Configuration

The project uses Rust edition 2021 with strict clippy settings.

### Code Formatting

Formatting is enforced via rustfmt. See [`rustfmt.toml`](./rustfmt.toml) for the configuration.

Key formatting rules:

- **Indentation**: 4 spaces (no tabs)
- **Max line width**: 100 characters

Run `cargo fmt` or `make format-anchor` to auto-format Rust files.

### Naming Conventions

#### Files and Modules

| Type       | Convention | Example                           |
| ---------- | ---------- | --------------------------------- |
| Modules    | snake_case | `escrow_account.rs`, `session.rs` |
| Test files | snake_case | `escrow_test.rs`                  |

#### Functions and Variables

| Pattern           | Use Case             | Example                            |
| ----------------- | -------------------- | ---------------------------------- |
| `snake_case`      | Functions, variables | `create_escrow`, `last_nonce`      |
| `SCREAMING_SNAKE` | Constants            | `MAX_TIMEOUT_SLOTS`, `SEED_PREFIX` |
| `_` prefix        | Unused parameters    | `_ctx`, `_bump`                    |

#### Types

| Pattern     | Use Case               | Example                       |
| ----------- | ---------------------- | ----------------------------- |
| `CamelCase` | Structs, enums, traits | `EscrowAccount`, `SessionKey` |
| `CamelCase` | Type aliases           | `Result<T>`, `ProgramResult`  |

#### Acronyms in Names

Follow the same rules as TypeScript - preserve acronym capitalization:

```rust
// Good
struct PDASigner { ... }
fn get_rpc_url() -> String { ... }
const MAX_URL_LENGTH: usize = 256;

// Bad
struct PdaSigner { ... }  // Should be PDASigner
fn get_rpc_Url() -> String { ... }  // Should be get_rpc_url
```

### Type System Patterns

#### Account Validation with Anchor

Use Anchor's constraint system for validation:

```rust
#[derive(Accounts)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", owner.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub system_program: Program<'info, System>,
}
```

#### Account Data Structures

Use `#[account]` for all program-owned data and `#[derive(InitSpace)]` for space calculation:

```rust
#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub owner: Pubkey,
    pub facilitator: Pubkey,
    pub last_nonce: u64,
    pub pending_count: u64,
    pub bump: u8,
}
```

#### PDA Patterns

Store PDA bumps in account data and use canonical bumps:

```rust
#[account(
    seeds = [b"escrow", owner.key().as_ref(), &escrow.index.to_le_bytes()],
    bump = escrow.bump,
)]
pub escrow: Account<'info, EscrowAccount>,
```

#### Avoiding Unsafe

Do not use `unsafe` blocks unless absolutely necessary. If required, document why thoroughly.

### Error Handling

#### Custom Error Codes

Define comprehensive error codes starting at 6000:

```rust
#[error_code]
pub enum FlexError {
    #[msg("Session key has expired")]
    SessionKeyExpired = 6000,

    #[msg("Session key revoked and grace period elapsed")]
    SessionKeyRevoked = 6001,

    #[msg("Nonce not strictly greater than last nonce")]
    InvalidNonce = 6002,

    #[msg("Ed25519 signature verification failed")]
    InvalidSignature = 6003,
}
```

#### Using require! Macros

Use `require!` for validation checks:

```rust
require!(
    nonce > escrow.last_nonce,
    FlexError::InvalidNonce
);

require!(
    session_key.active,
    FlexError::SessionKeyRevoked
);
```

#### Error Context

Add context when propagating errors:

```rust
let mint_info = fetch_mint(rpc, mint_address)
    .map_err(|e| error!(FlexError::InvalidMint).with_source(e))?;
```

### Module Organization

#### lib.rs Structure

Organize the main library file clearly:

```rust
use anchor_lang::prelude::*;

mod error;
mod instructions;
mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("...");

#[program]
pub mod flex {
    use super::*;

    pub fn create_escrow(ctx: Context<CreateEscrow>, ...) -> Result<()> {
        instructions::create_escrow(ctx, ...)
    }
}
```

#### CPI Code Organization

Organize CPI code in `impl` blocks:

```rust
impl<'info> Deposit<'info> {
    pub fn transfer_to_vault(&self, amount: u64) -> Result<()> {
        let cpi_accounts = Transfer {
            from: self.source.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.depositor.to_account_info(),
        };
        let cpi_program = self.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)
    }
}
```

### Testing

Use Anchor's test framework with TypeScript tests:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Flex } from "../target/types/flex";

describe("flex", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Flex as Program<Flex>;

  it("creates an escrow account", async () => {
    // Test implementation
  });
});
```

### Logging

Use the `msg!` macro for on-chain logging, never `println!`:

```rust
msg!("Creating escrow for owner: {}", owner.key());
msg!("Nonce: {}, Amount: {}", nonce, amount);
```

### Security

For detailed security patterns, always load the `anchor-security` skill when writing or reviewing Anchor code. Key requirements:

- Validate all account relationships with `has_one` or constraints
- Use typed accounts (`Account<'info, T>`) for ownership validation
- Check for duplicate mutable accounts
- Use canonical PDA bumps
- Validate program IDs for CPIs
- Properly close accounts with `close` constraint
- Enforce nonce monotonicity
- Validate time-based constraints with slots
- Add `/// CHECK:` comments for `UncheckedAccount`

---

## Code Reuse and Refactoring

Do not reimplement functionality that already exists in the codebase. Before writing new code:

1. Search for existing implementations that could serve the same purpose
2. If similar functionality exists, prefer refactoring it to meet the new requirements
3. Look for unexported functions in other packages that could be promoted to a shared location

When a refactor might be necessary, prompt with specific options:

- Refactor the existing implementation
- Promote an unexported function to a shared package
- Create a new implementation

Allow for custom answers if none of the options fit.

---

## External Code Attribution

Any code from outside the organization requires careful attribution and licensing compliance:

1. **License verification**: Check that the license is compatible with your project
2. **Isolated commit**: Place external code in its own commit without any modifications
3. **Complete attribution**: Include in the commit message:
   - Original source URL or reference
   - Author/copyright information
   - License type
   - Date retrieved

If modifications to external code are needed, make them in a separate follow-up commit.

---

## Configuration Files

Do not modify configuration files (e.g. eslint, prettier, rustfmt, clippy) unless explicitly asked. Focus on writing working software, not changing the conventions that are being used.

Keep consistent even if we disagree; if we decide to change a style, make it an explicit decision and discussion, not a side effect of other work.

---

## Personality

Do not use emojis in code or documentation. Act professionally.
