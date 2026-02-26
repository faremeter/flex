import { describe, it, expect, beforeAll } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import type { Flex } from "../../target/types/flex";
import {
  fundKeypair,
  createFundedTokenAccount,
  submitAuthorizationHelper,
  setupEscrowWithPending,
  setupEscrowForAuth,
  refundHelper,
  finalizeHelper,
} from "./helpers";

describe("submit_authorization", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();
  const payer = (provider.wallet as anchor.Wallet).payer;

  beforeAll(async () => {
    await fundKeypair(provider, owner);
    await fundKeypair(provider, facilitator);
  });

  it("creates pending settlement with correct fields", async () => {
    const { escrowPDA, mint, pendingPDA, sessionKey, splits } =
      await setupEscrowWithPending(
        program,
        provider,
        owner,
        facilitator,
        payer,
        100,
        { settleAmount: 50_000 },
      );

    const pending = await program.account.pendingSettlement.fetch(pendingPDA);
    expect(pending.version).toBe(1);
    expect(pending.escrow.toBase58()).toBe(escrowPDA.toBase58());
    expect(pending.mint.toBase58()).toBe(mint.toBase58());
    expect(pending.amount.toNumber()).toBe(50_000);
    expect(pending.originalAmount.toNumber()).toBe(50_000);
    expect(pending.maxAmount.toNumber()).toBe(50_000);
    expect(pending.nonce.toNumber()).toBe(1);
    expect(pending.submittedAtSlot.toNumber()).toBeGreaterThan(0);
    expect(pending.sessionKey.toBase58()).toBe(sessionKey.publicKey.toBase58());
    expect(pending.splitCount).toBe(1);
    expect(pending.splits[0]!.recipient.toBase58()).toBe(
      splits[0]!.recipient.toBase58(),
    );
    expect(pending.splits[0]!.bps).toBe(10_000);
    expect(pending.bump).toBeGreaterThan(0);
  });

  it("updates last_nonce and last_activity_slot on escrow", async () => {
    const { escrowPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      101,
      { nonce: 42 },
    );

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.lastNonce.toNumber()).toBe(42);
    expect(escrow.lastActivitySlot.toNumber()).toBeGreaterThan(0);
  }, 15_000);

  it("fails with invalid nonce", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        103,
      );

    const recipient = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const splits = [{ recipient, bps: 10_000 }];

    await submitAuthorizationHelper(
      program,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      2,
      100_000,
      splits,
    );

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        100_000,
        splits,
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("InvalidNonce");
    }
  });

  it("fails when pending limit reached", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        104,
        { depositAmount: 10_000_000 },
      );

    const recipient = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const splits = [{ recipient, bps: 10_000 }];

    for (let i = 1; i <= 16; i++) {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        i,
        1_000,
        splits,
      );
    }

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        17,
        1_000,
        splits,
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("PendingLimitReached");
    }
  }, 60_000);

  it("fails with insufficient vault balance", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        105,
        { depositAmount: 1_000 },
      );

    const recipient = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        2_000,
        [{ recipient, bps: 10_000 }],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("InsufficientBalance");
    }
  });

  it("fails with split bps not summing to 10000", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        106,
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r2 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        100_000,
        [
          { recipient: r1, bps: 5_000 },
          { recipient: r2, bps: 4_000 },
        ],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("InvalidSplitBps");
    }
  });

  it("fails with zero bps entry", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        107,
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r2 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        100_000,
        [
          { recipient: r1, bps: 10_000 },
          { recipient: r2, bps: 0 },
        ],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("SplitBpsZero");
    }
  });

  it("fails with duplicate split recipients", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        108,
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    try {
      await submitAuthorizationHelper(
        program,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        100_000,
        [
          { recipient: r1, bps: 7_000 },
          { recipient: r1, bps: 3_000 },
        ],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("DuplicateSplitRecipient");
    }
  });

  it("works with single-recipient split", async () => {
    const { pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      109,
      { settleAmount: 200_000 },
    );

    const pending = await program.account.pendingSettlement.fetch(pendingPDA);
    expect(pending.splitCount).toBe(1);
    expect(pending.splits[0]!.bps).toBe(10_000);
    expect(pending.amount.toNumber()).toBe(200_000);
  });

  it("works with multi-recipient split", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        110,
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r2 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    const splits = [
      { recipient: r1, bps: 7_000 },
      { recipient: r2, bps: 3_000 },
    ];

    const pendingPDA = await submitAuthorizationHelper(
      program,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      100_000,
      splits,
    );

    const pending = await program.account.pendingSettlement.fetch(pendingPDA);
    expect(pending.splitCount).toBe(2);
    expect(pending.splits[0]!.recipient.toBase58()).toBe(r1.toBase58());
    expect(pending.splits[0]!.bps).toBe(7_000);
    expect(pending.splits[1]!.recipient.toBase58()).toBe(r2.toBase58());
    expect(pending.splits[1]!.bps).toBe(3_000);
  });
});

describe("refund", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();
  const payer = (provider.wallet as anchor.Wallet).payer;

  beforeAll(async () => {
    await fundKeypair(provider, owner);
    await fundKeypair(provider, facilitator);
  });

  it("partial refund reduces pending amount and updates last_activity_slot", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      120,
      { refundTimeoutSlots: 100_000, settleAmount: 100_000 },
    );

    const escrowBefore = await program.account.escrowAccount.fetch(escrowPDA);
    const slotBefore = escrowBefore.lastActivitySlot.toNumber();

    await refundHelper(program, escrowPDA, facilitator, pendingPDA, 40_000);

    const pending = await program.account.pendingSettlement.fetch(pendingPDA);
    expect(pending.amount.toNumber()).toBe(60_000);
    expect(pending.originalAmount.toNumber()).toBe(100_000);

    const escrowAfter = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowAfter.lastActivitySlot.toNumber()).toBeGreaterThanOrEqual(
      slotBefore,
    );
  });

  it("full refund closes pending settlement account", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      121,
      { refundTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    const escrowBefore = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowBefore.pendingCount.toNumber()).toBe(1);

    await refundHelper(program, escrowPDA, facilitator, pendingPDA, 50_000);

    const pendingInfo = await provider.connection.getAccountInfo(pendingPDA);
    expect(pendingInfo).toBeNull();

    const escrowAfter = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowAfter.pendingCount.toNumber()).toBe(0);
  });

  it("fails after refund window expires", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      122,
      { refundTimeoutSlots: 0, settleAmount: 50_000 },
    );

    try {
      await refundHelper(program, escrowPDA, facilitator, pendingPDA, 10_000);
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("RefundWindowExpired");
    }
  });

  it("fails when refund amount exceeds pending amount", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      123,
      { refundTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    try {
      await refundHelper(program, escrowPDA, facilitator, pendingPDA, 60_000);
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("RefundExceedsAmount");
    }
  });
});

describe("finalize", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();
  const payer = (provider.wallet as anchor.Wallet).payer;

  beforeAll(async () => {
    await fundKeypair(provider, owner);
    await fundKeypair(provider, facilitator);
  });

  it("distributes to single recipient and decrements pending_count", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(
        program,
        provider,
        owner,
        facilitator,
        payer,
        130,
        { refundTimeoutSlots: 0, settleAmount: 100_000 },
      );

    const escrowBefore = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowBefore.pendingCount.toNumber()).toBe(1);

    const recipientBefore = await getAccount(
      provider.connection,
      splits[0]!.recipient,
    );
    expect(Number(recipientBefore.amount)).toBe(0);

    await finalizeHelper(
      program,
      escrowPDA,
      facilitator.publicKey,
      pendingPDA,
      vaultPDA,
      [splits[0]!.recipient],
    );

    const recipientAfter = await getAccount(
      provider.connection,
      splits[0]!.recipient,
    );
    expect(Number(recipientAfter.amount)).toBe(100_000);

    const pendingInfo = await provider.connection.getAccountInfo(pendingPDA);
    expect(pendingInfo).toBeNull();

    const escrowAfter = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowAfter.pendingCount.toNumber()).toBe(0);
  });

  it("distributes to multiple recipients proportionally", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        131,
        { refundTimeoutSlots: 0 },
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r2 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    const splits = [
      { recipient: r1, bps: 7_000 },
      { recipient: r2, bps: 3_000 },
    ];

    const pendingPDA = await submitAuthorizationHelper(
      program,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      100_000,
      splits,
    );

    await finalizeHelper(
      program,
      escrowPDA,
      facilitator.publicKey,
      pendingPDA,
      vaultPDA,
      [r1, r2],
    );

    const r1Account = await getAccount(provider.connection, r1);
    expect(Number(r1Account.amount)).toBe(70_000);

    const r2Account = await getAccount(provider.connection, r2);
    expect(Number(r2Account.amount)).toBe(30_000);
  });

  it("handles rounding dust for last recipient", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        132,
        { refundTimeoutSlots: 0 },
      );

    const r1 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r2 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const r3 = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    // 100 tokens split 3333/3333/3334 bps = 33.33 + 33.33 + remainder
    const splits = [
      { recipient: r1, bps: 3_333 },
      { recipient: r2, bps: 3_333 },
      { recipient: r3, bps: 3_334 },
    ];

    const pendingPDA = await submitAuthorizationHelper(
      program,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      100,
      splits,
    );

    await finalizeHelper(
      program,
      escrowPDA,
      facilitator.publicKey,
      pendingPDA,
      vaultPDA,
      [r1, r2, r3],
    );

    const r1Account = await getAccount(provider.connection, r1);
    const r2Account = await getAccount(provider.connection, r2);
    const r3Account = await getAccount(provider.connection, r3);

    // 100 * 3333 / 10000 = 33 for r1 and r2, last gets 100 - 33 - 33 = 34
    expect(Number(r1Account.amount)).toBe(33);
    expect(Number(r2Account.amount)).toBe(33);
    expect(Number(r3Account.amount)).toBe(34);
  }, 15_000);

  it("fails before refund window expires", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(
        program,
        provider,
        owner,
        facilitator,
        payer,
        133,
        { refundTimeoutSlots: 100_000, settleAmount: 50_000 },
      );

    try {
      await finalizeHelper(
        program,
        escrowPDA,
        facilitator.publicKey,
        pendingPDA,
        vaultPDA,
        [splits[0]!.recipient],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("RefundWindowNotExpired");
    }
  });

  it("fails with wrong recipient accounts", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, mint } =
      await setupEscrowWithPending(
        program,
        provider,
        owner,
        facilitator,
        payer,
        134,
        { refundTimeoutSlots: 0, settleAmount: 50_000 },
      );

    const wrongRecipient = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    try {
      await finalizeHelper(
        program,
        escrowPDA,
        facilitator.publicKey,
        pendingPDA,
        vaultPDA,
        [wrongRecipient],
      );
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("InvalidSplitRecipient");
    }
  });
});
