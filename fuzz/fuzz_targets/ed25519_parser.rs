#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

use flex::validate_ed25519_ix_data;

#[derive(Arbitrary, Debug)]
struct Input {
    ix_data: Vec<u8>,
    expected_pubkey: [u8; 32],
    expected_message: Vec<u8>,
}

fuzz_target!(|input: Input| {
    // The function must never panic -- it should return Ok or Err.
    let _ = validate_ed25519_ix_data(
        &input.ix_data,
        &input.expected_pubkey,
        &input.expected_message,
    );
});
