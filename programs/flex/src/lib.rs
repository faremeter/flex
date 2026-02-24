use anchor_lang::prelude::*;

mod error;
mod events;
mod instructions;
mod state;

pub use error::*;
pub use events::*;
pub use state::*;

declare_id!("EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS");

#[program]
pub mod flex {
    #[allow(unused_imports)]
    use super::*;
}
