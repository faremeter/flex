import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchPendingSettlement,
  getSubmitAuthorizationInstructionAsync,
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  FLEX_PROGRAM_ADDRESS,
  FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
  FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
} from "@faremeter/flex-solana";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  createRpc,
  fundKeypair,
  createFundedTokenAccount,
  submitAuthorizationHelper,
  setupEscrowWithPending,
  setupEscrowForAuth,
  finalizeHelper,
  fetchTokenBalance,
  expectToFail,
  defined,
  waitForSlot,
  sendTx,
} from "./helpers";

describe("finalize does not update last_activity_slot", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("preserves last_activity_slot after finalize", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 510, {
        refundTimeoutSlots: 150,
        settleAmount: 50_000,
      });

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    const slotBefore = escrowBefore.lastActivitySlot;

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    const recipientAddr = defined(splits[0]).recipient;
    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      pendingPDA,
      vaultPDA,
      [recipientAddr],
    );

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.lastActivitySlot).toBe(slotBefore);
  });
});

describe("finalize is permissionless", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("allows a third party to finalize", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 520, {
        refundTimeoutSlots: 150,
        settleAmount: 50_000,
      });

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    const thirdParty = await generateKeyPairSigner();
    await fundKeypair(rpc, thirdParty);

    const recipientAddr = defined(splits[0]).recipient;
    await finalizeHelper(
      rpc,
      thirdParty,
      escrowPDA,
      facilitator.address,
      pendingPDA,
      vaultPDA,
      [recipientAddr],
    );

    const recipientBalance = await fetchTokenBalance(rpc, recipientAddr);
    expect(Number(recipientBalance)).toBe(50_000);
  });
});

describe("finalize skips zero-amount split transfers", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("handles a split that rounds to zero tokens", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 550, {
        refundTimeoutSlots: 150,
      });

    const r1 = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const r2 = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    // With amount=1 and bps=1/9999, first split gets 1*1/10000=0 (truncated).
    // The last recipient gets total - cumulative = 1 - 0 = 1.
    // This exercises the `if amount > 0` skip branch in finalize.
    const splits = [
      { recipient: r1.address, bps: 1 },
      { recipient: r2.address, bps: 9_999 },
    ];

    const pendingPDA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      1,
      splits,
      { refundTimeoutSlots: 150 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      pendingPDA,
      vaultPDA,
      [r1.address, r2.address],
    );

    expect(await fetchTokenBalance(rpc, r1.address)).toBe(0n);
    expect(await fetchTokenBalance(rpc, r2.address)).toBe(1n);
  });
});

describe("finalize with wrong remaining accounts count", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("rejects finalize with no remaining accounts when one is expected", async () => {
    const { escrowPDA, vaultPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      590,
      { refundTimeoutSlots: 150, settleAmount: 50_000 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    // Pass zero remaining accounts when split_count is 1.
    await expectToFail(
      () =>
        finalizeHelper(
          rpc,
          facilitator,
          escrowPDA,
          facilitator.address,
          pendingPDA,
          vaultPDA,
          [],
        ),
      FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
    );
  });
});

describe("ed25519 instruction position", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, facilitator);
    await fundKeypair(rpc, payer);
  });

  it("fails when ed25519 instruction is not immediately before submit", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 540);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const currentSlot = await rpc.getSlot().send();
    const expiresAtSlot = currentSlot + 50n;
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    const message = serializePaymentAuthorization({
      programId: FLEX_PROGRAM_ADDRESS,
      escrow: escrowPDA,
      mint,
      maxAmount: 100_000n,
      authorizationId: 1n,
      expiresAtSlot,
      splits,
    });

    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        sessionKey.keyPair.privateKey,
        message,
      ),
    );

    const ed25519Ix = createEd25519VerifyInstruction({
      publicKey: sessionKey.address,
      message,
      signature,
    });

    const submitIx = await getSubmitAuthorizationInstructionAsync({
      escrow: escrowPDA,
      facilitator,
      sessionKey: sessionKeyPDA,
      tokenAccount: vaultPDA,
      mint,
      maxAmount: 100_000,
      settleAmount: 100_000,
      authorizationId: 1,
      expiresAtSlot,
      splits,
    });

    // Insert a system transfer between the Ed25519 verify and the submit.
    // The program checks current_index - 1, which will find the system
    // transfer instead of the ed25519 verify instruction.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- upstream type declaration error
    const fillerIx: typeof submitIx = getTransferSolInstruction({
      source: facilitator,
      destination: facilitator.address,
      amount: 0,
    });

    await expectToFail(
      () => sendTx(rpc, facilitator, [ed25519Ix, fillerIx, submitIx]),
      FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
    );
  });

  it("fails when ed25519 instruction is missing entirely", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 541);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const currentSlot = await rpc.getSlot().send();
    const expiresAtSlot = currentSlot + 50n;
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    const submitIx = await getSubmitAuthorizationInstructionAsync({
      escrow: escrowPDA,
      facilitator,
      sessionKey: sessionKeyPDA,
      tokenAccount: vaultPDA,
      mint,
      maxAmount: 100_000,
      settleAmount: 100_000,
      authorizationId: 1,
      expiresAtSlot,
      splits,
    });

    // Submit with no preceding ed25519 instruction at all.
    // current_index == 0, so the require!(current_index > 0) check fails.
    await expectToFail(
      () => sendTx(rpc, facilitator, [submitIx]),
      FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
    );
  });
});
