//! The domain's failure vocabulary.
//!
//! Every variant names something a construction reviewer could actually hit, because an error a
//! user cannot act on is a support ticket. Nothing here carries document content or a filesystem
//! path — these strings reach logs and the UI, and both are places customer drawings must not go.

use thiserror::Error;

/// Something the domain refused to do.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum DomainError {
    /// A field that must carry meaning was blank or whitespace.
    #[error("{field} must not be empty")]
    Empty {
        /// Which field.
        field: &'static str,
    },

    /// A field exceeded its bound. Bounds exist so a hostile import cannot balloon the store.
    #[error("{field} is longer than the {max} character limit")]
    TooLong {
        /// Which field.
        field: &'static str,
        /// The inclusive maximum.
        max: usize,
    },

    /// A status move the workflow does not permit.
    #[error("a markup cannot go from {from} to {to}")]
    IllegalTransition {
        /// Current status.
        from: &'static str,
        /// Requested status.
        to: &'static str,
    },

    /// An optimistic-concurrency check failed: someone else wrote first.
    #[error(
        "this markup was changed by someone else (expected version {expected}, found {found})"
    )]
    VersionConflict {
        /// The version the edit was made against.
        expected: u64,
        /// The version actually stored.
        found: u64,
    },

    /// A content hash did not match what the manifest recorded.
    #[error("content integrity check failed for {subject}")]
    IntegrityFailure {
        /// What failed — a source document, an attachment, the audit chain.
        subject: &'static str,
    },

    /// A value was outside the range the model allows.
    #[error("{field} is out of range: {reason}")]
    OutOfRange {
        /// Which field.
        field: &'static str,
        /// Why, in words a user can act on.
        reason: String,
    },

    /// A parse that had a defined grammar and did not match it.
    #[error("{subject} is not in a form this version understands")]
    Malformed {
        /// What was being parsed.
        subject: &'static str,
    },
}

/// The domain's result alias.
pub type Result<T> = std::result::Result<T, DomainError>;

/// Trim, reject blank, and enforce a maximum length.
///
/// Used at every boundary where user text enters the model. Trimming first means a subject of
/// `"   "` is rejected as empty rather than stored as three spaces that no filter will ever match.
///
/// # Errors
/// [`DomainError::Empty`] if the value is blank, [`DomainError::TooLong`] if it exceeds `max`.
pub fn bounded_text(value: &str, field: &'static str, max: usize) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DomainError::Empty { field });
    }
    // Count characters, not bytes: a 60-character Japanese subject is not "too long" merely
    // because it is 180 bytes.
    if trimmed.chars().count() > max {
        return Err(DomainError::TooLong { field, max });
    }
    Ok(trimmed.to_owned())
}

/// The same bound, but an absent or blank value is simply `None` rather than an error.
///
/// # Errors
/// [`DomainError::TooLong`] if a present, non-blank value exceeds `max`.
pub fn optional_text(
    value: Option<&str>,
    field: &'static str,
    max: usize,
) -> Result<Option<String>> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) => bounded_text(text, field, max).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_whitespace_are_both_empty() {
        assert_eq!(
            bounded_text("", "subject", 10),
            Err(DomainError::Empty { field: "subject" })
        );
        assert_eq!(
            bounded_text("   ", "subject", 10),
            Err(DomainError::Empty { field: "subject" })
        );
    }

    #[test]
    fn text_is_trimmed_before_it_is_measured() {
        assert_eq!(bounded_text("  ok  ", "subject", 2).unwrap(), "ok");
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        // Four characters, twelve bytes. A byte-based check would reject this.
        assert!(bounded_text("設備調整済み", "subject", 6).is_ok());
        assert_eq!(
            bounded_text("設備調整済みだ", "subject", 6),
            Err(DomainError::TooLong {
                field: "subject",
                max: 6
            }),
        );
    }

    #[test]
    fn optional_text_treats_blank_as_absent() {
        assert_eq!(optional_text(Some("  "), "cost_code", 10).unwrap(), None);
        assert_eq!(optional_text(None, "cost_code", 10).unwrap(), None);
        assert_eq!(
            optional_text(Some(" 03 30 00 "), "cost_code", 10).unwrap(),
            Some("03 30 00".into())
        );
    }
}
