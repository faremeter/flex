import {
  type Address,
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  type TransactionSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";

import type {
  x402PaymentRequirements,
  x402PaymentPayload,
  x402SettleResponse,
  x402SupportedKind,
  x402VerifyResponse,
} from "@faremeter/types/x402v2";
import type {
  FacilitatorHandler,
  GetRequirementsArgs,
} from "@faremeter/types/facilitator";
import { lookupX402Network } from "@faremeter/info/solana";
import { isValidationError } from "@faremeter/types";
import { generateMatcher, FLEX_SCHEME } from "../common";
import { FlexPaymentPayload } from "../types";
import {
  serializePaymentAuthorization,
  createEd25519VerifyInstruction,
  type SplitInput,
} from "../authorization";
import { fetchEscrowAccount, fetchSessionKey } from "../query";
import {
  getSubmitAuthorizationInstructionAsync,
  FLEX_PROGRAM_ADDRESS,
} from "../generated";
import { logger } from "../logger";

type FlexFacilitatorConfig = {
  maxRetries?: number;
  retryDelayMs?: number;
  supportedMints: Address[];
  defaultSplits: { recipient: string; bps: number }[];
};

export const createFacilitatorHandler = async (
  network: string,
  rpc: Rpc<SolanaRpcApi>,
  facilitatorSigner: TransactionSigner,
  config: FlexFacilitatorConfig,
): Promise<FacilitatorHandler> => {
  const { maxRetries = 30, retryDelayMs = 1000 } = config;
  const facilitatorAddress = facilitatorSigner.address;

  const solanaNetwork = lookupX402Network(network);
  const networkId = solanaNetwork.caip2;

  const matchers = config.supportedMints.map((mint) =>
    generateMatcher(network, mint),
  );

  const isMatchingRequirement = (req: {
    scheme: string;
    network: string;
    asset: string;
  }) => matchers.some((m) => m.isMatchingRequirement(req));

  const getSupported = (): Promise<x402SupportedKind>[] => [
    Promise.resolve({
      x402Version: 2 as const,
      scheme: FLEX_SCHEME,
      network: networkId,
      extra: {
        facilitator: facilitatorAddress,
        supportedMints: config.supportedMints,
        splits: config.defaultSplits,
      },
    }),
  ];

  const getRequirements = async (
    args: GetRequirementsArgs,
  ): Promise<x402PaymentRequirements[]> =>
    args.accepts.filter(isMatchingRequirement).map((r) => ({
      ...r,
      extra: {
        facilitator: facilitatorAddress,
        supportedMints: config.supportedMints,
        splits: config.defaultSplits,
      },
    }));

  const addressEncoder = getAddressEncoder();
  const u64Encoder = getU64Encoder();
  const textEncoder = new TextEncoder();

  const deriveSessionKeyPDA = (escrow: Address, sessionKey: Address) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("session"),
        addressEncoder.encode(escrow),
        addressEncoder.encode(sessionKey),
      ],
    });

  const deriveVaultPDA = (escrow: Address, mint: Address) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("token"),
        addressEncoder.encode(escrow),
        addressEncoder.encode(mint),
      ],
    });

  const derivePendingPDA = (escrow: Address, nonce: bigint) =>
    getProgramDerivedAddress({
      programAddress: FLEX_PROGRAM_ADDRESS,
      seeds: [
        textEncoder.encode("pending"),
        addressEncoder.encode(escrow),
        u64Encoder.encode(nonce),
      ],
    });

  const parseAndVerifyPayload = async (payment: x402PaymentPayload) => {
    const parseResult = FlexPaymentPayload(payment.payload);
    if (isValidationError(parseResult)) {
      return { error: `Invalid flex payload: ${parseResult.summary}` };
    }

    const escrowAddress = address(parseResult.escrow);
    const mint = address(parseResult.mint);
    const maxAmount = BigInt(parseResult.maxAmount);
    const nonce = BigInt(parseResult.nonce);
    const sessionKeyAddress = address(parseResult.sessionKey);

    const signatureBytes = Uint8Array.from(atob(parseResult.signature), (c) =>
      c.charCodeAt(0),
    );

    const splits: SplitInput[] = parseResult.splits.map((s) => ({
      recipient: address(s.recipient),
      bps: s.bps,
    }));

    const escrowAccount = await fetchEscrowAccount(rpc, escrowAddress);
    if (!escrowAccount) {
      return { error: "Escrow account not found" };
    }

    if (escrowAccount.facilitator !== facilitatorAddress) {
      return { error: "Escrow facilitator does not match" };
    }

    if (nonce <= escrowAccount.lastNonce) {
      return { error: "Nonce is not greater than escrow last nonce" };
    }

    const [sessionKeyPDA] = await deriveSessionKeyPDA(
      escrowAddress,
      sessionKeyAddress,
    );
    const sessionKeyData = await fetchSessionKey(rpc, sessionKeyPDA);
    if (!sessionKeyData) {
      return { error: "Session key not found" };
    }

    if (!sessionKeyData.active && sessionKeyData.revokedAtSlot === null) {
      return { error: "Session key is not active" };
    }

    const [vault] = await deriveVaultPDA(escrowAddress, mint);
    const vaultBalance = await rpc.getTokenAccountBalance(vault).send();
    if (BigInt(vaultBalance.value.amount) < maxAmount) {
      return { error: "Vault balance insufficient for max amount" };
    }

    const message = serializePaymentAuthorization({
      programId: FLEX_PROGRAM_ADDRESS,
      escrow: escrowAddress,
      mint,
      maxAmount,
      nonce,
      splits,
    });

    const publicKeyBytes = addressEncoder.encode(sessionKeyAddress);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      "Ed25519",
      false,
      ["verify"],
    );
    const isValid = await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      signatureBytes,
      message,
    );

    if (!isValid) {
      return { error: "Ed25519 signature verification failed" };
    }

    return {
      escrowAddress,
      mint,
      maxAmount,
      nonce,
      sessionKeyAddress,
      sessionKeyPDA,
      vault,
      splits,
      signatureBytes,
      message,
      payer: escrowAccount.owner,
    };
  };

  const handleVerify = async (
    requirements: x402PaymentRequirements,
    payment: x402PaymentPayload,
  ): Promise<x402VerifyResponse | null> => {
    if (!isMatchingRequirement(requirements)) {
      return null;
    }

    const result = await parseAndVerifyPayload(payment);

    if ("error" in result) {
      return { isValid: false, invalidReason: result.error };
    }

    return { isValid: true };
  };

  const handleSettle = async (
    requirements: x402PaymentRequirements,
    payment: x402PaymentPayload,
  ): Promise<x402SettleResponse | null> => {
    if (!isMatchingRequirement(requirements)) {
      return null;
    }

    const errorResponse = (msg: string): x402SettleResponse => {
      logger.error(msg);
      return {
        success: false,
        errorReason: msg,
        transaction: "",
        network: networkId,
      };
    };

    const result = await parseAndVerifyPayload(payment);

    if ("error" in result) {
      return errorResponse(result.error);
    }

    const settleAmount = BigInt(requirements.amount);
    const [pending] = await derivePendingPDA(
      result.escrowAddress,
      result.nonce,
    );

    const ed25519Ix = createEd25519VerifyInstruction({
      publicKey: result.sessionKeyAddress,
      message: result.message,
      signature: result.signatureBytes,
    });

    const submitIx = await getSubmitAuthorizationInstructionAsync({
      escrow: result.escrowAddress,
      facilitator: facilitatorSigner,
      sessionKey: result.sessionKeyPDA,
      tokenAccount: result.vault,
      pending,
      mint: result.mint,
      maxAmount: result.maxAmount,
      settleAmount,
      nonce: result.nonce,
      splits: result.splits.map((s) => ({
        recipient: s.recipient,
        bps: s.bps,
      })),
      signature: result.signatureBytes.subarray(0, 64),
    });

    const {
      value: { blockhash, lastValidBlockHeight },
    } = await rpc.getLatestBlockhash().send();

    const txMessage = appendTransactionMessageInstructions(
      [ed25519Ix, submitIx],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight },
        setTransactionMessageFeePayer(
          facilitatorSigner.address,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const txSignature = getSignatureFromTransaction(signedTx);

    const wireTransaction = getBase64EncodedWireTransaction(signedTx);
    await rpc.sendTransaction(wireTransaction, { encoding: "base64" }).send();

    for (let i = 0; i < maxRetries; i++) {
      const status = await rpc.getSignatureStatuses([txSignature]).send();
      const statusValue = status.value[0];
      if (statusValue?.err) {
        return errorResponse(
          `Transaction failed: ${JSON.stringify(statusValue.err)}`,
        );
      }
      if (
        statusValue?.confirmationStatus === "confirmed" ||
        statusValue?.confirmationStatus === "finalized"
      ) {
        return {
          success: true,
          transaction: txSignature,
          network: networkId,
          payer: result.payer,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    return errorResponse("Transaction confirmation timeout");
  };

  return {
    getSupported,
    getRequirements,
    handleVerify,
    handleSettle,
  };
};
