//! Format sniffing runs on every file offered as a drawing, before it is written anywhere.
//!
//! Refused or accepted, never a panic — and never accepted unless a PDF header is really there.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    if sf_security::validate_pdf_header(bytes).is_ok() {
        let head = &bytes[..bytes.len().min(1024)];
        assert!(
            head.windows(5).any(|window| window == b"%PDF-"),
            "accepted a file with no PDF header in its first kilobyte"
        );
    }
});
