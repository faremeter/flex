import { describe, it, expect, beforeAll } from "bun:test";
import { AccountRole, generateKeyPairSigner } from "@solana/kit";
import type { Instruction, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchEscrowAccount,
  getVoidPendingInstruction,
  getEmergencyCloseInstruction,
  FLEX_PROGRAM_ADDRESS,
  FLEX_ERROR__DEADMAN_NOT_EXPIRED,
  FLEX_ERROR__PENDING_SETTLEMENTS_EXIST,
  FLEX_ERROR__SESSION_KEYS_EXIST,
  FLEX_ERROR__VOID_CONDITION_NOT_MET,
  FLEX_ERROR__INVALID_VOID_AUTHORITY,
  fetchPendingSettlement,
  getCloseSessionKeyInstruction,
  getRevokeSessionKeyInstruction,
} from "@faremeter/flex-solana";
import {
  createRpc,
  sendTx,
  fundKeypair,
  createFundedTokenAccount,
  submitAuthorizationHelper,
  setupEscrowWithPending,
  setupEscrowForAuth,
  fetchTokenBalance,
  expectToFail,
  expectToFailWithAnchorError,
  ANCHOR_ERROR__CONSTRAINT_HAS_ONE,
  withRemainingAccounts,
  defined,
  waitForSlot,
} from "./helpers";

describe("void_pending", () => {
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

  it("closes pending settlement and returns rent to facilitator", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      200,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrowBefore.lastActivitySlot + 1001n);
    expect(escrowBefore.pendingCount).toBe(1);

    const { value: facilitatorBalanceBefore } = await rpc
      .getBalance(facilitator.address)
      .send();

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pendingPDA,
    });
    await sendTx(rpc, owner, [voidIx]);

    const pendingInfo = await rpc
      .getAccountInfo(pendingPDA, { encoding: "base64" })
      .send();
    expect(pendingInfo.value).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.pendingCount).toBe(0);

    const { value: facilitatorBalanceAfter } = await rpc
      .getBalance(facilitator.address)
      .send();
    expect(facilitatorBalanceAfter).toBeGreaterThan(facilitatorBalanceBefore);
  }, 15_000);

  it("fails before deadman timeout", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      201,
      { deadmanTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    await expectToFail(async () => {
      const voidIx = getVoidPendingInstruction({
        escrow: escrowPDA,
        authority: owner,
        facilitator: facilitator.address,
        pending: pendingPDA,
      });
      await sendTx(rpc, owner, [voidIx]);
    }, FLEX_ERROR__VOID_CONDITION_NOT_MET);
  }, 15_000);

  it("fails with unauthorized authority", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      202,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    const wrongOwner = await generateKeyPairSigner();
    await fundKeypair(rpc, wrongOwner);

    await expectToFail(async () => {
      const voidIx = getVoidPendingInstruction({
        escrow: escrowPDA,
        authority: wrongOwner,
        facilitator: facilitator.address,
        pending: pendingPDA,
      });
      await sendTx(rpc, wrongOwner, [voidIx]);
    }, FLEX_ERROR__INVALID_VOID_AUTHORITY);
  }, 15_000);

  it("fails with wrong facilitator", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      205,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    const wrongFacilitator = await generateKeyPairSigner();
    await fundKeypair(rpc, wrongFacilitator);

    await expectToFailWithAnchorError(async () => {
      const voidIx = getVoidPendingInstruction({
        escrow: escrowPDA,
        authority: owner,
        facilitator: wrongFacilitator.address,
        pending: pendingPDA,
      });
      await sendTx(rpc, owner, [voidIx]);
    }, ANCHOR_ERROR__CONSTRAINT_HAS_ONE);
  }, 15_000);

  it("fails at exact deadman timeout slot", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      203,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1000n);

    await expectToFail(async () => {
      const voidIx = getVoidPendingInstruction({
        escrow: escrowPDA,
        authority: owner,
        facilitator: facilitator.address,
        pending: pendingPDA,
      });
      await sendTx(rpc, owner, [voidIx]);
    }, FLEX_ERROR__VOID_CONDITION_NOT_MET);
  }, 15_000);

  it("succeeds one slot after deadman timeout", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      204,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pendingPDA,
    });
    await sendTx(rpc, owner, [voidIx]);

    const pendingInfo = await rpc
      .getAccountInfo(pendingPDA, { encoding: "base64" })
      .send();
    expect(pendingInfo.value).toBeNull();
  }, 15_000);

  it("voids via finalization deadline on an active escrow", async () => {
    // Submit pending A, wait, then submit pending B to bump last_activity_slot.
    // This creates a window where A's per-settlement deadline has passed
    // but the escrow-level deadman timeout has not expired (anchored to B's
    // submission time).
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 230, {
        refundTimeoutSlots: 150,
        deadmanTimeoutSlots: 1000,
        depositAmount: 1_000_000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    // Submit pending A
    const pendingA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      50_000,
      splits,
    );

    const pendingAData = defined(await fetchPendingSettlement(rpc, pendingA));
    // A's deadline = submitted_at_A + 150 + 1000 = submitted_at_A + 1150

    // Wait 500 slots, then submit pending B to push last_activity_slot forward
    await waitForSlot(rpc, pendingAData.submittedAtSlot + 500n);

    await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      2,
      50_000,
      splits,
    );

    const escrowAfterB = defined(await fetchEscrowAccount(rpc, escrowPDA));
    // Deadman = last_activity_slot + 1000 ≈ (submitted_at_A + 500) + 1000

    // Wait past A's deadline but not past deadman
    await waitForSlot(rpc, pendingAData.submittedAtSlot + 1151n);

    // Verify deadman is NOT expired
    const currentSlot = await rpc.getSlot().send();
    expect(currentSlot).toBeLessThanOrEqual(
      escrowAfterB.lastActivitySlot + 1000n,
    );

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pendingA,
    });
    await sendTx(rpc, owner, [voidIx]);

    const pendingInfo = await rpc
      .getAccountInfo(pendingA, { encoding: "base64" })
      .send();
    expect(pendingInfo.value).toBeNull();
  }, 15_000);

  it("facilitator can void as authority", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      231,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrowBefore.lastActivitySlot + 1001n);

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: facilitator,
      facilitator: facilitator.address,
      pending: pendingPDA,
    });
    await sendTx(rpc, facilitator, [voidIx]);

    const pendingInfo = await rpc
      .getAccountInfo(pendingPDA, { encoding: "base64" })
      .send();
    expect(pendingInfo.value).toBeNull();
  }, 15_000);

  it("fails when neither deadman nor deadline condition is met", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      233,
      {
        refundTimeoutSlots: 150,
        deadmanTimeoutSlots: 100_000,
        settleAmount: 50_000,
      },
    );

    await expectToFail(async () => {
      const voidIx = getVoidPendingInstruction({
        escrow: escrowPDA,
        authority: owner,
        facilitator: facilitator.address,
        pending: pendingPDA,
      });
      await sendTx(rpc, owner, [voidIx]);
    }, FLEX_ERROR__VOID_CONDITION_NOT_MET);
  }, 15_000);
});

describe("emergency_close", () => {
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

  it("recovers after voiding all pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 210, {
        deadmanTimeoutSlots: 1000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    const pending1 = await submitAuthorizationHelper(
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

    const pending2 = await submitAuthorizationHelper(
      rpc,
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

    const escrowMid = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowMid.pendingCount).toBe(2);

    await waitForSlot(rpc, escrowMid.lastActivitySlot + 1001n);

    const void1Ix = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pending1,
    });
    await sendTx(rpc, owner, [void1Ix]);

    const void2Ix = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pending2,
    });
    await sendTx(rpc, owner, [void2Ix]);

    const escrowPreClose = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowPreClose.pendingCount).toBe(0);

    // Close session key via deadman mode before emergency_close
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [closeKeyIx]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getEmergencyCloseInstruction({
      escrow: escrowPDA,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
    await sendTx(rpc, owner, [ix]);

    const destBalance = await fetchTokenBalance(rpc, dest.address);
    expect(destBalance).toBe(1_000_000n);

    const escrowInfo = await rpc
      .getAccountInfo(escrowPDA, { encoding: "base64" })
      .send();
    expect(escrowInfo.value).toBeNull();

    const vaultInfo = await rpc
      .getAccountInfo(vaultPDA, { encoding: "base64" })
      .send();
    expect(vaultInfo.value).toBeNull();
  }, 30_000);

  it("fails before deadman timeout even with no pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 212, {
        deadmanTimeoutSlots: 100_000,
        depositAmount: 1_000,
      });

    // Revoke and close session key so the test isolates deadman behavior
    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [revokeIx, closeKeyIx]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getEmergencyCloseInstruction({
        escrow: escrowPDA,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__DEADMAN_NOT_EXPIRED);
  }, 15_000);

  it("fails with pending settlements remaining", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      211,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getEmergencyCloseInstruction({
        escrow: escrowPDA,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__PENDING_SETTLEMENTS_EXIST);
  }, 15_000);

  it("fails at exact deadman timeout slot", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 214, {
        deadmanTimeoutSlots: 1000,
      });

    // Revoke and close session key so the test isolates deadman behavior
    const revokeIx = getRevokeSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [revokeIx, closeKeyIx]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1000n);

    await expectToFail(async () => {
      const baseIx = getEmergencyCloseInstruction({
        escrow: escrowPDA,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__DEADMAN_NOT_EXPIRED);
  }, 15_000);

  it("succeeds one slot after deadman timeout", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 215, {
        deadmanTimeoutSlots: 1000,
      });

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    // Close session key via deadman mode
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [closeKeyIx]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getEmergencyCloseInstruction({
      escrow: escrowPDA,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
    await sendTx(rpc, owner, [ix]);

    const escrowInfo = await rpc
      .getAccountInfo(escrowPDA, { encoding: "base64" })
      .send();
    expect(escrowInfo.value).toBeNull();
  }, 15_000);

  it("fails with wrong owner", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowForAuth(
      rpc,
      owner,
      facilitator,
      payer,
      213,
      { deadmanTimeoutSlots: 1000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const wrongOwner = await generateKeyPairSigner();
    await fundKeypair(rpc, wrongOwner);

    await expectToFailWithAnchorError(async () => {
      const baseIx = getEmergencyCloseInstruction({
        escrow: escrowPDA,
        owner: wrongOwner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, wrongOwner, [ix]);
    }, ANCHOR_ERROR__CONSTRAINT_HAS_ONE);
  }, 15_000);
});

describe("force_close is removed", () => {
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

  it("rejects the force_close discriminant even when timing conditions are met", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      220,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowBefore.pendingCount).toBe(1);

    await waitForSlot(rpc, escrowBefore.lastActivitySlot + 2001n);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    // Build a raw instruction using the old force_close Anchor discriminant.
    // This proves the on-chain program no longer recognizes this instruction,
    // not just that the TS client stopped exposing it.
    const FORCE_CLOSE_DISCRIMINATOR = new Uint8Array([
      71, 1, 6, 64, 15, 200, 254, 234,
    ]);

    const rawIx: Instruction = {
      programAddress: FLEX_PROGRAM_ADDRESS,
      data: FORCE_CLOSE_DISCRIMINATOR,
      accounts: [
        { address: escrowPDA, role: AccountRole.WRITABLE },
        { address: owner.address, role: AccountRole.WRITABLE_SIGNER },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: vaultPDA, role: AccountRole.WRITABLE },
        { address: dest.address, role: AccountRole.WRITABLE },
      ],
    };

    try {
      await sendTx(rpc, owner, [rawIx]);
      throw new Error("should have thrown");
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "should have thrown") {
        throw err;
      }
      // The program should reject an unknown discriminant.
      // We don't assert a specific error code because Anchor's dispatch
      // returns a generic error for unrecognized instruction data.
      expect(err).toBeDefined();
    }

    // Escrow must still be alive -- force_close must not have succeeded.
    const escrowAfter = await fetchEscrowAccount(rpc, escrowPDA);
    expect(escrowAfter).not.toBeNull();
  }, 15_000);

  it("recovery still works via void_pending + emergency_close", async () => {
    const { escrowPDA, mint, vaultPDA, pendingPDA, sessionKeyPDA } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 221, {
        deadmanTimeoutSlots: 1000,
        settleAmount: 50_000,
      });

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowBefore.pendingCount).toBe(1);

    await waitForSlot(rpc, escrowBefore.lastActivitySlot + 1001n);

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      authority: owner,
      facilitator: facilitator.address,
      pending: pendingPDA,
    });
    await sendTx(rpc, owner, [voidIx]);

    const escrowMid = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowMid.pendingCount).toBe(0);

    // Close session key via deadman mode
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [closeKeyIx]);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getEmergencyCloseInstruction({
      escrow: escrowPDA,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
    await sendTx(rpc, owner, [ix]);

    const destBalance = await fetchTokenBalance(rpc, dest.address);
    expect(destBalance).toBe(1_000_000n);

    const escrowInfo = await rpc
      .getAccountInfo(escrowPDA, { encoding: "base64" })
      .send();
    expect(escrowInfo.value).toBeNull();
  }, 30_000);

  it("rejects emergency_close when session keys exist", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowForAuth(
      rpc,
      owner,
      facilitator,
      payer,
      570,
      { deadmanTimeoutSlots: 1000 },
    );

    // Session key already registered by setupEscrowForAuth — don't close it
    const currentSlot = await rpc.getSlot().send();
    await waitForSlot(rpc, currentSlot + 1100n);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    await expectToFailWithAnchorError(async () => {
      const baseIx = getEmergencyCloseInstruction({
        escrow: escrowPDA,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__SESSION_KEYS_EXIST);
  });

  it("completes emergency cleanup with deadman session key close", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 571, {
        deadmanTimeoutSlots: 1000,
      });

    // Wait for deadman timeout
    const currentSlot = await rpc.getSlot().send();
    await waitForSlot(rpc, currentSlot + 1100n);

    // Close session key via deadman mode (key is active, not revoked)
    const closeKeyIx = getCloseSessionKeyInstruction({
      owner,
      escrow: escrowPDA,
      sessionKeyAccount: sessionKeyPDA,
    });
    await sendTx(rpc, owner, [closeKeyIx]);

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.sessionKeyCount).toBe(0);

    // Now emergency_close should succeed
    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getEmergencyCloseInstruction({
      escrow: escrowPDA,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
    await sendTx(rpc, owner, [ix]);

    const escrowInfo = await rpc
      .getAccountInfo(escrowPDA, { encoding: "base64" })
      .send();
    expect(escrowInfo.value).toBeNull();
  }, 30_000);
});
