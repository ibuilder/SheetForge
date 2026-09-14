//! Name checking decides what may become a filename: an export, an attachment, a derived drawing.
//!
//! An accepted name must be exactly one ordinary path component, on every platform — a name that
//! is one component on Linux and two on Windows is a package that means different things depending
//! on who opens it.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::path::{Component, Path};

fuzz_target!(|name: &str| {
    if sf_security::check_name(name).is_ok() {
        assert!(
            !name.contains(['/', '\\']),
            "accepted a name with a separator: {name:?}"
        );
        let components: Vec<_> = Path::new(name).components().collect();
        assert!(
            matches!(components.as_slice(), [Component::Normal(_)]),
            "accepted a name that is not one ordinary component: {name:?}"
        );
    }
});
