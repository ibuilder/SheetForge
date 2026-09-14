//! Redaction runs on text nobody wrote for a log: an operating system's error, a library's message.
//!
//! It must not panic, and it must keep the text's whitespace exactly, so that a redacted line still
//! reads as the line it was.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|text: &str| {
    let out = sf_audit::redact(text);
    let spacing = |value: &str| {
        value
            .chars()
            .filter(|character| character.is_whitespace())
            .collect::<String>()
    };
    assert_eq!(spacing(&out), spacing(text), "redaction changed the shape of {text:?}");
});
