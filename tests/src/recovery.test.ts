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
  expectAnchorError,
} from "./helpers";

describe("void_pending", () => {
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

  it("closes pending settlement and returns rent to owner", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      200,
      { deadmanTimeoutSlots: 0, settleAmount: 50_000 },
    );

    // Advance the slot so clock.slot > last_activity_slot
    await fundKeypair(provider, Keypair.generate(), 1_000);

    const escrowBefore = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowBefore.pendingCount.toNumber()).toBe(1);

    const ownerBalanceBefore = await provider.connection.getBalance(
      owner.publicKey,
    );

    await program.methods
      .voidPending()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        pending: pendingPDA,
      })
      .signers([owner])
      .rpc();

    const pendingInfo = await provider.connection.getAccountInfo(pendingPDA);
    expect(pendingInfo).toBeNull();

    const escrowAfter = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowAfter.pendingCount.toNumber()).toBe(0);

    const ownerBalanceAfter = await provider.connection.getBalance(
      owner.publicKey,
    );
    expect(ownerBalanceAfter).toBeGreaterThan(ownerBalanceBefore);
  });

  it("fails before deadman timeout", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      201,
      { deadmanTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    try {
      await program.methods
        .voidPending()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          pending: pendingPDA,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "DeadmanNotExpired");
    }
  });
});

describe("emergency_close", () => {
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

  it("recovers after voiding all pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(
        program,
        provider,
        owner,
        facilitator,
        payer,
        210,
        { deadmanTimeoutSlots: 0 },
      );

    const recipient = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );
    const splits = [{ recipient, bps: 10_000 }];

    const pending1 = await submitAuthorizationHelper(
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

    const pending2 = await submitAuthorizationHelper(
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

    const escrowMid = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowMid.pendingCount.toNumber()).toBe(2);

    // Advance the slot so clock.slot > last_activity_slot
    await fundKeypair(provider, Keypair.generate(), 1_000);

    await program.methods
      .voidPending()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        pending: pending1,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .voidPending()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        pending: pending2,
      })
      .signers([owner])
      .rpc();

    const escrowPreClose = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowPreClose.pendingCount.toNumber()).toBe(0);

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    await program.methods
      .emergencyClose()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
      ])
      .signers([owner])
      .rpc();

    const destAccount = await getAccount(provider.connection, dest);
    expect(Number(destAccount.amount)).toBe(1_000_000);

    const escrowInfo = await provider.connection.getAccountInfo(escrowPDA);
    expect(escrowInfo).toBeNull();

    const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);
    expect(vaultInfo).toBeNull();
  }, 30_000);

  it("fails before deadman timeout even with no pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowForAuth(
      program,
      provider,
      owner,
      facilitator,
      payer,
      212,
      { deadmanTimeoutSlots: 100_000, depositAmount: 1_000 },
    );

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    try {
      await program.methods
        .emergencyClose()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "DeadmanNotExpired");
    }
  });

  it("fails with pending settlements remaining", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      211,
      { deadmanTimeoutSlots: 0, settleAmount: 50_000 },
    );

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    try {
      await program.methods
        .emergencyClose()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "PendingSettlementsExist");
    }
  });
});

describe("force_close", () => {
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

  it("works at 2x deadman timeout even with pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      220,
      { deadmanTimeoutSlots: 0, settleAmount: 50_000 },
    );

    const escrowBefore = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrowBefore.pendingCount.toNumber()).toBe(1);

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    await program.methods
      .forceClose()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
      ])
      .signers([owner])
      .rpc();

    const destAccount = await getAccount(provider.connection, dest);
    expect(Number(destAccount.amount)).toBe(1_000_000);

    const escrowInfo = await provider.connection.getAccountInfo(escrowPDA);
    expect(escrowInfo).toBeNull();
  });

  it("fails before 2x deadman timeout", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      program,
      provider,
      owner,
      facilitator,
      payer,
      221,
      { deadmanTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    try {
      await program.methods
        .forceClose()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ])
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "ForceCloseTimeoutNotExpired");
    }
  });
});
