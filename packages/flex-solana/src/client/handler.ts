import { type Address, address } from "@solana/kit";

import type {
  PaymentExecer,
  PaymentHandler,
  RequestContext,
} from "@faremeter/types/client";
import type { x402PaymentRequirements } from "@faremeter/types/x402v2";
import { isValidationError } from "@faremeter/types";

import { generateMatcher } from "../common";
import {
  serializePaymentAuthorization,
  signPaymentAuthorization,
} from "../authorization";
import { fetchEscrowAccount } from "../query";
import { FlexPaymentRequirementsExtra } from "../types";
import { FLEX_PROGRAM_ADDRESS } from "../generated";
import { logger } from "../logger";

type Rpc = Parameters<typeof fetchEscrowAccount>[0];

export type CreateFlexPaymentHandlerOpts = {
  network: string;
  escrow: Address;
  mint: Address;
  sessionKeyPair: CryptoKeyPair;
  sessionKeyAddress: Address;
  rpc: Rpc;
  programAddress?: Address;
};

export function createPaymentHandler(
  opts: CreateFlexPaymentHandlerOpts,
): PaymentHandler {
  const {
    escrow,
    mint,
    sessionKeyPair,
    sessionKeyAddress,
    rpc,
    programAddress = FLEX_PROGRAM_ADDRESS,
  } = opts;

  const { isMatchingRequirement } = generateMatcher(opts.network, mint);

  let localNonce: bigint | null = null;
  let nonceInitPromise: Promise<void> | null = null;

  async function ensureNonce(): Promise<void> {
    if (localNonce !== null) return;
    if (nonceInitPromise === null) {
      nonceInitPromise = fetchEscrowAccount(rpc, escrow)
        .then((account) => {
          if (!account) {
            throw new Error("Escrow account not found on-chain");
          }
          localNonce = account.lastNonce;
        })
        .catch((cause) => {
          nonceInitPromise = null;
          throw cause;
        });
    }
    await nonceInitPromise;
  }

  return async (
    _context: RequestContext,
    accepts: x402PaymentRequirements[],
  ): Promise<PaymentExecer[]> => {
    const compatible = accepts.filter(isMatchingRequirement);

    return compatible.map((requirements) => {
      const exec = async () => {
        const extraResult = FlexPaymentRequirementsExtra(requirements.extra);
        if (isValidationError(extraResult)) {
          throw new Error(
            `Invalid flex requirements extra: ${extraResult.summary}`,
          );
        }

        await ensureNonce();

        const nonce = ++localNonce!;
        const maxAmount = BigInt(requirements.amount);

        const message = serializePaymentAuthorization({
          programId: programAddress,
          escrow,
          mint,
          maxAmount,
          nonce,
          splits: extraResult.splits.map((s) => ({
            recipient: address(s.recipient),
            bps: s.bps,
          })),
        });

        const signature = await signPaymentAuthorization({
          message,
          keyPair: sessionKeyPair,
        });

        const signatureBase64 = btoa(String.fromCharCode(...signature));

        logger.debug("signed payment authorization", {
          escrow,
          nonce: nonce.toString(),
          maxAmount: maxAmount.toString(),
        });

        const payload = {
          escrow,
          mint,
          maxAmount: maxAmount.toString(),
          nonce: nonce.toString(),
          splits: extraResult.splits,
          sessionKey: sessionKeyAddress,
          signature: signatureBase64,
        };

        return { payload };
      };

      return { exec, requirements };
    });
  };
}
