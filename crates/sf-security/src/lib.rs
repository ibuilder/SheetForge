//! # `sf-security` — hostile-input bounds, path containment and capabilities
//!
//! Everything the application reads from outside itself is treated as an attack until proven
//! otherwise: PDFs, attachments, imported project packages, XFDF and BCF files, and every payload
//! arriving from the webview. A drawing set is a normal thing to receive by email from a
//! subcontractor, which makes "open this PDF" the application's widest attack surface.
//!
//! Three defences live here, because all three are decisions rather than mechanisms and belong
//! where they can be read in one place:
//!
//! - [`ResourceLimits`] — the numbers every bounded operation refuses at. A limit that lives in
//!   the call site is a limit nobody can audit.
//! - [`contained_path`] — the only sanctioned way to turn user-supplied text into a path inside a
//!   project package. Traversal and symlink escape are both refused.
//! - [`Capability`] / [`Role`] — what a given user may do, checked before the act, not by hiding
//!   the button.
//!
//! ## What a local check can promise
//!
//! On a single-user desktop install the user *is* the trust boundary, and these checks stop
//! mistakes and malformed files rather than a determined local attacker. They are worth having
//! anyway, and they become load-bearing the moment a project package arrives from somebody else —
//! which is the normal case on a construction job.
//!
//! In a managed deployment the server remains the authority. What this module buys there is that
//! the client agrees with the server instead of offering an interface that lets people attempt
//! things their role forbids, and that every attempt is recorded either way.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

/// What a security check refused, and why.
///
/// Messages name the rule, never the offending path or the document's contents: these strings
/// reach logs, the UI and diagnostic bundles.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum SecurityError {
    /// A file was larger than the configured ceiling.
    #[error("this file is {actual_mb} MB, over the {limit_mb} MB limit for {subject}")]
    TooLarge {
        /// What was being read.
        subject: &'static str,
        /// Its size, rounded up.
        actual_mb: u64,
        /// The ceiling.
        limit_mb: u64,
    },

    /// The bytes are not the format they claim to be.
    #[error("this file is not a valid {expected} document")]
    NotTheExpectedFormat {
        /// The format that was expected.
        expected: &'static str,
    },

    /// A path escaped, or tried to escape, the package it must stay inside.
    #[error("that location is outside the project package")]
    PathEscape,

    /// A filename the platform cannot represent, or that means something else to it.
    #[error("that name cannot be used as a filename: {reason}")]
    UnusableName {
        /// Why, in words.
        reason: &'static str,
    },

    /// The current role does not hold the capability.
    #[error("your role does not allow {0}")]
    NotPermitted(Capability),

    /// A document with more pages than the ceiling allows — counted, not taken from its claim.
    #[error("this document has {pages} pages, over the {limit} page limit")]
    TooManyPages {
        /// Pages counted in the document.
        pages: u32,
        /// The ceiling.
        limit: u32,
    },

    /// Something that is not an ordinary file: a directory, a device, a pipe.
    ///
    /// Refused before reading, because reading one never ends — `/dev/zero`, or a named pipe
    /// dropped on the window, would otherwise grow memory until the process died.
    #[error("that is not an ordinary file")]
    NotAFile,

    /// The file exists but could not be read. No detail, because the underlying error names the
    /// path, and these messages reach logs and the interface.
    #[error("that file could not be read")]
    Unreadable,
}

/// This crate's result alias.
pub type Result<T> = std::result::Result<T, SecurityError>;

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

/// The bounds every untrusted-input operation refuses at.
///
/// Defaults are sized for real construction documents on ordinary hardware, not for the largest
/// file anyone could imagine. A full architectural set at 300 DPI is comfortably under the source
/// ceiling; a 2 GB "PDF" is either a mistake or an attack, and either way refusing it with a clear
/// message beats spending twenty minutes discovering the same thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResourceLimits {
    /// Largest source PDF accepted, in MB.
    pub max_pdf_mb: u64,
    /// Largest attachment accepted, in MB. Site photos are the common case.
    pub max_attachment_mb: u64,
    /// Largest imported project package accepted, in MB.
    pub max_package_mb: u64,
    /// Largest interchange file (XFDF, BCF) accepted, in MB.
    pub max_interchange_mb: u64,
    /// Most pages in one imported document. Mirrors the domain's own ceiling.
    pub max_pages: u32,
    /// Most render, OCR and export jobs allowed to run at once.
    ///
    /// Bounded because each job holds a rasterised tile, and an unbounded queue turns a fast
    /// scroll through a large set into memory exhaustion.
    pub max_concurrent_jobs: u32,
    /// How long a single background job may run before it is cancelled, in seconds.
    pub job_timeout_secs: u64,
    /// Largest decompressed size accepted from any one compressed stream, in MB.
    ///
    /// The zip-bomb bound. A package entry that expands past this is refused rather than written.
    pub max_decompressed_mb: u64,
    /// Most entries allowed in an imported package archive.
    pub max_archive_entries: u32,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_pdf_mb: 512,
            max_attachment_mb: 64,
            max_package_mb: 4_096,
            max_interchange_mb: 64,
            max_pages: 10_000,
            max_concurrent_jobs: 4,
            job_timeout_secs: 120,
            max_decompressed_mb: 1_024,
            max_archive_entries: 50_000,
        }
    }
}

impl ResourceLimits {
    /// Check a byte length against one of the ceilings.
    ///
    /// # Errors
    /// [`SecurityError::TooLarge`] naming both the actual size and the limit, so the message tells
    /// the user what to do about it.
    pub fn check_size(bytes: u64, limit_mb: u64, subject: &'static str) -> Result<()> {
        let limit_bytes = limit_mb.saturating_mul(1024 * 1024);
        if bytes > limit_bytes {
            // Round up, so a 512.4 MB file against a 512 MB limit does not report "512 MB, over
            // the 512 MB limit".
            let actual_mb = bytes.div_ceil(1024 * 1024);
            return Err(SecurityError::TooLarge {
                subject,
                actual_mb,
                limit_mb,
            });
        }
        Ok(())
    }

    /// Check a source PDF's size.
    ///
    /// # Errors
    /// As [`ResourceLimits::check_size`].
    pub fn check_pdf(&self, bytes: u64) -> Result<()> {
        Self::check_size(bytes, self.max_pdf_mb, "a drawing")
    }

    /// Check an attachment's size.
    ///
    /// # Errors
    /// As [`ResourceLimits::check_size`].
    pub fn check_attachment(&self, bytes: u64) -> Result<()> {
        Self::check_size(bytes, self.max_attachment_mb, "an attachment")
    }

    /// Check an imported package's size.
    ///
    /// # Errors
    /// As [`ResourceLimits::check_size`].
    pub fn check_package(&self, bytes: u64) -> Result<()> {
        Self::check_size(bytes, self.max_package_mb, "a project package")
    }

    /// Check an interchange file's size.
    ///
    /// # Errors
    /// As [`ResourceLimits::check_size`].
    pub fn check_interchange(&self, bytes: u64) -> Result<()> {
        Self::check_size(bytes, self.max_interchange_mb, "an import file")
    }

    /// Check a document's page count against [`ResourceLimits::max_pages`].
    ///
    /// The count must be one the caller made itself. A PDF's `/Count` is a claim the file makes
    /// about itself, and a crafted file can claim anything — which is also why this limit exists:
    /// a page tree of millions of entries is a way to make a viewer allocate without end.
    ///
    /// # Errors
    /// [`SecurityError::TooManyPages`].
    pub const fn check_pages(&self, pages: u32) -> Result<()> {
        if pages > self.max_pages {
            return Err(SecurityError::TooManyPages {
                pages,
                limit: self.max_pages,
            });
        }
        Ok(())
    }

    /// Read a file whole — refusing it *before* reading if it is too large or not an ordinary file.
    ///
    /// The size checks above are applied to bytes already in memory, which is too late for a file
    /// on disk: `std::fs::read` loads the whole thing first, so a 20 GB drawing is read in full
    /// before being refused as over 512 MB, and a device or a pipe is read forever. This is the
    /// order that actually bounds the damage:
    ///
    /// 1. **Not an ordinary file** — refused from its metadata, without opening it.
    /// 2. **Too large by its own account** — refused from its metadata, without reading it.
    /// 3. **Opened, then re-checked through the handle**, so a file swapped for something else
    ///    between being measured and being opened is caught as what it now is.
    /// 4. **Read at most one byte past the limit.** A file can report a size it does not have —
    ///    procfs files report zero and then produce data — or grow while being read. Reading one
    ///    byte beyond the ceiling is enough to know it crossed it, and no more is ever held.
    ///
    /// Residual: a file replaced with a named pipe in the instant between steps 1 and 3 would block
    /// the open. That needs a hostile local user racing the reviewer, which the threat model treats
    /// as out of scope — the adversary here is a hostile *document*.
    ///
    /// # Errors
    /// [`SecurityError::NotAFile`], [`SecurityError::TooLarge`], or [`SecurityError::Unreadable`].
    pub fn read_bounded(path: &Path, limit_mb: u64, subject: &'static str) -> Result<Vec<u8>> {
        let measured = std::fs::metadata(path).map_err(|_| SecurityError::Unreadable)?;
        if !measured.is_file() {
            return Err(SecurityError::NotAFile);
        }
        Self::check_size(measured.len(), limit_mb, subject)?;

        let file = std::fs::File::open(path).map_err(|_| SecurityError::Unreadable)?;
        let opened = file.metadata().map_err(|_| SecurityError::Unreadable)?;
        if !opened.is_file() {
            return Err(SecurityError::NotAFile);
        }
        Self::read_limited(file, opened.len(), limit_mb, subject)
    }

    /// The bounded read itself, over any reader, so a source that lies about its size can be tested
    /// without the filesystem's cooperation.
    ///
    /// # Errors
    /// [`SecurityError::TooLarge`] if more than the limit arrives, or [`SecurityError::Unreadable`].
    pub fn read_limited(
        reader: impl Read,
        size_hint: u64,
        limit_mb: u64,
        subject: &'static str,
    ) -> Result<Vec<u8>> {
        let limit_bytes = limit_mb.saturating_mul(1024 * 1024);
        // The hint is the file's own claim, so it only sizes the buffer; it is never trusted as a
        // bound, and never allowed to reserve more than the ceiling.
        let capacity = usize::try_from(size_hint.min(limit_bytes)).unwrap_or(0);
        let mut bytes = Vec::with_capacity(capacity);
        reader
            .take(limit_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| SecurityError::Unreadable)?;
        Self::check_size(bytes.len() as u64, limit_mb, subject)?;
        Ok(bytes)
    }

    /// Read a drawing from disk within [`ResourceLimits::max_pdf_mb`].
    ///
    /// # Errors
    /// As [`ResourceLimits::read_bounded`].
    pub fn read_pdf(&self, path: &Path) -> Result<Vec<u8>> {
        Self::read_bounded(path, self.max_pdf_mb, "a drawing")
    }

    /// Read an attachment from disk within [`ResourceLimits::max_attachment_mb`].
    ///
    /// # Errors
    /// As [`ResourceLimits::read_bounded`].
    pub fn read_attachment(&self, path: &Path) -> Result<Vec<u8>> {
        Self::read_bounded(path, self.max_attachment_mb, "an attachment")
    }

    /// Read an interchange file — XFDF, a markup set — within
    /// [`ResourceLimits::max_interchange_mb`].
    ///
    /// # Errors
    /// As [`ResourceLimits::read_bounded`].
    pub fn read_interchange(&self, path: &Path) -> Result<Vec<u8>> {
        Self::read_bounded(path, self.max_interchange_mb, "an import file")
    }
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

/// How far into a file the PDF header is allowed to start.
///
/// Zero would be correct by the specification and wrong in practice: real-world PDFs produced by
/// plotters and scanners routinely carry a few junk bytes before `%PDF-`, and every reader accepts
/// them. A small window accepts those without accepting a PDF header buried inside an executable.
const PDF_HEADER_SEARCH_WINDOW: usize = 1_024;

/// Whether these bytes begin a PDF.
///
/// A cheap structural check, not a parse. It exists to fail fast and clearly on the common cases —
/// a renamed `.docx`, a truncated download, an HTML error page saved as `.pdf` — before the file
/// reaches the renderer. The renderer remains the real validator, and it runs off the UI thread
/// inside the same limits.
///
/// # Errors
/// [`SecurityError::NotTheExpectedFormat`] when no header is found in the first
/// [`PDF_HEADER_SEARCH_WINDOW`] bytes.
pub fn validate_pdf_header(bytes: &[u8]) -> Result<()> {
    let window = &bytes[..bytes.len().min(PDF_HEADER_SEARCH_WINDOW)];
    let found = window.windows(5).any(|w| w == b"%PDF-");
    if found {
        Ok(())
    } else {
        Err(SecurityError::NotTheExpectedFormat { expected: "PDF" })
    }
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/// Names Windows refuses to use as a file, at any extension, in any case.
///
/// Checked even on non-Windows builds: a project package written on macOS is expected to open on
/// Windows, and discovering the problem at the point of writing beats discovering it when a
/// colleague cannot open the package.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Join `relative` onto `root` and refuse anything that leaves.
///
/// The only sanctioned way to build a path inside a project package from a value that came from
/// outside — a manifest entry, an archive member name, an IPC payload.
///
/// Rejected: absolute paths, drive letters, UNC prefixes, `..` at any depth, and anything that
/// resolves outside `root` once symbolic links are followed. The traversal check is done on the
/// *components* before touching the filesystem, so a malicious name is refused whether or not the
/// file exists.
///
/// # Errors
/// - [`SecurityError::PathEscape`] if the result would land outside `root`.
/// - [`SecurityError::UnusableName`] for empty, reserved or otherwise unrepresentable names.
pub fn contained_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty() {
        return Err(SecurityError::UnusableName {
            reason: "it is empty",
        });
    }
    // A NUL truncates the path at the OS boundary, so `a\0/../../etc` reaching the syscall as `a`
    // would pass a component check and mean something else entirely.
    if relative.contains('\0') {
        return Err(SecurityError::UnusableName {
            reason: "it contains a null byte",
        });
    }

    // Absolute and drive-qualified forms are rejected here, textually, rather than being left to
    // `Path::components` — because `components` is *platform-dependent*, and this is a container
    // format that travels between platforms.
    //
    // On Windows, `C:\Windows\System32\config\SAM` parses as a prefix plus a root and is caught as
    // an escape. On Linux the same string parses as a single, oddly-named file: no prefix, no
    // root, nothing to catch. A package crafted on one platform would then mean something
    // different when opened on the other, which is exactly the divergence an attacker looks for.
    // So the check is on the text, and it is the same everywhere.
    let bytes = relative.as_bytes();
    let drive_qualified = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if relative.starts_with('/') || drive_qualified {
        return Err(SecurityError::PathEscape);
    }
    // For the same reason, `/` is the only separator inside a package. A backslash anywhere is
    // either a Windows path in disguise — including a UNC prefix — or a name Windows cannot
    // represent. Both are refused.
    if relative.contains('\\') {
        return Err(SecurityError::PathEscape);
    }

    let candidate = Path::new(relative);
    let mut named_something = false;
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let name = part.to_str().ok_or(SecurityError::UnusableName {
                    reason: "it is not valid Unicode",
                })?;
                check_name(name)?;
                named_something = true;
            }
            // Everything else is either an escape or an absolute anchor.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SecurityError::PathEscape)
            }
            // `./` is harmless and is simply skipped.
            Component::CurDir => {}
        }
    }

    // `.` and `./` walk to the package directory itself. Nothing inside a package should ever name
    // the package, and a caller that then opens the result for writing is asking the platform to
    // replace a directory with a file. Found by a property test rather than by imagination.
    if !named_something {
        return Err(SecurityError::UnusableName {
            reason: "it names the project folder rather than a file inside it",
        });
    }

    let joined = root.join(candidate);

    // The component check above catches textual traversal. This second pass catches the case it
    // cannot see: a symlink already inside the package that points out of it. It only applies when
    // the path exists, which is correct — a path being created cannot yet be a link.
    if joined.exists() {
        let resolved_root = root.canonicalize().map_err(|_| SecurityError::PathEscape)?;
        let resolved = joined
            .canonicalize()
            .map_err(|_| SecurityError::PathEscape)?;
        if !resolved.starts_with(&resolved_root) {
            return Err(SecurityError::PathEscape);
        }
    }

    Ok(joined)
}

/// Whether one path segment is usable as a filename on every supported platform.
///
/// # Errors
/// [`SecurityError::UnusableName`] naming the specific problem.
pub fn check_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(SecurityError::UnusableName {
            reason: "it is empty",
        });
    }
    // 255 is the per-component limit on NTFS, APFS and ext4 alike.
    if name.len() > 255 {
        return Err(SecurityError::UnusableName {
            reason: "it is longer than 255 characters",
        });
    }
    // Separators are on the list too: a single path *component* containing one is either a path in
    // disguise or a name that means something different on another platform.
    if name.chars().any(|c| {
        matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/') || (c as u32) < 0x20
    }) {
        return Err(SecurityError::UnusableName {
            reason: "it contains a character Windows reserves",
        });
    }
    // Windows silently strips a trailing dot or space, so `report.` and `report` become the same
    // file — which is how two distinct manifest entries end up overwriting one another.
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(SecurityError::UnusableName {
            reason: "it ends with a dot or a space",
        });
    }
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(SecurityError::UnusableName {
            reason: "it is a name Windows reserves for a device",
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/// Something a user may or may not be allowed to do.
///
/// About *acts*, not about interface. Editing your own markup and editing a colleague's are
/// separate capabilities because on a review they are separate acts, and conflating them is how a
/// subcontractor ends up able to silently reword the architect's comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    /// Open and read a project.
    ProjectRead,
    /// Change project settings.
    ProjectManage,
    /// Bring a new drawing or revision into the project.
    DocumentImport,
    /// Raise a markup.
    MarkupCreate,
    /// Change a markup you raised.
    MarkupEditOwn,
    /// Change somebody else's markup.
    MarkupEditOthers,
    /// Delete a markup you raised.
    MarkupDeleteOwn,
    /// Delete somebody else's markup.
    MarkupDeleteOthers,
    /// Move a markup through the review workflow.
    MarkupStatus,
    /// Set or change a page's scale. Governs every quantity on that page.
    Calibrate,
    /// Produce a PDF, CSV, XFDF or BCF export.
    Export,
    /// Bring markups in from an interchange file.
    Import,
    /// Read the audit trail.
    AuditRead,
}

impl Capability {
    /// A phrase that completes "your role does not allow …".
    #[must_use]
    pub const fn describe(self) -> &'static str {
        match self {
            Self::ProjectRead => "opening this project",
            Self::ProjectManage => "changing project settings",
            Self::DocumentImport => "adding drawings",
            Self::MarkupCreate => "adding markups",
            Self::MarkupEditOwn => "editing your markups",
            Self::MarkupEditOthers => "editing other people's markups",
            Self::MarkupDeleteOwn => "deleting your markups",
            Self::MarkupDeleteOthers => "deleting other people's markups",
            Self::MarkupStatus => "changing markup status",
            Self::Calibrate => "setting the drawing scale",
            Self::Export => "exporting",
            Self::Import => "importing markups",
            Self::AuditRead => "reading the audit trail",
        }
    }
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.describe())
    }
}

/// A named bundle of capabilities.
///
/// Roles are coarse on purpose. A construction organisation's real permission model lives in its
/// own directory; what a desktop application needs is a small set that maps onto how a review
/// actually divides, and a seam where a managed deployment can substitute its own answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// One person, their own machine, their own files. Everything is allowed.
    #[default]
    Owner,
    /// Runs the review: may edit and delete anyone's markups.
    Lead,
    /// Raises and works their own markups; may not touch a colleague's.
    Reviewer,
    /// Reads and exports. The role a client or a subcontractor gets on an issued set.
    Observer,
}

impl Role {
    /// Whether this role holds a capability.
    #[must_use]
    pub const fn allows(self, capability: Capability) -> bool {
        use Capability as C;
        match self {
            Self::Owner => true,
            Self::Lead => !matches!(capability, C::ProjectManage),
            Self::Reviewer => matches!(
                capability,
                C::ProjectRead
                    | C::MarkupCreate
                    | C::MarkupEditOwn
                    | C::MarkupDeleteOwn
                    | C::MarkupStatus
                    | C::Calibrate
                    | C::Export
                    | C::Import
            ),
            Self::Observer => matches!(capability, C::ProjectRead | C::Export),
        }
    }

    /// Assert a capability.
    ///
    /// # Errors
    /// [`SecurityError::NotPermitted`] carrying the capability, so the refusal can be shown to the
    /// user and written to the audit trail with a reason rather than as a bare denial.
    pub fn require(self, capability: Capability) -> Result<()> {
        if self.allows(capability) {
            Ok(())
        } else {
            Err(SecurityError::NotPermitted(capability))
        }
    }

    /// The capability needed to edit a markup, given who raised it.
    #[must_use]
    pub fn edit_capability(authored_by_self: bool) -> Capability {
        if authored_by_self {
            Capability::MarkupEditOwn
        } else {
            Capability::MarkupEditOthers
        }
    }

    /// The capability needed to delete a markup, given who raised it.
    #[must_use]
    pub fn delete_capability(authored_by_self: bool) -> Capability {
        if authored_by_self {
            Capability::MarkupDeleteOwn
        } else {
            Capability::MarkupDeleteOthers
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- limits ----------------------------------------------------------

    #[test]
    fn a_file_at_exactly_the_limit_is_accepted() {
        let limits = ResourceLimits::default();
        assert!(limits.check_pdf(limits.max_pdf_mb * 1024 * 1024).is_ok());
        assert!(limits
            .check_pdf(limits.max_pdf_mb * 1024 * 1024 + 1)
            .is_err());
    }

    #[test]
    fn an_oversized_file_is_refused_with_both_numbers_in_the_message() {
        let limits = ResourceLimits::default();
        let err = limits.check_attachment(200 * 1024 * 1024).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("200 MB") && message.contains("64 MB"),
            "got: {message}"
        );
    }

    #[test]
    fn the_reported_size_rounds_up_so_it_never_equals_the_limit() {
        // A 512.4 MB file must not report "512 MB, over the 512 MB limit".
        let err = ResourceLimits::check_size(512 * 1024 * 1024 + 1, 512, "a drawing").unwrap_err();
        assert_eq!(
            err,
            SecurityError::TooLarge {
                subject: "a drawing",
                actual_mb: 513,
                limit_mb: 512
            }
        );
    }

    #[test]
    fn an_absurd_limit_does_not_overflow_into_accepting_nothing() {
        assert!(ResourceLimits::check_size(u64::MAX, u64::MAX, "x").is_ok());
    }

    #[test]
    fn the_defaults_are_the_documented_ones() {
        // These numbers are quoted in the security documentation and in the enterprise policy
        // surface, so a silent change to one is a documentation defect too.
        let limits = ResourceLimits::default();
        assert_eq!(limits.max_pdf_mb, 512);
        assert_eq!(limits.max_attachment_mb, 64);
        assert_eq!(limits.max_pages, 10_000);
        assert_eq!(limits.max_concurrent_jobs, 4);
    }

    // ---- format ----------------------------------------------------------

    #[test]
    fn a_pdf_is_recognised() {
        assert!(validate_pdf_header(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n").is_ok());
    }

    #[test]
    fn a_header_after_a_little_junk_is_still_accepted() {
        // Real plotters and scanners emit these, and every other reader accepts them.
        let mut bytes = vec![b'\n'; 300];
        bytes.extend_from_slice(b"%PDF-1.4");
        assert!(validate_pdf_header(&bytes).is_ok());
    }

    #[test]
    fn a_header_buried_deep_in_the_file_is_not_accepted() {
        let mut bytes = vec![0u8; PDF_HEADER_SEARCH_WINDOW * 2];
        bytes.extend_from_slice(b"%PDF-1.4");
        assert!(
            validate_pdf_header(&bytes).is_err(),
            "an executable with a PDF string inside is not a PDF"
        );
    }

    #[test]
    fn things_that_are_not_pdfs_are_refused() {
        assert!(validate_pdf_header(b"").is_err());
        assert!(
            validate_pdf_header(b"PK\x03\x04").is_err(),
            "a renamed docx or zip"
        );
        assert!(
            validate_pdf_header(b"<!DOCTYPE html><title>404</title>").is_err(),
            "a saved error page"
        );
        assert!(validate_pdf_header(b"MZ\x90\x00").is_err(), "an executable");
        assert!(validate_pdf_header(b"%PDF").is_err(), "a truncated header");
    }

    // ---- paths -----------------------------------------------------------

    fn root() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            r"C:\projects\riverside.sfproj"
        } else {
            "/projects/riverside.sfproj"
        })
    }

    #[test]
    fn an_ordinary_relative_path_joins() {
        let path = contained_path(&root(), "sources/ab12cd.pdf").unwrap();
        assert!(path.starts_with(root()));
        assert!(path.ends_with("ab12cd.pdf"));
    }

    #[test]
    fn traversal_is_refused_at_every_depth() {
        for attempt in [
            "../secrets.txt",
            "sources/../../secrets.txt",
            "sources/../../../../../../etc/passwd",
            "..",
            "a/b/c/../../../../x",
        ] {
            assert_eq!(
                contained_path(&root(), attempt),
                Err(SecurityError::PathEscape),
                "{attempt} must be refused"
            );
        }
    }

    #[test]
    fn an_absolute_path_is_refused_even_when_it_points_inside() {
        // A manifest entry naming an absolute path is always a bug or an attack; the package is
        // relocatable, so nothing inside it may depend on where it currently sits.
        assert_eq!(
            contained_path(&root(), "/etc/passwd"),
            Err(SecurityError::PathEscape)
        );
        assert_eq!(
            contained_path(&root(), r"C:\Windows\System32\config\SAM"),
            Err(SecurityError::PathEscape)
        );
        assert_eq!(
            contained_path(&root(), r"\\fileserver\share\x.pdf"),
            Err(SecurityError::PathEscape)
        );
    }

    #[test]
    fn windows_path_syntax_is_refused_identically_on_every_platform() {
        // The regression this exists for. `Path::components` disagrees across platforms about what
        // these strings are, so the check cannot be delegated to it: a package crafted on Windows
        // must not mean something different when opened on Linux, where `C:\...` is not an
        // absolute path at all but one oddly-named file.
        for attempt in [
            r"C:\Windows\System32\config\SAM",
            r"c:/Windows/System32",
            r"\\fileserver\share\x.pdf",
            r"sources\..\..\secrets.txt",
            r"sources\a.pdf",
        ] {
            assert_eq!(
                contained_path(&root(), attempt),
                Err(SecurityError::PathEscape),
                "{attempt} must be refused on every platform, not only on Windows",
            );
        }
    }

    #[test]
    fn a_leading_current_directory_is_harmless() {
        assert!(contained_path(&root(), "./sources/a.pdf").is_ok());
    }

    #[test]
    fn a_null_byte_is_refused_before_it_reaches_the_syscall() {
        // Without this, `a\0/../../etc/passwd` arrives at the OS truncated to `a` after passing a
        // component check that saw something else.
        let err = contained_path(&root(), "sources/a\0/../../etc/passwd").unwrap_err();
        assert!(matches!(err, SecurityError::UnusableName { .. }));
    }

    #[test]
    fn an_empty_relative_path_is_refused() {
        assert!(contained_path(&root(), "").is_err());
    }

    #[test]
    fn a_symlink_pointing_out_of_the_package_is_refused() {
        // The case the component check cannot see. Skipped where the platform will not let an
        // unprivileged process create a link — on Windows that needs Developer Mode.
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
            eprintln!("skipped: this platform does not permit creating symlinks unprivileged");
            return;
        }
        assert_eq!(
            contained_path(&package, "sources/escape/secret.txt"),
            Err(SecurityError::PathEscape)
        );
    }

    #[test]
    fn windows_device_names_are_refused_on_every_platform() {
        // A package written on macOS has to open on Windows.
        for name in ["CON", "con", "NUL.pdf", "com1", "LPT9.txt", "aux"] {
            assert!(check_name(name).is_err(), "{name} must be refused");
        }
        assert!(
            check_name("CONTRACT.pdf").is_ok(),
            "only the exact stem is reserved"
        );
        assert!(check_name("A-201.pdf").is_ok());
    }

    #[test]
    fn names_windows_would_silently_alter_are_refused() {
        // Windows strips these, so `report.` and `report` become one file and one manifest entry
        // overwrites the other.
        assert!(check_name("report.").is_err());
        assert!(check_name("report ").is_err());
    }

    #[test]
    fn characters_windows_reserves_are_refused() {
        for name in ["a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b", "a\u{1}b"] {
            assert!(check_name(name).is_err(), "{name:?} must be refused");
        }
    }

    #[test]
    fn an_over_long_component_is_refused() {
        assert!(check_name(&"x".repeat(255)).is_ok());
        assert!(check_name(&"x".repeat(256)).is_err());
    }

    #[test]
    fn unicode_names_are_accepted() {
        // Construction jobs are international; refusing these would be a bug, not a defence.
        assert!(check_name("平面図-A201.pdf").is_ok());
        assert!(check_name("Grundriß.pdf").is_ok());
    }

    // ---- capabilities ----------------------------------------------------

    #[test]
    fn an_owner_may_do_everything() {
        for capability in ALL_CAPABILITIES {
            assert!(
                Role::Owner.allows(capability),
                "owner must hold {capability:?}"
            );
        }
    }

    #[test]
    fn an_observer_may_only_read_and_export() {
        assert!(Role::Observer.allows(Capability::ProjectRead));
        assert!(Role::Observer.allows(Capability::Export));
        for capability in [
            Capability::MarkupCreate,
            Capability::MarkupEditOwn,
            Capability::MarkupStatus,
            Capability::Calibrate,
            Capability::DocumentImport,
            Capability::Import,
        ] {
            assert!(
                !Role::Observer.allows(capability),
                "observer must not hold {capability:?}"
            );
        }
    }

    #[test]
    fn a_reviewer_may_edit_their_own_work_and_not_a_colleagues() {
        assert!(Role::Reviewer.allows(Capability::MarkupEditOwn));
        assert!(!Role::Reviewer.allows(Capability::MarkupEditOthers));
        assert!(Role::Reviewer.allows(Capability::MarkupDeleteOwn));
        assert!(!Role::Reviewer.allows(Capability::MarkupDeleteOthers));
    }

    #[test]
    fn a_lead_may_edit_a_colleagues_markup_but_not_reconfigure_the_project() {
        assert!(Role::Lead.allows(Capability::MarkupEditOthers));
        assert!(Role::Lead.allows(Capability::MarkupDeleteOthers));
        assert!(!Role::Lead.allows(Capability::ProjectManage));
    }

    #[test]
    fn authorship_selects_which_capability_is_required() {
        assert_eq!(Role::edit_capability(true), Capability::MarkupEditOwn);
        assert_eq!(Role::edit_capability(false), Capability::MarkupEditOthers);
        assert_eq!(Role::delete_capability(true), Capability::MarkupDeleteOwn);
        assert_eq!(
            Role::delete_capability(false),
            Capability::MarkupDeleteOthers
        );
    }

    #[test]
    fn a_refusal_carries_a_reason_a_user_can_read() {
        let err = Role::Observer
            .require(Capability::MarkupCreate)
            .unwrap_err();
        assert_eq!(err.to_string(), "your role does not allow adding markups");
    }

    #[test]
    fn no_error_message_leaks_a_path_or_a_filename() {
        // These strings reach logs, the UI and diagnostic bundles.
        let errors = [
            SecurityError::PathEscape,
            SecurityError::UnusableName {
                reason: "it is empty",
            },
            SecurityError::NotTheExpectedFormat { expected: "PDF" },
            SecurityError::TooLarge {
                subject: "a drawing",
                actual_mb: 900,
                limit_mb: 512,
            },
            SecurityError::NotPermitted(Capability::Export),
        ];
        for error in errors {
            let message = error.to_string();
            assert!(
                !message.contains('\\') && !message.contains('/'),
                "path-like content in: {message}"
            );
            assert!(!message.contains(".pdf"), "filename in: {message}");
        }
    }

    const ALL_CAPABILITIES: [Capability; 13] = [
        Capability::ProjectRead,
        Capability::ProjectManage,
        Capability::DocumentImport,
        Capability::MarkupCreate,
        Capability::MarkupEditOwn,
        Capability::MarkupEditOthers,
        Capability::MarkupDeleteOwn,
        Capability::MarkupDeleteOthers,
        Capability::MarkupStatus,
        Capability::Calibrate,
        Capability::Export,
        Capability::Import,
        Capability::AuditRead,
    ];

    #[test]
    fn a_document_at_the_page_ceiling_is_accepted_and_one_more_is_refused() {
        let limits = ResourceLimits {
            max_pages: 10,
            ..ResourceLimits::default()
        };
        assert!(limits.check_pages(10).is_ok());
        assert_eq!(
            limits.check_pages(11),
            Err(SecurityError::TooManyPages {
                pages: 11,
                limit: 10
            })
        );
    }

    // ---- reading from disk -----------------------------------------------

    const MB: usize = 1024 * 1024;

    fn file_of(dir: &tempfile::TempDir, name: &str, len: usize) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, vec![0x25_u8; len]).unwrap();
        path
    }

    #[test]
    fn an_ordinary_file_within_the_limit_is_read_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_of(&dir, "small.pdf", 1000);
        let bytes = ResourceLimits::read_bounded(&path, 1, "a drawing").unwrap();
        assert_eq!(bytes.len(), 1000);
    }

    #[test]
    fn exactly_the_limit_is_read_and_one_byte_more_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let at = file_of(&dir, "at.pdf", MB);
        let over = file_of(&dir, "over.pdf", MB + 1);
        assert_eq!(
            ResourceLimits::read_bounded(&at, 1, "a drawing")
                .unwrap()
                .len(),
            MB
        );
        assert!(matches!(
            ResourceLimits::read_bounded(&over, 1, "a drawing"),
            Err(SecurityError::TooLarge {
                actual_mb: 2,
                limit_mb: 1,
                ..
            })
        ));
    }

    #[test]
    fn a_directory_is_refused_as_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            ResourceLimits::read_bounded(dir.path(), 1, "a drawing"),
            Err(SecurityError::NotAFile)
        );
    }

    /// The case that motivated this. `std::fs::read("/dev/zero")` never returns: it reads zeros
    /// until memory runs out. Refused from its metadata, it returns at once — so this test would
    /// hang, not fail, if the check were ever removed, which is still a failure CI will notice.
    #[cfg(unix)]
    #[test]
    fn a_device_is_refused_without_being_read() {
        assert_eq!(
            ResourceLimits::read_bounded(Path::new("/dev/zero"), 1, "a drawing"),
            Err(SecurityError::NotAFile)
        );
    }

    #[test]
    fn a_missing_file_is_unreadable_and_the_message_names_no_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("private-client-name.pdf");
        let error = ResourceLimits::read_bounded(&missing, 1, "a drawing").unwrap_err();
        assert_eq!(error, SecurityError::Unreadable);
        assert!(!error.to_string().contains("private-client-name"));
    }

    /// A source that claims to be empty and never ends — what a procfs file or a file growing
    /// under the reader looks like. Stopped one byte past the ceiling, never read to exhaustion.
    #[test]
    fn a_source_that_lies_about_its_size_is_stopped_at_the_limit() {
        let endless = std::io::repeat(0);
        assert!(matches!(
            ResourceLimits::read_limited(endless, 0, 1, "an import file"),
            Err(SecurityError::TooLarge { limit_mb: 1, .. })
        ));
    }

    /// A size hint is the file's own claim. An absurd one must not reserve memory on its say-so.
    #[test]
    fn an_absurd_size_hint_does_not_reserve_memory() {
        let bytes =
            ResourceLimits::read_limited(&b"small"[..], u64::MAX, 1, "an import file").unwrap();
        assert_eq!(bytes, b"small");
        assert!(bytes.capacity() <= MB);
    }

    #[test]
    fn each_kind_of_file_reads_against_its_own_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        let limits = ResourceLimits {
            max_pdf_mb: 3,
            max_attachment_mb: 2,
            max_interchange_mb: 1,
            ..ResourceLimits::default()
        };
        let two_and_a_bit = file_of(&dir, "f", 2 * MB + 1);
        assert!(limits.read_pdf(&two_and_a_bit).is_ok());
        assert!(limits.read_attachment(&two_and_a_bit).is_err());
        assert!(limits.read_interchange(&two_and_a_bit).is_err());
    }
}
