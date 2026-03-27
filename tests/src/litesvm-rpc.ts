import type { LiteSVM } from "litesvm";
import { FailedTransactionMetadata } from "litesvm";
import {
  TransactionErrorInstructionError,
  InstructionErrorCustom,
} from "litesvm/dist/internal";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  type Rpc,
  type SolanaRpcApi,
  SolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
} from "@solana/kit";

function toPublicKey(address: string): PublicKey {
  return new PublicKey(address);
}

function pending<T>(value: T) {
  return { send: () => Promise.resolve(value) };
}

function throwTransactionError(failed: FailedTransactionMetadata): never {
  const txErr = failed.err();
  if (txErr instanceof TransactionErrorInstructionError) {
    const ixErr = txErr.err();
    if (ixErr instanceof InstructionErrorCustom) {
      throw new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
        code: ixErr.code,
        index: txErr.index,
      });
    }
  }
  throw new Error(`Transaction failed: ${failed.toString()}`);
}

export function createLiteSVMRpc(svm: LiteSVM): Rpc<SolanaRpcApi> {
  const rpc = {
    getAccountInfo(address: string, _config?: Record<string, unknown>) {
      return pending(
        (() => {
          const account = svm.getAccount(toPublicKey(address));
          if (!account) return { value: null };
          const data = account.data as Uint8Array;
          const b64 = Buffer.from(data).toString("base64");
          return {
            value: {
              data: [b64, "base64"],
              executable: account.executable,
              lamports: BigInt(account.lamports),
              owner: account.owner.toBase58(),
              space: BigInt(data.length),
              rentEpoch: BigInt(account.rentEpoch ?? 0),
            },
          };
        })(),
      );
    },

    getBalance(address: string) {
      return pending({ value: svm.getBalance(toPublicKey(address)) ?? 0n });
    },

    getSlot() {
      return pending(svm.getClock().slot);
    },

    getLatestBlockhash() {
      return pending({
        value: {
          blockhash: svm.latestBlockhash(),
          lastValidBlockHeight: svm.getClock().slot + 300n,
        },
      });
    },

    sendTransaction(wire: string, _config?: Record<string, unknown>) {
      return pending(
        (() => {
          const bytes = Buffer.from(wire, "base64");
          const tx = VersionedTransaction.deserialize(bytes);
          const result = svm.sendTransaction(tx);
          if (result instanceof FailedTransactionMetadata) {
            throwTransactionError(result);
          }
          svm.warpToSlot(svm.getClock().slot + 1n);
          return "sig" as string;
        })(),
      );
    },

    requestAirdrop(address: string, amount: bigint) {
      return pending(
        (() => {
          svm.airdrop(toPublicKey(address), amount);
          return "airdrop" as string;
        })(),
      );
    },

    getTokenAccountBalance(address: string) {
      return pending(
        (() => {
          const account = svm.getAccount(toPublicKey(address));
          if (!account) throw new Error(`Token account not found: ${address}`);
          const data = account.data as Uint8Array;
          const view = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
          const amount = view.getBigUint64(64, true);
          return {
            value: {
              amount: amount.toString(),
              decimals: 6,
              uiAmount: null,
              uiAmountString: amount.toString(),
            },
          };
        })(),
      );
    },

    getMinimumBalanceForRentExemption(size: bigint) {
      return pending(svm.minimumBalanceForRentExemption(size));
    },
  };

  return rpc as unknown as Rpc<SolanaRpcApi>;
}
