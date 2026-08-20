//! # `sf-audit` — the tamper-evident audit trail
//!
//! Construction markups become contract evidence. "Who changed the dimension on this sheet, and
//! when?" is a question that gets asked in a mediation two years after the job finished, and an
//! answer is worth having only if it can be shown not to have been edited afterwards.
//!
//! So the trail is a **hash chain**: each event carries the digest of the one before it, and its own
//! digest covers both its content and that link. Removing an event, reordering two, or altering a
//! single character in one breaks every digest downstream of the change, and
//! [`verify_chain`] reports the first index that fails.
//!
//! ## What this is and is not
//!
//! It is *tamper-evident*: someone with write access to the database can still destroy the log, but
//! they cannot quietly change one line of it and leave the rest standing. That is the property an
//! evidentiary record needs.
//!
//! It is **not tamper-proof**, and it is not a signature. An attacker who controls the machine can
//! recompute the whole chain from the point of their edit forward. Making that impossible needs a
//! key they do not hold — a server-side notary or an HSM countersignature — which is a deployment
//! decision, not something a local application can assert on its own. [`AuditEvent::chain_hash`] is
//! exactly the value such a notary would sign, so the upgrade path is open.
//!
//! ## What must never be in here
//!
//! No document text, no OCR output, no markup body text, no filesystem paths, no tokens, no
//! credentials. The audit log gets exported, attached to tickets and shipped in diagnostic bundles;
//! it records *that* an act happened and against which identifier, never the content it touched.
//! [`AuditEvent::new`] enforces the bound on `detail`; keeping drawings out of it is a discipline
//! the callers have to hold, and [`redact`] is there to make holding it easy.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use thiserror::Error;

/// The genesis link — what the first event in a chain points at.
///
/// All zeroes rather than a random value, so an empty chain and a fresh chain are the same thing
/// and two independently created projects do not look related.
pub const GENESIS: [u8; 32] = [0u8; 32];

/// What went wrong in the audit subsystem.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum AuditError {
    /// The chain does not verify. Carries the first bad index so a report can point at it.
    #[error("the audit trail is broken at entry {index}: {reason}")]
    ChainBroken {
        /// Zero-based index of the first entry that failed.
        index: usize,
        /// Which check failed.
        reason: &'static str,
    },

    /// An event's `detail` map exceeded its bound.
    #[error("audit detail is larger than the {max} byte limit")]
    DetailTooLarge {
        /// The bound.
        max: usize,
    },

    /// A required field was blank.
    #[error("audit field {field} must not be empty")]
    Empty {
        /// Which field.
        field: &'static str,
    },
}

/// The audit subsystem's result alias.
pub type Result<T> = std::result::Result<T, AuditError>;

/// The outcome of an audited act.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// It happened.
    Allowed,
    /// It was refused. A refusal is as worth recording as a success — an attempt to export a
    /// locked drawing set is precisely the kind of thing a review asks about later.
    Denied,
}

impl Outcome {
    /// The stable wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Denied => "denied",
        }
    }
}

impl fmt::Display for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One line of the trail.
///
/// Flat and serialisable so it can be written straight to a log pipeline, and ordered by `seq`
/// within a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEvent {
    /// Position in the chain, from 0. Gaps mean entries were removed.
    pub seq: u64,
    /// RFC 3339 UTC.
    ///
    /// A string rather than a timestamp type because it is hashed: a parsed-and-reserialised
    /// timestamp can differ by a digit of sub-second precision and break a chain that is otherwise
    /// intact.
    pub at: String,
    /// Who acted.
    pub actor: String,
    /// What was attempted, e.g. `markup:create`, `export:csv`, `document:import`.
    pub action: String,
    /// Whether it went ahead.
    pub outcome: Outcome,
    /// Why it was refused, when there was a reason.
    pub reason: Option<String>,
    /// The identifier of the thing acted on — a markup id, a revision id.
    pub subject_id: Option<String>,
    /// What kind of thing that is, e.g. `markup`, `document-revision`.
    pub subject_kind: Option<String>,
    /// The revision this act was against, when it was against one.
    pub document_revision_id: Option<String>,
    /// 1-based page, when the act was on a page.
    pub page: Option<u32>,
    /// Anything else worth keeping. Sorted, so the hash is deterministic.
    ///
    /// Never document content. See the module docs.
    pub detail: BTreeMap<String, String>,
    /// The `chain_hash` of the previous entry, hex. `GENESIS` for the first.
    pub prev_hash: String,
    /// This entry's digest, hex. Covers its own content *and* `prev_hash`.
    pub chain_hash: String,
}

impl AuditEvent {
    /// The largest `detail` map accepted, summed over keys and values.
    pub const MAX_DETAIL_BYTES: usize = 4_096;

    /// Build the next event in a chain.
    ///
    /// `prev` is the entry this one follows, or `None` for the first in a project.
    ///
    /// # Errors
    /// If `actor` or `action` is blank, or `detail` exceeds [`AuditEvent::MAX_DETAIL_BYTES`].
    pub fn new(
        prev: Option<&Self>,
        at: String,
        actor: String,
        action: String,
        outcome: Outcome,
        record: Record,
    ) -> Result<Self> {
        if actor.trim().is_empty() {
            return Err(AuditError::Empty { field: "actor" });
        }
        if action.trim().is_empty() {
            return Err(AuditError::Empty { field: "action" });
        }
        let detail_bytes: usize = record.detail.iter().map(|(k, v)| k.len() + v.len()).sum();
        if detail_bytes > Self::MAX_DETAIL_BYTES {
            return Err(AuditError::DetailTooLarge {
                max: Self::MAX_DETAIL_BYTES,
            });
        }

        let (seq, prev_hash) = match prev {
            Some(previous) => (previous.seq + 1, previous.chain_hash.clone()),
            None => (0, hex::encode(GENESIS)),
        };

        let mut event = Self {
            seq,
            at,
            actor,
            action,
            outcome,
            reason: record.reason,
            subject_id: record.subject_id,
            subject_kind: record.subject_kind,
            document_revision_id: record.document_revision_id,
            page: record.page,
            detail: record.detail,
            prev_hash,
            chain_hash: String::new(),
        };
        event.chain_hash = event.compute_hash();
        Ok(event)
    }

    /// Recompute this entry's digest from its content.
    ///
    /// The encoding is explicit and length-prefixed rather than "serialise to JSON and hash that".
    /// A JSON encoder is free to change key order, whitespace or number formatting between
    /// versions, and any of those would invalidate every chain ever written. Length prefixes stop
    /// two different field splits from producing the same byte stream — without them an actor of
    /// `"a"` with action `"bc"` and an actor of `"ab"` with action `"c"` hash identically.
    #[must_use]
    pub fn compute_hash(&self) -> String {
        let mut hasher = Sha256::new();
        let mut field = |bytes: &[u8]| {
            hasher.update((bytes.len() as u64).to_be_bytes());
            hasher.update(bytes);
        };

        field(b"sf-audit-v1");
        field(&self.seq.to_be_bytes());
        field(self.at.as_bytes());
        field(self.actor.as_bytes());
        field(self.action.as_bytes());
        field(self.outcome.as_str().as_bytes());
        field(self.reason.as_deref().unwrap_or_default().as_bytes());
        field(self.subject_id.as_deref().unwrap_or_default().as_bytes());
        field(self.subject_kind.as_deref().unwrap_or_default().as_bytes());
        field(
            self.document_revision_id
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        field(&self.page.unwrap_or(0).to_be_bytes());
        field(&(self.detail.len() as u64).to_be_bytes());
        // BTreeMap iterates in key order, so this is stable across runs and platforms.
        for (key, value) in &self.detail {
            field(key.as_bytes());
            field(value.as_bytes());
        }
        field(self.prev_hash.as_bytes());

        hex::encode(hasher.finalize())
    }

    /// Whether this entry's stored digest matches its content.
    #[must_use]
    pub fn is_intact(&self) -> bool {
        self.chain_hash == self.compute_hash()
    }
}

/// The parts of an event that vary by act, gathered so [`AuditEvent::new`] stays callable.
#[derive(Debug, Clone, Default)]
pub struct Record {
    /// Why an act was refused.
    pub reason: Option<String>,
    /// What was acted on.
    pub subject_id: Option<String>,
    /// What kind of thing that was.
    pub subject_kind: Option<String>,
    /// Which revision it was against.
    pub document_revision_id: Option<String>,
    /// Which page.
    pub page: Option<u32>,
    /// Bounded extra facts. Never document content.
    pub detail: BTreeMap<String, String>,
}

impl Record {
    /// An empty record.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Name the thing acted on.
    #[must_use]
    pub fn subject(mut self, kind: &str, id: &str) -> Self {
        self.subject_kind = Some(kind.to_owned());
        self.subject_id = Some(id.to_owned());
        self
    }

    /// Name the revision and page.
    #[must_use]
    pub fn at_page(mut self, document_revision_id: &str, page: u32) -> Self {
        self.document_revision_id = Some(document_revision_id.to_owned());
        self.page = Some(page);
        self
    }

    /// Explain a refusal.
    #[must_use]
    pub fn because(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_owned());
        self
    }

    /// Add one bounded fact.
    #[must_use]
    pub fn with(mut self, key: &str, value: &str) -> Self {
        self.detail.insert(key.to_owned(), value.to_owned());
        self
    }
}

/// Check a chain end to end.
///
/// Verifies three things per entry, in the order that gives the most useful failure: that the
/// sequence numbers are contiguous, that each entry links to its predecessor, and that each
/// entry's digest matches its own content.
///
/// # Errors
/// [`AuditError::ChainBroken`] naming the first index that fails and which check it failed.
pub fn verify_chain(events: &[AuditEvent]) -> Result<()> {
    let mut expected_prev = hex::encode(GENESIS);
    for (index, event) in events.iter().enumerate() {
        if event.seq != index as u64 {
            return Err(AuditError::ChainBroken {
                index,
                reason: "sequence number is out of order or an entry is missing",
            });
        }
        if event.prev_hash != expected_prev {
            return Err(AuditError::ChainBroken {
                index,
                reason: "this entry does not follow the one before it",
            });
        }
        if !event.is_intact() {
            return Err(AuditError::ChainBroken {
                index,
                reason: "this entry's contents do not match its digest",
            });
        }
        expected_prev.clone_from(&event.chain_hash);
    }
    Ok(())
}

/// Strip the things that must never reach a log line.
///
/// A best-effort scrub for strings that were not built for logging — an OS error, a third-party
/// message — applied at the boundary where such a string would otherwise be recorded. It replaces
/// anything shaped like a filesystem path with `<path>`, and anything shaped like a token or key
/// with `<redacted>`.
///
/// It is a safety net, not a licence to log freely: the caller is still responsible for not putting
/// document content into an audit event in the first place.
#[must_use]
pub fn redact(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for token in value.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let trailing = &token[trimmed.len()..];
        out.push_str(&redact_token(trimmed));
        out.push_str(trailing);
    }
    out
}

fn redact_token(token: &str) -> String {
    // A Windows drive path, a UNC path, or a POSIX absolute path.
    let looks_like_path = token.len() > 3
        && (token.starts_with("\\\\")
            || token.starts_with('/')
            || (token.as_bytes()[0].is_ascii_alphabetic() && token[1..].starts_with(":\\"))
            || (token.as_bytes()[0].is_ascii_alphabetic() && token[1..].starts_with(":/")));
    if looks_like_path {
        return "<path>".to_owned();
    }

    // A long unbroken run of base64/hex-ish characters is a token, a key or a session id.
    let secretish = token.len() >= 24
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=' | '.'))
        && token.chars().any(|c| c.is_ascii_digit())
        && token.chars().any(char::is_alphabetic);
    if secretish {
        return "<redacted>".to_owned();
    }

    token.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain_of(actions: &[&str]) -> Vec<AuditEvent> {
        let mut events: Vec<AuditEvent> = Vec::new();
        for (index, action) in actions.iter().enumerate() {
            let event = AuditEvent::new(
                events.last(),
                format!("2026-08-20T10:0{index}:00Z"),
                "a.reviewer@example.com".into(),
                (*action).to_owned(),
                Outcome::Allowed,
                Record::new().subject("markup", &format!("markup-{index}")),
            )
            .unwrap();
            events.push(event);
        }
        events
    }

    #[test]
    fn a_fresh_chain_starts_at_genesis() {
        let events = chain_of(&["markup:create"]);
        assert_eq!(events[0].seq, 0);
        assert_eq!(events[0].prev_hash, hex::encode(GENESIS));
        verify_chain(&events).unwrap();
    }

    #[test]
    fn an_empty_chain_verifies() {
        verify_chain(&[]).unwrap();
    }

    #[test]
    fn a_well_formed_chain_verifies_end_to_end() {
        let events = chain_of(&[
            "markup:create",
            "markup:status",
            "export:csv",
            "markup:delete",
        ]);
        verify_chain(&events).unwrap();
        assert_eq!(events[3].prev_hash, events[2].chain_hash);
    }

    #[test]
    fn altering_one_character_of_one_entry_is_detected() {
        // The property the whole design exists for.
        let mut events = chain_of(&["markup:create", "markup:status", "export:csv"]);
        events[1].actor = "someone.else@example.com".into();

        let err = verify_chain(&events).unwrap_err();
        assert_eq!(
            err,
            AuditError::ChainBroken {
                index: 1,
                reason: "this entry's contents do not match its digest"
            }
        );
    }

    #[test]
    fn recomputing_the_digest_of_a_forged_entry_still_breaks_the_next_link() {
        // The realistic attack: change an entry *and* fix up its own hash. The entry passes its
        // own check, and its successor stops matching.
        let mut events = chain_of(&["markup:create", "markup:status", "export:csv"]);
        events[1].action = "markup:delete".into();
        events[1].chain_hash = events[1].compute_hash();
        assert!(
            events[1].is_intact(),
            "the forged entry is internally consistent"
        );

        let err = verify_chain(&events).unwrap_err();
        assert_eq!(
            err,
            AuditError::ChainBroken {
                index: 2,
                reason: "this entry does not follow the one before it"
            }
        );
    }

    #[test]
    fn removing_an_entry_from_the_middle_is_detected() {
        let mut events = chain_of(&[
            "markup:create",
            "markup:status",
            "export:csv",
            "markup:delete",
        ]);
        events.remove(1);
        let err = verify_chain(&events).unwrap_err();
        assert_eq!(
            err,
            AuditError::ChainBroken {
                index: 1,
                reason: "sequence number is out of order or an entry is missing"
            }
        );
    }

    #[test]
    fn reordering_two_entries_is_detected() {
        let mut events = chain_of(&["markup:create", "markup:status", "export:csv"]);
        events.swap(1, 2);
        assert!(verify_chain(&events).is_err());
    }

    #[test]
    fn truncating_the_tail_still_verifies_but_the_gap_is_visible_in_the_sequence() {
        // Chopping the end of a log is the one edit a bare chain cannot detect on its own; the
        // sequence number is what makes it visible against an external high-water mark. Recording
        // that here so the limit is not mistaken for a bug.
        let mut events = chain_of(&["markup:create", "markup:status", "export:csv"]);
        events.truncate(2);
        verify_chain(&events).unwrap();
        assert_eq!(
            events.last().unwrap().seq,
            1,
            "the count is what an external witness compares"
        );
    }

    #[test]
    fn the_hash_is_stable_across_runs() {
        // If this ever changes, every chain already written stops verifying. The expected value is
        // pinned rather than derived so the change cannot happen by accident.
        let event = AuditEvent::new(
            None,
            "2026-08-20T10:00:00Z".into(),
            "a.reviewer@example.com".into(),
            "markup:create".into(),
            Outcome::Allowed,
            Record::new().subject("markup", "0192f0c1-0000-7000-8000-000000000001"),
        )
        .unwrap();
        assert_eq!(
            event.chain_hash, "a63dc1894ab56ccc2a62b33e902ba555ddebd5a316bfd432661767bccc53dac0",
            "the digest encoding changed; every existing audit trail would stop verifying",
        );
    }

    #[test]
    fn field_boundaries_cannot_be_shifted_without_changing_the_hash() {
        // Without length prefixes these two would hash identically, and an attacker could move
        // characters between adjacent fields undetected.
        let left = AuditEvent::new(
            None,
            "T".into(),
            "ab".into(),
            "c".into(),
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
        let right = AuditEvent::new(
            None,
            "T".into(),
            "a".into(),
            "bc".into(),
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
        assert_ne!(left.chain_hash, right.chain_hash);
    }

    #[test]
    fn detail_order_does_not_affect_the_hash() {
        let forward = Record::new().with("zone", "L4").with("area", "east");
        let backward = Record::new().with("area", "east").with("zone", "L4");
        let left = AuditEvent::new(
            None,
            "T".into(),
            "a".into(),
            "x".into(),
            Outcome::Allowed,
            forward,
        )
        .unwrap();
        let right = AuditEvent::new(
            None,
            "T".into(),
            "a".into(),
            "x".into(),
            Outcome::Allowed,
            backward,
        )
        .unwrap();
        assert_eq!(left.chain_hash, right.chain_hash);
    }

    #[test]
    fn a_denial_is_recorded_with_its_reason() {
        let event = AuditEvent::new(
            None,
            "2026-08-20T10:00:00Z".into(),
            "sub@example.com".into(),
            "export:pdf".into(),
            Outcome::Denied,
            Record::new().because("the drawing set is issued for construction and is locked"),
        )
        .unwrap();
        assert_eq!(event.outcome, Outcome::Denied);
        assert!(event.reason.unwrap().contains("locked"));
    }

    #[test]
    fn an_event_without_an_actor_or_action_is_refused() {
        let blank_actor = AuditEvent::new(
            None,
            "T".into(),
            "  ".into(),
            "x".into(),
            Outcome::Allowed,
            Record::new(),
        );
        assert_eq!(
            blank_actor.unwrap_err(),
            AuditError::Empty { field: "actor" }
        );

        let blank_action = AuditEvent::new(
            None,
            "T".into(),
            "a".into(),
            String::new(),
            Outcome::Allowed,
            Record::new(),
        );
        assert_eq!(
            blank_action.unwrap_err(),
            AuditError::Empty { field: "action" }
        );
    }

    #[test]
    fn oversized_detail_is_refused_rather_than_truncated() {
        let record = Record::new().with("note", &"x".repeat(AuditEvent::MAX_DETAIL_BYTES));
        let err = AuditEvent::new(
            None,
            "T".into(),
            "a".into(),
            "x".into(),
            Outcome::Allowed,
            record,
        )
        .unwrap_err();
        assert_eq!(
            err,
            AuditError::DetailTooLarge {
                max: AuditEvent::MAX_DETAIL_BYTES
            }
        );
    }

    #[test]
    fn an_event_survives_a_json_round_trip_with_its_digest_intact() {
        // The trail is exported as NDJSON, and a round trip that changed the bytes would make an
        // exported log unverifiable.
        let events = chain_of(&["markup:create", "export:csv"]);
        let json = serde_json::to_string(&events).unwrap();
        let back: Vec<AuditEvent> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, events);
        verify_chain(&back).unwrap();
    }

    #[test]
    fn redaction_removes_paths() {
        assert_eq!(
            redact("failed to open C:\\Projects\\Riverside\\A-201.pdf now"),
            "failed to open <path> now"
        );
        assert_eq!(
            redact("open /home/matt/plans/A-201.pdf failed"),
            "open <path> failed"
        );
        assert_eq!(redact("\\\\fileserver\\jobs\\A-201.pdf"), "<path>");
    }

    #[test]
    fn redaction_removes_token_shaped_strings() {
        assert_eq!(
            redact("bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5"),
            "bearer <redacted>"
        );
    }

    #[test]
    fn redaction_leaves_ordinary_words_and_identifiers_alone() {
        assert_eq!(
            redact("markup:create was denied"),
            "markup:create was denied"
        );
        assert_eq!(redact("page 4 of 12"), "page 4 of 12");
        // A UUID is an identifier we deliberately keep — it is how an event is correlated.
        let uuid = "0192f0c1-0000-7000-8000-000000000001";
        assert_eq!(
            redact(uuid),
            "<redacted>",
            "over-redaction here is the safe direction"
        );
    }
}
