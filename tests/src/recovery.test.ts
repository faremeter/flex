import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchEscrowAccount,
  getVoidPendingInstruction,
  getEmergencyCloseInstruction,
  getForceCloseInstruction,
  FLEX_ERROR__DEADMAN_NOT_EXPIRED,
  FLEX_ERROR__PENDING_SETTLEMENTS_EXIST,
  FLEX_ERROR__FORCE_CLOSE_TIMEOUT_NOT_EXPIRED,
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

  it("closes pending settlement and returns rent to owner", async () => {
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
    expect(escrowBefore.pendingCount).toBe(1n);

    const { value: ownerBalanceBefore } = await rpc
      .getBalance(owner.address)
      .send();

    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      owner,
      pending: pendingPDA,
    });
    await sendTx(rpc, owner, [voidIx]);

    const pendingInfo = await rpc
      .getAccountInfo(pendingPDA, { encoding: "base64" })
      .send();
    expect(pendingInfo.value).toBeNull();

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfter.pendingCount).toBe(0n);

    const { value: ownerBalanceAfter } = await rpc
      .getBalance(owner.address)
      .send();
    expect(ownerBalanceAfter).toBeGreaterThan(ownerBalanceBefore);
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
        owner,
        pending: pendingPDA,
      });
      await sendTx(rpc, owner, [voidIx]);
    }, FLEX_ERROR__DEADMAN_NOT_EXPIRED);
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
    expect(escrowMid.pendingCount).toBe(2n);

    await waitForSlot(rpc, escrowMid.lastActivitySlot + 1001n);

    const void1Ix = getVoidPendingInstruction({
      escrow: escrowPDA,
      owner,
      pending: pending1,
    });
    await sendTx(rpc, owner, [void1Ix]);

    const void2Ix = getVoidPendingInstruction({
      escrow: escrowPDA,
      owner,
      pending: pending2,
    });
    await sendTx(rpc, owner, [void2Ix]);

    const escrowPreClose = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowPreClose.pendingCount).toBe(0n);

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
    const { escrowPDA, mint, vaultPDA } = await setupEscrowForAuth(
      rpc,
      owner,
      facilitator,
      payer,
      212,
      { deadmanTimeoutSlots: 100_000, depositAmount: 1_000 },
    );

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
});

describe("force_close", () => {
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

  it("works at 2x deadman timeout even with pending settlements", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      220,
      { deadmanTimeoutSlots: 1000, settleAmount: 50_000 },
    );

    const escrowBefore = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowBefore.pendingCount).toBe(1n);

    await waitForSlot(rpc, escrowBefore.lastActivitySlot + 2001n);

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getForceCloseInstruction({
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
  }, 15_000);

  it("fails before 2x deadman timeout", async () => {
    const { escrowPDA, mint, vaultPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      221,
      { deadmanTimeoutSlots: 100_000, settleAmount: 50_000 },
    );

    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getForceCloseInstruction({
        escrow: escrowPDA,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__FORCE_CLOSE_TIMEOUT_NOT_EXPIRED);
  }, 15_000);
});
