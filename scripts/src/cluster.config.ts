export type Cluster = "devnet" | "mainnet";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function clusterRpcUrl(cluster: Cluster): string {
  if (cluster === "devnet") {
    return DEVNET_RPC_URL;
  }

  const mainnetURL = process.env.MAINNET_RPC_URL;
  if (!mainnetURL || mainnetURL.length === 0) {
    throw new Error(
      "MAINNET_RPC_URL environment variable is required for mainnet; " +
        "configure a paid RPC provider endpoint before invoking mainnet flows",
    );
  }

  return mainnetURL;
}
