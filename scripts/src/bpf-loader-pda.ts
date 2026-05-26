// The BPF Loader Upgradeable program ID and the ProgramData PDA
// derivation are needed by every module that reads or writes
// upgradeable-program state — the on-chain instruction builders,
// the version/sha reader, and the program-close flow. Centralizing
// them here keeps a single canonical definition: a PDA-derivation
// regression (the kind that produced the historical
// `["ProgramData", program_id]` mistake) would otherwise have to be
// fixed in every duplicate site, and the fixes can drift.

import { PublicKey } from "@solana/web3.js";

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

// `bpf_loader_upgradeable::find_program_address` derives ProgramData
// from a single seed: `[program_id.as_ref()]`. No prefix, no string
// tag. See the loader's `id()`-based derivation in agave's
// solana-loader-v3-interface crate.
export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );
  return pda;
}
