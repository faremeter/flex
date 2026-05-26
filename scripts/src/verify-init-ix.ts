import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getBase58Encoder } from "@solana/kit";

export const OTTER_VERIFY_PROGRAM_ID = new PublicKey(
  "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC",
);

const SOLANA_VERIFY_INSTALL_HINT =
  "install via `cargo install solana-verify` " +
  "(see https://github.com/Ellipsis-Labs/solana-verifiable-build)";

export type BuildVerifyInitIxArgs = {
  programId: PublicKey;
  uploader: PublicKey;
  repoURL: string;
};

function assertRepoURL(repoURL: string): void {
  if (typeof repoURL !== "string" || repoURL.trim().length === 0) {
    throw new Error("buildVerifyInitIx: repoURL must be a non-empty string");
  }
  try {
    new URL(repoURL);
  } catch (cause) {
    throw new Error(`buildVerifyInitIx: repoURL is not a valid URL`, { cause });
  }
}

// solana-verify export-pda-tx writes the serialized transaction as
// base58. Bind to that single contract rather than guessing across
// multiple encodings: if upstream ever changes the encoding, we want
// a loud failure naming the change, not a silent misparse on a
// payload that happens to be valid under both base58 and unpadded
// base64.
const BASE58_ALPHABET_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function decodePayload(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "buildVerifyInitIx: solana-verify produced an empty payload on stdout",
    );
  }
  if (!BASE58_ALPHABET_RE.test(trimmed)) {
    throw new Error(
      "buildVerifyInitIx: solana-verify payload is not base58 — " +
        "this contract is bound to the upstream tool's documented " +
        "output encoding. If solana-verify has changed its output " +
        "format, update decodePayload to match the new contract.",
    );
  }
  return getBase58Encoder().encode(trimmed) as Uint8Array;
}

async function runSolanaVerify(
  programId: PublicKey,
  uploader: PublicKey,
  repoURL: string,
): Promise<string> {
  const spawnArgs = [
    "solana-verify",
    "export-pda-tx",
    "--uploader",
    uploader.toBase58(),
    "--program-id",
    programId.toBase58(),
    repoURL,
  ];
  const proc = (() => {
    try {
      return Bun.spawn(spawnArgs, { stdout: "pipe", stderr: "pipe" });
    } catch (cause) {
      throw new Error(
        `buildVerifyInitIx: failed to spawn solana-verify; ${SOLANA_VERIFY_INSTALL_HINT}`,
        { cause },
      );
    }
  })();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `buildVerifyInitIx: solana-verify exited with code ${String(exitCode)}; stderr:\n${stderr}`,
    );
  }

  return stdout;
}

export async function buildVerifyInitIx(
  args: BuildVerifyInitIxArgs,
): Promise<TransactionInstruction> {
  const { programId, uploader, repoURL } = args;
  assertRepoURL(repoURL);

  const stdout = await runSolanaVerify(programId, uploader, repoURL);
  const payloadBytes = decodePayload(stdout);

  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(payloadBytes));
  } catch (cause) {
    throw new Error(
      "buildVerifyInitIx: failed to decode solana-verify payload as a " +
        "legacy wire-format transaction",
      { cause },
    );
  }

  const matching = tx.instructions.filter((ix) =>
    ix.programId.equals(OTTER_VERIFY_PROGRAM_ID),
  );

  if (matching.length !== 1) {
    throw new Error(
      `buildVerifyInitIx: expected exactly one instruction targeting ` +
        `${OTTER_VERIFY_PROGRAM_ID.toBase58()}, found ${String(matching.length)}`,
    );
  }

  const source = matching[0];
  if (!source) {
    throw new Error(
      "buildVerifyInitIx: matched instruction is undefined after filter",
    );
  }

  if (source.keys.length === 0) {
    throw new Error(
      "buildVerifyInitIx: otter_verify instruction has no accounts",
    );
  }

  if (source.data.length === 0) {
    throw new Error("buildVerifyInitIx: otter_verify instruction has no data");
  }

  return source;
}
