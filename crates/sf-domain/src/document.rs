//! Source documents and their revisions.
//!
//! The governing distinction in this module is between the *document* — "sheet A-201", a thing that
//! exists across the life of the job — and the *revision* — "the issue of A-201 dated 14 March,
//! whose bytes hash to `a3f1…`". Markups attach to a revision. That is what makes it possible to
//! say later that a comment was raised against Rev C and to migrate it forward deliberately,
//! rather than have it float over whichever PDF happens to be loaded.
//!
//! Source bytes are never modified. A markup is a separate record that refers to a revision by id;
//! the PDF on disk stays byte-identical to what the architect issued, which is the only version of
//! events a contract dispute will accept.

use crate::error::{bounded_text, optional_text};
use crate::ids::{ActorId, DocumentRevisionId, ProjectId, SourceDocumentId};
use crate::{DomainError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A SHA-256 of a file's bytes, used as its identity.
///
/// Content addressing rather than a path: the same drawing arrives twice under two different
/// filenames on a normal job, and storing it twice wastes space while storing it once under a
/// name that means something is a lie. The hash is also the integrity check — a package that has
/// been edited on disk fails to verify rather than opening with silently altered drawings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    /// Wrap raw digest bytes.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// The raw digest.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lower-case hex, 64 characters. This is the on-disk filename inside a package.
    #[must_use]
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse from hex.
    ///
    /// # Errors
    /// If the string is not exactly 64 lower-case hex characters.
    pub fn from_hex(value: &str) -> Result<Self> {
        // Rejecting upper case rather than accepting it: one spelling means a filename built from
        // a hash always matches the file already on disk, on a case-sensitive filesystem too.
        let hex_lower = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
        if value.len() != 64 || !value.bytes().all(hex_lower) {
            return Err(DomainError::Malformed {
                subject: "content hash",
            });
        }
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(value, &mut bytes).map_err(|_| DomainError::Malformed {
            subject: "content hash",
        })?;
        Ok(Self(bytes))
    }

    /// The first 12 hex characters — enough to tell two revisions apart in a log line without
    /// putting a full identifier in front of a user.
    #[must_use]
    pub fn short(&self) -> String {
        self.to_hex()[..12].to_owned()
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl TryFrom<String> for ContentHash {
    type Error = DomainError;
    fn try_from(value: String) -> Result<Self> {
        Self::from_hex(&value)
    }
}

impl From<ContentHash> for String {
    fn from(value: ContentHash) -> Self {
        value.to_hex()
    }
}

/// The logical document — the thing a sheet number names, across every issue of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDocument {
    /// Stable across re-issues.
    pub id: SourceDocumentId,
    /// Which project it belongs to.
    pub project_id: ProjectId,
    /// The sheet number or document name as the job knows it, e.g. `A-201`.
    pub name: String,
    /// Discipline or set the sheet belongs to, when known.
    pub discipline: Option<String>,
    /// When this document was first seen.
    pub created_at: DateTime<Utc>,
}

impl SourceDocument {
    /// Longest accepted document name.
    pub const MAX_NAME: usize = 200;

    /// Create one, validating its name.
    ///
    /// # Errors
    /// If the name is blank or over [`SourceDocument::MAX_NAME`].
    pub fn new(project_id: ProjectId, name: &str, discipline: Option<&str>) -> Result<Self> {
        Ok(Self {
            id: SourceDocumentId::new(),
            project_id,
            name: bounded_text(name, "document name", Self::MAX_NAME)?,
            discipline: optional_text(discipline, "discipline", 64)?,
            created_at: crate::now(),
        })
    }
}

/// One imported issue of a source document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentRevision {
    /// This revision.
    pub id: DocumentRevisionId,
    /// Its project.
    pub project_id: ProjectId,
    /// The document it is an issue of.
    pub source_document_id: SourceDocumentId,
    /// The revision as printed in the title block — `C`, `3`, `IFC`. Absent when the sheet
    /// carries none, which is common on early issues and on sketches.
    pub revision_label: Option<String>,
    /// SHA-256 of the PDF bytes. The revision's real identity.
    pub content_sha256: ContentHash,
    /// Size in bytes of the source file, recorded so a package can be sanity-checked without
    /// rehashing every drawing in it.
    pub byte_len: u64,
    /// How many pages the PDF reported when it was imported.
    pub page_count: u32,
    /// When it entered this project.
    pub imported_at: DateTime<Utc>,
    /// Who imported it.
    pub imported_by: ActorId,
}

impl DocumentRevision {
    /// A hard ceiling on pages in one imported file.
    ///
    /// Not a performance limit — the viewer is lazy and handles long sets — but a hostile-input
    /// bound. A crafted PDF can claim an enormous page tree, and anything that allocates per page
    /// before rendering needs a number to refuse at.
    pub const MAX_PAGES: u32 = 10_000;

    /// Record an import.
    ///
    /// # Errors
    /// If the file claims zero pages or more than [`DocumentRevision::MAX_PAGES`], or if the
    /// revision label is over-long.
    pub fn new(
        project_id: ProjectId,
        source_document_id: SourceDocumentId,
        revision_label: Option<&str>,
        content_sha256: ContentHash,
        byte_len: u64,
        page_count: u32,
        imported_by: ActorId,
    ) -> Result<Self> {
        if page_count == 0 {
            return Err(DomainError::OutOfRange {
                field: "page_count",
                reason: "the file reports no pages, so there is nothing to review".into(),
            });
        }
        if page_count > Self::MAX_PAGES {
            return Err(DomainError::OutOfRange {
                field: "page_count",
                reason: format!(
                    "{page_count} pages exceeds the {} page import limit",
                    Self::MAX_PAGES
                ),
            });
        }
        Ok(Self {
            id: DocumentRevisionId::new(),
            project_id,
            source_document_id,
            revision_label: optional_text(revision_label, "revision label", 32)?,
            content_sha256,
            byte_len,
            page_count,
            imported_at: crate::now(),
            imported_by,
        })
    }

    /// A short, non-sensitive way to name this revision in a log or an error.
    ///
    /// Deliberately not the filename: filenames on a construction job routinely carry the client,
    /// the project and sometimes a person's name, none of which belongs in a diagnostic bundle.
    #[must_use]
    pub fn diagnostic_ref(&self) -> String {
        match &self.revision_label {
            Some(label) => format!("rev {label} ({})", self.content_sha256.short()),
            None => format!("rev ({})", self.content_sha256.short()),
        }
    }

    /// Whether a page number is inside this revision. Pages are 1-based, as they are printed.
    #[must_use]
    pub const fn has_page(&self, page: u32) -> bool {
        page >= 1 && page <= self.page_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash_of(byte: u8) -> ContentHash {
        ContentHash::from_bytes([byte; 32])
    }

    fn a_revision(page_count: u32) -> Result<DocumentRevision> {
        DocumentRevision::new(
            ProjectId::new(),
            SourceDocumentId::new(),
            Some("C"),
            hash_of(0xab),
            1024,
            page_count,
            ActorId::local(),
        )
    }

    #[test]
    fn a_hash_round_trips_through_hex() {
        let hash = hash_of(0x0f);
        assert_eq!(hash.to_hex().len(), 64);
        assert_eq!(ContentHash::from_hex(&hash.to_hex()).unwrap(), hash);
    }

    #[test]
    fn hashes_are_lower_case_only() {
        let lower = "ab".repeat(32);
        assert!(ContentHash::from_hex(&lower).is_ok());
        assert!(
            ContentHash::from_hex(&lower.to_uppercase()).is_err(),
            "one spelling, so a filename built from a hash matches the file on disk",
        );
    }

    #[test]
    fn a_wrong_length_hash_is_refused() {
        assert!(ContentHash::from_hex("").is_err());
        assert!(ContentHash::from_hex(&"ab".repeat(31)).is_err());
        assert!(ContentHash::from_hex(&"ab".repeat(33)).is_err());
        assert!(
            ContentHash::from_hex(&"zz".repeat(32)).is_err(),
            "non-hex characters"
        );
    }

    #[test]
    fn a_hash_serialises_as_hex_not_as_a_byte_array() {
        // It lands in manifest.json, where a 32-element array of integers would be unreadable
        // and would not match the filename it names.
        let hash = hash_of(0x01);
        assert_eq!(
            serde_json::to_string(&hash).unwrap(),
            format!("\"{}\"", hash.to_hex())
        );
        let back: ContentHash = serde_json::from_str(&format!("\"{}\"", hash.to_hex())).unwrap();
        assert_eq!(back, hash);
    }

    #[test]
    fn a_manifest_carrying_a_corrupt_hash_fails_to_parse() {
        assert!(serde_json::from_str::<ContentHash>("\"deadbeef\"").is_err());
    }

    #[test]
    fn an_empty_document_is_refused_with_a_reason_a_user_can_act_on() {
        let err = a_revision(0).unwrap_err();
        assert!(err.to_string().contains("no pages"), "got: {err}");
    }

    #[test]
    fn an_absurd_page_count_is_refused() {
        assert!(a_revision(DocumentRevision::MAX_PAGES).is_ok());
        assert!(a_revision(DocumentRevision::MAX_PAGES + 1).is_err());
    }

    #[test]
    fn page_bounds_are_one_based() {
        let revision = a_revision(3).unwrap();
        assert!(
            !revision.has_page(0),
            "there is no page zero on a drawing set"
        );
        assert!(revision.has_page(1) && revision.has_page(3));
        assert!(!revision.has_page(4));
    }

    #[test]
    fn a_diagnostic_reference_carries_no_filename() {
        let revision = a_revision(1).unwrap();
        let reference = revision.diagnostic_ref();
        assert!(reference.contains("rev C"));
        assert!(reference.contains(&revision.content_sha256.short()));
        assert!(
            reference.len() < 40,
            "short enough for a log line: {reference}"
        );
    }

    #[test]
    fn a_document_name_is_required() {
        assert!(SourceDocument::new(ProjectId::new(), "   ", None).is_err());
        let doc =
            SourceDocument::new(ProjectId::new(), "  A-201  ", Some(" Architectural ")).unwrap();
        assert_eq!(doc.name, "A-201");
        assert_eq!(doc.discipline.as_deref(), Some("Architectural"));
    }
}
