//! The page counter reads every drawing the application admits, before anything else does.
//!
//! It must not panic, and it must stay inside the range its caller relies on: at least one page,
//! and no more than one past the ceiling, whatever the file claims about itself.
#![no_main]

use libfuzzer_sys::fuzz_target;

/// The domain's page ceiling. Fixed here rather than imported, so the property is stated in full.
const CEILING: u32 = 10_000;

fuzz_target!(|bytes: &[u8]| {
    let counted = sf_security::count_pages(bytes, CEILING);
    assert!(
        (1..=CEILING + 1).contains(&counted),
        "counted {counted} pages"
    );
});
