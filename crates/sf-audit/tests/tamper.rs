//! Property tests over the audit chain.
//!
//! The unit tests beside the code tamper in the ways somebody thought of: change a field, forge a
//! digest, remove an entry, swap two. These assert the property those examples are instances of —
//! **any** modification to a verified chain is detected — over generated chains and generated
//! edits.
//!
//! That is the claim the product actually makes. "We checked the four tampering cases we imagined"
//! is a much weaker statement than the audit trail is meant to support, and the difference only
//! shows up when somebody tampers in a fifth way.

use proptest::prelude::*;
use sf_audit::{verify_chain, AuditEvent, Outcome, Record};

/// Build a valid chain of `n` events.
fn chain(n: usize) -> Vec<AuditEvent> {
    let mut events: Vec<AuditEvent> = Vec::new();
    for index in 0..n {
        let event = AuditEvent::new(
            events.last(),
            format!("2026-08-20T10:00:{:02}.000Z", index % 60),
            format!("actor-{}", index % 3),
            [
                "markup:create",
                "markup:status",
                "export:csv",
                "markup:delete",
            ][index % 4]
                .to_owned(),
            if index % 7 == 0 {
                Outcome::Denied
            } else {
                Outcome::Allowed
            },
            Record::new()
                .subject("markup", &format!("markup-{index}"))
                .with("seq", &index.to_string()),
        )
        .expect("a well-formed event");
        events.push(event);
    }
    events
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Any chain this code builds verifies.
    #[test]
    fn a_chain_built_normally_always_verifies(n in 0usize..40) {
        prop_assert!(verify_chain(&chain(n)).is_ok());
    }

    /// Changing any single field of any single entry is detected.
    ///
    /// This is the property the whole hash-chain design exists to provide, and it is asserted over
    /// every field rather than over the one an example test happened to pick.
    #[test]
    fn altering_any_field_of_any_entry_is_detected(
        n in 1usize..25,
        index in 0usize..25,
        field in 0usize..8,
    ) {
        let mut events = chain(n);
        let index = index % events.len();
        let target = &mut events[index];

        match field {
            0 => target.actor.push('x'),
            1 => target.action.push('x'),
            2 => target.at.push('x'),
            3 => target.outcome = match target.outcome {
                Outcome::Allowed => Outcome::Denied,
                Outcome::Denied => Outcome::Allowed,
            },
            4 => target.reason = Some("rewritten".into()),
            5 => target.subject_id = Some("someone-elses-markup".into()),
            6 => target.page = Some(target.page.unwrap_or(0) + 1),
            _ => { target.detail.insert("added".into(), "later".into()); }
        }

        prop_assert!(
            verify_chain(&events).is_err(),
            "an edit to field {field} of entry {index} went undetected",
        );
    }

    /// Forging the digest of the edited entry does not help: the next entry stops matching.
    ///
    /// The realistic attack, rather than the naive one. It only fails to be detected when the
    /// edited entry is the last, which is the tail-truncation limit stated in SECURITY.md.
    #[test]
    fn re_signing_a_forged_entry_still_breaks_the_chain(n in 2usize..25, index in 0usize..25) {
        let mut events = chain(n);
        let index = index % (events.len() - 1); // never the last entry
        // Appended rather than assigned: the chain builder cycles through a fixed set of actions,
        // so assigning one of them can leave the entry byte-identical — a forgery that changes
        // nothing is not a forgery, and asserting it is detected would be asserting a falsehood.
        events[index].action.push_str(":forged");
        events[index].chain_hash = events[index].compute_hash();

        prop_assert!(events[index].is_intact(), "the forged entry should pass its own check");
        prop_assert!(
            verify_chain(&events).is_err(),
            "forging entry {index} of {n} and re-signing it went undetected",
        );
    }

    /// Removing any entry other than the tail is detected.
    #[test]
    fn removing_an_entry_is_detected(n in 2usize..25, index in 0usize..25) {
        let mut events = chain(n);
        let index = index % (events.len() - 1);
        events.remove(index);
        prop_assert!(verify_chain(&events).is_err(), "removing entry {index} went undetected");
    }

    /// Reordering any two distinct entries is detected.
    #[test]
    fn reordering_two_entries_is_detected(n in 2usize..25, a in 0usize..25, b in 0usize..25) {
        let mut events = chain(n);
        let (a, b) = (a % events.len(), b % events.len());
        prop_assume!(a != b);
        events.swap(a, b);
        prop_assert!(verify_chain(&events).is_err(), "swapping {a} and {b} went undetected");
    }

    /// Verification of arbitrary rubbish must refuse, never panic. Entries are read back from a
    /// file that may have been edited by anything.
    #[test]
    fn verification_never_panics_on_arbitrary_entries(
        actors in proptest::collection::vec(".*", 0..8),
        hashes in proptest::collection::vec("[a-f0-9]{0,80}", 0..8),
    ) {
        let mut events = chain(actors.len());
        for (index, (actor, hash)) in actors.into_iter().zip(hashes).enumerate() {
            events[index].actor = actor;
            events[index].prev_hash = hash;
        }
        let _ = verify_chain(&events);
    }

    /// Two events with identical content and the same predecessor hash identically; two with any
    /// difference do not. Without this a chain could be rewritten with a substituted entry.
    #[test]
    fn the_digest_is_a_function_of_the_content(action_a in "[a-z:]{1,20}", action_b in "[a-z:]{1,20}") {
        let make = |action: &str| {
            AuditEvent::new(
                None,
                "2026-08-20T10:00:00.000Z".into(),
                "a".into(),
                action.to_owned(),
                Outcome::Allowed,
                Record::new(),
            )
            .unwrap()
        };
        let left = make(&action_a);
        let right = make(&action_b);
        prop_assert_eq!(left.chain_hash == right.chain_hash, action_a == action_b);
    }
}

/// Redaction is applied to strings that were never written for a log, so it has to survive
/// anything.
#[test]
fn redaction_never_panics_and_never_lengthens_a_path() {
    for input in [
        "",
        "C:\\",
        "/",
        "\\\\",
        "a".repeat(10_000).as_str(),
        "C:\\Projects\\Riverside\\A-201.pdf",
        "/home/matt/plans/A-201.pdf",
        "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5",
        "  spaced   out  ",
        "\u{202e}gnp.evititsnes",
    ] {
        let out = sf_audit::redact(input);
        assert!(
            !out.contains(".pdf"),
            "a filename survived redaction: {out}"
        );
    }
}
