//! Property tests over the hostile-input boundary.
//!
//! The unit tests next to the code check the cases somebody thought of. These check the cases
//! nobody thought of, by generating hundreds of thousands of inputs and asserting the properties
//! that must hold for *all* of them.
//!
//! That distinction matters here more than anywhere else in the codebase. `contained_path` is
//! fed manifest entries and archive member names from project packages that arrive by email, and
//! the history of path-containment bugs is a history of inputs the author did not imagine:
//! a trailing dot, a mixed separator, an alternate encoding, a name that means one thing on one
//! filesystem and another elsewhere. An example-based test can only ever cover the imagination of
//! whoever wrote it.
//!
//! The properties asserted are deliberately absolute:
//!
//! 1. **No input escapes.** Whatever comes back from `contained_path` is inside the root, always.
//! 2. **Nothing panics.** A panic in a Tauri command aborts the process in release builds — where
//!    `panic = "abort"` is set — so a crafted package would be a denial of service.
//! 3. **The answer does not depend on the platform.** A package written on Windows and opened on
//!    Linux must mean the same thing, which is the bug CI caught by hand and this now covers by
//!    construction.

use proptest::prelude::*;
use sf_security::{check_name, contained_path, validate_pdf_header, ResourceLimits, SecurityError};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(if cfg!(windows) {
        r"C:\projects\riverside.sfproj"
    } else {
        "/projects/riverside.sfproj"
    })
}

/// Strings built from the alphabet that path bugs actually live in.
///
/// Uniform random text almost never produces `..` or a drive letter, so it would explore the
/// boring part of the space forever. This biases hard towards separators, dots, colons and the
/// characters platforms disagree about.
fn hostile_path() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        2 => Just("..".to_owned()),
        2 => Just("/".to_owned()),
        2 => Just("\\".to_owned()),
        1 => Just(".".to_owned()),
        1 => Just(":".to_owned()),
        1 => Just("C:".to_owned()),
        1 => Just("//".to_owned()),
        1 => Just(r"\\".to_owned()),
        1 => Just("~".to_owned()),
        1 => Just(" ".to_owned()),
        1 => Just("\u{0}".to_owned()),
        1 => Just("\u{202e}".to_owned()), // right-to-left override
        1 => Just("%2e%2e".to_owned()),
        1 => Just("CON".to_owned()),
        1 => Just("NUL".to_owned()),
        3 => "[a-zA-Z0-9._-]{1,8}",
    ];
    proptest::collection::vec(piece, 1..10).prop_map(|parts| parts.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    /// The one that matters: nothing reaches outside the package.
    #[test]
    fn a_contained_path_is_always_inside_the_root(relative in hostile_path()) {
        let root = root();
        if let Ok(path) = contained_path(&root, &relative) {
            prop_assert!(
                path.starts_with(&root),
                "{relative:?} produced {path:?}, which is outside {root:?}",
            );
            // Belt and braces: no component of the *result* may be a parent reference, even if the
            // prefix check passed. `C:\a\..\..\b` starts with `C:\a` textually.
            prop_assert!(
                !path.components().any(|c| matches!(c, std::path::Component::ParentDir)),
                "{relative:?} produced a path still containing `..`: {path:?}",
            );
        }
    }

    /// A refusal must be a refusal, not a panic.
    #[test]
    fn path_containment_never_panics(relative in ".*") {
        let _ = contained_path(&root(), &relative);
    }

    /// Filename validation is fed the same untrusted text.
    #[test]
    fn name_checking_never_panics(name in ".*") {
        let _ = check_name(&name);
    }

    /// An accepted name is usable as a single path component — no separators, no traversal.
    #[test]
    fn an_accepted_name_is_a_single_component(name in hostile_path()) {
        if check_name(&name).is_ok() {
            prop_assert!(!name.contains('/') && !name.contains('\\'), "{name:?} is not one component");
            prop_assert!(name != ".." && name != ".", "{name:?} is a traversal");
            prop_assert!(!name.is_empty());
        }
    }

    /// Format sniffing is the first thing untrusted bytes touch.
    #[test]
    fn pdf_sniffing_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = validate_pdf_header(&bytes);
    }

    /// Anything accepted as a PDF really does carry the marker; anything rejected really does not,
    /// within the window the sniffer looks at.
    #[test]
    fn pdf_sniffing_agrees_with_the_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let window = &bytes[..bytes.len().min(1024)];
        let present = window.windows(5).any(|w| w == b"%PDF-");
        prop_assert_eq!(validate_pdf_header(&bytes).is_ok(), present);
    }

    /// Size checks are pure arithmetic on attacker-influenced numbers, which is where overflow
    /// lives. A wrong answer here is either a refused legitimate file or an accepted enormous one.
    #[test]
    fn size_limits_never_overflow(bytes in any::<u64>(), limit_mb in any::<u64>()) {
        let outcome = ResourceLimits::check_size(bytes, limit_mb, "a drawing");
        // The limit in bytes, computed without wrapping.
        let limit_bytes = u128::from(limit_mb) * 1024 * 1024;
        prop_assert_eq!(outcome.is_ok(), u128::from(bytes) <= limit_bytes);
    }

    /// The reported size must never claim to be within the limit while refusing.
    #[test]
    fn an_oversize_refusal_reports_a_size_above_the_limit(
        bytes in 1u64..u64::MAX / 2,
        limit_mb in 0u64..1024,
    ) {
        if let Err(SecurityError::TooLarge { actual_mb, limit_mb: reported, .. }) =
            ResourceLimits::check_size(bytes, limit_mb, "a drawing")
        {
            prop_assert!(
                actual_mb > reported,
                "refused {bytes} bytes against {limit_mb} MB but reported {actual_mb} MB, which \
                 reads as though it were within the limit",
            );
        }
    }
}

/// Paths that must be refused on every platform, checked as a set rather than one by one.
///
/// The regression behind this is worth restating: `Path::components` answers differently on Windows
/// and on Linux, so delegating containment to it meant a package crafted on one platform meant
/// something else on the other.
#[test]
fn known_escapes_are_refused_everywhere() {
    let escapes = [
        "../secrets",
        "..",
        "a/../../b",
        "/etc/passwd",
        r"C:\Windows\System32",
        r"c:/Windows",
        r"\\server\share",
        r"a\..\..\b",
        "a/./../../b",
        "....//....//etc",
        r"a\\..\\..\\b",
    ];
    for attempt in escapes {
        let result = contained_path(&root(), attempt);
        assert!(
            result.is_err(),
            "{attempt:?} was accepted and resolved to {:?}",
            result.ok(),
        );
    }
}

/// A corpus of files that are not PDFs but arrive named as if they were.
#[test]
fn things_that_are_not_pdfs_are_refused() {
    let corpus: [(&str, &[u8]); 9] = [
        ("empty", b""),
        ("zip or docx", b"PK\x03\x04\x14\x00\x00\x00"),
        ("windows executable", b"MZ\x90\x00\x03\x00\x00\x00"),
        ("elf executable", b"\x7fELF\x02\x01\x01\x00"),
        (
            "html error page",
            b"<!DOCTYPE html><title>404 Not Found</title>",
        ),
        ("truncated header", b"%PDF"),
        ("postscript", b"%!PS-Adobe-3.0"),
        ("rtf", b"{\\rtf1\\ansi"),
        ("png", b"\x89PNG\r\n\x1a\n"),
    ];
    for (what, bytes) in corpus {
        assert!(
            validate_pdf_header(bytes).is_err(),
            "{what} was accepted as a PDF"
        );
    }
}

/// A PDF header buried past the window is not a PDF, however much it looks like one.
#[test]
fn a_header_hidden_deep_in_a_file_is_refused() {
    let mut bytes = vec![0u8; 4096];
    bytes.extend_from_slice(b"%PDF-1.7");
    assert!(validate_pdf_header(&bytes).is_err());
}

/// Names that Windows silently rewrites, which is how two manifest entries become one file.
#[test]
fn names_that_collide_after_the_platform_rewrites_them_are_refused() {
    for name in [
        "report.", "report ", "CON", "nul.pdf", "com1", "LPT9.txt", "a<b", "a|b",
    ] {
        assert!(check_name(name).is_err(), "{name:?} was accepted");
    }
}

/// Long paths, which historically split behaviour between platforms and APIs.
#[test]
fn a_very_long_name_is_refused_rather_than_truncated() {
    let long = "x".repeat(300);
    assert!(check_name(&long).is_err());
    assert!(contained_path(&root(), &long).is_err());
}

/// A path that exists and points outside the package must be refused even though every component
/// looked innocent.
#[test]
fn a_symlink_out_of_the_package_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let package = temp.path().join("project.sfproj");
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(package.join("sources")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), b"x").unwrap();

    let link = package.join("sources").join("escape");
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();

    if !made {
        eprintln!("skipped: this platform does not permit unprivileged symlink creation");
        return;
    }
    assert_eq!(
        contained_path(&package, "sources/escape/secret.txt"),
        Err(SecurityError::PathEscape),
    );
}

/// The root itself is not a valid target: writing to it would overwrite the package directory.
#[test]
fn the_package_root_is_not_a_writable_target() {
    for attempt in ["", ".", "./"] {
        let resolved = contained_path(&root(), attempt);
        if let Ok(path) = resolved {
            assert_ne!(
                path,
                root(),
                "{attempt:?} resolved to the package root itself"
            );
        }
    }
}

/// `Path` is not asked anything it answers differently per platform.
#[test]
fn containment_does_not_consult_the_filesystem_for_paths_that_do_not_exist() {
    // A path that cannot exist must still be judged, and judged the same way, on a machine where
    // the root directory is absent entirely.
    let absent = Path::new(if cfg!(windows) {
        r"Z:\no\such\package"
    } else {
        "/no/such/package"
    });
    assert!(contained_path(absent, "../escape").is_err());
    assert!(contained_path(absent, "sources/a.pdf").is_ok());
}
