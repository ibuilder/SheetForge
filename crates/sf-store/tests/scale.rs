//! What happens at the size of a real job.
//!
//! Every other test in this crate uses a handful of records, which proves correctness and says
//! nothing about whether the thing is usable. A drawing review is a few thousand markups across a
//! few hundred sheets, and the queries the interface runs — the markup list on every keystroke, the
//! status roll-up on every filter change — run against all of them.
//!
//! ## What these assert, and why the ceilings are loose
//!
//! These run on shared CI hardware whose speed varies by several times between runs, so a tight
//! budget would fail for reasons unrelated to the code and train everyone to ignore it. The
//! ceilings here are set to catch an **order-of-magnitude** regression: a missing index, an
//! accidental full scan, a per-row query inside a loop. Those are the failures that actually make
//! the product unusable, and they show up as 100x rather than 20%.
//!
//! The measured numbers are printed either way, so `cargo test -- --nocapture` gives a real figure
//! to compare against rather than only a pass or a fail.

use sf_domain::{
    ActorId, Calibration, ContentHash, DocumentRevision, Geometry, Markup, MarkupKind,
    MarkupMetadata, MarkupPatch, MarkupStatus, MeasureKind, Project, Quantity, ScaleSource,
    SourceDocument,
};
use sf_store::Store;
use std::time::{Duration, Instant};

/// A set of this size is an ordinary commercial job: 200 sheets, a few thousand comments.
const SHEETS: u32 = 200;
const MARKUPS: usize = 5_000;

struct Bench {
    _dir: tempfile::TempDir,
    store: Store,
    revision: DocumentRevision,
}

/// Build a project with `MARKUPS` markups spread across `SHEETS` pages.
fn seeded() -> (Bench, Duration) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("database.sqlite")).unwrap();
    let actor = ActorId::local();

    let project = Project::new("Riverside Tower", None, None, actor.clone()).unwrap();
    store.create_project(&project).unwrap();
    let document = SourceDocument::new(project.id, "Set", None).unwrap();
    store.insert_source_document(&document).unwrap();
    let revision = DocumentRevision::new(
        project.id,
        document.id,
        Some("C"),
        ContentHash::from_bytes([0xab; 32]),
        400_000_000,
        SHEETS,
        actor.clone(),
    )
    .unwrap();
    store.insert_revision(&revision).unwrap();

    let calibration =
        Calibration::new(1, 8.0 / 72.0, "ft", ScaleSource::UserCalibrated, None).unwrap();

    let mut batch = Vec::with_capacity(MARKUPS);
    for index in 0..MARKUPS {
        let page = u32::try_from(index % SHEETS as usize).unwrap() + 1;
        // Every fifth markup is a measurement, which is roughly the mix on a takeoff-heavy job and
        // exercises the quantity column rather than leaving it NULL throughout.
        let (kind, quantity) = if index % 5 == 0 {
            let scale = Calibration::new(
                page,
                calibration.units_per_page_unit,
                "ft",
                ScaleSource::UserCalibrated,
                None,
            )
            .unwrap();
            (
                MarkupKind::Measurement,
                Some(Quantity::derive(MeasureKind::Area, 5184.0, page, Some(&scale), 2).unwrap()),
            )
        } else {
            (MarkupKind::Cloud, None)
        };

        let markup = Markup::create(
            project.id,
            revision.id,
            page,
            SHEETS,
            kind,
            Geometry::new(
                1,
                serde_json::json!({
                    // A realistic ink path rather than two points: geometry is the largest column
                    // and a benchmark on empty payloads measures the wrong thing.
                    "points": (0..40).map(|n| [f64::from(n) * 3.0, f64::from(n) * 1.5]).collect::<Vec<_>>()
                }),
            )
            .unwrap(),
            MarkupMetadata {
                subject: Some(format!("Coordination issue {index}")),
                discipline: Some(["MEP", "structural", "architectural"][index % 3].into()),
                cost_code: Some(format!("0{} 30 00", index % 9)),
                ..Default::default()
            },
            quantity,
            actor.clone(),
        )
        .unwrap();
        batch.push(markup);
    }

    // Seeded through the batched path, which is what every bulk route in the application now uses.
    // Doing it one at a time here would measure a route nothing takes any more — and would take
    // two minutes on a CI runner whose disk flushes three times slower than a developer's.
    let started = Instant::now();
    store.insert_markups(&batch).unwrap();
    let elapsed = started.elapsed();

    (
        Bench {
            _dir: dir,
            store,
            revision,
        },
        elapsed,
    )
}

/// Assert a ceiling and report the number either way.
fn within(what: &str, took: Duration, ceiling: Duration) {
    println!("  {what}: {took:?} (ceiling {ceiling:?})");
    assert!(
        took < ceiling,
        "{what} took {took:?}, past the {ceiling:?} ceiling — this is an order-of-magnitude \
         regression rather than noise, so look for a missing index or a query inside a loop",
    );
}

#[test]
fn a_realistic_project_stays_responsive() {
    let (bench, seeding) = seeded();
    println!("\nseeded {MARKUPS} markups across {SHEETS} pages in {seeding:?}");

    // One transaction, one flush. The ceiling is generous because disk speed varies by several
    // times between a developer's machine and a shared runner; what it catches is the batching
    // being lost, which would put this back into the minutes.
    within(
        "insert 5,000 markups in one transaction",
        seeding,
        Duration::from_secs(30),
    );

    // The query the markup list runs when a page is opened. Indexed on (revision, page); without
    // that index this becomes a scan of every markup in the project.
    let started = Instant::now();
    let page = bench.store.markups_on_page(bench.revision.id, 7).unwrap();
    within(
        "one page of markups",
        started.elapsed(),
        Duration::from_millis(250),
    );
    assert_eq!(page.len(), MARKUPS / SHEETS as usize);

    // The roll-up behind the status board, which the interface refreshes whenever a filter changes.
    let started = Instant::now();
    let counts = bench.store.status_counts().unwrap();
    within(
        "status roll-up",
        started.elapsed(),
        Duration::from_millis(500),
    );
    assert_eq!(counts.iter().map(|(_, n)| n).sum::<u64>(), MARKUPS as u64);

    // Loading everything, which is what happens when a document opens.
    let started = Instant::now();
    let all = bench.store.markups(bench.revision.id).unwrap();
    within("load all 5,000", started.elapsed(), Duration::from_secs(5));
    assert_eq!(all.len(), MARKUPS);

    // Reopening the same drawing: a content-hash lookup that must not scan.
    let started = Instant::now();
    let found = bench
        .store
        .revision_by_hash(bench.revision.content_sha256)
        .unwrap();
    within(
        "find a revision by hash",
        started.elapsed(),
        Duration::from_millis(100),
    );
    assert!(found.is_some());
}

#[test]
fn a_single_edit_stays_fast_in_a_large_project() {
    // The one that matters most for how the application *feels*: changing a status must not get
    // slower because the project is big. If it does, the interface stutters on every click.
    let (mut bench, _) = seeded();
    let markups = bench.store.markups(bench.revision.id).unwrap();
    let actor = ActorId::local();

    let started = Instant::now();
    for markup in markups.iter().take(50) {
        bench
            .store
            .update_markup(
                markup.id,
                MarkupPatch {
                    status: Some(MarkupStatus::InProgress),
                    ..Default::default()
                },
                markup.version,
                actor.clone(),
            )
            .unwrap();
    }
    let each = started.elapsed() / 50;
    within("one status change", each, Duration::from_millis(200));
}

#[test]
fn the_audit_trail_verifies_in_reasonable_time() {
    // Verification is offered as a user action, so it has to complete while somebody waits. It is
    // linear in the number of entries and hashes each one, which is the cost of the guarantee.
    let (mut bench, _) = seeded();
    let actor = ActorId::local();

    let started = Instant::now();
    for index in 0..2_000 {
        bench
            .store
            .append_audit(
                &actor,
                "markup:create",
                sf_audit::Outcome::Allowed,
                sf_audit::Record::new().subject("markup", &format!("m-{index}")),
            )
            .unwrap();
    }
    within(
        "append 2,000 audit entries",
        started.elapsed(),
        Duration::from_secs(240),
    );

    let started = Instant::now();
    bench.store.verify_audit().unwrap();
    within(
        "verify 2,000 audit entries",
        started.elapsed(),
        Duration::from_secs(5),
    );
}

#[test]
fn a_batched_import_is_dramatically_faster_than_one_at_a_time() {
    // The measurement that prompted `insert_markups` to exist. With `synchronous = FULL` every
    // implicit transaction is a flush to disk, so inserting one record at a time costs one fsync
    // each — about 8 ms on ordinary hardware. Five thousand of those is forty seconds of a user
    // watching a progress bar during an XFDF import.
    //
    // One transaction is one flush, and the durability guarantee is unchanged: the batch lands
    // whole or not at all, which is also the right semantics for an import.
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("database.sqlite")).unwrap();
    let actor = ActorId::local();

    let project = Project::new("Riverside Tower", None, None, actor.clone()).unwrap();
    store.create_project(&project).unwrap();
    let document = SourceDocument::new(project.id, "Set", None).unwrap();
    store.insert_source_document(&document).unwrap();
    let revision = DocumentRevision::new(
        project.id,
        document.id,
        None,
        ContentHash::from_bytes([0x11; 32]),
        1024,
        SHEETS,
        actor.clone(),
    )
    .unwrap();
    store.insert_revision(&revision).unwrap();

    let batch: Vec<Markup> = (0..1_000)
        .map(|index| {
            Markup::create(
                project.id,
                revision.id,
                (index % SHEETS) + 1,
                SHEETS,
                MarkupKind::Cloud,
                Geometry::new(1, serde_json::json!({ "points": [[1.0, 2.0], [3.0, 4.0]] }))
                    .unwrap(),
                MarkupMetadata {
                    subject: Some(format!("Imported {index}")),
                    ..Default::default()
                },
                None,
                actor.clone(),
            )
            .unwrap()
        })
        .collect();

    let started = Instant::now();
    store.insert_markups(&batch).unwrap();
    let batched = started.elapsed();
    within(
        "import 1,000 markups in one transaction",
        batched,
        Duration::from_secs(20),
    );

    assert_eq!(store.markups(revision.id).unwrap().len(), 1_000);

    // The comparison, on a small sample so the test does not itself take a minute.
    let sample: Vec<Markup> = (0..40)
        .map(|index| {
            Markup::create(
                project.id,
                revision.id,
                1,
                SHEETS,
                MarkupKind::Cloud,
                Geometry::new(1, serde_json::json!({ "points": [[1.0, 2.0]] })).unwrap(),
                MarkupMetadata {
                    subject: Some(format!("One at a time {index}")),
                    ..Default::default()
                },
                None,
                actor.clone(),
            )
            .unwrap()
        })
        .collect();

    let started = Instant::now();
    for markup in &sample {
        store.insert_markup(markup).unwrap();
    }
    let per_record_alone = started.elapsed() / 40;
    let per_record_batched = batched / 1_000;
    println!(
        "  per record: {per_record_batched:?} batched vs {per_record_alone:?} one at a time \
         ({}x)",
        per_record_alone.as_nanos() / per_record_batched.as_nanos().max(1),
    );

    // A generous factor: the point is that batching is a different order of cost, not that it hits
    // a particular ratio on a particular machine.
    assert!(
        per_record_batched * 5 < per_record_alone,
        "batching saved almost nothing ({per_record_batched:?} vs {per_record_alone:?}); either \
         the transaction is not being reused or `synchronous` is no longer FULL",
    );
}
