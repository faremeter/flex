# Anchor/Solana Skills for Flex Payment Scheme

Skills for implementing the Flex Payment Scheme escrow on Solana using Anchor.

## Discovery

Skills are in subdirectories with `SKILL.md` files. Each skill has YAML frontmatter with `name` and `description` fields that indicate when to load it.

Glob pattern: `skills/*/SKILL.md`

## Source Material

Skills are built from:
- [Anchor Documentation](https://www.anchor-lang.com/docs)
- [Anchor Book](https://github.com/coral-xyz/anchor-book)
- [Sealevel Attacks](https://github.com/coral-xyz/sealevel-attacks)
- Project design: `/docs/flex-solana.md`

## Maintenance

Update skills when:
- Anchor framework introduces new patterns
- New security vulnerabilities are discovered
- Project requirements change
