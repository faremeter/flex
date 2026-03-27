import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchPendingSettlement,
  FLEX_ERROR__AUTHORIZATION_EXPIRED,
  FLEX_ERROR__EXPIRY_TOO_FAR,
  FLEX_ERROR__PENDING_LIMIT_REACHED,
  FLEX_ERROR__INSUFFICIENT_BALANCE,
  FLEX_ERROR__INVALID_SPLIT_BPS,
  FLEX_ERROR__SPLIT_BPS_ZERO,
  FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT,
  FLEX_ERROR__REFUND_WINDOW_EXPIRED,
  FLEX_ERROR__REFUND_EXCEEDS_AMOUNT,
  FLEX_ERROR__REFUND_AMOUNT_ZERO,
  FLEX_ERROR__REFUND_WINDOW_NOT_EXPIRED,
  FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
  FLEX_ERROR__SETTLE_AMOUNT_ZERO,
  FLEX_ERROR__SETTLE_EXCEEDS_MAX,
  FLEX_ERROR__INVALID_SPLIT_COUNT,
  FLEX_ERROR__SESSION_KEY_EXPIRED,
  FLEX_ERROR__SESSION_KEY_REVOKED,
  FLEX_ERROR__INVALID_SIGNATURE,
  fetchSessionKey,
  getRevokeSessionKeyInstruction,
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  FLEX_PROGRAM_ADDRESS,
  getSubmitAuthorizationInstructionAsync,
} from "@faremeter/flex-solana";
import {
  createRpc,
  sendTx,
  fundKeypair,
  defined,
  createFundedTokenAccount,
  submitAuthorizationHelper,
  setupEscrowWithPending,
  setupEscrowForAuth,
  refundHelper,
  finalizeHelper,
  fetchTokenBalance,
  expectToFail,
  waitForSlot,
} from "./helpers";

describe("submit_authorization", () => {
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

  it("creates pending settlement with correct fields", async () => {
    const { escrowPDA, mint, pendingPDA, sessionKey, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 100, {
        settleAmount: 50_000,
      });

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(pending.version).toBe(1);
    expect(pending.escrow).toBe(escrowPDA);
    expect(pending.mint).toBe(mint);
    expect(Number(pending.amount)).toBe(50_000);
    expect(Number(pending.originalAmount)).toBe(50_000);
    expect(Number(pending.maxAmount)).toBe(50_000);
    expect(Number(pending.authorizationId)).toBe(1);
    expect(Number(pending.expiresAtSlot)).toBeGreaterThan(0);
    expect(Number(pending.submittedAtSlot)).toBeGreaterThan(0);
    expect(pending.sessionKey).toBe(sessionKey.address);
    expect(pending.splitCount).toBe(1);
    expect(defined(pending.splits[0]).recipient).toBe(
      defined(splits[0]).recipient,
    );
    expect(defined(pending.splits[0]).bps).toBe(10_000);
    expect(pending.bump).toBeGreaterThan(0);
  });

  it("updates last_activity_slot on escrow", async () => {
    const { escrowPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      101,
      { authorizationId: 42 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrow.lastActivitySlot)).toBeGreaterThan(0);
  }, 15_000);

  it("fails when authorization has expired", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 103);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [{ recipient: recipient.address, bps: 10_000 }],
          { expiresAtSlot: 1n },
        ),
      FLEX_ERROR__AUTHORIZATION_EXPIRED,
    );
  });

  it("fails when expiry too far", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 1030);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const currentSlot = await rpc.getSlot().send();

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          2,
          100_000,
          [{ recipient: recipient.address, bps: 10_000 }],
          { expiresAtSlot: currentSlot + 10_000n },
        ),
      FLEX_ERROR__EXPIRY_TOO_FAR,
    );
  });

  it("fails with duplicate authorization_id", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 1031, {
        depositAmount: 10_000_000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      999,
      100_000,
      splits,
    );

    let threw = false;
    try {
      await submitAuthorizationHelper(
        rpc,
        escrowPDA,
        facilitator,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        999,
        100_000,
        splits,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("fails when pending limit reached", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 104, {
        depositAmount: 10_000_000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    for (let i = 1; i <= 16; i++) {
      await submitAuthorizationHelper(
        rpc,
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

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          17,
          1_000,
          splits,
        ),
      FLEX_ERROR__PENDING_LIMIT_REACHED,
    );
  }, 60_000);

  it("fails with insufficient vault balance", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 105, {
        depositAmount: 1_000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          2_000,
          [{ recipient: recipient.address, bps: 10_000 }],
        ),
      FLEX_ERROR__INSUFFICIENT_BALANCE,
    );
  });

  it("fails with split bps not summing to 10000", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 106);

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

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [
            { recipient: r1.address, bps: 5_000 },
            { recipient: r2.address, bps: 4_000 },
          ],
        ),
      FLEX_ERROR__INVALID_SPLIT_BPS,
    );
  });

  it("fails with zero bps entry", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 107);

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

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [
            { recipient: r1.address, bps: 10_000 },
            { recipient: r2.address, bps: 0 },
          ],
        ),
      FLEX_ERROR__SPLIT_BPS_ZERO,
    );
  });

  it("fails with duplicate split recipients", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 108);

    const r1 = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [
            { recipient: r1.address, bps: 7_000 },
            { recipient: r1.address, bps: 3_000 },
          ],
        ),
      FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT,
    );
  });

  it("works with single-recipient split", async () => {
    const { pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      109,
      { settleAmount: 200_000 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(pending.splitCount).toBe(1);
    expect(defined(pending.splits[0]).bps).toBe(10_000);
    expect(Number(pending.amount)).toBe(200_000);
  });

  it("works with multi-recipient split", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 110);

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

    const splits = [
      { recipient: r1.address, bps: 7_000 },
      { recipient: r2.address, bps: 3_000 },
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
      100_000,
      splits,
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(pending.splitCount).toBe(2);
    expect(defined(pending.splits[0]).recipient).toBe(r1.address);
    expect(defined(pending.splits[0]).bps).toBe(7_000);
    expect(defined(pending.splits[1]).recipient).toBe(r2.address);
    expect(defined(pending.splits[1]).bps).toBe(3_000);
  });

  it("fails with settle amount of zero", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 150);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          0,
          [{ recipient: recipient.address, bps: 10_000 }],
        ),
      FLEX_ERROR__SETTLE_AMOUNT_ZERO,
    );
  });

  it("fails when settle exceeds max amount", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 151);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [{ recipient: recipient.address, bps: 10_000 }],
          { maxAmount: 50_000 },
        ),
      FLEX_ERROR__SETTLE_EXCEEDS_MAX,
    );
  });

  it("fails with empty splits", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 152);

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [],
        ),
      FLEX_ERROR__INVALID_SPLIT_COUNT,
    );
  });

  it("fails with expired session key", async () => {
    const currentSlot = await rpc.getSlot().send();
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 153, {
        sessionKeyExpiresAtSlot: currentSlot + 5n,
      });

    await waitForSlot(rpc, currentSlot + 5n);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [{ recipient: recipient.address, bps: 10_000 }],
        ),
      FLEX_ERROR__SESSION_KEY_EXPIRED,
    );
  });

  it("succeeds with revoked key within grace period", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 154, {
        revocationGracePeriodSlots: 100_000_000,
      });

    const revokeIx = getRevokeSessionKeyInstruction({
      escrow: escrowPDA,
      owner,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    const sessionKeyAccount = defined(
      await fetchSessionKey(rpc, sessionKeyPDA),
    );
    expect(sessionKeyAccount.active).toBe(false);
    expect(sessionKeyAccount.revokedAtSlot).not.toBeNull();

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const pendingPDA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      100_000,
      [{ recipient: recipient.address, bps: 10_000 }],
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending.amount)).toBe(100_000);
  });

  it("fails with revoked key past grace period", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 158, {
        revocationGracePeriodSlots: 5,
      });

    const revokeIx = getRevokeSessionKeyInstruction({
      escrow: escrowPDA,
      owner,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [revokeIx]);

    const sessionKeyAccount = defined(
      await fetchSessionKey(rpc, sessionKeyPDA),
    );
    await waitForSlot(rpc, defined(sessionKeyAccount.revokedAtSlot) + 5n);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    await expectToFail(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mint,
          vaultPDA,
          1,
          100_000,
          [{ recipient: recipient.address, bps: 10_000 }],
        ),
      FLEX_ERROR__SESSION_KEY_REVOKED,
    );
  });

  // The Ed25519 verify instruction checks a signature from wrongKey, which
  // succeeds because the signature is valid for that key. But the program's
  // introspection compares the pubkey against the registered session key and
  // finds a mismatch, returning InvalidSignature.
  it("fails with wrong session key signature", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 155);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const wrongKey = await generateKeyPairSigner();
    const splits = [{ recipient: recipient.address, bps: 10_000 }];
    const currentSlot = await rpc.getSlot().send();
    const expiresAtSlot = currentSlot + 50n;

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
      await crypto.subtle.sign("Ed25519", wrongKey.keyPair.privateKey, message),
    );

    const ed25519Ix = createEd25519VerifyInstruction({
      publicKey: wrongKey.address,
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
      signature: new Uint8Array(64),
    });

    await expectToFail(
      () => sendTx(rpc, facilitator, [ed25519Ix, submitIx]),
      FLEX_ERROR__INVALID_SIGNATURE,
    );
  });

  it("fails with unauthorized facilitator", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 156);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const unauthorized = await generateKeyPairSigner();
    await fundKeypair(rpc, unauthorized);

    let threw = false;
    try {
      await submitAuthorizationHelper(
        rpc,
        escrowPDA,
        unauthorized,
        sessionKey,
        sessionKeyPDA,
        mint,
        vaultPDA,
        1,
        100_000,
        [{ recipient: recipient.address, bps: 10_000 }],
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("succeeds with settle amount less than max", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 157);

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const pendingPDA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      100_000,
      [{ recipient: recipient.address, bps: 10_000 }],
      { maxAmount: 200_000 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending.amount)).toBe(100_000);
    expect(Number(pending.maxAmount)).toBe(200_000);
    expect(Number(pending.originalAmount)).toBe(100_000);
  });
});

describe("refund", () => {
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

  it("partial refund reduces pending amount and updates last_activity_slot", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      120,
      {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 100_000,
      },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    const slotBefore = Number(escrowBefore.lastActivitySlot);

    await refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 40_000);

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending.amount)).toBe(60_000);
    expect(Number(pending.originalAmount)).toBe(100_000);

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowAfter.lastActivitySlot)).toBeGreaterThanOrEqual(
      slotBefore,
    );
  });

  it("full refund closes pending settlement account", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      121,
      {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 50_000,
      },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowBefore.pendingCount)).toBe(1);

    await refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 50_000);

    const pendingAfter = await fetchPendingSettlement(rpc, pendingPDA);
    expect(pendingAfter).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowAfter.pendingCount)).toBe(0);
  });

  it("fails after refund window expires", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      122,
      { refundTimeoutSlots: 150, settleAmount: 50_000 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    await expectToFail(
      () => refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 10_000),
      FLEX_ERROR__REFUND_WINDOW_EXPIRED,
    );
  });

  it("fails when refund amount exceeds pending amount", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      123,
      {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 50_000,
      },
    );

    await expectToFail(
      () => refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 60_000),
      FLEX_ERROR__REFUND_EXCEEDS_AMOUNT,
    );
  });

  it("fails with zero refund amount", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      124,
      {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 50_000,
      },
    );

    await expectToFail(
      () => refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 0),
      FLEX_ERROR__REFUND_AMOUNT_ZERO,
    );
  });
});

describe("finalize", () => {
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

  it("distributes to single recipient and decrements pending_count", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 130, {
        refundTimeoutSlots: 150,
        settleAmount: 100_000,
      });

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowBefore.pendingCount)).toBe(1);

    const recipientAddr = defined(splits[0]).recipient;
    const recipientBefore = await fetchTokenBalance(rpc, recipientAddr);
    expect(Number(recipientBefore)).toBe(0);

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      pendingPDA,
      vaultPDA,
      [recipientAddr],
    );

    const recipientAfter = await fetchTokenBalance(rpc, recipientAddr);
    expect(Number(recipientAfter)).toBe(100_000);

    const pendingAfter = await fetchPendingSettlement(rpc, pendingPDA);
    expect(pendingAfter).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowAfter.pendingCount)).toBe(0);
  });

  it("distributes to multiple recipients proportionally", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 131, {
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

    const splits = [
      { recipient: r1.address, bps: 7_000 },
      { recipient: r2.address, bps: 3_000 },
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
      100_000,
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

    const r1Balance = await fetchTokenBalance(rpc, r1.address);
    expect(Number(r1Balance)).toBe(70_000);

    const r2Balance = await fetchTokenBalance(rpc, r2.address);
    expect(Number(r2Balance)).toBe(30_000);
  });

  it("handles rounding dust for last recipient", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 132, {
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
    const r3 = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    const splits = [
      { recipient: r1.address, bps: 3_333 },
      { recipient: r2.address, bps: 3_333 },
      { recipient: r3.address, bps: 3_334 },
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
      100,
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
      [r1.address, r2.address, r3.address],
    );

    const r1Balance = await fetchTokenBalance(rpc, r1.address);
    const r2Balance = await fetchTokenBalance(rpc, r2.address);
    const r3Balance = await fetchTokenBalance(rpc, r3.address);

    // 100 * 3333 / 10000 = 33 for r1 and r2, last gets 100 - 33 - 33 = 34
    expect(Number(r1Balance)).toBe(33);
    expect(Number(r2Balance)).toBe(33);
    expect(Number(r3Balance)).toBe(34);
  }, 15_000);

  it("fails before refund window expires", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 133, {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 50_000,
      });

    await expectToFail(
      () =>
        finalizeHelper(
          rpc,
          facilitator,
          escrowPDA,
          facilitator.address,
          pendingPDA,
          vaultPDA,
          [defined(splits[0]).recipient],
        ),
      FLEX_ERROR__REFUND_WINDOW_NOT_EXPIRED,
    );
  });

  it("fails with wrong recipient accounts", async () => {
    const { escrowPDA, vaultPDA, pendingPDA, mint } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 134, {
        refundTimeoutSlots: 150,
        settleAmount: 50_000,
      });

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));

    const wrongRecipient = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    await expectToFail(
      () =>
        finalizeHelper(
          rpc,
          facilitator,
          escrowPDA,
          facilitator.address,
          pendingPDA,
          vaultPDA,
          [wrongRecipient.address],
        ),
      FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
    );
  });
});
