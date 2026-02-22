# Agent Instructions for Flex Payment Scheme

## Session Initialization

Before responding to the user's first message in any session, complete the following steps in order:

1. **Load the `style` skill** (from global skills)
2. **Read `CONVENTIONS.md`** and follow all conventions defined there
3. **Review local Anchor/Solana skills** in `/skills/` directory
4. **Read metadata from all local skills** to understand what patterns are available

### Local Skills Discovery

This repository contains comprehensive Anchor/Solana skills in the `/skills/` directory. These skills must be understood at the start of every session before proceeding with any Anchor/Solana development work.

**Critical:** The local skills contain essential security patterns, implementation guides, and best practices specific to this project's Solana escrow program. Not reviewing these skills before development could result in security vulnerabilities or incorrect implementations.

### Session Start Procedure

At the beginning of each session:

1. **Read `CONVENTIONS.md`** to understand coding conventions for both TypeScript and Rust/Anchor
2. **Glob for available skills** using the pattern `skills/*/SKILL.md`
3. **Read the skills README** at `skills/README.md` to understand what each skill covers
4. **Acknowledge the available skills** with a message like:
   ```
   I have reviewed the style skill and discovered the local Anchor/Solana skills in /skills/.
   Available skills: [list discovered skills]
   I understand this project implements the Flex Payment Scheme escrow on Solana
   and will follow the security patterns and best practices documented in the skills.
   ```
5. When user asks to implement Anchor code, load the appropriate skills based on the task
6. **Always prioritize loading security-related skills** when writing or reviewing Anchor code

### Important Notes

- **Security First:** Any security-related skill must ALWAYS be loaded when writing or reviewing Anchor programs
- **Local Skills Take Precedence:** These skills contain project-specific patterns that override general Anchor knowledge
- **Dynamic Discovery:** Skills may be added, removed, or renamed - always glob to discover current skills
- **Check README First:** The `skills/README.md` provides an overview of all available skills and their purposes

## Project-Specific Guidelines

### This is the Flex Payment Scheme

This project implements a prepaid escrow account system on Solana for the x402 payment protocol. Key features:

- **Dual Authorization:** Client session keys + facilitator signatures
- **Nonce-Based Replay Protection:** Monotonically increasing nonces
- **Slot-Based Timeouts:** Refund windows and deadman switches
- **Multi-Mint Support:** One escrow, multiple token vaults
- **Session Key System:** Off-chain signatures with on-chain validation

Design documents:

- `/README.md` - Scheme overview
- `/docs/flex-solana.md` - Solana implementation details

### Security is Non-Negotiable

When writing Anchor code:

- ✅ Always load `anchor-security` skill
- ✅ Validate all account relationships with `has_one` or constraints
- ✅ Use typed accounts (`Account<'info, T>`) for ownership validation
- ✅ Check for duplicate mutable accounts
- ✅ Use canonical PDA bumps
- ✅ Validate program IDs for CPIs
- ✅ Properly close accounts with `close` constraint
- ✅ Enforce nonce monotonicity
- ✅ Validate time-based constraints with slots

### Code Quality Standards

Follow the patterns in the skills:

- Use `#[account]` for all program-owned data
- Use `#[derive(InitSpace)]` for space calculation
- Organize CPI code in `impl` blocks
- Store PDA bumps in account data
- Use `require!` macros for validation
- Define comprehensive error codes starting at 6000
- Add `/// CHECK:` comments for `UncheckedAccount`

## DO NOT DO THIS BEFORE YOU'VE DONE ALL STEPS OF THE ABOVE

I'M SUPER SERIOUS.
