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
