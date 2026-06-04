// Opens the Ledger USB HID transport at the supplied signer URL,
// reads the on-device public key, and prints it to stdout as base58.
// Used by the rehearsal opsh script to derive the Ledger's pubkey for
// the multisig membership list.

import { openLedgerSigner, parseLedgerURLSpec } from "./signer";

const url = process.argv[2] ?? "usb://ledger?key=0";
const { derivationPath } = parseLedgerURLSpec(url);
const signer = await openLedgerSigner(url, derivationPath);
try {
  process.stdout.write(`${signer.publicKey.toBase58()}\n`);
} finally {
  await signer.close();
}
