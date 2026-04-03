#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

use flex::compute_split_amounts;
use flex::SplitEntry;

#[derive(Arbitrary, Debug)]
struct Input {
    total_amount: u64,
    bps: [u16; 5],
    split_count: u8,
}

fuzz_target!(|input: Input| {
    let split_count = (input.split_count % 5 + 1) as usize;

    let splits: Vec<SplitEntry> = input.bps[..split_count]
        .iter()
        .map(|&bps| SplitEntry {
            recipient: anchor_lang::prelude::Pubkey::default(),
            bps,
        })
        .collect();

    let bps_sum: u32 = splits.iter().map(|s| s.bps as u32).sum();
    if bps_sum != 10_000 || splits.iter().any(|s| s.bps == 0) {
        // Only test valid bps distributions -- the program rejects these
        // before reaching the split calculation.
        return;
    }

    match compute_split_amounts(input.total_amount, &splits, split_count) {
        Ok(amounts) => {
            // Invariant 1: the right number of amounts was returned.
            assert_eq!(amounts.len(), split_count);

            // Invariant 2: amounts sum to exactly total_amount (no dust lost).
            let sum: u64 = amounts.iter().sum();
            assert_eq!(
                sum, input.total_amount,
                "Split amounts {amounts:?} sum to {sum}, expected {}",
                input.total_amount
            );

            // Invariant 3: no individual amount exceeds total.
            for amount in &amounts {
                assert!(
                    *amount <= input.total_amount,
                    "Individual amount {amount} exceeds total {}",
                    input.total_amount
                );
            }
        }
        Err(_) => {
            // Errors are acceptable for extreme values (overflow in
            // checked_mul). The function must not panic.
        }
    }
});
