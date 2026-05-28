import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  accounts as squadsAccounts,
  instructions as squadsInstructions,
  PROGRAM_ID as SQUADS_PROGRAM_ID,
  getMultisigPda,
  getProgramConfigPda,
  getProposalPda,
  getTransactionPda,
  getVaultPda as squadsGetVaultPda,
  types as squadsTypes,
} from "@sqds/multisig";

export { SQUADS_PROGRAM_ID };

type OpenProposalStatus = "Draft" | "Active" | "Approved";

export type OpenProposal = {
  proposalPda: PublicKey;
  transactionIndex: bigint;
  status: OpenProposalStatus;
};

export function getVaultPda(
  multisig: PublicKey,
  vaultIndex: number,
): PublicKey {
  const [pda] = squadsGetVaultPda({
    multisigPda: multisig,
    index: vaultIndex,
  });
  return pda;
}

function bignumToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString: () => string }).toString === "function"
  ) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(
    `Cannot convert beet bignum to bigint: ${String(value)} (type ${typeof value})`,
  );
}

async function fetchMultisigAccount(
  connection: Connection,
  multisig: PublicKey,
): Promise<squadsAccounts.Multisig> {
  const info = await connection.getAccountInfo(multisig);
  if (info === null) {
    throw new Error(`Multisig account ${multisig.toBase58()} not found`);
  }
  const [acct] = squadsAccounts.Multisig.fromAccountInfo(info);
  return acct;
}

async function fetchProposalAccount(
  connection: Connection,
  proposalPda: PublicKey,
): Promise<squadsAccounts.Proposal | null> {
  const info = await connection.getAccountInfo(proposalPda);
  if (info === null) {
    return null;
  }
  const [acct] = squadsAccounts.Proposal.fromAccountInfo(info);
  return acct;
}

async function fetchVaultTransactionAccount(
  connection: Connection,
  transactionPda: PublicKey,
): Promise<squadsAccounts.VaultTransaction | null> {
  const info = await connection.getAccountInfo(transactionPda);
  if (info === null) {
    return null;
  }
  const [acct] = squadsAccounts.VaultTransaction.fromAccountInfo(info);
  return acct;
}

export async function getMultisigConfig(
  connection: Connection,
  multisig: PublicKey,
): Promise<{
  threshold: number;
  members: PublicKey[];
  timeLock: number;
  staleTransactionIndex: bigint;
}> {
  const acct = await fetchMultisigAccount(connection, multisig);
  return {
    threshold: acct.threshold,
    members: acct.members.map((m) => m.key),
    timeLock: acct.timeLock,
    staleTransactionIndex: bignumToBigInt(acct.staleTransactionIndex),
  };
}

export async function assertTimeLock(
  connection: Connection,
  multisig: PublicKey,
  expectedSeconds: number,
): Promise<void> {
  const config = await getMultisigConfig(connection, multisig);
  if (config.timeLock !== expectedSeconds) {
    throw new Error(
      `Squads multisig ${multisig.toBase58()} time lock mismatch: expected ${expectedSeconds} seconds, got ${config.timeLock} seconds`,
    );
  }
}

export async function createUpgradeProposal(args: {
  connection: Connection;
  multisig: PublicKey;
  vaultIndex: number;
  instructions: TransactionInstruction[];
  proposer: PublicKey;
}): Promise<{
  proposalPda: PublicKey;
  transactionPda: PublicKey;
  transactionIndex: bigint;
  vaultTransactionCreateIx: TransactionInstruction;
  proposalCreateIx: TransactionInstruction;
  squadsUrl: string;
}> {
  const multisigAcct = await fetchMultisigAccount(
    args.connection,
    args.multisig,
  );
  const nextIndex = bignumToBigInt(multisigAcct.transactionIndex) + 1n;

  const [vaultPda] = squadsGetVaultPda({
    multisigPda: args.multisig,
    index: args.vaultIndex,
  });

  const transactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: args.instructions,
  });

  const vaultTransactionCreateIx = squadsInstructions.vaultTransactionCreate({
    multisigPda: args.multisig,
    transactionIndex: nextIndex,
    creator: args.proposer,
    vaultIndex: args.vaultIndex,
    ephemeralSigners: 0,
    transactionMessage,
    addressLookupTableAccounts: [] as AddressLookupTableAccount[],
  });

  const proposalCreateIx = squadsInstructions.proposalCreate({
    multisigPda: args.multisig,
    creator: args.proposer,
    transactionIndex: nextIndex,
  });

  const [proposalPda] = getProposalPda({
    multisigPda: args.multisig,
    transactionIndex: nextIndex,
  });
  const [transactionPda] = getTransactionPda({
    multisigPda: args.multisig,
    index: nextIndex,
  });

  const squadsUrl = `https://app.squads.so/squads/${args.multisig.toBase58()}/transactions/${nextIndex.toString()}`;

  return {
    proposalPda,
    transactionPda,
    transactionIndex: nextIndex,
    vaultTransactionCreateIx,
    proposalCreateIx,
    squadsUrl,
  };
}

function classifyOpenStatus(
  status: squadsAccounts.Proposal["status"],
): OpenProposalStatus | null {
  switch (status.__kind) {
    case "Draft":
      return "Draft";
    case "Active":
      return "Active";
    case "Approved":
      return "Approved";
    default:
      return null;
  }
}

export type ProposalSnapshot = {
  index: bigint;
  proposalPda: PublicKey;
  status: OpenProposalStatus;
  targetsProgram: boolean;
};

// Filter a precomputed proposal-snapshot list down to those that are
// still executable and target the program. Encodes Squads v4's
// executability semantics:
//
//   - i > staleTransactionIndex: Draft/Active/Approved are all live.
//     Draft can be activated, Active can be voted into Approved, and
//     Approved can be executed.
//
//   - i <= staleTransactionIndex: only Approved survives.
//     `proposal_activate` and `proposal_vote` both reject stale
//     proposals with StaleProposal, so stale Draft cannot reach
//     Active and stale Active cannot reach Approved. But
//     `vault_transaction_execute` has no staleness check, and an
//     Approved-then-staled proposal stays Approved indefinitely
//     (only `proposal_cancel` clears it). That stale-Approved
//     window is the duplicate-proposal hole this filter closes.
//
// Source: programs/squads_multisig_program/src/instructions/{proposal_activate,proposal_vote,vault_transaction_execute}.rs
// in https://github.com/Squads-Protocol/v4.
export function selectBlockingProposals(
  snapshots: readonly ProposalSnapshot[],
  staleTransactionIndex: bigint,
): OpenProposal[] {
  const blocking: OpenProposal[] = [];
  for (const s of snapshots) {
    if (!s.targetsProgram) {
      continue;
    }
    if (s.index <= staleTransactionIndex && s.status !== "Approved") {
      continue;
    }
    blocking.push({
      proposalPda: s.proposalPda,
      transactionIndex: s.index,
      status: s.status,
    });
  }
  return blocking;
}

export async function listOpenProposals(args: {
  connection: Connection;
  multisig: PublicKey;
  programId: PublicKey;
}): Promise<OpenProposal[]> {
  const multisigAcct = await fetchMultisigAccount(
    args.connection,
    args.multisig,
  );
  const transactionIndex = bignumToBigInt(multisigAcct.transactionIndex);
  const staleTransactionIndex = bignumToBigInt(
    multisigAcct.staleTransactionIndex,
  );

  const targetProgramIdBase58 = args.programId.toBase58();

  const snapshots: ProposalSnapshot[] = [];

  // Walk the full lifetime range. Stale-Approved proposals targeting
  // the program are still executable in Squads v4 and must be visible
  // to the duplicate-proposal guard; starting the scan above
  // `staleTransactionIndex` would silently miss them.
  for (let i = 1n; i <= transactionIndex; i++) {
    const [proposalPda] = getProposalPda({
      multisigPda: args.multisig,
      transactionIndex: i,
    });
    const proposal = await fetchProposalAccount(args.connection, proposalPda);
    if (proposal === null) {
      continue;
    }
    const openStatus = classifyOpenStatus(proposal.status);
    if (openStatus === null) {
      continue;
    }

    const [transactionPda] = getTransactionPda({
      multisigPda: args.multisig,
      index: i,
    });
    const vaultTransaction = await fetchVaultTransactionAccount(
      args.connection,
      transactionPda,
    );
    if (vaultTransaction === null) {
      continue;
    }

    // The flex program ID does not appear as the dispatched-to program
    // in an upgrade proposal — bpf_loader_upgradeable does. The flex
    // program ID appears as a writable account in the upgrade
    // instruction (the program-data PDA seeds reference it, and the
    // program account itself is passed writable). Match by walking
    // every instruction's account list for the program ID.
    const accountKeysBase58 = vaultTransaction.message.accountKeys.map((k) =>
      k.toBase58(),
    );
    const targetsProgram = vaultTransaction.message.instructions.some((ix) =>
      ix.accountIndexes.some(
        (idx) => accountKeysBase58[idx] === targetProgramIdBase58,
      ),
    );

    snapshots.push({
      index: i,
      proposalPda,
      status: openStatus,
      targetsProgram,
    });
  }

  return selectBlockingProposals(snapshots, staleTransactionIndex);
}

// Throws if any open vault proposal on `multisig` targets `programId`.
// Shared by every operator command that composes a new
// program-targeting Squads proposal (program-deploy, program-close,
// program-verify), so the duplicate-proposal guard has a single point
// of repair if its accept/reject criteria ever change. The error
// preamble is parameterized because each consumer's recovery hint
// differs (close vs. retry vs. retry-with-script-name).
export async function guardNoOpenProposalsForProgram(args: {
  connection: Connection;
  multisig: PublicKey;
  programId: PublicKey;
  errorPreamble: string;
}): Promise<void> {
  const open = await listOpenProposals({
    connection: args.connection,
    multisig: args.multisig,
    programId: args.programId,
  });
  if (open.length === 0) {
    return;
  }
  const descriptions = open
    .map(
      (p) =>
        `${p.proposalPda.toBase58()} (idx=${p.transactionIndex.toString()}, status=${p.status})`,
    )
    .join(", ");
  throw new Error(
    `${args.errorPreamble}: ${String(open.length)} open vault proposal(s) target program ${args.programId.toBase58()}: ${descriptions}.`,
  );
}

async function fetchProgramConfigTreasury(
  connection: Connection,
): Promise<PublicKey> {
  const [programConfigPda] = getProgramConfigPda({});
  const info = await connection.getAccountInfo(programConfigPda, "confirmed");
  if (info === null) {
    throw new Error(
      `Squads program config account ${programConfigPda.toBase58()} not found`,
    );
  }
  const [acct] = squadsAccounts.ProgramConfig.fromAccountInfo({
    data: info.data,
    executable: info.executable,
    lamports: info.lamports,
    owner: info.owner,
  });
  return acct.treasury;
}

export type CreateMultisigResult = {
  multisig: PublicKey;
  vault: PublicKey;
  createKey: Keypair;
  instruction: TransactionInstruction;
};

export async function createMultisig(args: {
  connection: Connection;
  creator: PublicKey;
  members: PublicKey[];
  threshold: number;
  timeLock: number;
  vaultIndex: number;
}): Promise<CreateMultisigResult> {
  const createKey = Keypair.generate();
  const [multisigPda] = getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = squadsGetVaultPda({
    multisigPda,
    index: args.vaultIndex,
  });
  const treasury = await fetchProgramConfigTreasury(args.connection);

  const members = args.members.map((member) => ({
    key: member,
    permissions: squadsTypes.Permissions.all(),
  }));

  const instruction = squadsInstructions.multisigCreateV2({
    treasury,
    creator: args.creator,
    multisigPda,
    configAuthority: null,
    threshold: args.threshold,
    members,
    timeLock: args.timeLock,
    createKey: createKey.publicKey,
    rentCollector: null,
    memo: null,
  });

  return {
    multisig: multisigPda,
    vault: vaultPda,
    createKey,
    instruction,
  };
}
