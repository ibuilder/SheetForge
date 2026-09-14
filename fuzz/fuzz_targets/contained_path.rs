//! Path containment turns names from somebody else's package into paths inside it.
//!
//! The one property that matters: whatever comes back is inside the root. The history of
//! containment bugs is a history of inputs nobody imagined, which is what a fuzzer is for.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::path::Path;

fuzz_target!(|relative: &str| {
    let root = Path::new(if cfg!(windows) {
        r"C:\projects\riverside.sfproj"
    } else {
        "/projects/riverside.sfproj"
    });
    if let Ok(path) = sf_security::contained_path(root, relative) {
        assert!(
            path.starts_with(root),
            "{relative:?} resolved outside the package, to {path:?}"
        );
    }
});
