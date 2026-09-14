//! Markup metadata arrives as JSON from the interface and from imports, and is validated in the
//! domain before it is stored.
//!
//! Parsed or refused, never a panic — in the decoder or in the validation behind it.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    if let Ok(metadata) = serde_json::from_slice::<sf_domain::MarkupMetadata>(bytes) {
        let _ = metadata.validated();
    }
});
