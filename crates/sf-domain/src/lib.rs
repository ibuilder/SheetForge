//! # `sf-domain` — SheetForge's domain model
//!
//! Entities, invariants and state transitions for a construction drawing review. No I/O, no
//! database, no PDF engine, no Tauri. If a rule about what a markup *is* lives anywhere, it lives
//! here, because a rule enforced in a command handler is a rule the importer does not obey.
//!
//! ## What the model insists on
//!
//! - **Source PDFs are immutable, addressed by content hash.** A markup refers to a
//!   [`DocumentRevision`], never to a file path. The bytes the architect issued stay byte-identical.
//! - **Markup geometry is PDF user space.** 1/72", top-left origin, unrotated — never viewport
//!   pixels, which are correct at one zoom level on one monitor.
//! - **A quantity carries its provenance.** Raw page magnitude, calibration, formula version and
//!   unit travel with the number, so re-calibrating a page re-derives it and an unverified scale
//!   is visible rather than silently authoritative. See [`measurement`].
//! - **Status is a state machine.** [`MarkupStatus`] declares which moves are legal; a closed item
//!   reopens at the start of the workflow, not halfway through it.
//! - **Writes are version-checked.** [`Markup::apply`] refuses a stale edit rather than letting
//!   last-writer-win discard somebody's review comment.
//! - **Nothing here carries a filesystem path or document text.** Error strings reach logs and
//!   diagnostic bundles, and customer drawings must not.
//!
//! ## Time and identity
//!
//! Timestamps are RFC 3339 UTC ([`chrono::DateTime<Utc>`]). Identifiers are UUIDv7, which sorts
//! chronologically — see [`ids`].

pub mod document;
pub mod error;
pub mod ids;
pub mod markup;
pub mod measurement;
pub mod project;
pub mod scale_check;
pub mod sheet;
pub mod status;
pub mod view;

pub use document::{ContentHash, DocumentRevision, SourceDocument};
pub use error::{DomainError, Result};
pub use ids::{ActorId, CalibrationId, DocumentRevisionId, MarkupId, ProjectId, SourceDocumentId};
pub use markup::{Geometry, Markup, MarkupKind, MarkupMetadata, MarkupPatch};
pub use measurement::{Calibration, MeasureKind, Quantity, ScaleSource, FORMULA_VERSION};
pub use project::Project;
pub use scale_check::{check as check_scale, ScaleCheck, Verdict};
pub use sheet::{Sheet, SheetSource};
pub use status::MarkupStatus;
pub use view::SavedView;

/// The current time, at the resolution the model actually keeps.
///
/// `Utc::now()` resolves to nanoseconds, but every persisted and exported form of a timestamp —
/// the RFC 3339 string in SQLite, in an audit event, in a CSV — carries milliseconds. Minting at
/// nanosecond precision would mean a record in memory never quite equals the same record read back
/// from disk, so a save-then-compare reports a spurious change and a round-trip test can only
/// assert approximate equality.
///
/// Millisecond resolution is also all the model can honestly claim: two markups drawn in the same
/// millisecond are not meaningfully ordered by time, and their UUIDv7 ids order them anyway.
#[must_use]
pub fn now() -> chrono::DateTime<chrono::Utc> {
    use chrono::SubsecRound;
    chrono::Utc::now().trunc_subsecs(3)
}

/// The domain model's own version.
///
/// Bumped when a persisted shape changes in a way a migration has to know about. `sf-store` writes
/// it into the database and refuses to open a file written by a newer model than the running
/// binary understands — opening it anyway would mean reading fields that are not there and writing
/// away fields it does not know to preserve.
pub const MODEL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_runs_end_to_end_through_the_model() {
        // The first delivery slice, expressed as an assertion about the domain alone: raise a
        // cloud against a revision, fill in the construction fields, work it through the
        // workflow, and measure something on the same page.
        let actor = ActorId::new("a.reviewer@example.com").unwrap();
        let project =
            Project::new("Riverside Tower", Some("2026-014"), None, actor.clone()).unwrap();
        let document = SourceDocument::new(project.id, "A-201", Some("Architectural")).unwrap();
        let revision = DocumentRevision::new(
            project.id,
            document.id,
            Some("C"),
            ContentHash::from_bytes([7; 32]),
            2_400_000,
            12,
            actor.clone(),
        )
        .unwrap();

        let geometry = Geometry::new(1, serde_json::json!({ "points": [[72.0, 144.0]] })).unwrap();
        let mut cloud = Markup::create(
            project.id,
            revision.id,
            4,
            revision.page_count,
            MarkupKind::Cloud,
            geometry,
            MarkupMetadata {
                subject: Some("Duct clashes with beam".into()),
                discipline: Some("MEP".into()),
                ..Default::default()
            },
            None,
            actor.clone(),
        )
        .unwrap();

        assert!(cloud.status.is_outstanding());
        cloud
            .apply(
                MarkupPatch {
                    status: Some(MarkupStatus::InProgress),
                    ..Default::default()
                },
                1,
                actor.clone(),
            )
            .unwrap();
        cloud
            .apply(
                MarkupPatch {
                    status: Some(MarkupStatus::Closed),
                    ..Default::default()
                },
                2,
                actor.clone(),
            )
            .unwrap();
        assert!(cloud.status.is_terminal());
        assert_eq!(cloud.version, 3);

        // A measurement on the same sheet, at the sheet's own scale.
        let calibration = Calibration::new(
            4,
            8.0 / 72.0,
            "ft",
            ScaleSource::UserCalibrated,
            Some("1/8\" = 1'-0\""),
        )
        .unwrap();
        let quantity =
            Quantity::derive(MeasureKind::Area, 72.0 * 72.0, 4, Some(&calibration), 2).unwrap();
        assert_eq!(quantity.display(), "64.00 ft");
        assert!(!quantity.provisional);
    }

    #[test]
    fn a_markup_cannot_be_raised_on_a_page_the_revision_does_not_have() {
        let actor = ActorId::local();
        let revision = DocumentRevision::new(
            ProjectId::new(),
            SourceDocumentId::new(),
            None,
            ContentHash::from_bytes([1; 32]),
            100,
            2,
            actor.clone(),
        )
        .unwrap();
        assert!(!revision.has_page(3));

        let result = Markup::create(
            revision.project_id,
            revision.id,
            3,
            revision.page_count,
            MarkupKind::Text,
            Geometry::new(1, serde_json::json!({})).unwrap(),
            MarkupMetadata::default(),
            None,
            actor,
        );
        assert!(result.is_err());
    }
}
