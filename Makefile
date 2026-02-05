export PATH := $(PWD)/bin:$(PATH)
export INSIDE_STAGING_DIR := false

.PHONY: all build lint test format clean FORCE

all: lint build test

# TypeScript targets
pre-build-ts:
	rm -f .eslintcache .build-finished

build-ts: pre-build-ts $(wildcard packages/*) $(wildcard apps/*)
	touch .build-finished

lint-ts:
	bun prettier --check .
	bun eslint --cache .

format-ts:
	bun prettier --write .

test-ts:
	bun test

packages/%: FORCE
	cd $@ && rm -rf dist && bun run tsc

apps/%: FORCE
	cd $@ && rm -rf dist && bun run tsc

scripts: FORCE
	cd scripts && rm -rf dist && bun run tsc

tests: FORCE
	cd tests && bun run tsc

# Rust/Anchor targets
build-anchor:
	anchor build

lint-anchor:
	cargo fmt --check
	cargo clippy -- -D warnings

format-anchor:
	cargo fmt

test-anchor:
	anchor test

# Combined targets
build: build-ts build-anchor

lint: lint-ts lint-anchor

format: format-ts format-anchor

test: test-ts test-anchor

clean:
	rm -f .eslintcache .build-finished
	rm -rf node_modules
	find . -type d -name "dist" -a ! -path '*/node_modules/*' | xargs rm -rf
	anchor clean

FORCE:
