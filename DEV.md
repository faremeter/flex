# Developer Notes

## Tools Required

- bun (v1.2 or newer)
- Rust (stable, via rustup)
- Anchor (v0.31 or newer)
- Solana CLI
- GNU make

## Setting Up Your Environment

0. Configure your git hooks:

```
git config core.hooksPath .githooks
```

1. Install TypeScript dependencies:

```
bun install
```

2. Build everything:

```
make
```

## Building

Build all packages (TypeScript and Anchor):

```
make build
```

Build TypeScript only:

```
make build-ts
```

Build Anchor program only:

```
make build-anchor
```

Build a specific TypeScript package:

```
make packages/<package-name>
```

## Linting

Run all lint checks:

```
make lint
```

TypeScript only:

```
make lint-ts
```

Rust only:

```
make lint-anchor
```

## Formatting

Auto-format all files:

```
make format
```

## Testing

Run all tests:

```
make test
```

TypeScript tests only:

```
make test-ts
```

Anchor tests only:

```
make test-anchor
```

## Clean

Remove build artifacts:

```
make clean
```

## Squads proposal lifecycle and time lock

- Squads v4 does NOT expire un-executed proposals. A fully approved proposal
  stays executable indefinitely unless cancelled or invalidated by a multisig
  config change.
- **Duplicate-proposal guard.** `bin/program-deploy` aborts hard if any open
  vault proposal already targets the program upgrade authority. There is no
  override flag. Operators resolve the existing proposal (execute or cancel)
  via the Squads UI before retrying.
- **Vault-stale quirk.** Changing multisig membership or threshold invalidates
  only un-approved proposals. An already-approved vault proposal remains
  executable across config changes. Operators MUST `proposal_cancel` before
  retiring members with in-flight upgrade approvals.
- **Time lock semantics.** Per-multisig, expressed in seconds; gates the
  Approved → Executable transition. Mainnet default: 86400 (24h). Devnet
  default: 0. Maximum: 7,776,000 (90 days).
