import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import type { Flex } from "../../target/types/flex";

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
  const account = await createAccount(
    provider.connection,
    mintAuthority,
    mint,
    owner,
    keypair,
  );
  if (BigInt(amount) > 0n) {
    await mintTo(
      provider.connection,
      mintAuthority,
      mint,
      account,
      mintAuthority,
      amount,
    );
  }
  return account;
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
