//! Identifiers.
//!
//! Every id is UUIDv7 rather than v4. The difference matters for a local SQLite store: v7 embeds a
//! millisecond timestamp in its high bits, so ids sort chronologically and index inserts land at
//! the right-hand edge of the B-tree instead of scattering across it. On a set with a hundred
//! thousand markups that is the difference between an append and a page split per row.
//!
//! They are newtypes rather than bare `Uuid` because a project id and a markup id are both 16
//! bytes and passing one where the other belongs compiles perfectly.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// Mint a new id from the current time.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            /// Wrap an existing UUID — for rows read back out of the store.
            #[must_use]
            pub const fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            /// The underlying UUID.
            #[must_use]
            pub const fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                // Hyphenated lower-case, always. One canonical spelling means a string comparison
                // in a log or an export is never a false negative.
                fmt::Display::fmt(&self.0.as_hyphenated(), f)
            }
        }

        impl std::str::FromStr for $name {
            type Err = crate::DomainError;
            fn from_str(s: &str) -> crate::Result<Self> {
                Uuid::parse_str(s)
                    .map(Self)
                    .map_err(|_| crate::DomainError::Malformed { subject: stringify!($name) })
            }
        }
    };
}

id_type!(
    /// A project.
    ProjectId
);
id_type!(
    /// One imported issue of one source document. Never reused across a re-issue.
    DocumentRevisionId
);
id_type!(
    /// The logical document a revision is an issue *of* — stable across re-issues.
    SourceDocumentId
);
id_type!(
    /// A markup record.
    MarkupId
);
id_type!(
    /// One page's scale calibration.
    CalibrationId
);

/// Who acted.
///
/// A string rather than a UUID because the authority for identity is the host's directory, not this
/// application, and a local single-user install has no directory at all. What the domain needs is a
/// stable, comparable, non-empty label to put on a record and in the audit trail.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ActorId(String);

impl ActorId {
    /// Longest actor label accepted. Generous for a UPN or an email, bounded against an import
    /// that tries to write a megabyte into every row.
    pub const MAX_LEN: usize = 256;

    /// Validate and wrap.
    ///
    /// # Errors
    /// If the label is blank or longer than [`ActorId::MAX_LEN`].
    pub fn new(value: &str) -> crate::Result<Self> {
        crate::error::bounded_text(value, "actor", Self::MAX_LEN).map(Self)
    }

    /// The label used when no identity is configured — a single-user local install.
    #[must_use]
    pub fn local() -> Self {
        Self("local".to_owned())
    }

    /// Borrow as a string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ActorId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn ids_sort_in_creation_order() {
        // The property the whole choice of v7 rests on. Sleeping a millisecond between mints
        // because v7's ordering guarantee is at millisecond granularity.
        let mut minted = Vec::new();
        for _ in 0..8 {
            minted.push(MarkupId::new());
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mut sorted = minted.clone();
        sorted.sort();
        assert_eq!(minted, sorted, "UUIDv7 ids must sort chronologically");
    }

    #[test]
    fn ids_round_trip_through_their_string_form() {
        let id = ProjectId::new();
        assert_eq!(ProjectId::from_str(&id.to_string()).unwrap(), id);
    }

    #[test]
    fn a_malformed_id_is_rejected_rather_than_defaulted() {
        assert!(ProjectId::from_str("not-a-uuid").is_err());
        assert!(ProjectId::from_str("").is_err());
    }

    #[test]
    fn ids_serialise_as_a_bare_string() {
        let id = MarkupId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(
            json,
            format!("\"{id}\""),
            "transparent, so exports stay readable"
        );
    }

    #[test]
    fn an_actor_must_carry_a_label() {
        assert!(ActorId::new("  ").is_err());
        assert_eq!(
            ActorId::new(" a.reviewer@example.com ").unwrap().as_str(),
            "a.reviewer@example.com"
        );
    }
}
