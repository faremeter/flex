import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchPendingSettlement,
  getSubmitAuthorizationInstructionAsync,
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  getDepositInstructionAsync,
  getCloseEscrowInstruction,
  FLEX_PROGRAM_ADDRESS,
  FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
  FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
  FLEX_ERROR__INVALID_SPLIT_COUNT,
  FLEX_ERROR__INSUFFICIENT_BALANCE,
  FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR,
} from "@faremeter/flex-solana";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
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
  createTestMint,
  createEscrowHelper,
  withRemainingAccounts,
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

describe("submit with non-null session key expiry", () => {
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

  it("succeeds when session key has a future expiry", async () => {
    const currentSlot = await rpc.getSlot().send();
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 570, {
        sessionKeyExpiresAtSlot: currentSlot + 100_000n,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    // This exercises the `if let Some(expires_at)` success path in
    // submit_authorization where the key is not expired.
    const pendingPDA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      50_000,
      [{ recipient: recipient.address, bps: 10_000 }],
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending.amount)).toBe(50_000);
  });
});

describe("submit with too many splits", () => {
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

  it("rejects authorization with 6 splits", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 600);

    const recipients = [];
    for (let i = 0; i < 6; i++) {
      const r = await createFundedTokenAccount(
        rpc,
        mint,
        facilitator.address,
        payer,
        0n,
      );
      recipients.push(r);
    }

    // 6 splits exceeds MAX_SPLITS (5).
    const splits = [
      { recipient: defined(recipients[0]).address, bps: 2_000 },
      { recipient: defined(recipients[1]).address, bps: 2_000 },
      { recipient: defined(recipients[2]).address, bps: 2_000 },
      { recipient: defined(recipients[3]).address, bps: 2_000 },
      { recipient: defined(recipients[4]).address, bps: 1_000 },
      { recipient: defined(recipients[5]).address, bps: 1_000 },
    ];

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
          50_000,
          splits,
        ),
      FLEX_ERROR__INVALID_SPLIT_COUNT,
    );
  }, 30_000);
});

describe("deposit with zero amount", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, payer);
  });

  it("rejects deposit of zero tokens", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 580);
    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000n,
    );

    // Exercises the require!(amount > 0) guard in deposit.
    await expectToFail(async () => {
      const depositIx = await getDepositInstructionAsync({
        depositor: owner,
        escrow: escrowPDA,
        mint: mint.address,
        source: source.address,
        amount: 0,
      });
      await sendTx(rpc, owner, [depositIx]);
    }, FLEX_ERROR__INSUFFICIENT_BALANCE);
  });
});

describe("close escrow with empty vault", () => {
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

  it("closes vault with zero balance after all funds finalized out", async () => {
    const { escrowPDA, mint, vaultPDA, pendingPDA, splits } =
      await setupEscrowWithPending(rpc, owner, facilitator, payer, 560, {
        refundTimeoutSlots: 150,
        depositAmount: 100_000,
        settleAmount: 100_000,
      });

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

    // Vault is now empty
    expect(await fetchTokenBalance(rpc, vaultPDA)).toBe(0n);

    // Close the escrow, providing the empty vault and a destination.
    // This exercises the `if amount > 0` skip in close_token_accounts.
    const dest = await createFundedTokenAccount(
      rpc,
      mint,
      owner.address,
      payer,
      0n,
    );

    const baseIx = getCloseEscrowInstruction({
      escrow: escrowPDA,
      owner,
      facilitator,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ix = withRemainingAccounts(baseIx, [vaultPDA, dest.address]);
    await sendTx(rpc, owner, [ix]);

    // Vault account is fully closed
    const vaultInfo = await rpc
      .getAccountInfo(vaultPDA, { encoding: "base64" })
      .send();
    expect(vaultInfo.value).toBeNull();

    // Destination still has 0 tokens (no transfer happened)
    expect(await fetchTokenBalance(rpc, dest.address)).toBe(0n);
  });
});

describe("close_token_accounts remaining_accounts validation", () => {
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

  it("rejects destination owned by wrong party", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 700);
    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 1_000,
    });
    await sendTx(rpc, owner, [depositIx]);

    const vaultPDA = defined(depositIx.accounts[3]).address;

    // Destination owned by a third party, not the escrow owner.
    const wrongOwner = await generateKeyPairSigner();
    const wrongDest = await createFundedTokenAccount(
      rpc,
      mint.address,
      wrongOwner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [vaultPDA, wrongDest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR);
  });

  it("rejects destination with mismatched mint", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 701);
    const mintA = await createTestMint(rpc, payer);
    const mintB = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mintA.address,
      owner.address,
      payer,
      1_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mintA.address,
      source: source.address,
      amount: 1_000,
    });
    await sendTx(rpc, owner, [depositIx]);

    const vaultPDA = defined(depositIx.accounts[3]).address;

    // Destination has wrong mint (mintB instead of mintA).
    const wrongMintDest = await createFundedTokenAccount(
      rpc,
      mintB.address,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [
        vaultPDA,
        wrongMintDest.address,
      ]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR);
  });

  it("rejects non-vault source account", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 702);
    const mint = await createTestMint(rpc, payer);
    const source = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      1_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mint.address,
      source: source.address,
      amount: 1_000,
    });
    await sendTx(rpc, owner, [depositIx]);

    // Use a regular token account (not the vault PDA) as the source.
    const fakeSrc = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      0n,
    );
    const dest = await createFundedTokenAccount(
      rpc,
      mint.address,
      owner.address,
      payer,
      0n,
    );

    await expectToFail(async () => {
      const baseIx = getCloseEscrowInstruction({
        escrow: escrowPDA,
        owner,
        facilitator,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const ix = withRemainingAccounts(baseIx, [fakeSrc.address, dest.address]);
      await sendTx(rpc, owner, [ix]);
    }, FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR);
  });
});
