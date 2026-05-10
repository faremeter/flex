import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  fetchEscrowAccount,
  FLEX_ERROR__AUTHORIZATION_REPLAY,
} from "@faremeter/flex-solana";
import {
  createRpc,
  fundKeypair,
  defined,
  createFundedTokenAccount,
  setupEscrowForAuth,
  submitAuthorizationHelper,
  finalizeHelper,
  initializeReplayShardHelper,
  expectToFail,
  fetchTokenBalance,
} from "./helpers";

// This keeps the original zero-timeout replay scenario, but expects the replay
// shard to reject reuse after the pending PDA is finalized and closed.

describe("zero refund timeout replay protection", () => {
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

  it("rejects replay after immediate finalization", async () => {
    const depositAmount = 1_000_000;
    const settleAmount = 500_000;

    const { escrowPDA, mint, vaultPDA, sessionKey, sessionKeyPDA } =
      await setupEscrowForAuth(rpc, owner, facilitator, payer, 2000, {
        refundTimeoutSlots: 0,
        deadmanTimeoutSlots: 1000,
        depositAmount,
      });

    const recipient = await createFundedTokenAccount(
      rpc,
      mint,
      facilitator.address,
      payer,
      0n,
    );
    const splits = [{ recipient: recipient.address, bps: 10_000 }];

    await initializeReplayShardHelper(
      rpc,
      facilitator,
      escrowPDA,
      sessionKeyPDA,
      1,
    );

    // Pick an expiry far in the future. With refund_timeout_slots == 0, the
    // ExpiryTooFar guard is skipped, so this is accepted.
    const currentSlot = await rpc.getSlot().send();
    const expiresAtSlot = currentSlot + 10_000n;

    // --- First submission: authorization_id=1 for 500,000 tokens ---

    const pendingPDA = await submitAuthorizationHelper(
      rpc,
      escrowPDA,
      facilitator,
      sessionKey,
      sessionKeyPDA,
      mint,
      vaultPDA,
      1,
      settleAmount,
      splits,
      { refundTimeoutSlots: 0, expiresAtSlot },
    );

    // Finalize immediately — refund window is submitted_at_slot + 0, so it
    // passes in the same slot. This closes the pending PDA.
    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      pendingPDA,
      vaultPDA,
      [recipient.address],
    );

    const recipientAfterFirst = await fetchTokenBalance(rpc, recipient.address);
    expect(recipientAfterFirst).toBe(BigInt(settleAmount));

    const vaultAfterFirst = await fetchTokenBalance(rpc, vaultPDA);
    expect(vaultAfterFirst).toBe(BigInt(depositAmount - settleAmount));

    const escrowAfterFirst = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowAfterFirst.pendingCount).toBe(0);

    // --- Replay: resubmit the SAME authorization_id with the same signature ---
    //
    // The pending PDA was closed by finalize, so Anchor's init constraint
    // allows re-creation at the same address. The signed message is identical
    // (same escrow, mint, maxAmount, authorizationId, expiresAtSlot, splits),
    // so the same Ed25519 signature is valid.

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
          settleAmount,
          splits,
          { refundTimeoutSlots: 0, expiresAtSlot },
        ),
      FLEX_ERROR__AUTHORIZATION_REPLAY,
    );

    // --- Verify replay was blocked ---
    //
    // The recipient has only received the first 500,000-token settlement. The
    // replayed authorization was rejected even though the pending PDA was closed.

    const recipientFinal = await fetchTokenBalance(rpc, recipient.address);
    expect(recipientFinal).toBe(BigInt(settleAmount));

    const vaultFinal = await fetchTokenBalance(rpc, vaultPDA);
    expect(vaultFinal).toBe(BigInt(depositAmount - settleAmount));

    const escrowFinal = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowFinal.pendingCount).toBe(0);
  }, 30_000);
});
