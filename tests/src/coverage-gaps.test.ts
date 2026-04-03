import { describe, it, expect, beforeAll } from "bun:test";
import {
  type Address,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import {
  fetchEscrowAccount,
  fetchPendingSettlement,
  getSubmitAuthorizationInstructionAsync,
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  getDepositInstructionAsync,
  getCloseEscrowInstruction,
  getRegisterSessionKeyInstructionAsync,
  FLEX_PROGRAM_ADDRESS,
  FLEX_ERROR__INVALID_ED25519_INSTRUCTION,
  FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
  FLEX_ERROR__INVALID_SPLIT_COUNT,
  FLEX_ERROR__INSUFFICIENT_BALANCE,
  FLEX_ERROR__INVALID_TOKEN_ACCOUNT_PAIR,
  FLEX_ERROR__PENDING_LIMIT_REACHED,
  FLEX_ERROR__REFUND_EXCEEDS_AMOUNT,
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
  refundHelper,
  fetchTokenBalance,
  expectToFail,
  expectToFailWithAnchorError,
  ANCHOR_ERROR__ACCOUNT_ALREADY_IN_USE,
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

describe("finalize rejects wrong-mint recipient", () => {
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

  it("rejects recipient token account with wrong mint", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 710, {
        refundTimeoutSlots: 150,
      });

    // Create a recipient token account for a different mint.
    const wrongMint = await createTestMint(rpc, payer);
    const wrongMintRecipient = await createFundedTokenAccount(
      rpc,
      wrongMint.address,
      facilitator.address,
      payer,
      0n,
    );

    // Submit with the wrong-mint recipient address in the splits.
    // submit_authorization does not validate recipient mints.
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
      [{ recipient: wrongMintRecipient.address, bps: 10_000 }],
      { refundTimeoutSlots: 150 },
    );

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    await waitForSlot(rpc, pending.submittedAtSlot + 150n);

    // Finalize catches the mint mismatch.
    await expectToFail(
      () =>
        finalizeHelper(
          rpc,
          facilitator,
          escrowPDA,
          facilitator.address,
          pendingPDA,
          vaultPDA,
          [wrongMintRecipient.address],
        ),
      FLEX_ERROR__INVALID_SPLIT_RECIPIENT,
    );
  });
});

describe("non-owner can deposit", () => {
  const rpc = createRpc();
  let owner: KeyPairSigner;
  let facilitator: KeyPairSigner;
  let payer: KeyPairSigner;
  let thirdParty: KeyPairSigner;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    facilitator = await generateKeyPairSigner();
    payer = await generateKeyPairSigner();
    thirdParty = await generateKeyPairSigner();
    await fundKeypair(rpc, owner);
    await fundKeypair(rpc, payer);
    await fundKeypair(rpc, thirdParty);
  });

  it("allows a third party to deposit into an escrow they do not own", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 720);
    const mint = await createTestMint(rpc, payer);

    const thirdPartySource = await createFundedTokenAccount(
      rpc,
      mint.address,
      thirdParty.address,
      payer,
      500_000n,
    );

    const depositIx = await getDepositInstructionAsync({
      depositor: thirdParty,
      escrow: escrowPDA,
      mint: mint.address,
      source: thirdPartySource.address,
      amount: 500_000,
    });
    await sendTx(rpc, thirdParty, [depositIx]);

    const vaultPDA = defined(depositIx.accounts[3]).address;
    expect(await fetchTokenBalance(rpc, vaultPDA)).toBe(500_000n);
  });
});

describe("authorization ID uniqueness is per-escrow not per-mint", () => {
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

  it("rejects duplicate auth ID even with different mints", async () => {
    const escrowPDA = await createEscrowHelper(rpc, owner, facilitator, 730);

    const mintA = await createTestMint(rpc, payer);
    const mintB = await createTestMint(rpc, payer);

    const sourceA = await createFundedTokenAccount(
      rpc,
      mintA.address,
      owner.address,
      payer,
      1_000_000n,
    );
    const sourceB = await createFundedTokenAccount(
      rpc,
      mintB.address,
      owner.address,
      payer,
      1_000_000n,
    );

    const depositIxA = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mintA.address,
      source: sourceA.address,
      amount: 1_000_000,
    });
    const depositIxB = await getDepositInstructionAsync({
      depositor: owner,
      escrow: escrowPDA,
      mint: mintB.address,
      source: sourceB.address,
      amount: 1_000_000,
    });

    const sessionKey = await generateKeyPairSigner();
    const registerIx = await getRegisterSessionKeyInstructionAsync({
      owner,
      escrow: escrowPDA,
      sessionKey: sessionKey.address,
      expiresAtSlot: null,
      revocationGracePeriodSlots: 0,
    });
    const sessionKeyPDA = defined(registerIx.accounts[2]).address;

    await sendTx(rpc, owner, [depositIxA, depositIxB, registerIx]);

    const vaultA = defined(depositIxA.accounts[3]).address;
    const vaultB = defined(depositIxB.accounts[3]).address;

    const recipientA = await createFundedTokenAccount(
      rpc,
      mintA.address,
      facilitator.address,
      payer,
      0n,
    );
    const recipientB = await createFundedTokenAccount(
      rpc,
      mintB.address,
      facilitator.address,
      payer,
      0n,
    );

    await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mintA.address,
      vaultA,
      1,
      100_000,
      [{ recipient: recipientA.address, bps: 10_000 }],
    );

    // Same authId=1 on a different mint fails because the pending PDA
    // seeds are [b"pending", escrow, authId] with no mint component.
    await expectToFailWithAnchorError(
      () =>
        submitAuthorizationHelper(
          rpc,
          escrowPDA,
          facilitator,
          sessionKey,
          sessionKeyPDA,
          mintB.address,
          vaultB,
          1,
          100_000,
          [{ recipient: recipientB.address, bps: 10_000 }],
        ),
      ANCHOR_ERROR__ACCOUNT_ALREADY_IN_USE,
    );
  }, 30_000);
});

describe("finalize succeeds after deadman timeout", () => {
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

  it("finalizes well past the deadman timeout", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 740, {
        refundTimeoutSlots: 150,
        deadmanTimeoutSlots: 1000,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );

    // Submit two authorizations.
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
      [{ recipient: recipient.address, bps: 10_000 }],
      { refundTimeoutSlots: 150 },
    );
    const pendingB = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      2,
      50_000,
      [{ recipient: recipient.address, bps: 10_000 }],
      { refundTimeoutSlots: 150 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    await waitForSlot(rpc, escrow.lastActivitySlot + 1001n);

    // Prove the deadman timeout has elapsed by voiding one pending.
    const { getVoidPendingInstruction } =
      await import("@faremeter/flex-solana");
    const voidIx = getVoidPendingInstruction({
      escrow: escrowPDA,
      owner,
      pending: pendingB,
    });
    await sendTx(rpc, owner, [voidIx]);

    // Finalize the other settlement -- should succeed despite deadman.
    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      pendingA,
      vaultPDA,
      [recipient.address],
    );

    expect(await fetchTokenBalance(rpc, recipient.address)).toBe(50_000n);

    // Vault retains the voided pending's tokens (1M - 50k finalized).
    expect(await fetchTokenBalance(rpc, vaultPDA)).toBe(950_000n);

    const escrowAfter = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrowAfter.pendingCount)).toBe(0);
  });
});

describe("pending quota recovery after full refund", () => {
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

  it("allows new submission after full refund frees a slot", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 750, {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
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

    const pendingPDAs: Record<number, Address> = {};
    for (let i = 1; i <= 16; i++) {
      pendingPDAs[i] = await submitAuthorizationHelper(
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
        { refundTimeoutSlots: 1_000_000 },
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
          { refundTimeoutSlots: 1_000_000 },
        ),
      FLEX_ERROR__PENDING_LIMIT_REACHED,
    );

    // Full refund of auth #8 frees a slot.
    const pending8 = defined(pendingPDAs[8]);
    await refundHelper(rpc, escrowPDA, facilitator, pending8, 1_000);

    // Verify the refunded pending account was closed.
    const pending8Info = await rpc
      .getAccountInfo(pending8, { encoding: "base64" })
      .send();
    expect(pending8Info.value).toBeNull();

    // Now auth #17 succeeds.
    await submitAuthorizationHelper(
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
      { refundTimeoutSlots: 1_000_000 },
    );

    const escrow = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(Number(escrow.pendingCount)).toBe(16);
  }, 120_000);
});

describe("sequential partial refunds respect reduced amount", () => {
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

  it("rejects refund exceeding amount reduced by prior refunds", async () => {
    const { escrowPDA, pendingPDA } = await setupEscrowWithPending(
      rpc,
      owner,
      facilitator,
      payer,
      760,
      {
        refundTimeoutSlots: 1_000_000,
        deadmanTimeoutSlots: 2_000_000,
        settleAmount: 100_000,
      },
    );

    await refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 40_000);

    const pending1 = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending1.amount)).toBe(60_000);

    await refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 30_000);

    const pending2 = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending2.amount)).toBe(30_000);

    // 40k exceeds the 30k remaining after two prior refunds.
    await expectToFail(
      () => refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 40_000),
      FLEX_ERROR__REFUND_EXCEEDS_AMOUNT,
    );
  });
});

describe("partial refund then finalize distributes reduced amount", () => {
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

  it("transfers the reduced amount to recipients after partial refund", async () => {
    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 770, {
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
      { recipient: r1.address, bps: 6_000 },
      { recipient: r2.address, bps: 4_000 },
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

    // Refund 40k, leaving 60k to be distributed.
    await refundHelper(rpc, escrowPDA, facilitator, pendingPDA, 40_000);

    const pending = defined(await fetchPendingSettlement(rpc, pendingPDA));
    expect(Number(pending.amount)).toBe(60_000);

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

    // 60k * 6000/10000 = 36k for r1, remainder 60k - 36k = 24k for r2.
    expect(await fetchTokenBalance(rpc, r1.address)).toBe(36_000n);
    expect(await fetchTokenBalance(rpc, r2.address)).toBe(24_000n);

    // Vault retains the un-refunded portion (1M deposit - 60k finalized).
    expect(await fetchTokenBalance(rpc, vaultPDA)).toBe(940_000n);
  });
});
