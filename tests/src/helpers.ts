import { expect } from "bun:test";
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  isSolanaError,
  lamports,
  unwrapSimulationError,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeAccountInstruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
} from "@solana-program/token";
import {
  FLEX_PROGRAM_ADDRESS,
  type FlexError,
  type SplitEntry,
  getFlexErrorMessage,
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  getRefundInstruction,
  getFinalizeInstruction,
  getSubmitAuthorizationInstructionAsync,
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
} from "@faremeter/flex-solana";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MINT_SIZE = 82n;
const ACCOUNT_SIZE = 165n;

export function createRpc() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  return createSolanaRpc(url);
}

export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected defined value");
  }
  return value;
}

export function expectFlexError(err: unknown, expectedCode: FlexError): void {
  if (err instanceof Error && err.message === "should have thrown") throw err;
  const cause = unwrapSimulationError(err);
  if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
    throw new Error(
      `Expected SolanaError with custom instruction error but got: ${String(err)}`,
    );
  }
  expect(cause.context.code).toBe(expectedCode);
  const message = getFlexErrorMessage(expectedCode);
  expect(message).toBeDefined();
}

export async function expectToFail(
  fn: () => Promise<unknown>,
  expectedCode: FlexError,
): Promise<void> {
  try {
    await fn();
    throw new Error("should have thrown");
  } catch (err: unknown) {
    expectFlexError(err, expectedCode);
  }
}

async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  sig: Signature,
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    const status = statuses[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        throw new Error(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          `Transaction failed: ${JSON.stringify(status.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Transaction confirmation timeout");
}

export async function sendTx(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signedTx);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, sig);
}

export async function fundKeypair(
  rpc: Rpc<SolanaRpcApi>,
  keypair: KeyPairSigner,
  amount = lamports(10n * LAMPORTS_PER_SOL),
): Promise<void> {
  const sig = await rpc.requestAirdrop(keypair.address, amount).send();
  await confirmSignature(rpc, sig);
}

export async function createTestMint(
  rpc: Rpc<SolanaRpcApi>,
  payer: KeyPairSigner,
): Promise<KeyPairSigner> {
  const mint = await generateKeyPairSigner();
  const rentLamports = await rpc
    .getMinimumBalanceForRentExemption(MINT_SIZE)
    .send();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
  const createAccountIx: Instruction = getCreateAccountInstruction({
    payer,
    newAccount: mint,
    lamports: rentLamports,
    space: MINT_SIZE,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
  const initMintIx: Instruction = getInitializeMint2Instruction({
    mint: mint.address,
    decimals: 6,
    mintAuthority: payer.address,
    freezeAuthority: null,
  });
  await sendTx(rpc, payer, [createAccountIx, initMintIx]);
  return mint;
}

export async function createFundedTokenAccount(
  rpc: Rpc<SolanaRpcApi>,
  mint: Address,
  owner: Address,
  mintAuthority: KeyPairSigner,
  amount: bigint,
): Promise<KeyPairSigner> {
  const tokenAccount = await generateKeyPairSigner();
  const rentLamports = await rpc
    .getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
    .send();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
  const createIx: Instruction = getCreateAccountInstruction({
    payer: mintAuthority,
    newAccount: tokenAccount,
    lamports: rentLamports,
    space: ACCOUNT_SIZE,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
  const initIx: Instruction = getInitializeAccountInstruction({
    account: tokenAccount.address,
    mint,
    owner,
  });
  const instructions: Instruction[] = [createIx, initIx];
  if (amount > 0n) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
    const mintToIx: Instruction = getMintToInstruction({
      mint,
      token: tokenAccount.address,
      mintAuthority,
      amount,
    });
    instructions.push(mintToIx);
  }
  await sendTx(rpc, mintAuthority, instructions);
  return tokenAccount;
}

export async function fetchTokenBalance(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<bigint> {
  const { value } = await rpc.getTokenAccountBalance(address).send();
  return BigInt(value.amount);
}

export async function createEscrowHelper(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  facilitator: KeyPairSigner,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    maxSessionKeys?: number;
  },
): Promise<Address> {
  const ix = await getCreateEscrowInstructionAsync({
    owner,
    index,
    facilitator: facilitator.address,
    refundTimeoutSlots: opts?.refundTimeoutSlots ?? 100,
    deadmanTimeoutSlots: opts?.deadmanTimeoutSlots ?? 1000,
    maxSessionKeys: opts?.maxSessionKeys ?? 10,
  });
  await sendTx(rpc, owner, [ix]);

  const escrowMeta = ix.accounts[1];
  if (!escrowMeta) throw new Error("escrow account meta missing");
  return escrowMeta.address;
}

export async function submitAuthorizationHelper(
  rpc: Rpc<SolanaRpcApi>,
  escrow: Address,
  facilitator: KeyPairSigner,
  sessionKey: KeyPairSigner,
  sessionKeyPDA: Address,
  mint: Address,
  vault: Address,
  authorizationId: number,
  settleAmount: number,
  splits: SplitEntry[],
  opts?: {
    expiresAtSlot?: bigint;
    refundTimeoutSlots?: number;
    maxAmount?: number;
  },
): Promise<Address> {
  const currentSlot = await rpc.getSlot().send();
  const timeout = BigInt(opts?.refundTimeoutSlots ?? 100);
  const expiresAtSlot =
    opts?.expiresAtSlot ?? currentSlot + (timeout > 10n ? timeout / 2n : 5n);
  const maxAmount = opts?.maxAmount ?? settleAmount;

  const message = serializePaymentAuthorization({
    programId: FLEX_PROGRAM_ADDRESS,
    escrow,
    mint,
    maxAmount: BigInt(maxAmount),
    authorizationId: BigInt(authorizationId),
    expiresAtSlot,
    splits,
  });

  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", sessionKey.keyPair.privateKey, message),
  );

  const ed25519Ix = createEd25519VerifyInstruction({
    publicKey: sessionKey.address,
    message,
    signature,
  });

  const submitIx = await getSubmitAuthorizationInstructionAsync({
    escrow,
    facilitator,
    sessionKey: sessionKeyPDA,
    tokenAccount: vault,
    mint,
    maxAmount,
    settleAmount,
    authorizationId,
    expiresAtSlot,
    splits,
    signature: new Uint8Array(64),
  });

  await sendTx(rpc, facilitator, [ed25519Ix, submitIx]);

  const pendingMeta = submitIx.accounts[4];
  if (!pendingMeta) throw new Error("pending account meta missing");
  return pendingMeta.address;
}

export async function refundHelper(
  rpc: Rpc<SolanaRpcApi>,
  escrow: Address,
  facilitator: KeyPairSigner,
  pending: Address,
  refundAmount: number,
): Promise<void> {
  const ix = getRefundInstruction({
    escrow,
    facilitator,
    pending,
    refundAmount,
  });
  await sendTx(rpc, facilitator, [ix]);
}

export function withRemainingAccounts(
  ix: Instruction,
  accounts: Address[],
): Instruction {
  return {
    ...ix,
    accounts: [
      ...(ix.accounts ?? []),
      ...accounts.map((address) => ({
        address,
        role: AccountRole.WRITABLE as const,
      })),
    ],
  };
}

export async function finalizeHelper(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  escrow: Address,
  facilitator: Address,
  pending: Address,
  vault: Address,
  recipientAccounts: Address[],
): Promise<void> {
  const baseIx = getFinalizeInstruction({
    escrow,
    facilitator,
    pending,
    tokenAccount: vault,
  });

  const ix = withRemainingAccounts(baseIx, recipientAccounts);
  await sendTx(rpc, feePayer, [ix]);
}

export type EscrowWithPending = {
  escrowPDA: Address;
  mint: Address;
  vaultPDA: Address;
  sessionKey: KeyPairSigner;
  sessionKeyPDA: Address;
  pendingPDA: Address;
  splits: SplitEntry[];
};

export async function setupEscrowWithPending(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  facilitator: KeyPairSigner,
  payer: KeyPairSigner,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    depositAmount?: number;
    settleAmount?: number;
    authorizationId?: number;
    splits?: SplitEntry[];
  },
): Promise<EscrowWithPending> {
  const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
    await setupEscrowForAuth(rpc, owner, facilitator, payer, index, opts);

  let splits: SplitEntry[];
  if (opts?.splits) {
    splits = opts.splits;
  } else {
    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    splits = [{ recipient: recipient.address, bps: 10_000 }];
  }

  const authorizationId = opts?.authorizationId ?? 1;
  const settleAmount = opts?.settleAmount ?? 100_000;

  const pendingPDA = await submitAuthorizationHelper(
    rpc,
    escrowPDA,
    facilitator,
    sessionKey,
    sessionKeyPDA,
    mint,
    vaultPDA,
    authorizationId,
    settleAmount,
    splits,
    opts?.refundTimeoutSlots ? { refundTimeoutSlots: opts.refundTimeoutSlots } : {},
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
  escrowPDA: Address;
  mint: Address;
  vaultPDA: Address;
  sessionKey: KeyPairSigner;
  sessionKeyPDA: Address;
};

export async function setupEscrowForAuth(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  facilitator: KeyPairSigner,
  payer: KeyPairSigner,
  index: number,
  opts?: {
    refundTimeoutSlots?: number;
    deadmanTimeoutSlots?: number;
    depositAmount?: number;
    sessionKeyExpiresAtSlot?: bigint | null;
    revocationGracePeriodSlots?: number;
  },
): Promise<EscrowForAuth> {
  const depositAmount = opts?.depositAmount ?? 1_000_000;

  const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, index, {
    refundTimeoutSlots: opts?.refundTimeoutSlots ?? 100,
    deadmanTimeoutSlots: opts?.deadmanTimeoutSlots ?? 1000,
  });

  const mint = await createTestMint(rpc, payer);
  const source = await createFundedTokenAccount(
    rpc,
    mint.address,
    owner.address,
    payer,
    BigInt(depositAmount),
  );

  const depositIx = await getDepositInstructionAsync({
    depositor: owner,
    escrow: escrowPDA,
    mint: mint.address,
    source: source.address,
    amount: depositAmount,
  });
  const vaultMeta = depositIx.accounts[3];
  if (!vaultMeta) throw new Error("vault account meta missing");
  const vaultPDA = vaultMeta.address;

  const sessionKey = await generateKeyPairSigner();
  const registerIx = await getRegisterSessionKeyInstructionAsync({
    owner,
    escrow: escrowPDA,
    sessionKey: sessionKey.address,
    expiresAtSlot: opts?.sessionKeyExpiresAtSlot ?? null,
    revocationGracePeriodSlots: opts?.revocationGracePeriodSlots ?? 0,
  });
  const sessionKeyAccountMeta = registerIx.accounts[2];
  if (!sessionKeyAccountMeta) throw new Error("session key meta missing");
  const sessionKeyPDA = sessionKeyAccountMeta.address;

  await sendTx(rpc, owner, [depositIx, registerIx]);

  return {
    escrowPDA,
    mint: mint.address,
    vaultPDA,
    sessionKey,
    sessionKeyPDA,
  };
}
