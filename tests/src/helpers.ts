import { expect } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  createInitializeAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { Flex } from "../../target/types/flex";

export function expectAnchorError(err: unknown, code: string): void {
  if (err instanceof Error && err.message === "should have thrown") throw err;
  if (!(err instanceof anchor.AnchorError)) {
    throw new Error(
      `Expected AnchorError with code "${code}" but got: ${String(err)}`,
    );
  }
  expect(err.error.errorCode.code).toBe(code);
}

export async function fundKeypair(
  provider: anchor.AnchorProvider,
  keypair: Keypair,
  lamports = 10 * LAMPORTS_PER_SOL,
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    keypair.publicKey,
    lamports,
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
}

export function deriveEscrowPDA(
  owner: PublicKey,
  index: number | bigint,
  programId: PublicKey,
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), owner.toBuffer(), buf],
    programId,
  );
}

export function deriveVaultPDA(
  escrow: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token"), escrow.toBuffer(), mint.toBuffer()],
    programId,
  );
}

export function deriveSessionKeyPDA(
  escrow: PublicKey,
  sessionKey: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), escrow.toBuffer(), sessionKey.toBuffer()],
    programId,
  );
}

export async function createTestMint(
  provider: anchor.AnchorProvider,
  authority: Keypair,
): Promise<PublicKey> {
  return createMint(
    provider.connection,
    authority,
    authority.publicKey,
    null,
    6,
  );
}

export async function createFundedTokenAccount(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  owner: PublicKey,
  mintAuthority: Keypair,
  amount: number | bigint,
): Promise<PublicKey> {
  const keypair = Keypair.generate();
  const lamports =
    await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthority.publicKey,
      newAccountPubkey: keypair.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(keypair.publicKey, mint, owner),
  );

  if (BigInt(amount) > 0n) {
    tx.add(
      createMintToInstruction(
        mint,
        keypair.publicKey,
        mintAuthority.publicKey,
        BigInt(amount),
      ),
    );
  }

  await provider.sendAndConfirm(tx, [mintAuthority, keypair]);
  return keypair.publicKey;
}

export async function createEscrowHelper(
  program: Program<Flex>,
  owner: Keypair,
  facilitator: Keypair,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    maxSessionKeys?: number;
  },
): Promise<PublicKey> {
  const bn = new anchor.BN(index);
  const [escrowPDA] = deriveEscrowPDA(
    owner.publicKey,
    index,
    program.programId,
  );

  await program.methods
    .createEscrow(
      bn,
      facilitator.publicKey,
      new anchor.BN(opts?.refundTimeoutSlots ?? 100),
      new anchor.BN(opts?.deadmanTimeoutSlots ?? 1000),
      opts?.maxSessionKeys ?? 10,
    )
    .accounts({
      owner: owner.publicKey,
      escrow: escrowPDA,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([owner])
    .rpc();

  return escrowPDA;
}

export function derivePendingPDA(
  escrow: PublicKey,
  nonce: number | bigint,
  programId: PublicKey,
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pending"), escrow.toBuffer(), buf],
    programId,
  );
}

export function serializePaymentAuthorization(args: {
  programId: PublicKey;
  escrow: PublicKey;
  mint: PublicKey;
  maxAmount: bigint;
  nonce: bigint;
  splits: Array<{ recipient: PublicKey; bps: number }>;
}): Buffer {
  const splitCount = args.splits.length;
  const buf = Buffer.alloc(32 + 32 + 32 + 8 + 8 + 4 + 34 * splitCount);
  let offset = 0;

  args.programId.toBuffer().copy(buf, offset);
  offset += 32;
  args.escrow.toBuffer().copy(buf, offset);
  offset += 32;
  args.mint.toBuffer().copy(buf, offset);
  offset += 32;
  buf.writeBigUInt64LE(args.maxAmount, offset);
  offset += 8;
  buf.writeBigUInt64LE(args.nonce, offset);
  offset += 8;
  buf.writeUInt32LE(splitCount, offset);
  offset += 4;

  for (const split of args.splits) {
    split.recipient.toBuffer().copy(buf, offset);
    offset += 32;
    buf.writeUInt16LE(split.bps, offset);
    offset += 2;
  }

  return buf;
}

export type EscrowWithPending = {
  escrowPDA: PublicKey;
  mint: PublicKey;
  vaultPDA: PublicKey;
  sessionKey: Keypair;
  sessionKeyPDA: PublicKey;
  pendingPDA: PublicKey;
  splits: Array<{ recipient: PublicKey; bps: number }>;
};

export async function setupEscrowWithPending(
  program: Program<Flex>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  facilitator: Keypair,
  payer: Keypair,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    depositAmount?: number;
    settleAmount?: number;
    nonce?: number;
    splits?: Array<{ recipient: PublicKey; bps: number }>;
  },
): Promise<EscrowWithPending> {
  const connection = provider.connection;
  const depositAmount = opts?.depositAmount ?? 1_000_000;

  const [escrowPDA] = deriveEscrowPDA(
    owner.publicKey,
    index,
    program.programId,
  );
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const sourceKeypair = Keypair.generate();
  const recipientKeypair = opts?.splits ? null : Keypair.generate();
  const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);
  const sessionKey = Keypair.generate();
  const [sessionKeyPDA] = deriveSessionKeyPDA(
    escrowPDA,
    sessionKey.publicKey,
    program.programId,
  );

  const [mintRent, accountRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
  ]);

  // Phase 1: createEscrow + token setup in parallel
  const tokenSetupTx = new Transaction();
  tokenSetupTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      6,
      payer.publicKey,
      null,
    ),
  );

  tokenSetupTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: sourceKeypair.publicKey,
      lamports: accountRent,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(
      sourceKeypair.publicKey,
      mint,
      owner.publicKey,
    ),
    createMintToInstruction(
      mint,
      sourceKeypair.publicKey,
      payer.publicKey,
      depositAmount,
    ),
  );

  const tokenSetupSigners: Keypair[] = [payer, mintKeypair, sourceKeypair];
  if (recipientKeypair) {
    tokenSetupTx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: recipientKeypair.publicKey,
        lamports: accountRent,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        recipientKeypair.publicKey,
        mint,
        facilitator.publicKey,
      ),
    );
    tokenSetupSigners.push(recipientKeypair);
  }

  await Promise.all([
    program.methods
      .createEscrow(
        new anchor.BN(index),
        facilitator.publicKey,
        new anchor.BN(opts?.refundTimeoutSlots ?? 100),
        new anchor.BN(opts?.deadmanTimeoutSlots ?? 1000),
        10,
      )
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc(),
    provider.sendAndConfirm(tokenSetupTx, tokenSetupSigners),
  ]);

  // Phase 2: deposit + registerSessionKey in one transaction
  const [depositIx, registerIx] = await Promise.all([
    program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source: sourceKeypair.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction(),
    program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(0))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sessionKeyPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction(),
  ]);

  await provider.sendAndConfirm(new Transaction().add(depositIx, registerIx), [
    owner,
  ]);

  // Phase 3: submitAuthorization
  const nonce = opts?.nonce ?? 1;
  const settleAmount = opts?.settleAmount ?? 100_000;
  const splits = opts?.splits ?? [
    { recipient: recipientKeypair!.publicKey, bps: 10_000 },
  ];

  const pendingPDA = await submitAuthorizationHelper(
    program,
    escrowPDA,
    facilitator,
    sessionKey,
    sessionKeyPDA,
    mint,
    vaultPDA,
    nonce,
    settleAmount,
    splits,
  );

  return {
    escrowPDA,
    mint,
    vaultPDA,
    sessionKey,
    sessionKeyPDA,
    pendingPDA,
    splits,
  };
}

export type EscrowForAuth = {
  escrowPDA: PublicKey;
  mint: PublicKey;
  vaultPDA: PublicKey;
  sessionKey: Keypair;
  sessionKeyPDA: PublicKey;
};

export async function setupEscrowForAuth(
  program: Program<Flex>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  facilitator: Keypair,
  payer: Keypair,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    depositAmount?: number;
  },
): Promise<EscrowForAuth> {
  const depositAmount = opts?.depositAmount ?? 1_000_000;
  const escrowPDA = await createEscrowHelper(
    program,
    owner,
    facilitator,
    index,
    opts,
  );

  const mint = await createTestMint(provider, payer);
  const source = await createFundedTokenAccount(
    provider,
    mint,
    owner.publicKey,
    payer,
    depositAmount,
  );
  const [vaultPDA] = deriveVaultPDA(escrowPDA, mint, program.programId);

  const sessionKey = Keypair.generate();
  const [sessionKeyPDA] = deriveSessionKeyPDA(
    escrowPDA,
    sessionKey.publicKey,
    program.programId,
  );

  const [depositIx, registerIx] = await Promise.all([
    program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        depositor: owner.publicKey,
        escrow: escrowPDA,
        mint,
        vault: vaultPDA,
        source,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction(),
    program.methods
      .registerSessionKey(sessionKey.publicKey, null, new anchor.BN(0))
      .accounts({
        owner: owner.publicKey,
        escrow: escrowPDA,
        sessionKeyAccount: sessionKeyPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction(),
  ]);

  await provider.sendAndConfirm(new Transaction().add(depositIx, registerIx), [
    owner,
  ]);

  return { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA };
}

export async function refundHelper(
  program: Program<Flex>,
  escrowPDA: PublicKey,
  facilitator: Keypair,
  pendingPDA: PublicKey,
  refundAmount: number,
): Promise<void> {
  await program.methods
    .refund(new anchor.BN(refundAmount))
    .accounts({
      escrow: escrowPDA,
      facilitator: facilitator.publicKey,
      pending: pendingPDA,
    })
    .signers([facilitator])
    .rpc();
}

export async function finalizeHelper(
  program: Program<Flex>,
  escrowPDA: PublicKey,
  facilitator: PublicKey,
  pendingPDA: PublicKey,
  vaultPDA: PublicKey,
  recipientAccounts: PublicKey[],
): Promise<void> {
  await program.methods
    .finalize()
    .accounts({
      escrow: escrowPDA,
      facilitator,
      pending: pendingPDA,
      tokenAccount: vaultPDA,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      recipientAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    )
    .rpc();
}

export async function submitAuthorizationHelper(
  program: Program<Flex>,
  escrowPDA: PublicKey,
  facilitator: Keypair,
  sessionKey: Keypair,
  sessionKeyPDA: PublicKey,
  mint: PublicKey,
  vaultPDA: PublicKey,
  nonce: number,
  settleAmount: number,
  splits: Array<{ recipient: PublicKey; bps: number }>,
): Promise<PublicKey> {
  const message = serializePaymentAuthorization({
    programId: program.programId,
    escrow: escrowPDA,
    mint,
    maxAmount: BigInt(settleAmount),
    nonce: BigInt(nonce),
    splits,
  });

  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: sessionKey.secretKey,
    message,
  });

  const [pendingPDA] = derivePendingPDA(escrowPDA, nonce, program.programId);

  await program.methods
    .submitAuthorization(
      mint,
      new anchor.BN(settleAmount),
      new anchor.BN(settleAmount),
      new anchor.BN(nonce),
      splits.map((s) => ({ recipient: s.recipient, bps: s.bps })),
      Array.from({ length: 64 }, () => 0),
    )
    .accounts({
      escrow: escrowPDA,
      facilitator: facilitator.publicKey,
      sessionKey: sessionKeyPDA,
      tokenAccount: vaultPDA,
      pending: pendingPDA,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .preInstructions([ed25519Ix])
    .signers([facilitator])
    .rpc();

  return pendingPDA;
}
