import "dotenv/config";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { instructions as squadsInstructions } from "@sqds/multisig";
import { configureApp, getLogger } from "@faremeter/logs";
import { type Cluster } from "./cluster.config";
import { squadsConfig } from "./squads.config";
import { createUpgradeProposal, getVaultPda } from "./squads";
import { connectionFor, loadWeb3Keypair } from "./solana";
import {
  emit,
  invocationName,
  parseCluster,
  requireEnvFile,
} from "./cli-helpers";

await configureApp();
const logger = await getLogger(["flex", "squads-cli"]);

// The same TS file backs both bin/program-squads-approve and
// bin/program-squads-execute; the bin wrapper passes its name in
// FLEX_INVOCATION_NAME so the USAGE strings interpolate correctly.
const PROGRAM = invocationName("scripts/src/squads-cli.ts");

const APPROVE_USAGE = `usage: ${PROGRAM} <cluster> <multisig> <tx-index> [--rpc-url <url>]

Casts an Approve vote on a Squads vault proposal as
$OPERATOR_PAYER_KEYPAIR. Submits proposalApprove(multisig, tx-index,
member) as a single-instruction transaction. Once the multisig's
threshold count of approvals is reached (plus the time lock, if any),
the proposal becomes executable; see program-squads-execute for that
step.

Arguments:
  cluster                 devnet | mainnet
  multisig                The multisig PDA (base58 PublicKey)
  tx-index                The vault transaction index (decimal integer)

Options:
  --rpc-url <url>         Override the cluster RPC URL
  --help | -h             Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR  Path to the member keypair casting the vote;
                          required.
  MAINNET_RPC_URL         Required when cluster=mainnet and no --rpc-url
                          override is supplied.

Output: a single JSON line on stdout with {sig, multisig,
transactionIndex, member}.
`;

const CANCEL_USAGE = `usage: ${PROGRAM} <cluster> <multisig> <tx-index> [--rpc-url <url>]

Casts a Cancel vote on a Squads vault proposal as
$OPERATOR_PAYER_KEYPAIR. Squads v4 transitions a proposal to the
Cancelled state once a threshold of members vote Cancel; for a
single-member multisig the vote is itself the cancellation. Used to
retire proposals that have been Approved but cannot execute (the
program-deploy duplicate-proposal guard refuses to compose a new
proposal targeting the same program while such a stuck Approved
proposal remains).

Arguments:
  cluster                 devnet | mainnet
  multisig                The multisig PDA (base58 PublicKey)
  tx-index                The vault transaction index (decimal integer)

Options:
  --rpc-url <url>         Override the cluster RPC URL
  --help | -h             Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR  Path to the member keypair casting the vote;
                          required.
  MAINNET_RPC_URL         Required when cluster=mainnet and no --rpc-url
                          override is supplied.

Output: a single JSON line on stdout with {sig, multisig,
transactionIndex, member}.
`;

const VAULT_DRAIN_USAGE = `usage: ${PROGRAM} <cluster> [--recipient <pubkey>] [--rpc-url <url>]

Composes a Squads vault proposal containing a single
SystemProgram.transfer instruction moving the vault PDA's full
balance to the recipient (defaults to OPERATOR_PAYER_KEYPAIR's public
key). Used after program-close to reclaim the released ProgramData
rent that flows to the vault on close-program-data execute, and
during operator rehearsals to recycle buffer-write rent that
accumulates in the vault between phases.

The vault PDA is system-owned with zero data, so a full-balance
drain is safe (no rent-exemption reserve to preserve). The proposal
must still be approved and executed by the multisig's threshold of
members via program-squads-approve and program-squads-execute.

This command has no duplicate-proposal guard: the deploy/close
guards filter listOpenProposals() by program ID, but a vault-drain
proposal has no natural program ID to filter on, and the Squads
SDK's open-proposal query does not expose a "list all open proposals
on this multisig" mode that the guard could use. Re-running
program-vault-drain composes a second pending drain for the same
balance; both proposals would attempt to transfer the entire vault
on execute and the second would land an empty transfer. Resolve any
stuck pending proposals (via program-squads-cancel or the Squads UI)
before re-composing.

Arguments:
  cluster                 devnet | mainnet

Options:
  --recipient <pubkey>    Override the transfer recipient (defaults to
                          the operator payer's pubkey)
  --rpc-url <url>         Override the cluster RPC URL
  --help | -h             Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR  Path to the keypair that submits the
                          proposal-creation transaction; must be a
                          member of the multisig. Required.
  MAINNET_RPC_URL         Required when cluster=mainnet and no --rpc-url
                          override is supplied.

Output: a single JSON line on stdout with {sig, multisig,
transactionIndex, proposalPda, transactionPda, lamports, recipient}.
`;

const EXECUTE_USAGE = `usage: ${PROGRAM} <cluster> <multisig> <tx-index> [--rpc-url <url>]

Submits vaultTransactionExecute(multisig, tx-index, signer) for a
Squads vault proposal whose Approved-state threshold has been reached
and whose time lock has elapsed. The execute transaction is a
versioned-v0 message because the SDK may return address-lookup-table
accounts that legacy transactions cannot reference.

Arguments:
  cluster                 devnet | mainnet
  multisig                The multisig PDA (base58 PublicKey)
  tx-index                The vault transaction index (decimal integer)

Options:
  --rpc-url <url>         Override the cluster RPC URL
  --help | -h             Print this usage and exit 0

Environment:
  OPERATOR_PAYER_KEYPAIR  Path to the keypair that signs and pays the
                          execute transaction; required.
  MAINNET_RPC_URL         Required when cluster=mainnet and no --rpc-url
                          override is supplied.

Output: a single JSON line on stdout with {sig, multisig,
transactionIndex, signer}.
`;

type ParsedArgs = {
  cluster: Cluster;
  multisig: PublicKey;
  transactionIndex: bigint;
  rpcOverride: string | undefined;
};

function parseCommonArgs(args: string[], commandName: string): ParsedArgs {
  if (args.length === 0) {
    throw new Error(`${commandName}: missing arguments`);
  }
  const cluster = parseCluster(args[0]);
  const multisigRaw = args[1];
  const txIndexRaw = args[2];
  if (!multisigRaw) {
    throw new Error(`${commandName} requires <multisig>`);
  }
  if (!txIndexRaw) {
    throw new Error(`${commandName} requires <transaction-index>`);
  }
  if (!/^[0-9]+$/.test(txIndexRaw)) {
    throw new Error(
      `${commandName}: tx-index must be a non-negative integer; got: ${txIndexRaw}`,
    );
  }
  const multisig = new PublicKey(multisigRaw);
  const transactionIndex = BigInt(txIndexRaw);

  let rpcOverride: string | undefined;
  for (let i = 3; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--rpc-url") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error("--rpc-url requires a value");
      }
      rpcOverride = v;
      i += 1;
    } else {
      throw new Error(`${commandName}: unknown option: ${String(arg)}`);
    }
  }
  return { cluster, multisig, transactionIndex, rpcOverride };
}

async function cmdApprove(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(APPROVE_USAGE);
    return;
  }
  const { cluster, multisig, transactionIndex, rpcOverride } = parseCommonArgs(
    args,
    "approve",
  );
  const member = loadWeb3Keypair(requireEnvFile("OPERATOR_PAYER_KEYPAIR"));
  const connection = connectionFor(cluster, rpcOverride);

  logger.info(
    `approve: multisig=${multisig.toBase58()} txIndex=${transactionIndex.toString()} member=${member.publicKey.toBase58()}`,
  );

  const ix = squadsInstructions.proposalApprove({
    multisigPda: multisig,
    transactionIndex,
    member: member.publicKey,
  });

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [member],
  );

  logger.info(`approve: sig=${sig}`);
  emit({
    sig,
    multisig: multisig.toBase58(),
    transactionIndex: transactionIndex.toString(),
    member: member.publicKey.toBase58(),
  });
}

async function cmdExecute(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(EXECUTE_USAGE);
    return;
  }
  const { cluster, multisig, transactionIndex, rpcOverride } = parseCommonArgs(
    args,
    "execute",
  );
  const signer = loadWeb3Keypair(requireEnvFile("OPERATOR_PAYER_KEYPAIR"));
  const connection = connectionFor(cluster, rpcOverride);

  logger.info(
    `execute: multisig=${multisig.toBase58()} txIndex=${transactionIndex.toString()} signer=${signer.publicKey.toBase58()}`,
  );

  // vaultTransactionExecute reads the vault transaction account on-chain
  // to determine the inner instructions' account-meta layout, and returns
  // the lookup-table accounts that were registered with the proposal so
  // the caller can build a v0 transaction with them. A legacy transaction
  // cannot carry address-lookup-table references; execute must always be
  // sent as v0.
  const { instruction, lookupTableAccounts } =
    await squadsInstructions.vaultTransactionExecute({
      connection,
      multisigPda: multisig,
      transactionIndex,
      member: signer.publicKey,
    });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message(lookupTableAccounts);

  const tx = new VersionedTransaction(message);
  tx.sign([signer]);

  const sig = await connection.sendTransaction(tx);
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err !== null) {
    throw new Error(
      `execute: confirmation reported error: ${JSON.stringify(confirmation.value.err)}`,
    );
  }

  logger.info(`execute: sig=${sig}`);
  emit({
    sig,
    multisig: multisig.toBase58(),
    transactionIndex: transactionIndex.toString(),
    signer: signer.publicKey.toBase58(),
  });
}

async function cmdCancel(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(CANCEL_USAGE);
    return;
  }
  const { cluster, multisig, transactionIndex, rpcOverride } = parseCommonArgs(
    args,
    "cancel",
  );
  const member = loadWeb3Keypair(requireEnvFile("OPERATOR_PAYER_KEYPAIR"));
  const connection = connectionFor(cluster, rpcOverride);

  logger.info(
    `cancel: multisig=${multisig.toBase58()} txIndex=${transactionIndex.toString()} member=${member.publicKey.toBase58()}`,
  );

  const ix = squadsInstructions.proposalCancelV2({
    multisigPda: multisig,
    transactionIndex,
    member: member.publicKey,
  });

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(ix),
    [member],
  );

  logger.info(`cancel: sig=${sig}`);
  emit({
    sig,
    multisig: multisig.toBase58(),
    transactionIndex: transactionIndex.toString(),
    member: member.publicKey.toBase58(),
  });
}

async function cmdVaultDrain(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(VAULT_DRAIN_USAGE);
    return;
  }
  // No explicit args.length check — parseCluster rejects undefined
  // with a clearer "cluster must be devnet or mainnet" message.
  const cluster = parseCluster(args[0]);

  let recipientOverride: PublicKey | undefined;
  let rpcOverride: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      break;
    }
    if (arg === "--recipient") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error("--recipient requires a value");
      }
      recipientOverride = new PublicKey(v);
      i += 1;
    } else if (arg === "--rpc-url") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new Error("--rpc-url requires a value");
      }
      rpcOverride = v;
      i += 1;
    } else {
      throw new Error(`vault-drain: unknown option: ${arg}`);
    }
  }

  const proposer = loadWeb3Keypair(requireEnvFile("OPERATOR_PAYER_KEYPAIR"));
  const recipient = recipientOverride ?? proposer.publicKey;
  const { multisig, vaultIndex } = squadsConfig[cluster];
  const vault = getVaultPda(multisig, vaultIndex);
  const connection = connectionFor(cluster, rpcOverride);

  const lamports = await connection.getBalance(vault, "confirmed");
  logger.info(
    `vault-drain: cluster=${cluster} multisig=${multisig.toBase58()} vault=${vault.toBase58()} recipient=${recipient.toBase58()} balance=${String(lamports)}`,
  );
  if (lamports === 0) {
    logger.info("vault-drain: vault is empty; not composing a proposal");
    emit({
      skipped: true,
      multisig: multisig.toBase58(),
      vault: vault.toBase58(),
      recipient: recipient.toBase58(),
      lamports: 0,
    });
    return;
  }

  const proposal = await createUpgradeProposal({
    connection,
    multisig,
    vaultIndex,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: vault,
        toPubkey: recipient,
        lamports,
      }),
    ],
    proposer: proposer.publicKey,
  });

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      proposal.vaultTransactionCreateIx,
      proposal.proposalCreateIx,
    ),
    [proposer],
  );

  logger.info(
    `vault-drain: composed proposal txIndex=${proposal.transactionIndex.toString()} sig=${sig}`,
  );
  emit({
    sig,
    multisig: multisig.toBase58(),
    transactionIndex: proposal.transactionIndex.toString(),
    proposalPda: proposal.proposalPda.toBase58(),
    transactionPda: proposal.transactionPda.toBase58(),
    vault: vault.toBase58(),
    recipient: recipient.toBase58(),
    lamports,
  });
}

type Subcommand = (args: string[]) => Promise<void>;

const subcommands: Record<string, Subcommand> = {
  approve: cmdApprove,
  execute: cmdExecute,
  cancel: cmdCancel,
  "vault-drain": cmdVaultDrain,
};

const [, , subcommandName, ...rest] = process.argv;
if (!subcommandName) {
  logger.error(
    `usage: squads-cli <subcommand> [args...]\nsubcommands: ${Object.keys(subcommands).join(", ")}`,
  );
  process.exit(2);
}
const handler = subcommands[subcommandName];
if (!handler) {
  logger.error(
    `unknown subcommand: ${subcommandName}\nsubcommands: ${Object.keys(subcommands).join(", ")}`,
  );
  process.exit(2);
}

try {
  await handler(rest);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  process.exit(1);
}
