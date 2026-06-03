import "dotenv/config";
import { configureApp, getLogger } from "@faremeter/logs";
import { type Cluster } from "./cluster.config";
import { squadsConfig } from "./squads.config";
import { createMultisig, getVaultPda } from "./squads";
import { connectionFor, sendWeb3Tx } from "./solana";
import { parseSignerURL } from "./signer";
import { invocationName, requireSignerURL } from "./cli-helpers";

const PROGRAM = invocationName("scripts/src/bootstrap-multisig.ts");

const USAGE = `usage: ${PROGRAM} <cluster>

Provision a Squads v4 multisig for the named cluster using the
configuration in scripts/src/squads.config.ts.

Arguments:
  cluster    one of: devnet, mainnet

Environment:
  CREATOR_KEYPAIR_PATH   path to the keypair that pays for and creates
                         the multisig (required)
  MAINNET_RPC_URL        RPC endpoint to use when cluster is mainnet

The script prints the new multisig address and vault PDA. Record both
values in operational docs and replace the placeholder "multisig" entry
for the target cluster in scripts/src/squads.config.ts.
`;

await configureApp();
const logger = await getLogger(["flex", "bootstrap-multisig"]);

const [, , clusterArg] = process.argv;

if (clusterArg === "-h" || clusterArg === "--help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (clusterArg !== "devnet" && clusterArg !== "mainnet") {
  process.stderr.write(USAGE);
  logger.error(
    `${PROGRAM}: cluster argument must be "devnet" or "mainnet"; got ${String(clusterArg)}`,
  );
  process.exit(2);
}

const cluster: Cluster = clusterArg;
const clusterConfig = squadsConfig[cluster];

// timeLock and other per-cluster invariants are validated by
// assertValidConfig() at squads.config.ts module-load time; if the
// config were invalid the import on line 5 would have thrown before
// reaching here, so no duplicate guard is needed.

const creatorURL = requireSignerURL("CREATOR_KEYPAIR_PATH");

const connection = connectionFor(cluster);
const creator = await parseSignerURL(creatorURL);

logger.info(`Cluster:    ${cluster}`);
logger.info(`RPC URL:    ${connection.rpcEndpoint}`);
logger.info(`Creator:    ${creator.publicKey.toBase58()}`);
logger.info(`Members:    ${clusterConfig.members.length}`);
logger.info(`Threshold:  ${clusterConfig.threshold}`);
logger.info(`Vault idx:  ${clusterConfig.vaultIndex}`);
logger.info(`Time lock:  ${clusterConfig.timeLock} seconds`);

try {
  const result = await createMultisig({
    connection,
    creator: creator.publicKey,
    members: clusterConfig.members,
    threshold: clusterConfig.threshold,
    timeLock: clusterConfig.timeLock,
    vaultIndex: clusterConfig.vaultIndex,
  });

  logger.info(`Sending multisig_create transaction...`);
  await sendWeb3Tx(connection, creator, [result.instruction], {
    cosigners: [result.createKey],
    blindSign: {
      label: "multisigCreateV2",
      multisig: result.multisig,
    },
  });

  const vault = getVaultPda(result.multisig, clusterConfig.vaultIndex);
  if (!vault.equals(result.vault)) {
    throw new Error(
      `bootstrap-multisig: vault PDA mismatch: createMultisig returned ${result.vault.toBase58()}, getVaultPda returned ${vault.toBase58()}`,
    );
  }

  logger.info(`Multisig created successfully`);

  process.stdout.write(`MULTISIG_ADDRESS=${result.multisig.toBase58()}\n`);
  process.stdout.write(`VAULT_PDA=${vault.toBase58()}\n`);

  logger.info(
    `Record both values in operational docs and replace the placeholder ` +
      `"multisig" entry for ${cluster} in scripts/src/squads.config.ts.`,
  );
} finally {
  await creator.close();
}
