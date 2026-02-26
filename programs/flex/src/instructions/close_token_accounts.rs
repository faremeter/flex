use std::collections::HashSet;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, TokenAccount, Transfer};

use crate::error::FlexError;

pub struct CloseTokenAccountsParams<'a, 'info> {
    pub remaining_accounts: &'a [AccountInfo<'info>],
    pub escrow_account_info: &'a AccountInfo<'info>,
    pub escrow_owner_info: &'a AccountInfo<'info>,
    pub escrow_owner: &'a Pubkey,
    pub escrow_index: u64,
    pub escrow_bump: u8,
    pub mint_count: u64,
    pub token_program: &'a AccountInfo<'info>,
    pub program_id: &'a Pubkey,
}

#[allow(clippy::too_many_lines)]
pub fn close_token_accounts(params: CloseTokenAccountsParams) -> Result<()> {
    let CloseTokenAccountsParams {
        remaining_accounts,
        escrow_account_info,
        escrow_owner_info,
        escrow_owner,
        escrow_index,
        escrow_bump,
        mint_count,
        token_program,
        program_id,
    } = params;

    let expected_len = mint_count
        .checked_mul(2)
        .ok_or(error!(FlexError::InvalidTokenAccountPair))?;
    require!(
        remaining_accounts.len() == expected_len as usize,
        FlexError::InvalidTokenAccountPair
    );

    let escrow_key = escrow_account_info.key();
    let mut seen_mints = HashSet::new();

    for pair in remaining_accounts.chunks_exact(2) {
        let source = &pair[0];
        let destination = &pair[1];

        require!(
            source.owner == token_program.key,
            FlexError::InvalidTokenAccountPair
        );

        let source_data = source.try_borrow_data()?;
        let mut slice: &[u8] = &source_data;
        let source_token = TokenAccount::try_deserialize(&mut slice)
            .map_err(|_| error!(FlexError::InvalidTokenAccountPair))?;

        require!(
            source_token.owner == escrow_key,
            FlexError::InvalidTokenAccountPair
        );

        let (expected_vault, _) = Pubkey::find_program_address(
            &[b"token", escrow_key.as_ref(), source_token.mint.as_ref()],
            program_id,
        );
        require!(
            source.key() == expected_vault,
            FlexError::InvalidTokenAccountPair
        );

        require!(
            destination.owner == token_program.key,
            FlexError::InvalidTokenAccountPair
        );

        let dest_data = destination.try_borrow_data()?;
        let mut dest_slice: &[u8] = &dest_data;
        let dest_token = TokenAccount::try_deserialize(&mut dest_slice)
            .map_err(|_| error!(FlexError::InvalidTokenAccountPair))?;

        require!(
            dest_token.owner == *escrow_owner,
            FlexError::InvalidTokenAccountPair
        );
        require!(
            dest_token.mint == source_token.mint,
            FlexError::InvalidTokenAccountPair
        );

        require!(
            seen_mints.insert(source_token.mint),
            FlexError::DuplicateAccounts
        );
    }

    let index_bytes = escrow_index.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"escrow",
        escrow_owner.as_ref(),
        &index_bytes,
        &[escrow_bump],
    ];

    for pair in remaining_accounts.chunks_exact(2) {
        let source = &pair[0];
        let destination = &pair[1];

        let source_data = source.try_borrow_data()?;
        let mut slice: &[u8] = &source_data;
        let source_token = TokenAccount::try_deserialize(&mut slice)
            .map_err(|_| error!(FlexError::InvalidTokenAccountPair))?;
        let amount = source_token.amount;
        drop(source_data);

        if amount > 0 {
            token::transfer(
                CpiContext::new(
                    token_program.clone(),
                    Transfer {
                        from: source.clone(),
                        to: destination.clone(),
                        authority: escrow_account_info.clone(),
                    },
                )
                .with_signer(&[signer_seeds]),
                amount,
            )?;
        }

        token::close_account(
            CpiContext::new(
                token_program.clone(),
                CloseAccount {
                    account: source.clone(),
                    destination: escrow_owner_info.clone(),
                    authority: escrow_account_info.clone(),
                },
            )
            .with_signer(&[signer_seeds]),
        )?;
    }

    Ok(())
}
