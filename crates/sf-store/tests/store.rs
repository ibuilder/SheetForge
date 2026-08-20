//! Integration tests for the project store.
//!
//! These drive the store through its public surface only, against a real SQLite file on disk
//! rather than an in-memory database wherever the property under test involves durability,
//! reopening or the WAL — none of which an in-memory database exercises.

use sf_audit::{Outcome, Record};
use sf_domain::{
    ActorId, Calibration, ContentHash, DocumentRevision, Geometry, Markup, MarkupKind,
    MarkupMetadata, MarkupPatch, MarkupStatus, MeasureKind, Project, Quantity, ScaleSource,
    SourceDocument,
};
use sf_store::{Store, StoreError};
use tempfile::TempDir;

/// A project seeded with one document, one revision and nothing else.
struct Fixture {
    _dir: TempDir,
    path: std::path::PathBuf,
    store: Store,
    project: Project,
    revision: DocumentRevision,
    actor: ActorId,
}

fn fixture() -> Fixture {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("database.sqlite");
    let store = Store::open(&path).unwrap();
    let actor = ActorId::new("a.reviewer@example.com").unwrap();

    let project = Project::new("Riverside Tower", Some("2026-014"), None, actor.clone()).unwrap();
    store.create_project(&project).unwrap();

    let document = SourceDocument::new(project.id, "A-201", Some("Architectural")).unwrap();
    store.insert_source_document(&document).unwrap();

    let revision = DocumentRevision::new(
        project.id,
        document.id,
        Some("C"),
        ContentHash::from_bytes([0xab; 32]),
        2_400_000,
        12,
        actor.clone(),
    )
    .unwrap();
    store.insert_revision(&revision).unwrap();

    Fixture {
        _dir: dir,
        path,
        store,
        project,
        revision,
        actor,
    }
}

fn a_cloud(fixture: &Fixture, subject: &str) -> Markup {
    Markup::create(
        fixture.project.id,
        fixture.revision.id,
        4,
        fixture.revision.page_count,
        MarkupKind::Cloud,
        Geometry::new(
            1,
            serde_json::json!({ "points": [[72.0, 144.0], [216.0, 288.0]] }),
        )
        .unwrap(),
        MarkupMetadata {
            subject: Some(subject.into()),
            discipline: Some("MEP".into()),
            ..Default::default()
        },
        None,
        fixture.actor.clone(),
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// Schema and lifecycle
// ---------------------------------------------------------------------------

#[test]
fn a_new_file_is_migrated_to_the_current_schema() {
    let fixture = fixture();
    assert_eq!(
        fixture.store.schema_version().unwrap(),
        sf_store::schema::MIGRATIONS.last().unwrap().version
    );
}

#[test]
fn reopening_an_existing_file_does_not_re_run_migrations_or_lose_data() {
    let fixture = fixture();
    let cloud = a_cloud(&fixture, "Duct clashes with beam");
    fixture.store.insert_markup(&cloud).unwrap();
    drop(fixture.store);

    let reopened = Store::open(&fixture.path).unwrap();
    assert_eq!(
        reopened.schema_version().unwrap(),
        sf_store::schema::MIGRATIONS.last().unwrap().version
    );
    assert_eq!(reopened.markups(fixture.revision.id).unwrap().len(), 1);
    assert_eq!(reopened.project().unwrap().unwrap().name, "Riverside Tower");
}

#[test]
fn a_file_from_a_newer_build_is_refused_rather_than_opened() {
    // Opening it would mean reading past fields this build does not know about, and the next
    // write would drop them permanently.
    let fixture = fixture();
    let path = fixture.path.clone();
    drop(fixture.store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE store_meta SET value = '9999' WHERE key = 'schema_version'",
        [],
    )
    .unwrap();
    drop(conn);

    match Store::open(&path) {
        Err(StoreError::NewerFormat { found, supported }) => {
            assert_eq!(found, 9999);
            assert_eq!(
                supported,
                sf_store::schema::MIGRATIONS.last().unwrap().version
            );
        }
        other => panic!(
            "expected a NewerFormat refusal, got {other:?}",
            other = other.err()
        ),
    }
}

#[test]
fn a_second_project_cannot_be_written_into_the_same_file() {
    // The file *is* the package. Two projects in one file means a package that cannot be handed
    // over without handing over another job as well.
    let fixture = fixture();
    let another = Project::new("Somewhere Else", None, None, fixture.actor.clone()).unwrap();
    assert!(matches!(
        fixture.store.create_project(&another),
        Err(StoreError::AlreadyInitialised)
    ));
}

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

#[test]
fn a_markup_against_an_unknown_revision_is_refused() {
    // Foreign keys are off by default in SQLite; this is the test that the pragma is actually set.
    let fixture = fixture();
    let orphan = Markup::create(
        fixture.project.id,
        sf_domain::DocumentRevisionId::new(),
        1,
        12,
        MarkupKind::Text,
        Geometry::new(1, serde_json::json!({})).unwrap(),
        MarkupMetadata::default(),
        None,
        fixture.actor.clone(),
    )
    .unwrap();
    assert!(fixture.store.insert_markup(&orphan).is_err());
}

#[test]
fn a_page_number_is_stored_as_a_number() {
    // STRICT tables. Without them SQLite would happily store the string "four" in `page`, and the
    // failure would surface days later as a parse error on read.
    let fixture = fixture();
    drop(fixture.store);
    let conn = rusqlite::Connection::open(&fixture.path).unwrap();
    let inserted = conn.execute(
        "INSERT INTO markups (id, project_id, document_revision_id, page, kind, status,
             geometry_schema, geometry, metadata, quantity, version, created_by, created_at,
             updated_by, updated_at)
         VALUES ('x','y','z','four','cloud','open',1,'{}','{}',NULL,1,'a','t','a','t')",
        [],
    );
    assert!(
        inserted.is_err(),
        "a STRICT table must refuse a string in an INTEGER column"
    );
}

// ---------------------------------------------------------------------------
// Markups
// ---------------------------------------------------------------------------

#[test]
fn a_markup_round_trips_with_every_field_intact() {
    let fixture = fixture();
    let cloud = a_cloud(&fixture, "Duct clashes with beam");
    fixture.store.insert_markup(&cloud).unwrap();

    let read_back = fixture.store.markup(cloud.id).unwrap();
    assert_eq!(
        read_back, cloud,
        "a stored markup must come back byte-for-byte identical"
    );
}

#[test]
fn a_measurement_keeps_its_provenance_across_a_round_trip() {
    // The claim the takeoff rests on: the raw magnitude and the calibration id survive storage,
    // so a page can still be re-calibrated after a reopen.
    let fixture = fixture();
    let calibration = Calibration::new(
        4,
        8.0 / 72.0,
        "ft",
        ScaleSource::UserCalibrated,
        Some("1/8\" = 1'-0\""),
    )
    .unwrap();
    fixture
        .store
        .set_calibration(fixture.revision.id, &calibration)
        .unwrap();

    let quantity =
        Quantity::derive(MeasureKind::Area, 72.0 * 72.0, 4, Some(&calibration), 2).unwrap();
    let measurement = Markup::create(
        fixture.project.id,
        fixture.revision.id,
        4,
        12,
        MarkupKind::Measurement,
        Geometry::new(
            1,
            serde_json::json!({ "points": [[0.0, 0.0], [72.0, 72.0]] }),
        )
        .unwrap(),
        MarkupMetadata::default(),
        Some(quantity.clone()),
        fixture.actor.clone(),
    )
    .unwrap();
    fixture.store.insert_markup(&measurement).unwrap();

    let read_back = fixture
        .store
        .markup(measurement.id)
        .unwrap()
        .quantity
        .unwrap();
    assert_eq!(read_back, quantity);
    assert_eq!(read_back.calibration_id, Some(calibration.id));
    assert_eq!(read_back.display(), "64.00 ft");
}

#[test]
fn markups_come_back_in_creation_order() {
    let fixture = fixture();
    let mut expected = Vec::new();
    for index in 0..5 {
        let cloud = a_cloud(&fixture, &format!("issue {index}"));
        fixture.store.insert_markup(&cloud).unwrap();
        expected.push(cloud.id);
        // UUIDv7 orders at millisecond granularity.
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let ids: Vec<_> = fixture
        .store
        .markups(fixture.revision.id)
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, expected);
}

#[test]
fn a_page_query_returns_only_that_page() {
    let fixture = fixture();
    for page in [1u32, 4, 4, 9] {
        let mut cloud = a_cloud(&fixture, "issue");
        cloud.page = page;
        fixture.store.insert_markup(&cloud).unwrap();
    }
    assert_eq!(
        fixture
            .store
            .markups_on_page(fixture.revision.id, 4)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fixture
            .store
            .markups_on_page(fixture.revision.id, 1)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture
            .store
            .markups_on_page(fixture.revision.id, 7)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn a_stale_write_is_refused_and_the_stored_record_is_untouched() {
    let mut fixture = fixture();
    let cloud = a_cloud(&fixture, "Duct clashes with beam");
    fixture.store.insert_markup(&cloud).unwrap();

    // The first reviewer closes it.
    fixture
        .store
        .update_markup(
            cloud.id,
            MarkupPatch {
                status: Some(MarkupStatus::Closed),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();

    // The second loaded it before that and tries to reassign it.
    let stale = fixture.store.update_markup(
        cloud.id,
        MarkupPatch {
            metadata: Some(MarkupMetadata {
                subject: Some("Something else".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        1,
        fixture.actor.clone(),
    );
    assert!(matches!(
        stale,
        Err(StoreError::Domain(
            sf_domain::DomainError::VersionConflict {
                expected: 1,
                found: 2
            }
        )),
    ));

    let stored = fixture.store.markup(cloud.id).unwrap();
    assert_eq!(stored.status, MarkupStatus::Closed);
    assert_eq!(
        stored.metadata.subject.as_deref(),
        Some("Duct clashes with beam")
    );
    assert_eq!(
        stored.version, 2,
        "the refused write must not have bumped the version"
    );
}

#[test]
fn an_illegal_status_move_is_refused_at_the_store_boundary() {
    let mut fixture = fixture();
    let cloud = a_cloud(&fixture, "issue");
    fixture.store.insert_markup(&cloud).unwrap();
    fixture
        .store
        .update_markup(
            cloud.id,
            MarkupPatch {
                status: Some(MarkupStatus::Closed),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();

    let skipped = fixture.store.update_markup(
        cloud.id,
        MarkupPatch {
            status: Some(MarkupStatus::ForReview),
            ..Default::default()
        },
        2,
        fixture.actor.clone(),
    );
    assert!(matches!(
        skipped,
        Err(StoreError::Domain(
            sf_domain::DomainError::IllegalTransition { .. }
        ))
    ));
    assert_eq!(
        fixture.store.markup(cloud.id).unwrap().status,
        MarkupStatus::Closed
    );
}

#[test]
fn a_stale_delete_is_refused() {
    let mut fixture = fixture();
    let cloud = a_cloud(&fixture, "issue");
    fixture.store.insert_markup(&cloud).unwrap();
    fixture
        .store
        .update_markup(
            cloud.id,
            MarkupPatch {
                status: Some(MarkupStatus::InProgress),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();

    assert!(
        fixture.store.delete_markup(cloud.id, 1).is_err(),
        "somebody worked on it since you loaded it"
    );
    assert!(fixture.store.markup(cloud.id).is_ok());
    fixture.store.delete_markup(cloud.id, 2).unwrap();
    assert!(matches!(
        fixture.store.markup(cloud.id),
        Err(StoreError::NotFound(_))
    ));
}

#[test]
fn status_counts_roll_up_for_the_review_board() {
    let mut fixture = fixture();
    let mut ids = Vec::new();
    for index in 0..4 {
        let cloud = a_cloud(&fixture, &format!("issue {index}"));
        fixture.store.insert_markup(&cloud).unwrap();
        ids.push(cloud.id);
    }
    fixture
        .store
        .update_markup(
            ids[0],
            MarkupPatch {
                status: Some(MarkupStatus::Closed),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();
    fixture
        .store
        .update_markup(
            ids[1],
            MarkupPatch {
                status: Some(MarkupStatus::Closed),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();
    fixture
        .store
        .update_markup(
            ids[2],
            MarkupPatch {
                status: Some(MarkupStatus::InProgress),
                ..Default::default()
            },
            1,
            fixture.actor.clone(),
        )
        .unwrap();

    let counts = fixture.store.status_counts().unwrap();
    assert!(counts.contains(&(MarkupStatus::Closed, 2)));
    assert!(counts.contains(&(MarkupStatus::InProgress, 1)));
    assert!(counts.contains(&(MarkupStatus::Open, 1)));
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

#[test]
fn each_page_holds_its_own_scale() {
    // A plan sheet and its enlarged detail are different scales; a document-wide factor produces
    // confidently wrong numbers on half the set.
    let fixture = fixture();
    let plan = Calibration::new(
        4,
        8.0 / 72.0,
        "ft",
        ScaleSource::DeclaredPreset,
        Some("1/8\" = 1'-0\""),
    )
    .unwrap();
    let detail = Calibration::new(
        5,
        1.0 / 72.0,
        "ft",
        ScaleSource::DeclaredPreset,
        Some("1\" = 1'-0\""),
    )
    .unwrap();
    fixture
        .store
        .set_calibration(fixture.revision.id, &plan)
        .unwrap();
    fixture
        .store
        .set_calibration(fixture.revision.id, &detail)
        .unwrap();

    assert_eq!(
        fixture
            .store
            .calibration(fixture.revision.id, 4)
            .unwrap()
            .unwrap()
            .preset_label
            .unwrap(),
        "1/8\" = 1'-0\""
    );
    assert_eq!(
        fixture
            .store
            .calibration(fixture.revision.id, 5)
            .unwrap()
            .unwrap()
            .preset_label
            .unwrap(),
        "1\" = 1'-0\""
    );
    assert!(fixture
        .store
        .calibration(fixture.revision.id, 6)
        .unwrap()
        .is_none());
}

#[test]
fn re_calibrating_a_page_replaces_the_scale_rather_than_adding_a_second() {
    let fixture = fixture();
    let wrong = Calibration::new(
        4,
        4.0 / 72.0,
        "ft",
        ScaleSource::DeclaredPreset,
        Some("1/4\" = 1'-0\""),
    )
    .unwrap();
    let right = Calibration::new(4, 8.0 / 72.0, "ft", ScaleSource::UserCalibrated, None).unwrap();
    fixture
        .store
        .set_calibration(fixture.revision.id, &wrong)
        .unwrap();
    fixture
        .store
        .set_calibration(fixture.revision.id, &right)
        .unwrap();

    let stored = fixture
        .store
        .calibration(fixture.revision.id, 4)
        .unwrap()
        .unwrap();
    assert_eq!(stored.id, right.id);
    assert_eq!(stored.source, ScaleSource::UserCalibrated);
}

#[test]
fn an_unverified_extracted_scale_stays_unverified_across_a_round_trip() {
    // If this flipped to verified on read, an OCR guess would silently become an authoritative
    // scale for every quantity on the page.
    let fixture = fixture();
    let extracted =
        Calibration::new(4, 8.0 / 72.0, "ft", ScaleSource::ExtractedFromSheet, None).unwrap();
    assert!(!extracted.is_verified);
    fixture
        .store
        .set_calibration(fixture.revision.id, &extracted)
        .unwrap();
    assert!(
        !fixture
            .store
            .calibration(fixture.revision.id, 4)
            .unwrap()
            .unwrap()
            .is_verified
    );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

#[test]
fn the_audit_trail_chains_and_verifies() {
    let mut fixture = fixture();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "document:import",
            Outcome::Allowed,
            Record::new().subject("document-revision", &fixture.revision.id.to_string()),
        )
        .unwrap();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "markup:create",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "export:csv",
            Outcome::Allowed,
            Record::new().with("rows", "42"),
        )
        .unwrap();

    let events = fixture.store.audit_events().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].seq, 0);
    assert_eq!(events[2].prev_hash, events[1].chain_hash);
    fixture.store.verify_audit().unwrap();
}

#[test]
fn a_refusal_is_recorded_alongside_the_acts_that_succeeded() {
    let mut fixture = fixture();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "markup:create",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "export:pdf",
            Outcome::Denied,
            Record::new().because("the set is issued for construction and is locked"),
        )
        .unwrap();

    let events = fixture.store.audit_events().unwrap();
    assert_eq!(events[1].outcome, Outcome::Denied);
    assert!(events[1].reason.as_deref().unwrap().contains("locked"));
    fixture.store.verify_audit().unwrap();
}

#[test]
fn the_audit_trail_cannot_be_updated_or_deleted_from_even_by_raw_sql() {
    // Enforced by triggers, so it is a property of the file rather than a habit of this code —
    // which is what makes it worth something to a person reading the database later.
    let mut fixture = fixture();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "markup:create",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    let path = fixture.path.clone();
    drop(fixture.store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let updated = conn.execute(
        "UPDATE audit_events SET actor = 'someone.else' WHERE seq = 0",
        [],
    );
    assert!(updated.is_err(), "the trail must refuse an update");
    let deleted = conn.execute("DELETE FROM audit_events WHERE seq = 0", []);
    assert!(deleted.is_err(), "the trail must refuse a delete");
}

#[test]
fn tampering_with_the_trail_is_detected_on_verification() {
    // The triggers stop the easy edit; this is what happens when somebody drops the triggers
    // first, which is the realistic attack on a local file.
    let mut fixture = fixture();
    for action in ["markup:create", "markup:status", "export:csv"] {
        fixture
            .store
            .append_audit(&fixture.actor, action, Outcome::Allowed, Record::new())
            .unwrap();
    }
    fixture.store.verify_audit().unwrap();
    let path = fixture.path.clone();
    drop(fixture.store);

    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "DROP TRIGGER audit_events_are_immutable;
         UPDATE audit_events SET action = 'markup:delete' WHERE seq = 1;",
    )
    .unwrap();
    drop(conn);

    let reopened = Store::open(&path).unwrap();
    let err = reopened.verify_audit().unwrap_err();
    assert!(
        matches!(
            err,
            StoreError::Audit(sf_audit::AuditError::ChainBroken { index: 1, .. })
        ),
        "got {err:?}"
    );
}

#[test]
fn the_trail_survives_being_reopened() {
    let mut fixture = fixture();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "markup:create",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    fixture
        .store
        .append_audit(
            &fixture.actor,
            "markup:status",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    drop(fixture.store);

    let mut reopened = Store::open(&fixture.path).unwrap();
    // The next event must chain onto what is already there rather than restarting at genesis.
    let next = reopened
        .append_audit(
            &fixture.actor,
            "export:csv",
            Outcome::Allowed,
            Record::new(),
        )
        .unwrap();
    assert_eq!(next.seq, 2);
    reopened.verify_audit().unwrap();
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

#[test]
fn a_committed_write_survives_an_abrupt_close() {
    // Not a true power-cut test — that needs a killed process, and the release runbook covers it —
    // but it does check the case a WAL database gets wrong when `synchronous` is misconfigured:
    // dropping the connection without a clean checkpoint must not lose committed work.
    let fixture = fixture();
    let cloud = a_cloud(&fixture, "Duct clashes with beam");
    fixture.store.insert_markup(&cloud).unwrap();

    // Leak the connection rather than dropping it, so no destructor runs and no checkpoint
    // happens — the closest a test can get to the process disappearing.
    std::mem::forget(fixture.store);

    let reopened = Store::open(&fixture.path).unwrap();
    let recovered = reopened.markups(fixture.revision.id).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].metadata.subject.as_deref(),
        Some("Duct clashes with beam")
    );
}

#[test]
fn no_error_message_from_the_store_leaks_a_path() {
    // Store errors reach the UI and the diagnostic bundle.
    let errors = [
        StoreError::Corrupt.to_string(),
        StoreError::NotFound("markup").to_string(),
        StoreError::AlreadyInitialised.to_string(),
        StoreError::NewerFormat {
            found: 9,
            supported: 1,
        }
        .to_string(),
    ];
    for message in errors {
        assert!(
            !message.contains(":\\") && !message.contains(".sqlite"),
            "path-like content in: {message}"
        );
    }
}
