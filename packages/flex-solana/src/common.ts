import { generateRequirementsMatcher } from "@faremeter/types/x402";
import { lookupX402Network } from "@faremeter/info/solana";

import { FLEX_SCHEME } from "./scheme";

/**
 * Creates a matcher that checks whether an x402 payment requirement
 * targets the Flex scheme on the given Solana network and asset.
 *
 * @param network - Solana cluster name (e.g. "mainnet", "devnet")
 * @param asset - Mint address of the token
 * @returns An object with an `isMatchingRequirement` predicate
 */
export function generateMatcher(
  network: string,
  asset: string,
): {
  isMatchingRequirement: (req: {
    scheme: string;
    network: string;
    asset: string;
  }) => boolean;
} {
  const solanaNetwork = lookupX402Network(network);

  return generateRequirementsMatcher(
    [FLEX_SCHEME],
    [solanaNetwork.caip2],
    [asset],
  );
}
