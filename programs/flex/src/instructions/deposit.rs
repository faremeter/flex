use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::FlexError;
use crate::events::Deposited;
use crate::state::{EscrowAccount, MAX_MINTS};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.owner.as_ref(), &escrow.index.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub mint: Account<'info, Mint>,

    /// CHECK: Created via CPI if empty, validated manually if existing.
    /// Seeds enforce the correct PDA derivation.
    #[account(
        mut,
        seeds = [b"token", escrow.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
    )]
    pub source: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Deposit<'info> {
    pub fn transfer_to_vault(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let program = self.token_program.to_account_info();
        let accounts = Transfer {
            from: self.source.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.depositor.to_account_info(),
        };
        CpiContext::new(program, accounts)
    }
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, FlexError::InsufficientBalance);

    let vault = &ctx.accounts.vault;
    let escrow = &ctx.accounts.escrow;

    if vault.data_is_empty() {
        require!(
            (escrow.mint_count as usize) < MAX_MINTS,
            FlexError::MintLimitReached
        );

        let vault_bump = ctx.bumps.vault;
        let escrow_key = escrow.key();
        let mint_key = ctx.accounts.mint.key();
        let signer_seeds: &[&[u8]] = &[
            b"token",
            escrow_key.as_ref(),
            mint_key.as_ref(),
            &[vault_bump],
        ];

        let rent = Rent::get()?;
        let space = TokenAccount::LEN;
        let lamports = rent.minimum_balance(space);

        system_program::create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: vault.to_account_info(),
                },
            )
            .with_signer(&[signer_seeds]),
            lamports,
            space as u64,
            ctx.accounts.token_program.key,
        )?;

        token::initialize_account3(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::InitializeAccount3 {
                account: vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: escrow.to_account_info(),
            },
        ))?;

        ctx.accounts.escrow.mint_count += 1;
    } else {
        let vault_data = vault.try_borrow_data()?;
        let mut slice: &[u8] = &vault_data;
        let token_account = TokenAccount::try_deserialize(&mut slice)
            .map_err(|_| error!(FlexError::InvalidTokenAccountPair))?;

        require!(
            token_account.mint == ctx.accounts.mint.key(),
            FlexError::InvalidTokenAccountPair
        );
        require!(
            token_account.owner == escrow.key(),
            FlexError::InvalidTokenAccountPair
        );
    }

    token::transfer(ctx.accounts.transfer_to_vault(), amount)?;

    emit!(Deposited {
        escrow: ctx.accounts.escrow.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        depositor: ctx.accounts.depositor.key(),
    });

    Ok(())
}
