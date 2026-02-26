import { describe, it, expect, beforeAll } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import type { Flex } from "../../target/types/flex";
import {
  fundKeypair,
  deriveSessionKeyPDA,
  createEscrowHelper,
  expectAnchorError,
} from "./helpers";

describe("register_session_key", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();

  beforeAll(async () => {
    await fundKeypair(provider, owner);
  });

  it("creates PDA and increments session key count", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 40);
    const sessionKey = Keypair.generate();
    const [skPDA] = deriveSessionKeyPDA(
      escrowPDA,
      sessionKey.publicKey,
      program.programId,
    );

    await program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(1000))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const ska = await program.account.sessionKey.fetch(skPDA);
    expect(ska.version).toBe(1);
    expect(ska.active).toBe(true);
    expect(ska.escrow.toBase58()).toBe(escrowPDA.toBase58());
    expect(ska.key.toBase58()).toBe(sessionKey.publicKey.toBase58());
    expect(ska.expiresAtSlot).toBeNull();
    expect(ska.revokedAtSlot).toBeNull();
    expect(ska.revocationGracePeriodSlots.toNumber()).toBe(1000);
    expect(ska.createdAtSlot.toNumber()).toBeGreaterThan(0);
    expect(ska.bump).toBeGreaterThan(0);

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.sessionKeyCount).toBe(1);
  });

  it("respects max_session_keys limit", async () => {
    const escrowPDA = await createEscrowHelper(
      program,
      owner,
      facilitator,
      41,
      { maxSessionKeys: 2 },
    );

    for (let i = 0; i < 2; i++) {
      const sk = Keypair.generate();
      const [skPDA] = deriveSessionKeyPDA(
        escrowPDA,
        sk.publicKey,
        program.programId,
      );
      await program.methods
        .registerSessionKey(sk.publicKey, null, new anchor.BN(0))
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: skPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    const thirdKey = Keypair.generate();
    const [thirdPDA] = deriveSessionKeyPDA(
      escrowPDA,
      thirdKey.publicKey,
      program.programId,
    );

    try {
      await program.methods
        .registerSessionKey(thirdKey.publicKey, null, new anchor.BN(0))
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: thirdPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "SessionKeyLimitReached");
    }
  });

  it("stores a non-null expires_at_slot", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 43);
    const sessionKey = Keypair.generate();
    const [skPDA] = deriveSessionKeyPDA(
      escrowPDA,
      sessionKey.publicKey,
      program.programId,
    );

    const expiresAt = new anchor.BN(999_999);
    await program.methods
      .registerSessionKey(sessionKey.publicKey, expiresAt, new anchor.BN(500))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const ska = await program.account.sessionKey.fetch(skPDA);
    expect(ska.expiresAtSlot).not.toBeNull();
    expect(ska.expiresAtSlot!.toNumber()).toBe(999_999);
  });

  it("allows unlimited keys when maxSessionKeys is 0", async () => {
    const escrowPDA = await createEscrowHelper(
      program,
      owner,
      facilitator,
      42,
      { maxSessionKeys: 0 },
    );

    for (let i = 0; i < 3; i++) {
      const sk = Keypair.generate();
      const [skPDA] = deriveSessionKeyPDA(
        escrowPDA,
        sk.publicKey,
        program.programId,
      );
      await program.methods
        .registerSessionKey(sk.publicKey, null, new anchor.BN(0))
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: skPDA,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.sessionKeyCount).toBe(3);
  });
});

describe("revoke_session_key", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();

  beforeAll(async () => {
    await fundKeypair(provider, owner);
  });

  it("sets revoked fields correctly", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 50);
    const sessionKey = Keypair.generate();
    const [skPDA] = deriveSessionKeyPDA(
      escrowPDA,
      sessionKey.publicKey,
      program.programId,
    );

    await program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(1000))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      })
      .signers([owner])
      .rpc();

    const ska = await program.account.sessionKey.fetch(skPDA);
    expect(ska.active).toBe(false);
    expect(ska.revokedAtSlot).not.toBeNull();
    expect(ska.revokedAtSlot!.toNumber()).toBeGreaterThan(0);
  });

  it("fails for an already-revoked key", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 51);
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

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      })
      .signers([owner])
      .rpc();

    try {
      await program.methods
        .revokeSessionKey()
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: skPDA,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "SessionKeyRevoked");
    }
  });
});

describe("close_session_key", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Flex as Program<Flex>;

  const owner = Keypair.generate();
  const facilitator = Keypair.generate();

  beforeAll(async () => {
    await fundKeypair(provider, owner);
  });

  it("fails for an active (non-revoked) session key", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 63);
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

    try {
      await program.methods
        .closeSessionKey()
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: skPDA,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "SessionKeyStillActive");
    }
  });

  it("closes after grace period elapses", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 60);
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

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .closeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      })
      .signers([owner])
      .rpc();

    const accountInfo = await provider.connection.getAccountInfo(skPDA);
    expect(accountInfo).toBeNull();
  }, 15_000);

  it("fails during grace period", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 61);
    const sessionKey = Keypair.generate();
    const [skPDA] = deriveSessionKeyPDA(
      escrowPDA,
      sessionKey.publicKey,
      program.programId,
    );

    await program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(100_000))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: skPDA,
      })
      .signers([owner])
      .rpc();

    try {
      await program.methods
        .closeSessionKey()
        .accounts({
          owner: owner.publicKey,
          escrow: escrowPDA,
          sessionKeyAccount: skPDA,
        })
        .signers([owner])
        .rpc();
      throw new Error("should have thrown");
    } catch (err: unknown) {
      expectAnchorError(err, "SessionKeyGracePeriodActive");
    }
  }, 15_000);

  it("decrements session_key_count on close", async () => {
    const escrowPDA = await createEscrowHelper(program, owner, facilitator, 62);

    const sk1 = Keypair.generate();
    const sk2 = Keypair.generate();
    const [sk1PDA] = deriveSessionKeyPDA(
      escrowPDA,
      sk1.publicKey,
      program.programId,
    );
    const [sk2PDA] = deriveSessionKeyPDA(
      escrowPDA,
      sk2.publicKey,
      program.programId,
    );

    await program.methods
      .registerSessionKey(sk1.publicKey, null, new anchor.BN(0))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk1PDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .registerSessionKey(sk2.publicKey, null, new anchor.BN(0))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk2PDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    let escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.sessionKeyCount).toBe(2);

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk1PDA,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .closeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk1PDA,
      })
      .signers([owner])
      .rpc();

    escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.sessionKeyCount).toBe(1);

    await program.methods
      .revokeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk2PDA,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .closeSessionKey()
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sk2PDA,
      })
      .signers([owner])
      .rpc();

    escrow = await program.account.escrowAccount.fetch(escrowPDA);
    expect(escrow.sessionKeyCount).toBe(0);
  }, 30_000);
});
