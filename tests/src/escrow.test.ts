import { describe, it, expect, beforeAll } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import type { Flex } from "../../target/types/flex";
import {
  fundKeypair,
  deriveVaultPDA,
  deriveSessionKeyPDA,
  createTestMint,
  createFundedTokenAccount,
  createEscrowHelper,
  submitAuthorizationHelper,
} from "./helpers";

describe("create_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();

  beforeAll(async () => {
    await fundKeypair(provider, owner);
  });

  it("creates account with correct fields", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 0, {
      refundTimeoutSlots: 200,
      deadmanTimeoutSlots: 500,
      maxSessionKeys: 5,
    });

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.version).toBe(1);
    expect(escrow.owner.toBase58()).toBe(owner.publicKey.toBase58());
    expect(escrow.facilitator.toBase58()).toBe(
      facilitator.publicKey.toBase58(),
    );
    expect(escrow.index.toNumber()).toBe(0);
    expect(escrow.lastNonce.toNumber()).toBe(0);
    expect(escrow.pendingCount.toNumber()).toBe(0);
    expect(escrow.mintCount.toNumber()).toBe(0);
    expect(escrow.refundTimeoutSlots.toNumber()).toBe(200);
    expect(escrow.deadmanTimeoutSlots.toNumber()).toBe(500);
    expect(escrow.maxSessionKeys).toBe(5);
    expect(escrow.sessionKeyCount).toBe(0);
    expect(escrow.bump).toBeGreaterThan(0);
    expect(escrow.lastActivitySlot.toNumber()).toBeGreaterThan(0);
  });

  it("creates multiple escrows for the same owner", async () => {
    const escrowPDA1 = await createEscrowHelper(
      program,
      owner,
      facilitator,
      10,
    );
    const escrowPDA2 = await createEscrowHelper(
      program,
      owner,
      facilitator,
      11,
    );

    const e1 = await program.account.escrowAccount.fetch(escrowPDA1);
    const e2 = await program.account.escrowAccount.fetch(escrowPDA2);
    expect(e1.index.toNumber()).toBe(10);
    expect(e2.index.toNumber()).toBe(11);
  });
});

describe("deposit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();
  const payer = (provider.wallet as anchor.Wallet).payer;

  beforeAll(async () => {
    await fundKeypair(provider, owner);
  });

  it("deposits to a single mint and creates a vault", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 20);
    const mint = await createTestMint(provider, payer);
    const source = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

    await program.methods
      .deposit(new anchor.BN(500_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.mintCount.toNumber()).toBe(1);

    const vaultAccount = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultAccount.amount)).toBe(500_000);
  });

  it("deposits multiple mints up to the limit", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 21);

    for (let i = 0; i < 8; i++) {
      const mint = await createTestMint(provider, payer);
      const source = await createFundedTokenAccount(
        provider,
        mint,
        owner.publicKey,
        payer,
        1_000,
      );
      const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

      await program.methods
        .deposit(new anchor.BN(1_000))
        .accounts({
          depositor: owner.publicKey,
          escrow: escrowPDA,
          mint,
          vault: vaultPDA,
          source,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.mintCount.toNumber()).toBe(8);
  }, 30_000);

  it("rejects the 9th mint", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 22);

    for (let i = 0; i < 8; i++) {
      const mint = await createTestMint(provider, payer);
      const source = await createFundedTokenAccount(
        provider,
        mint,
        owner.publicKey,
        payer,
        1_000,
      );
      const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

      await program.methods
        .deposit(new anchor.BN(1_000))
        .accounts({
          depositor: owner.publicKey,
          escrow: escrowPDA,
          mint,
          vault: vaultPDA,
          source,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    const ninthMint = await createTestMint(provider, payer);
    const ninthSource = await createFundedTokenAccount(
      provider,
      ninthMint,
      owner.publicKey,
      payer,
      1_000,
    );
    const [ninthVault] = deriveVaultPDA(
      escrowPDA,
      ninthMint,
      program.programId,
    );

    try {
      await program.methods
        .deposit(new anchor.BN(1_000))
        .accounts({
          depositor: owner.publicKey,
          escrow: escrowPDA,
          mint: ninthMint,
          vault: ninthVault,
          source: ninthSource,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("MintLimitReached");
    }
  }, 30_000);

  it("reuses an existing vault on second deposit", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 23);
    const mint = await createTestMint(provider, payer);
    const source = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      2_000_000,
    );
    const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

    const depositAccounts = {
      depositor: owner.publicKey,
      escrow: escrowPDA,
      mint,
      vault: vaultPDA,
      source,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    await program.methods
      .deposit(new anchor.BN(700_000))
      .accounts(depositAccounts)
      .signers([owner])
      .rpc();

    await program.methods
      .deposit(new anchor.BN(300_000))
      .accounts(depositAccounts)
      .signers([owner])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.mintCount.toNumber()).toBe(1);

    const vaultAccount = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultAccount.amount)).toBe(1_000_000);
  });
});

describe("close_escrow", () => {
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

  it("transfers balances and closes the escrow", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 30);

    const mintA = await createTestMint(provider, payer);
    const mintB = await createTestMint(provider, payer);

    const sourceA = await createFundedTokenAccount(
      provider,
      mintA,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const sourceB = await createFundedTokenAccount(
      provider,
      mintB,
      owner.publicKey,
      payer,
      2_000_000,
    );

    const [vaultA] = deriveVaultPDA(escrowPDA, mintA, program.programId);
    const [vaultB] = deriveVaultPDA(escrowPDA, mintB, program.programId);

    await program.methods
      .deposit(new anchor.BN(1_000_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint: mintA,
        vault: vaultA,
        source: sourceA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .deposit(new anchor.BN(2_000_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint: mintB,
        vault: vaultB,
        source: sourceB,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const destA = await createFundedTokenAccount(
      provider,
      mintA,
      owner.publicKey,
      payer,
      0,
    );
    const destB = await createFundedTokenAccount(
      provider,
      mintB,
      owner.publicKey,
      payer,
      0,
    );

    await program.methods
      .closeEscrow()
      .accounts({
        escrow: escrowPDA,
        owner: owner.publicKey,
        facilitator: facilitator.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: vaultA, isSigner: false, isWritable: true },
        { pubkey: destA, isSigner: false, isWritable: true },
        { pubkey: vaultB, isSigner: false, isWritable: true },
        { pubkey: destB, isSigner: false, isWritable: true },
      ])
      .signers([owner, facilitator])
      .rpc();

    const destAAccount = await getAccount(provider.connection, destA);
    expect(Number(destAAccount.amount)).toBe(1_000_000);

    const destBAccount = await getAccount(provider.connection, destB);
    expect(Number(destBAccount.amount)).toBe(2_000_000);

    const vaultAInfo = await provider.connection.getAccountInfo(vaultA);
    expect(vaultAInfo).toBeNull();

    const vaultBInfo = await provider.connection.getAccountInfo(vaultB);
    expect(vaultBInfo).toBeNull();

    const escrowInfo = await provider.connection.getAccountInfo(escrowPDA);
    expect(escrowInfo).toBeNull();
  }, 30_000);

  it("fails with pending settlements", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 34);

    const mint = await createTestMint(provider, payer);
    const source = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

    await program.methods
      .deposit(new anchor.BN(500_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const sessionKey = Keypair.generate();
    const [skPDA] = deriveSessionKeyPDA(
      escrowPDA,
      sessionKey.publicKey,
      program.programId,
    );

    await program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(0))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const recipient = await createFundedTokenAccount(
      provider,
      mint,
      facilitator.publicKey,
      payer,
      0,
    );

    await submitAuthorizationHelper(
      program,
      escrowPDA,
      facilitator,
      sessionKey,
      skPDA,
      mint,
      vaultPDA,
      1,
      100_000,
      [{ recipient, bps: 10_000 }],
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
        .closeEscrow()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          facilitator: facilitator.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ])
        .signers([owner, facilitator])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("PendingSettlementsExist");
    }
  }, 30_000);

  it("fails without facilitator signature", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 31);

    try {
      await program.methods
        .closeEscrow()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          facilitator: facilitator.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      expect(String(err)).toContain("Signature verification failed");
    }
  });

  it("fails with duplicate mints in remaining accounts", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 32);

    const mint = await createTestMint(provider, payer);
    const source = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

    await program.methods
      .deposit(new anchor.BN(500_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Deposit a second mint so mint_count=2, allowing 4 remaining accounts
    const mint2 = await createTestMint(provider, payer);
    const source2 = await createFundedTokenAccount(
      provider,
      mint2,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const [vault2] = deriveVaultPDA(escrowPDA, mint2, program.programId);

    await program.methods
      .deposit(new anchor.BN(500_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint: mint2,
        vault: vault2,
        source: source2,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const dest = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      0,
    );

    try {
      await program.methods
        .closeEscrow()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          facilitator: facilitator.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ])
        .signers([owner, facilitator])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("DuplicateAccounts");
    }
  });

  it("fails with wrong remaining accounts count", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 33);

    const mint = await createTestMint(provider, payer);
    const source = await createFundedTokenAccount(
      provider,
      mint,
      owner.publicKey,
      payer,
      1_000_000,
    );
    const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

    await program.methods
      .deposit(new anchor.BN(500_000))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    try {
      await program.methods
        .closeEscrow()
        .accounts({
          escrow: escrowPDA,
          owner: owner.publicKey,
          facilitator: facilitator.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([])
        .signers([owner, facilitator])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown")
        throw err;
      const anchorErr = err as anchor.AnchorError;
      expect(anchorErr.error.errorCode.code).toBe("InvalidTokenAccountPair");
    }
  });
});
