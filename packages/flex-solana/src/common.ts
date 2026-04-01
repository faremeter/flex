import { generateRequirementsMatcher } from "@faremeter/types/x402";
import { lookupX402Network } from "@faremeter/info/solana";

import { FLEX_SCHEME } from "./scheme";

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
