#![no_main]

#[cfg(not(feature = "stateful"))]
compile_error!("Build with: cargo +nightly fuzz run stateful_sequence --no-default-features --features stateful");

#[cfg(feature = "stateful")]
mod harness {
    use std::collections::HashMap;

    use arbitrary::Arbitrary;
    use borsh::BorshSerialize;
    use litesvm::LiteSVM;
    use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo, spl_token};
    use sha2::{Digest, Sha256};
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_message::Message;
    use solana_program_pack::Pack;
    use solana_pubkey::Pubkey;
    use solana_signer::Signer;
    use solana_transaction::Transaction;

    const PROGRAM_BYTES: &[u8] = include_bytes!("../../target/deploy/flex.so");
    const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

    fn program_id() -> Pubkey {
        "EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS"
            .parse()
            .unwrap()
    }

    fn spl_token_id() -> Pubkey {
        spl_token::ID
    }

    fn system_id() -> Pubkey {
        solana_system_interface::program::ID
    }

    fn instructions_sysvar() -> Pubkey {
        "Sysvar1nstructions1111111111111111111111111"
            .parse()
            .unwrap()
    }

    #[derive(BorshSerialize, Clone)]
    struct SplitEntry {
        recipient: [u8; 32],
        bps: u16,
    }

    #[derive(BorshSerialize)]
    struct PaymentAuthorization {
        program_id: [u8; 32],
        escrow: [u8; 32],
        mint: [u8; 32],
        max_amount: u64,
        authorization_id: u64,
        expires_at_slot: u64,
        splits: Vec<SplitEntry>,
    }

    fn pk_bytes(pk: &Pubkey) -> [u8; 32] {
        pk.to_bytes()
    }

    #[derive(Arbitrary, Debug)]
    pub struct FuzzScenario {
        refund_timeout_slots: u16,
        deadman_timeout_slots: u16,
        initial_deposit: u32,
        operations: Vec<FuzzOp>,
    }

    #[derive(Arbitrary, Debug)]
    pub enum FuzzOp {
        Deposit { amount: u32 },
        DepositMintB { amount: u32 },
        SubmitAuthorization { auth_id: u8, max_amount: u32, settle_amount: u32, use_multi_split: bool },
        SubmitAuthorizationMintB { auth_id: u8, max_amount: u32, settle_amount: u32 },
        Refund { auth_id: u8, amount: u32 },
        Finalize { auth_id: u8 },
        VoidPending { auth_id: u8 },
        RevokeSessionKey,
        RegisterNewSessionKey { grace_period_slots: u16 },
        CloseSessionKey,
        EmergencyClose,
        ForceClose,
        CloseEscrow,
        AdvanceSlots { slots: u32 },
        // Compound operations that produce useful multi-step sequences
        // the random fuzzer would rarely discover on its own.
        SubmitAndFinalize { auth_id: u8, amount: u32 },
        SubmitAndRefund { auth_id: u8, settle_amount: u32, refund_amount: u32 },
        // Negative testing: valid signature from wrong keypair.
        // Precompile passes but program rejects (pubkey mismatch).
        SubmitWithWrongKey { auth_id: u8, amount: u32 },
        // Negative testing: right pubkey but corrupted signature.
        // Precompile rejects the transaction entirely.
        SubmitWithBadSignature { auth_id: u8, amount: u32, corrupt_byte: u8 },
        // Compound: submit, fully refund (closes PDA), resubmit same auth_id.
        SubmitRefundResubmit { auth_id: u8, amount: u32 },
        // Compound: submit, partial refund, advance past window, finalize.
        SubmitPartialRefundFinalize { auth_id: u8, settle_amount: u32, refund_amount: u32 },
        // Compound: fill all 16 pending slots, then attempt a 17th.
        FillPendingSlots { base_amount: u32 },
        // Compound: register key with grace, submit, revoke, submit again in grace window.
        RevokeAndSubmitDuringGrace { auth_id: u8, amount: u32, grace_period_slots: u16 },
        // Compound: submit N auths, advance past deadman, void each, emergency_close.
        FullEmergencyRecovery { num_pending: u8, amount: u32 },
        // Compound: submit multiple auths totaling more than vault, try to finalize all.
        OvercommitVault { amount: u32 },
        // Compound: submit with multi-split, advance, finalize.
        SubmitMultiSplitAndFinalize { auth_id: u8, amount: u32 },
        // Wrong signer: owner tries to submit (only facilitator should).
        SubmitWithOwnerAsSigner { auth_id: u8, amount: u32 },
        // Wrong signer: owner tries to refund (only facilitator should).
        RefundWithOwnerAsSigner { auth_id: u8, amount: u32 },
        // Wrong signer: facilitator tries to void (only owner should).
        VoidWithFacilitatorAsSigner { auth_id: u8 },
        // Wrong signer: facilitator tries emergency_close (only owner should).
        EmergencyCloseWithFacilitator,
    }

    // Snapshot of immutable escrow configuration taken at creation time.
    struct EscrowConfig {
        owner: Pubkey,
        facilitator: Pubkey,
        refund_timeout: u64,
        deadman_timeout: u64,
    }

    struct TestEnv {
        svm: LiteSVM,
        owner: Keypair,
        facilitator: Keypair,
        session_keys: Vec<(Keypair, Pubkey, bool)>,
        mint: Pubkey,
        mint_b: Pubkey,
        escrow_pda: Pubkey,
        vault_pda: Pubkey,
        vault_b_pda: Pubkey,
        recipient_a: Pubkey,
        recipient_b: Pubkey,
        owner_token: Pubkey,
        owner_token_b: Pubkey,
        recipient_b_for_mint_b: Pubkey,
        total_deposited: HashMap<Pubkey, u64>,
        total_finalized: HashMap<Pubkey, u64>,
        pending_amounts: HashMap<u8, u64>,
        pending_mints: HashMap<u8, Pubkey>,
        pending_splits: HashMap<u8, Vec<Pubkey>>,
        submitted_at_slots: HashMap<u8, u64>,
        session_key_count: u8,
        last_activity_slot: u64,
        escrow_alive: bool,
        config: EscrowConfig,
    }

    fn find_pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
        Pubkey::find_program_address(seeds, &program_id())
    }

    fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> bool {
        let blockhash = svm.latest_blockhash();
        let msg = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(&[payer], msg, blockhash);
        svm.send_transaction(tx).is_ok()
    }

    fn send_signed(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> bool {
        let blockhash = svm.latest_blockhash();
        let msg = Message::new(ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, blockhash);
        svm.send_transaction(tx).is_ok()
    }

    fn anchor_disc(name: &str) -> [u8; 8] {
        let mut hasher = Sha256::new();
        hasher.update(format!("global:{name}").as_bytes());
        let result = hasher.finalize();
        let mut disc = [0u8; 8];
        disc.copy_from_slice(&result[..8]);
        disc
    }

    fn build_ix(name: &str, data: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
        let mut ix_data = anchor_disc(name).to_vec();
        ix_data.extend_from_slice(data);
        Instruction::new_with_bytes(program_id(), &ix_data, accounts)
    }

    fn build_ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
        let ed25519_program: Pubkey = "Ed25519SigVerify111111111111111111111111111"
            .parse()
            .unwrap();

        let pubkey_bytes = signer.pubkey().to_bytes();
        let signature = signer.sign_message(message);
        let sig_bytes = signature.as_ref();

        let data_start: usize = 16;
        let sig_offset = data_start;
        let pk_offset = sig_offset + 64;
        let msg_offset = pk_offset + 32;
        let msg_size = message.len();
        let total = msg_offset + msg_size;

        let mut data = vec![0u8; total];
        data[0] = 1;

        let offsets: [(usize, u16); 7] = [
            (2, sig_offset as u16),
            (4, 0xFFFF),
            (6, pk_offset as u16),
            (8, 0xFFFF),
            (10, msg_offset as u16),
            (12, msg_size as u16),
            (14, 0xFFFF),
        ];
        for (off, val) in offsets {
            data[off..off + 2].copy_from_slice(&val.to_le_bytes());
        }

        data[sig_offset..sig_offset + 64].copy_from_slice(&sig_bytes[..64]);
        data[pk_offset..pk_offset + 32].copy_from_slice(&pubkey_bytes);
        data[msg_offset..msg_offset + msg_size].copy_from_slice(message);

        Instruction::new_with_bytes(ed25519_program, &data, vec![])
    }

    fn get_token_balance(svm: &LiteSVM, address: &Pubkey) -> Option<u64> {
        let account = svm.get_account(address)?;
        let token = spl_token::state::Account::unpack(&account.data).ok()?;
        Some(token.amount)
    }

    fn setup(scenario: &FuzzScenario) -> Option<TestEnv> {
        let refund_timeout = 150u64.max(scenario.refund_timeout_slots as u64).min(1_296_000);
        let deadman_timeout =
            1000u64.max(scenario.deadman_timeout_slots as u64).min(2_592_000);
        let deadman_timeout = deadman_timeout.max(refund_timeout * 2);
        let initial_deposit = 1u64.max(scenario.initial_deposit as u64);

        let mut svm = LiteSVM::new()
            .with_sigverify(false)
            .with_builtins()
            .with_precompiles()
            .with_lamports(LAMPORTS_PER_SOL * 1000);

        let _ = svm.add_program(program_id(), PROGRAM_BYTES);
        svm.warp_to_slot(1);

        let owner = Keypair::new();
        let facilitator = Keypair::new();
        let session_key = Keypair::new();

        svm.airdrop(&owner.pubkey(), LAMPORTS_PER_SOL * 100).ok()?;
        svm.airdrop(&facilitator.pubkey(), LAMPORTS_PER_SOL * 100).ok()?;

        let mint = CreateMint::new(&mut svm, &owner)
            .decimals(6)
            .send()
            .ok()?;

        let mint_b = CreateMint::new(&mut svm, &owner)
            .decimals(6)
            .send()
            .ok()?;

        let owner_token =
            CreateAssociatedTokenAccount::new(&mut svm, &owner, &mint)
                .send()
                .ok()?;

        let owner_token_b =
            CreateAssociatedTokenAccount::new(&mut svm, &owner, &mint_b)
                .send()
                .ok()?;

        MintTo::new(&mut svm, &owner, &mint, &owner_token, initial_deposit)
            .send()
            .ok()?;

        MintTo::new(&mut svm, &owner, &mint_b, &owner_token_b, initial_deposit)
            .send()
            .ok()?;

        let recipient_a =
            CreateAssociatedTokenAccount::new(&mut svm, &facilitator, &mint)
                .send()
                .ok()?;

        let r2_owner = Keypair::new();
        svm.airdrop(&r2_owner.pubkey(), LAMPORTS_PER_SOL * 10).ok()?;
        let recipient_b =
            CreateAssociatedTokenAccount::new(&mut svm, &r2_owner, &mint)
                .send()
                .ok()?;

        let recipient_b_for_mint_b =
            CreateAssociatedTokenAccount::new(&mut svm, &r2_owner, &mint_b)
                .send()
                .ok()?;

        let owner_pk = owner.pubkey();
        let fac_pk = facilitator.pubkey();

        let index: u64 = 0;
        let (escrow_pda, _) =
            find_pda(&[b"escrow", owner_pk.as_ref(), &index.to_le_bytes()]);

        let mut data = Vec::new();
        index.serialize(&mut data).ok()?;
        pk_bytes(&fac_pk).serialize(&mut data).ok()?;
        refund_timeout.serialize(&mut data).ok()?;
        deadman_timeout.serialize(&mut data).ok()?;
        10u8.serialize(&mut data).ok()?;

        let ix = build_ix(
            "create_escrow",
            &data,
            vec![
                AccountMeta::new(owner_pk, true),
                AccountMeta::new(escrow_pda, false),
                AccountMeta::new_readonly(system_id(), false),
            ],
        );
        if !send(&mut svm, &owner, &[ix]) {
            return None;
        }

        let (vault_pda, _) =
            find_pda(&[b"token", escrow_pda.as_ref(), mint.as_ref()]);

        let (vault_b_pda, _) =
            find_pda(&[b"token", escrow_pda.as_ref(), mint_b.as_ref()]);

        let mut data = Vec::new();
        initial_deposit.serialize(&mut data).ok()?;

        let ix = build_ix(
            "deposit",
            &data,
            vec![
                AccountMeta::new(owner_pk, true),
                AccountMeta::new(escrow_pda, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(vault_pda, false),
                AccountMeta::new(owner_token, false),
                AccountMeta::new_readonly(spl_token_id(), false),
                AccountMeta::new_readonly(system_id(), false),
            ],
        );
        if !send(&mut svm, &owner, &[ix]) {
            return None;
        }

        let mut data = Vec::new();
        initial_deposit.serialize(&mut data).ok()?;

        let ix = build_ix(
            "deposit",
            &data,
            vec![
                AccountMeta::new(owner_pk, true),
                AccountMeta::new(escrow_pda, false),
                AccountMeta::new_readonly(mint_b, false),
                AccountMeta::new(vault_b_pda, false),
                AccountMeta::new(owner_token_b, false),
                AccountMeta::new_readonly(spl_token_id(), false),
                AccountMeta::new_readonly(system_id(), false),
            ],
        );
        if !send(&mut svm, &owner, &[ix]) {
            return None;
        }

        let sk_pk = session_key.pubkey();
        let (session_key_pda, _) =
            find_pda(&[b"session", escrow_pda.as_ref(), sk_pk.as_ref()]);

        let mut data = Vec::new();
        pk_bytes(&sk_pk).serialize(&mut data).ok()?;
        None::<u64>.serialize(&mut data).ok()?;
        0u64.serialize(&mut data).ok()?;

        let ix = build_ix(
            "register_session_key",
            &data,
            vec![
                AccountMeta::new(owner_pk, true),
                AccountMeta::new(escrow_pda, false),
                AccountMeta::new(session_key_pda, false),
                AccountMeta::new_readonly(system_id(), false),
            ],
        );
        if !send(&mut svm, &owner, &[ix]) {
            return None;
        }

        let mut total_deposited = HashMap::new();
        total_deposited.insert(mint, initial_deposit);
        total_deposited.insert(mint_b, initial_deposit);

        let mut total_finalized = HashMap::new();
        total_finalized.insert(mint, 0);
        total_finalized.insert(mint_b, 0);

        let current_slot = svm.get_sysvar::<solana_clock::Clock>().slot;

        let config = EscrowConfig {
            owner: owner_pk,
            facilitator: fac_pk,
            refund_timeout,
            deadman_timeout,
        };

        Some(TestEnv {
            svm,
            owner,
            facilitator,
            session_keys: vec![(session_key, session_key_pda, false)],
            mint,
            mint_b,
            escrow_pda,
            vault_pda,
            vault_b_pda,
            recipient_a,
            recipient_b,
            owner_token,
            owner_token_b,
            recipient_b_for_mint_b,
            total_deposited,
            total_finalized,
            pending_amounts: HashMap::new(),
            pending_mints: HashMap::new(),
            pending_splits: HashMap::new(),
            submitted_at_slots: HashMap::new(),
            session_key_count: 1,
            last_activity_slot: current_slot,
            escrow_alive: true,
            config,
        })
    }

    fn exec_op(env: &mut TestEnv, op: &FuzzOp) {
        if !env.escrow_alive {
            return;
        }

        match op {
            FuzzOp::Deposit { amount } => {
                let amount = *amount as u64;
                if amount == 0 {
                    return;
                }
                let _ = MintTo::new(
                    &mut env.svm,
                    &env.owner,
                    &env.mint,
                    &env.owner_token,
                    amount,
                )
                .send();

                let mut data = Vec::new();
                let _ = amount.serialize(&mut data);

                let ix = build_ix(
                    "deposit",
                    &data,
                    vec![
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new_readonly(env.mint, false),
                        AccountMeta::new(env.vault_pda, false),
                        AccountMeta::new(env.owner_token, false),
                        AccountMeta::new_readonly(spl_token_id(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                if send(&mut env.svm, &env.owner, &[ix]) {
                    *env.total_deposited.entry(env.mint).or_insert(0) += amount;
                }
            }

            FuzzOp::DepositMintB { amount } => {
                let amount = *amount as u64;
                if amount == 0 {
                    return;
                }
                let _ = MintTo::new(
                    &mut env.svm,
                    &env.owner,
                    &env.mint_b,
                    &env.owner_token_b,
                    amount,
                )
                .send();

                let mut data = Vec::new();
                let _ = amount.serialize(&mut data);

                let ix = build_ix(
                    "deposit",
                    &data,
                    vec![
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new_readonly(env.mint_b, false),
                        AccountMeta::new(env.vault_b_pda, false),
                        AccountMeta::new(env.owner_token_b, false),
                        AccountMeta::new_readonly(spl_token_id(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                if send(&mut env.svm, &env.owner, &[ix]) {
                    *env.total_deposited.entry(env.mint_b).or_insert(0) += amount;
                }
            }

            FuzzOp::SubmitAuthorization { auth_id, max_amount, settle_amount, use_multi_split } => {
                let auth_id = *auth_id % 16;
                let max_amount = 1u64.max(*max_amount as u64);
                let settle_amount = 1u64.max(*settle_amount as u64).min(max_amount);

                // Prefer non-revoked keys, but also try revoked keys
                // (they may still be within the grace period on-chain).
                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));

                let Some(sk_idx) = sk_idx else { return };
                let session_key_pda = env.session_keys[sk_idx].1;
                let session_key = &env.session_keys[sk_idx].0;

                let current_slot =
                    env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;

                let (splits, recipient_pubkeys) = if *use_multi_split {
                    (
                        vec![
                            SplitEntry { recipient: pk_bytes(&env.recipient_a), bps: 7_000 },
                            SplitEntry { recipient: pk_bytes(&env.recipient_b), bps: 3_000 },
                        ],
                        vec![env.recipient_a, env.recipient_b],
                    )
                } else {
                    (
                        vec![SplitEntry { recipient: pk_bytes(&env.recipient_a), bps: 10_000 }],
                        vec![env.recipient_a],
                    )
                };

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint),
                    max_amount,
                    authorization_id: auth_id as u64,
                    expires_at_slot,
                    splits: splits.clone(),
                };

                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                let ed25519_ix =
                    build_ed25519_ix(session_key, &expected_message);

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint).serialize(&mut data);
                let _ = max_amount.serialize(&mut data);
                let _ = settle_amount.serialize(&mut data);
                let _ = (auth_id as u64).serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                if send_signed(
                    &mut env.svm,
                    &[&env.facilitator],
                    &[ed25519_ix, submit_ix],
                ) {
                    SUBMIT_OK.fetch_add(1, Ordering::Relaxed);
                    env.pending_amounts.insert(auth_id, settle_amount);
                    env.pending_mints.insert(auth_id, env.mint);
                    env.pending_splits.insert(auth_id, recipient_pubkeys);
                    env.submitted_at_slots.insert(auth_id, current_slot);
                    env.last_activity_slot = current_slot;
                } else {
                    SUBMIT_FAIL.fetch_add(1, Ordering::Relaxed);
                }
            }

            FuzzOp::SubmitAuthorizationMintB { auth_id, max_amount, settle_amount } => {
                let auth_id = *auth_id % 16;
                let max_amount = 1u64.max(*max_amount as u64);
                let settle_amount = 1u64.max(*settle_amount as u64).min(max_amount);

                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));

                let Some(sk_idx) = sk_idx else { return };
                let session_key_pda = env.session_keys[sk_idx].1;
                let session_key = &env.session_keys[sk_idx].0;

                let current_slot =
                    env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;

                let splits = vec![SplitEntry { recipient: pk_bytes(&env.recipient_b_for_mint_b), bps: 10_000 }];
                let recipient_pubkeys = vec![env.recipient_b_for_mint_b];

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint_b),
                    max_amount,
                    authorization_id: auth_id as u64,
                    expires_at_slot,
                    splits: splits.clone(),
                };

                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                let ed25519_ix =
                    build_ed25519_ix(session_key, &expected_message);

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint_b).serialize(&mut data);
                let _ = max_amount.serialize(&mut data);
                let _ = settle_amount.serialize(&mut data);
                let _ = (auth_id as u64).serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_b_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                if send_signed(
                    &mut env.svm,
                    &[&env.facilitator],
                    &[ed25519_ix, submit_ix],
                ) {
                    SUBMIT_OK.fetch_add(1, Ordering::Relaxed);
                    env.pending_amounts.insert(auth_id, settle_amount);
                    env.pending_mints.insert(auth_id, env.mint_b);
                    env.pending_splits.insert(auth_id, recipient_pubkeys);
                    env.submitted_at_slots.insert(auth_id, current_slot);
                    env.last_activity_slot = current_slot;
                } else {
                    SUBMIT_FAIL.fetch_add(1, Ordering::Relaxed);
                }
            }

            FuzzOp::Refund { auth_id, amount } => {
                let auth_id = *auth_id % 16;
                let amount = *amount as u64;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = amount.serialize(&mut data);

                let ix = build_ix(
                    "refund",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new(pending_pda, false),
                    ],
                );

                let amount_before = env.pending_amounts.get(&auth_id).copied();

                if send(&mut env.svm, &env.facilitator, &[ix]) {
                    REFUND_OK.fetch_add(1, Ordering::Relaxed);
                    let current_slot =
                        env.svm.get_sysvar::<solana_clock::Clock>().slot;

                    // Post-hoc: refund only succeeds within the refund window
                    if let Some(&submitted_at) = env.submitted_at_slots.get(&auth_id) {
                        assert!(
                            current_slot < submitted_at + env.config.refund_timeout,
                            "SECURITY: refund succeeded after refund window expired"
                        );
                    }

                    // Post-hoc: refund never increases pending amount
                    if let Some(before) = amount_before {
                        // Read on-chain amount after refund
                        let on_chain_after = env.svm.get_account(&pending_pda)
                            .and_then(|d| {
                                if d.data.len() >= 81 {
                                    Some(u64::from_le_bytes(d.data[73..81].try_into().unwrap()))
                                } else {
                                    None
                                }
                            });
                        match on_chain_after {
                            Some(a) => assert!(
                                a < before,
                                "SECURITY: refund did not decrease pending amount ({before} -> {a})"
                            ),
                            None => {} // account closed (full refund)
                        }
                    }

                    if let Some(pending) = env.pending_amounts.get_mut(&auth_id) {
                        if amount >= *pending {
                            env.pending_amounts.remove(&auth_id);
                            env.pending_splits.remove(&auth_id);
                            env.pending_mints.remove(&auth_id);
                            env.submitted_at_slots.remove(&auth_id);
                        } else {
                            *pending -= amount;
                        }
                    }
                    env.last_activity_slot = current_slot;
                }
            }

            FuzzOp::Finalize { auth_id } => {
                let auth_id = *auth_id % 16;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mint = env.pending_mints.get(&auth_id).copied().unwrap_or(env.mint);
                let vault = if mint == env.mint_b { env.vault_b_pda } else { env.vault_pda };
                let vault_before = get_token_balance(&env.svm, &vault);
                let pending_amount = env.pending_amounts.get(&auth_id).copied();

                let recipients = env.pending_splits
                    .get(&auth_id)
                    .cloned()
                    .unwrap_or_else(|| vec![env.recipient_a]);

                let mut accounts = vec![
                    AccountMeta::new(env.escrow_pda, false),
                    AccountMeta::new(env.facilitator.pubkey(), false),
                    AccountMeta::new(pending_pda, false),
                    AccountMeta::new(vault, false),
                    AccountMeta::new_readonly(spl_token_id(), false),
                ];
                for r in &recipients {
                    accounts.push(AccountMeta::new(*r, false));
                }

                let ix = build_ix("finalize", &[], accounts);

                if send(&mut env.svm, &env.facilitator, &[ix]) {
                    let current_slot =
                        env.svm.get_sysvar::<solana_clock::Clock>().slot;

                    // Post-hoc: finalize only succeeds after the refund window
                    if let Some(&submitted_at) = env.submitted_at_slots.get(&auth_id) {
                        assert!(
                            current_slot >= submitted_at + env.config.refund_timeout,
                            "SECURITY: finalize succeeded before refund window expired"
                        );
                    }

                    // Post-hoc: vault decreased by exactly the pending amount
                    if let (Some(before), Some(amt)) = (vault_before, pending_amount) {
                        let after = get_token_balance(&env.svm, &vault).unwrap_or(0);
                        assert_eq!(
                            before - after, amt,
                            "SECURITY: finalize transferred {}, expected {amt}",
                            before - after
                        );
                    }

                    if let Some(amount) = env.pending_amounts.remove(&auth_id) {
                        FINALIZE_OK.fetch_add(1, Ordering::Relaxed);
                        *env.total_finalized.entry(mint).or_insert(0) += amount;
                    }
                    env.pending_mints.remove(&auth_id);
                    env.pending_splits.remove(&auth_id);
                    env.submitted_at_slots.remove(&auth_id);
                    // finalize does NOT update last_activity_slot on-chain
                }
            }

            FuzzOp::VoidPending { auth_id } => {
                let auth_id = *auth_id % 16;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let ix = build_ix(
                    "void_pending",
                    &[],
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new(pending_pda, false),
                    ],
                );

                if send(&mut env.svm, &env.owner, &[ix]) {
                    // Post-hoc: void only succeeds after deadman timeout
                    let current_slot =
                        env.svm.get_sysvar::<solana_clock::Clock>().slot;
                    assert!(
                        current_slot > env.last_activity_slot + env.config.deadman_timeout,
                        "SECURITY: void_pending succeeded before deadman timeout"
                    );

                    env.pending_amounts.remove(&auth_id);
                    env.pending_splits.remove(&auth_id);
                    env.pending_mints.remove(&auth_id);
                    env.submitted_at_slots.remove(&auth_id);
                }
            }

            FuzzOp::RevokeSessionKey => {
                let sk_idx = {
                    let mut idx = None;
                    for (i, (_, _, revoked)) in env.session_keys.iter().enumerate() {
                        if !revoked {
                            idx = Some(i);
                            break;
                        }
                    }
                    idx
                };

                if let Some(idx) = sk_idx {
                    let session_key_pda = env.session_keys[idx].1;
                    let ix = build_ix(
                        "revoke_session_key",
                        &[],
                        vec![
                            AccountMeta::new_readonly(env.owner.pubkey(), true),
                            AccountMeta::new_readonly(env.escrow_pda, false),
                            AccountMeta::new(session_key_pda, false),
                        ],
                    );

                    if send(&mut env.svm, &env.owner, &[ix]) {
                        env.session_keys[idx].2 = true;
                    }
                }
            }

            FuzzOp::RegisterNewSessionKey { grace_period_slots } => {
                if env.session_keys.len() >= 4 {
                    return;
                }

                let new_session_key = Keypair::new();
                let sk_pk = new_session_key.pubkey();
                let (session_key_pda, _) =
                    find_pda(&[b"session", env.escrow_pda.as_ref(), sk_pk.as_ref()]);

                let grace_period = *grace_period_slots as u64;
                let mut data = Vec::new();
                if pk_bytes(&sk_pk).serialize(&mut data).is_err() {
                    return;
                }
                if None::<u64>.serialize(&mut data).is_err() {
                    return;
                }
                if grace_period.serialize(&mut data).is_err() {
                    return;
                }

                let ix = build_ix(
                    "register_session_key",
                    &data,
                    vec![
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(session_key_pda, false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                if send(&mut env.svm, &env.owner, &[ix]) {
                    env.session_keys.push((new_session_key, session_key_pda, false));
                    env.session_key_count += 1;
                }
            }

            FuzzOp::CloseSessionKey => {
                let sk_idx = {
                    let mut idx = None;
                    for (i, (_, _, revoked)) in env.session_keys.iter().enumerate() {
                        if *revoked {
                            idx = Some(i);
                            break;
                        }
                    }
                    idx
                };

                if let Some(idx) = sk_idx {
                    let session_key_pda = env.session_keys[idx].1;
                    let ix = build_ix(
                        "close_session_key",
                        &[],
                        vec![
                            AccountMeta::new_readonly(env.owner.pubkey(), true),
                            AccountMeta::new_readonly(env.escrow_pda, false),
                            AccountMeta::new(session_key_pda, false),
                        ],
                    );

                    if send(&mut env.svm, &env.owner, &[ix]) {
                        env.session_keys.remove(idx);
                        env.session_key_count = env.session_key_count.saturating_sub(1);
                    }
                }
            }

            FuzzOp::EmergencyClose => {
                // Requires pending_count == 0 and deadman timeout expired.
                // remaining_accounts: [vault, owner_dest] pairs for each mint.
                let accounts = vec![
                    AccountMeta::new(env.escrow_pda, false),
                    AccountMeta::new(env.owner.pubkey(), true),
                    AccountMeta::new_readonly(spl_token_id(), false),
                    AccountMeta::new(env.vault_pda, false),
                    AccountMeta::new(env.owner_token, false),
                    AccountMeta::new(env.vault_b_pda, false),
                    AccountMeta::new(env.owner_token_b, false),
                ];

                let ix = build_ix("emergency_close", &[], accounts);

                if send(&mut env.svm, &env.owner, &[ix]) {
                    let current_slot =
                        env.svm.get_sysvar::<solana_clock::Clock>().slot;

                    // Post-hoc: emergency close requires deadman timeout elapsed
                    assert!(
                        current_slot > env.last_activity_slot + env.config.deadman_timeout,
                        "SECURITY: emergency_close succeeded before deadman timeout"
                    );

                    // Post-hoc: emergency close requires no pending settlements
                    assert!(
                        env.pending_amounts.is_empty(),
                        "SECURITY: emergency_close succeeded with {} pending settlements",
                        env.pending_amounts.len()
                    );

                    // Post-hoc: vaults should be closed (funds go home)
                    assert!(
                        env.svm.get_account(&env.vault_pda).is_none(),
                        "SECURITY: vault A still exists after emergency_close"
                    );
                    assert!(
                        env.svm.get_account(&env.vault_b_pda).is_none(),
                        "SECURITY: vault B still exists after emergency_close"
                    );

                    CLOSE_OK.fetch_add(1, Ordering::Relaxed);
                    env.escrow_alive = false;
                    env.pending_amounts.clear();
                    env.pending_splits.clear();
                    env.pending_mints.clear();
                    env.submitted_at_slots.clear();
                }
            }

            FuzzOp::ForceClose => {
                // Nuclear option: skips pending_count check at 2x deadman.
                // remaining_accounts: [vault, owner_dest] pairs for each mint.
                let accounts = vec![
                    AccountMeta::new(env.escrow_pda, false),
                    AccountMeta::new(env.owner.pubkey(), true),
                    AccountMeta::new_readonly(spl_token_id(), false),
                    AccountMeta::new(env.vault_pda, false),
                    AccountMeta::new(env.owner_token, false),
                    AccountMeta::new(env.vault_b_pda, false),
                    AccountMeta::new(env.owner_token_b, false),
                ];

                let ix = build_ix("force_close", &[], accounts);

                if send(&mut env.svm, &env.owner, &[ix]) {
                    let current_slot =
                        env.svm.get_sysvar::<solana_clock::Clock>().slot;

                    // Post-hoc: force close requires 2x deadman timeout elapsed
                    assert!(
                        current_slot > env.last_activity_slot + env.config.deadman_timeout * 2,
                        "SECURITY: force_close succeeded before 2x deadman timeout"
                    );

                    // Post-hoc: vaults should be closed
                    assert!(
                        env.svm.get_account(&env.vault_pda).is_none(),
                        "SECURITY: vault A still exists after force_close"
                    );
                    assert!(
                        env.svm.get_account(&env.vault_b_pda).is_none(),
                        "SECURITY: vault B still exists after force_close"
                    );

                    CLOSE_OK.fetch_add(1, Ordering::Relaxed);
                    env.escrow_alive = false;
                    env.pending_amounts.clear();
                    env.pending_splits.clear();
                    env.pending_mints.clear();
                    env.submitted_at_slots.clear();
                }
            }

            FuzzOp::AdvanceSlots { slots } => {
                let current =
                    env.svm.get_sysvar::<solana_clock::Clock>().slot;
                env.svm.warp_to_slot(current + (*slots as u64).min(6_000_000));
            }

            FuzzOp::CloseEscrow => {
                // No early return -- let the on-chain program reject if
                // pending_count != 0. This exercises the constraint path.
                let accounts = vec![
                    AccountMeta::new(env.escrow_pda, false),
                    AccountMeta::new(env.owner.pubkey(), true),
                    AccountMeta::new(env.facilitator.pubkey(), true),
                    AccountMeta::new_readonly(spl_token_id(), false),
                    AccountMeta::new(env.vault_pda, false),
                    AccountMeta::new(env.owner_token, false),
                    AccountMeta::new(env.vault_b_pda, false),
                    AccountMeta::new(env.owner_token_b, false),
                ];

                let ix = build_ix("close_escrow", &[], accounts);

                if send_signed(
                    &mut env.svm,
                    &[&env.owner, &env.facilitator],
                    &[ix],
                ) {
                    // Post-hoc: vaults should be closed
                    assert!(
                        env.svm.get_account(&env.vault_pda).is_none(),
                        "SECURITY: vault A still exists after close_escrow"
                    );
                    assert!(
                        env.svm.get_account(&env.vault_b_pda).is_none(),
                        "SECURITY: vault B still exists after close_escrow"
                    );

                    CLOSE_OK.fetch_add(1, Ordering::Relaxed);
                    env.escrow_alive = false;
                    env.pending_amounts.clear();
                    env.pending_splits.clear();
                    env.pending_mints.clear();
                    env.submitted_at_slots.clear();
                }
            }

            FuzzOp::SubmitAndFinalize { auth_id, amount } => {
                // Submit, advance past refund window, finalize.
                let submit_op = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit_op);
                if !env.escrow_alive { return; }

                let advance_op = FuzzOp::AdvanceSlots {
                    slots: env.config.refund_timeout as u32 + 1,
                };
                exec_op(env, &advance_op);

                let finalize_op = FuzzOp::Finalize { auth_id: *auth_id };
                exec_op(env, &finalize_op);
            }

            FuzzOp::SubmitAndRefund { auth_id, settle_amount, refund_amount } => {
                // Submit, then immediately refund (within the window).
                let submit_op = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *settle_amount,
                    settle_amount: *settle_amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit_op);
                if !env.escrow_alive { return; }

                let refund_op = FuzzOp::Refund {
                    auth_id: *auth_id,
                    amount: *refund_amount,
                };
                exec_op(env, &refund_op);
            }

            FuzzOp::SubmitWithWrongKey { auth_id, amount } => {
                // Valid Ed25519 signature from a keypair that is NOT the
                // registered session key. The precompile verifies the
                // signature successfully, but the program's introspection
                // compares the pubkey against the session key and rejects.
                let auth_id = *auth_id % 16;
                let amount = 1u64.max(*amount as u64);

                let wrong_key = Keypair::new();

                let current_slot =
                    env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;

                let splits = vec![SplitEntry {
                    recipient: pk_bytes(&env.recipient_a),
                    bps: 10_000,
                }];

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint),
                    max_amount: amount,
                    authorization_id: auth_id as u64,
                    expires_at_slot,
                    splits: splits.clone(),
                };

                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                // Sign with the wrong key -- signature is valid for
                // wrong_key but the program expects session_key.
                let ed25519_ix = build_ed25519_ix(&wrong_key, &expected_message);

                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));
                let Some(sk_idx) = sk_idx else { return };
                let session_key_pda = env.session_keys[sk_idx].1;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint).serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = (auth_id as u64).serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                let succeeded = send_signed(
                    &mut env.svm,
                    &[&env.facilitator],
                    &[ed25519_ix, submit_ix],
                );

                assert!(
                    !succeeded,
                    "SECURITY: submit succeeded with wrong session key signature"
                );
                BAD_SIG_REJECTED.fetch_add(1, Ordering::Relaxed);
            }

            FuzzOp::SubmitWithBadSignature { auth_id, amount, corrupt_byte } => {
                // Correct session key pubkey in the Ed25519 instruction,
                // but the signature bytes are corrupted. The Ed25519
                // precompile should reject the transaction entirely.
                let auth_id = *auth_id % 16;
                let amount = 1u64.max(*amount as u64);

                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));
                let Some(sk_idx) = sk_idx else { return };
                let session_key = &env.session_keys[sk_idx].0;
                let session_key_pda = env.session_keys[sk_idx].1;

                let current_slot =
                    env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;

                let splits = vec![SplitEntry {
                    recipient: pk_bytes(&env.recipient_a),
                    bps: 10_000,
                }];

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint),
                    max_amount: amount,
                    authorization_id: auth_id as u64,
                    expires_at_slot,
                    splits: splits.clone(),
                };

                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                // Build a real Ed25519 instruction, then corrupt one
                // byte of the signature to make it invalid.
                let mut ed25519_ix = build_ed25519_ix(session_key, &expected_message);
                // Signature starts at offset 16 in the instruction data.
                let corrupt_offset = 16 + (*corrupt_byte as usize % 64);
                ed25519_ix.data[corrupt_offset] ^= 0xFF;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint).serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = (auth_id as u64).serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                let succeeded = send_signed(
                    &mut env.svm,
                    &[&env.facilitator],
                    &[ed25519_ix, submit_ix],
                );

                assert!(
                    !succeeded,
                    "SECURITY: submit succeeded with corrupted signature"
                );
                BAD_SIG_REJECTED.fetch_add(1, Ordering::Relaxed);
            }

            FuzzOp::SubmitRefundResubmit { auth_id, amount } => {
                let submit = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit);
                if !env.escrow_alive { return; }

                // Full refund closes the PDA
                let refund = FuzzOp::Refund {
                    auth_id: *auth_id,
                    amount: u32::MAX,
                };
                exec_op(env, &refund);
                if !env.escrow_alive { return; }

                // Resubmit same auth_id -- exercises replay-after-full-refund
                let resubmit = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: false,
                };
                exec_op(env, &resubmit);
            }

            FuzzOp::SubmitPartialRefundFinalize { auth_id, settle_amount, refund_amount } => {
                let submit = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *settle_amount,
                    settle_amount: *settle_amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit);
                if !env.escrow_alive { return; }

                let refund = FuzzOp::Refund {
                    auth_id: *auth_id,
                    amount: *refund_amount,
                };
                exec_op(env, &refund);
                if !env.escrow_alive { return; }

                let advance = FuzzOp::AdvanceSlots {
                    slots: env.config.refund_timeout as u32 + 1,
                };
                exec_op(env, &advance);

                let finalize = FuzzOp::Finalize { auth_id: *auth_id };
                exec_op(env, &finalize);
            }

            FuzzOp::FillPendingSlots { base_amount } => {
                let amount = 1u32.max(*base_amount);
                for i in 0u8..16 {
                    let submit = FuzzOp::SubmitAuthorization {
                        auth_id: i,
                        max_amount: amount,
                        settle_amount: amount,
                        use_multi_split: false,
                    };
                    exec_op(env, &submit);
                    if !env.escrow_alive { return; }
                }

                // 17th should fail -- build manually with auth_id 16
                // to avoid % 16 mapping back to 0
                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));
                let Some(sk_idx) = sk_idx else { return };
                let session_key_pda = env.session_keys[sk_idx].1;
                let session_key = &env.session_keys[sk_idx].0;

                let current_slot = env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;
                let auth_id_17: u64 = 16;
                let settle = 1u64.max(amount as u64);

                let splits = vec![SplitEntry {
                    recipient: pk_bytes(&env.recipient_a),
                    bps: 10_000,
                }];

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint),
                    max_amount: settle,
                    authorization_id: auth_id_17,
                    expires_at_slot,
                    splits: splits.clone(),
                };
                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                let ed25519_ix = build_ed25519_ix(session_key, &expected_message);
                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &auth_id_17.to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint).serialize(&mut data);
                let _ = settle.serialize(&mut data);
                let _ = settle.serialize(&mut data);
                let _ = auth_id_17.serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                let succeeded = send_signed(
                    &mut env.svm,
                    &[&env.facilitator],
                    &[ed25519_ix, submit_ix],
                );
                // 17th should be rejected if all 16 slots are occupied
                if env.pending_amounts.len() >= 16 {
                    assert!(
                        !succeeded,
                        "SECURITY: 17th submit succeeded with 16 pending settlements"
                    );
                }
            }

            FuzzOp::RevokeAndSubmitDuringGrace { auth_id, amount, grace_period_slots } => {
                let register = FuzzOp::RegisterNewSessionKey {
                    grace_period_slots: 100u16.max(*grace_period_slots),
                };
                exec_op(env, &register);
                if !env.escrow_alive { return; }

                let submit = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit);
                if !env.escrow_alive { return; }

                let revoke = FuzzOp::RevokeSessionKey;
                exec_op(env, &revoke);
                if !env.escrow_alive { return; }

                // Submit again with a different auth_id during grace window
                let submit2 = FuzzOp::SubmitAuthorization {
                    auth_id: auth_id.wrapping_add(1),
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit2);
            }

            FuzzOp::FullEmergencyRecovery { num_pending, amount } => {
                let n = 1u8.max(*num_pending).min(16);
                let amount = 1u32.max(*amount);

                for i in 0..n {
                    let submit = FuzzOp::SubmitAuthorization {
                        auth_id: i,
                        max_amount: amount,
                        settle_amount: amount,
                        use_multi_split: false,
                    };
                    exec_op(env, &submit);
                    if !env.escrow_alive { return; }
                }

                let advance = FuzzOp::AdvanceSlots {
                    slots: env.config.deadman_timeout as u32 + 1,
                };
                exec_op(env, &advance);

                for i in 0..n {
                    let void = FuzzOp::VoidPending { auth_id: i };
                    exec_op(env, &void);
                    if !env.escrow_alive { return; }
                }

                let close = FuzzOp::EmergencyClose;
                exec_op(env, &close);
            }

            FuzzOp::OvercommitVault { amount } => {
                let amount = 1u32.max(*amount);

                let submit0 = FuzzOp::SubmitAuthorization {
                    auth_id: 0,
                    max_amount: amount,
                    settle_amount: amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit0);
                if !env.escrow_alive { return; }

                let submit1 = FuzzOp::SubmitAuthorization {
                    auth_id: 1,
                    max_amount: amount,
                    settle_amount: amount,
                    use_multi_split: false,
                };
                exec_op(env, &submit1);
                if !env.escrow_alive { return; }

                let advance = FuzzOp::AdvanceSlots {
                    slots: env.config.refund_timeout as u32 + 1,
                };
                exec_op(env, &advance);

                // First finalize may drain the vault
                let fin0 = FuzzOp::Finalize { auth_id: 0 };
                exec_op(env, &fin0);

                // Second finalize may fail if vault is drained
                let fin1 = FuzzOp::Finalize { auth_id: 1 };
                exec_op(env, &fin1);
            }

            FuzzOp::SubmitMultiSplitAndFinalize { auth_id, amount } => {
                let submit = FuzzOp::SubmitAuthorization {
                    auth_id: *auth_id,
                    max_amount: *amount,
                    settle_amount: *amount,
                    use_multi_split: true,
                };
                exec_op(env, &submit);
                if !env.escrow_alive { return; }

                let advance = FuzzOp::AdvanceSlots {
                    slots: env.config.refund_timeout as u32 + 1,
                };
                exec_op(env, &advance);

                let finalize = FuzzOp::Finalize { auth_id: *auth_id };
                exec_op(env, &finalize);
            }

            FuzzOp::SubmitWithOwnerAsSigner { auth_id, amount } => {
                let auth_id = *auth_id % 16;
                let amount = 1u64.max(*amount as u64);

                let sk_idx = env.session_keys.iter()
                    .position(|(_, _, revoked)| !revoked)
                    .or_else(|| env.session_keys.iter().position(|_| true));
                let Some(sk_idx) = sk_idx else { return };
                let session_key_pda = env.session_keys[sk_idx].1;
                let session_key = &env.session_keys[sk_idx].0;

                let current_slot = env.svm.get_sysvar::<solana_clock::Clock>().slot;
                let expires_at_slot = current_slot + 50;

                let splits = vec![SplitEntry {
                    recipient: pk_bytes(&env.recipient_a),
                    bps: 10_000,
                }];

                let authorization = PaymentAuthorization {
                    program_id: pk_bytes(&program_id()),
                    escrow: pk_bytes(&env.escrow_pda),
                    mint: pk_bytes(&env.mint),
                    max_amount: amount,
                    authorization_id: auth_id as u64,
                    expires_at_slot,
                    splits: splits.clone(),
                };
                let expected_message = match borsh::to_vec(&authorization) {
                    Ok(m) => m,
                    Err(_) => return,
                };

                let ed25519_ix = build_ed25519_ix(session_key, &expected_message);
                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = pk_bytes(&env.mint).serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = amount.serialize(&mut data);
                let _ = (auth_id as u64).serialize(&mut data);
                let _ = expires_at_slot.serialize(&mut data);
                let _ = splits.serialize(&mut data);

                // Owner as signer instead of facilitator
                let submit_ix = build_ix(
                    "submit_authorization",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new_readonly(session_key_pda, false),
                        AccountMeta::new_readonly(env.vault_pda, false),
                        AccountMeta::new(pending_pda, false),
                        AccountMeta::new_readonly(instructions_sysvar(), false),
                        AccountMeta::new_readonly(system_id(), false),
                    ],
                );

                let succeeded = send_signed(
                    &mut env.svm,
                    &[&env.owner],
                    &[ed25519_ix, submit_ix],
                );
                assert!(
                    !succeeded,
                    "SECURITY: submit succeeded with owner as signer instead of facilitator"
                );
                WRONG_SIGNER_REJECTED.fetch_add(1, Ordering::Relaxed);
            }

            FuzzOp::RefundWithOwnerAsSigner { auth_id, amount } => {
                let auth_id = *auth_id % 16;
                let amount = *amount as u64;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                let mut data = Vec::new();
                let _ = amount.serialize(&mut data);

                // Owner as signer instead of facilitator
                let ix = build_ix(
                    "refund",
                    &data,
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.owner.pubkey(), true),
                        AccountMeta::new(pending_pda, false),
                    ],
                );

                let succeeded = send(&mut env.svm, &env.owner, &[ix]);
                assert!(
                    !succeeded,
                    "SECURITY: refund succeeded with owner as signer instead of facilitator"
                );
                WRONG_SIGNER_REJECTED.fetch_add(1, Ordering::Relaxed);
            }

            FuzzOp::VoidWithFacilitatorAsSigner { auth_id } => {
                let auth_id = *auth_id % 16;

                let (pending_pda, _) = find_pda(&[
                    b"pending",
                    env.escrow_pda.as_ref(),
                    &(auth_id as u64).to_le_bytes(),
                ]);

                // Facilitator as signer instead of owner
                let ix = build_ix(
                    "void_pending",
                    &[],
                    vec![
                        AccountMeta::new(env.escrow_pda, false),
                        AccountMeta::new(env.facilitator.pubkey(), true),
                        AccountMeta::new(pending_pda, false),
                    ],
                );

                let succeeded = send(&mut env.svm, &env.facilitator, &[ix]);
                assert!(
                    !succeeded,
                    "SECURITY: void_pending succeeded with facilitator as signer instead of owner"
                );
                WRONG_SIGNER_REJECTED.fetch_add(1, Ordering::Relaxed);
            }

            FuzzOp::EmergencyCloseWithFacilitator => {
                // Facilitator as signer instead of owner
                let accounts = vec![
                    AccountMeta::new(env.escrow_pda, false),
                    AccountMeta::new(env.facilitator.pubkey(), true),
                    AccountMeta::new_readonly(spl_token_id(), false),
                    AccountMeta::new(env.vault_pda, false),
                    AccountMeta::new(env.owner_token, false),
                    AccountMeta::new(env.vault_b_pda, false),
                    AccountMeta::new(env.owner_token_b, false),
                ];

                let ix = build_ix("emergency_close", &[], accounts);

                let succeeded = send(&mut env.svm, &env.facilitator, &[ix]);
                assert!(
                    !succeeded,
                    "SECURITY: emergency_close succeeded with facilitator as signer instead of owner"
                );
                WRONG_SIGNER_REJECTED.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn check_invariants(env: &TestEnv) {
        if !env.escrow_alive {
            return;
        }

        const PENDING_COUNT_OFFSET: usize = 81;
        const PENDING_COUNT_END: usize = PENDING_COUNT_OFFSET + 8;
        const SESSION_KEY_COUNT_OFFSET: usize = 122;
        const SESSION_KEY_COUNT_END: usize = SESSION_KEY_COUNT_OFFSET + 1;
        const LAST_ACTIVITY_OFFSET: usize = 113;
        const LAST_ACTIVITY_END: usize = LAST_ACTIVITY_OFFSET + 8;

        let mints = vec![env.mint, env.mint_b];

        for mint in &mints {
            let vault = if *mint == env.mint_b { env.vault_b_pda } else { env.vault_pda };

            if let Some(vault_balance) = get_token_balance(&env.svm, &vault) {
                // The program allows over-commitment: each submit checks
                // vault >= settle_amount individually, not cumulatively.
                // The facilitator is trusted not to over-commit.

                let deposited = env.total_deposited.get(mint).copied().unwrap_or(0);
                let finalized = env.total_finalized.get(mint).copied().unwrap_or(0);
                assert_eq!(
                    deposited,
                    vault_balance + finalized,
                    "INVARIANT VIOLATION (mint {mint}): deposited={deposited} != vault={vault_balance} + finalized={finalized}"
                );
            }
        }

        if let Some(escrow_data) = env.svm.get_account(&env.escrow_pda) {
            if escrow_data.data.len() >= PENDING_COUNT_END {
                let pending_count = u64::from_le_bytes(
                    escrow_data.data[PENDING_COUNT_OFFSET..PENDING_COUNT_END]
                        .try_into()
                        .unwrap(),
                );
                assert_eq!(
                    pending_count,
                    env.pending_amounts.len() as u64,
                    "INVARIANT VIOLATION: on_chain pending_count={pending_count} != shadow={}",
                    env.pending_amounts.len()
                );
            }

            if escrow_data.data.len() >= SESSION_KEY_COUNT_END {
                let session_key_count = escrow_data.data[SESSION_KEY_COUNT_OFFSET];
                assert_eq!(
                    session_key_count,
                    env.session_key_count,
                    "INVARIANT VIOLATION: on_chain session_key_count={session_key_count} != shadow={}",
                    env.session_key_count
                );
            }

            if escrow_data.data.len() >= LAST_ACTIVITY_END {
                let last_activity = u64::from_le_bytes(
                    escrow_data.data[LAST_ACTIVITY_OFFSET..LAST_ACTIVITY_END]
                        .try_into()
                        .unwrap(),
                );
                assert_eq!(
                    last_activity,
                    env.last_activity_slot,
                    "INVARIANT VIOLATION: on_chain last_activity={last_activity} != shadow={}",
                    env.last_activity_slot
                );
            }
        }

        for (auth_id, amount) in &env.pending_amounts {
            let (pending_pda, _) = find_pda(&[
                b"pending",
                env.escrow_pda.as_ref(),
                &(*auth_id as u64).to_le_bytes(),
            ]);

            if let Some(pending_data) = env.svm.get_account(&pending_pda) {
                if pending_data.data.len() >= 81 {
                    const PENDING_AMOUNT_OFFSET: usize = 73;
                    const PENDING_AMOUNT_END: usize = PENDING_AMOUNT_OFFSET + 8;
                    if pending_data.data.len() >= PENDING_AMOUNT_END {
                        let on_chain_amount = u64::from_le_bytes(
                            pending_data.data[PENDING_AMOUNT_OFFSET..PENDING_AMOUNT_END]
                                .try_into()
                                .unwrap(),
                        );
                        assert_eq!(
                            on_chain_amount,
                            *amount,
                            "INVARIANT VIOLATION: pending auth {auth_id}: on_chain amount={on_chain_amount} != shadow={amount}"
                        );
                    }
                }
            }
        }

        // Escrow configuration immutability: owner, facilitator, and
        // timeout parameters must never change after creation.
        if let Some(escrow_data) = env.svm.get_account(&env.escrow_pda) {
            // owner at offset 9 (32 bytes), facilitator at offset 41 (32 bytes)
            // refund_timeout at offset 97 (8 bytes), deadman_timeout at offset 105 (8 bytes)
            if escrow_data.data.len() >= 113 {
                let owner_bytes = &escrow_data.data[9..41];
                assert_eq!(
                    owner_bytes, env.config.owner.as_ref(),
                    "SECURITY: escrow owner changed after creation"
                );

                let fac_bytes = &escrow_data.data[41..73];
                assert_eq!(
                    fac_bytes, env.config.facilitator.as_ref(),
                    "SECURITY: escrow facilitator changed after creation"
                );

                let refund_timeout = u64::from_le_bytes(
                    escrow_data.data[97..105].try_into().unwrap(),
                );
                assert_eq!(
                    refund_timeout, env.config.refund_timeout,
                    "SECURITY: refund_timeout changed after creation"
                );

                let deadman_timeout = u64::from_le_bytes(
                    escrow_data.data[105..113].try_into().unwrap(),
                );
                assert_eq!(
                    deadman_timeout, env.config.deadman_timeout,
                    "SECURITY: deadman_timeout changed after creation"
                );
            }
        }
    }


    use std::sync::atomic::{AtomicU64, Ordering};

    static ITERATIONS: AtomicU64 = AtomicU64::new(0);
    static SUBMIT_OK: AtomicU64 = AtomicU64::new(0);
    static SUBMIT_FAIL: AtomicU64 = AtomicU64::new(0);
    static FINALIZE_OK: AtomicU64 = AtomicU64::new(0);
    static REFUND_OK: AtomicU64 = AtomicU64::new(0);
    static BAD_SIG_REJECTED: AtomicU64 = AtomicU64::new(0);
    static WRONG_SIGNER_REJECTED: AtomicU64 = AtomicU64::new(0);
    static CLOSE_OK: AtomicU64 = AtomicU64::new(0);

    const LOG_INTERVAL: u64 = 500;
    const HEALTH_CHECK_AFTER: u64 = 1000;

    fn health_check(i: u64) {
        if i == 0 {
            return;
        }

        let submits = SUBMIT_OK.load(Ordering::Relaxed);
        let submit_fails = SUBMIT_FAIL.load(Ordering::Relaxed);
        let finalizes = FINALIZE_OK.load(Ordering::Relaxed);
        let refunds = REFUND_OK.load(Ordering::Relaxed);
        let rejected = BAD_SIG_REJECTED.load(Ordering::Relaxed);
        let wrong_signer = WRONG_SIGNER_REJECTED.load(Ordering::Relaxed);
        let closes = CLOSE_OK.load(Ordering::Relaxed);

        if i % LOG_INTERVAL == 0 {
            eprintln!(
                "[fuzz health] iter={i} submit={submits}/{} finalize={finalizes} \
                 refund={refunds} bad_sig={rejected} wrong_signer={wrong_signer} close={closes}",
                submits + submit_fails,
            );
        }

        if i >= HEALTH_CHECK_AFTER {
            assert!(
                submits > 0,
                "FUZZER HEALTH: {i} iterations but 0 successful submissions. \
                 The fuzzer is not exercising the payment flow."
            );
            assert!(
                finalizes > 0,
                "FUZZER HEALTH: {i} iterations but 0 successful finalizations. \
                 The fuzzer is not exercising the finalize path."
            );
            assert!(
                rejected > 0,
                "FUZZER HEALTH: {i} iterations but 0 bad-signature rejections. \
                 The negative signature tests are not running."
            );
        }
    }

    pub fn fuzz(scenario: FuzzScenario) {
        let iter = ITERATIONS.fetch_add(1, Ordering::Relaxed) + 1;

        let ops = if scenario.operations.len() > 50 {
            &scenario.operations[..50]
        } else {
            &scenario.operations
        };

        let Some(mut env) = setup(&scenario) else {
            return;
        };

        check_invariants(&env);

        for op in ops {
            exec_op(&mut env, op);
            check_invariants(&env);
        }

        health_check(iter);
    }
}

#[cfg(feature = "stateful")]
use harness::FuzzScenario;

#[cfg(feature = "stateful")]
libfuzzer_sys::fuzz_target!(|scenario: FuzzScenario| {
    harness::fuzz(scenario);
});
