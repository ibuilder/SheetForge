//! Does a database written by the previous build still open?
//!
//! Until there were two schema versions this could not be tested at all, and `docs/status.md` said
//! so: *"migrations are tested at one version, so cross-version migration is untested by
//! construction"*. Adding the second version is what makes the question askable, and an untested
//! migration path is the kind of thing that is fine until the morning somebody upgrades and their
//! project will not open.
//!
//! What these assert is the whole of the promise made in
//! [ADR-0003](../../../docs/adr/0003-project-package-and-local-data-model.md): a project written by
//! an older build opens in a newer one, the data that was in it is still in it, and the upgrade is
//! not silently destructive.
//!
//! The v1 database is built here from the shipped migration rather than from a committed binary
//! fixture. A `.sqlite` in the repository is a file nobody can review; migration 1's own SQL is
//! code, and there is a test in `schema.rs` asserting it is still the text that shipped — so this
//! is reconstructing the real thing rather than approximating it.

use rusqlite::Connection;
use sf_domain::{ActorId, ContentHash, DocumentRevision, Project, SourceDocument};
use sf_store::Store;

/// Identifiers, in the shape the domain insists on.
///
/// UUIDs rather than `p1`/`d1`: the ids are parsed back into typed values on read, so a
/// convenient-looking placeholder fails at the point the row is used rather than at the point it
/// is written — which is a confusing way to spend twenty minutes.
const PROJECT: &str = "0192f0c1-0000-7000-8000-0000000000c1";
const DOCUMENT: &str = "0192f0c1-0000-7000-8000-0000000000d1";
const REVISION: &str = "0192f0c1-0000-7000-8000-0000000000e1";

/// Build a database at schema version 1, exactly as the first release wrote one.
fn a_version_one_database(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    let first = &sf_store::schema::MIGRATIONS[0];
    assert_eq!(first.version, 1);

    connection
        .execute_batch("PRAGMA journal_mode = WAL;")
        .unwrap();
    connection.execute_batch(first.sql).unwrap();
    connection
        .execute(
            "INSERT INTO store_meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .unwrap();

    // A project with a drawing in it, so the migration has something to preserve. Inserted through
    // raw SQL rather than through `Store`, because `Store` is the *new* build and would run the
    // migration before writing — which would defeat the point.
    connection
        .execute(
            "INSERT INTO projects \
             (id, name, job_number, description, created_at, updated_at, created_by) \
             VALUES (?1, 'Riverside Tower', NULL, NULL, '2026-08-01T00:00:00.000Z', \
             '2026-08-01T00:00:00.000Z', 'a.reviewer@example.com')",
            [PROJECT],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO source_documents (id, project_id, name, discipline, created_at) \
             VALUES (?1, ?2, 'A-201', NULL, '2026-08-01T00:00:00.000Z')",
            [DOCUMENT, PROJECT],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO document_revisions \
             (id, project_id, source_document_id, revision_label, content_sha256, byte_len, \
              page_count, imported_at, imported_by) \
             VALUES (?1, ?2, ?3, 'C', \
             'ab00000000000000000000000000000000000000000000000000000000000000', \
             1024, 12, '2026-08-01T00:00:00.000Z', 'a.reviewer@example.com')",
            [REVISION, PROJECT, DOCUMENT],
        )
        .unwrap();
}

#[test]
fn a_project_written_by_the_previous_build_still_opens() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");
    a_version_one_database(&file);

    // Opening runs the outstanding migrations. If this returns an error, an upgrade bricks a
    // project — the failure this whole file exists to catch.
    let store = Store::open(&file).unwrap();

    let project = store
        .project()
        .unwrap()
        .expect("the project survived the upgrade");
    assert_eq!(project.name, "Riverside Tower");

    let documents = store.source_documents(project.id).unwrap();
    assert_eq!(documents.len(), 1, "the drawing survived the upgrade");
    assert_eq!(documents[0].name, "A-201");
}

#[test]
fn the_upgrade_records_the_version_it_reached() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");
    a_version_one_database(&file);

    Store::open(&file).unwrap();

    let connection = Connection::open(&file).unwrap();
    let version: String = connection
        .query_row(
            "SELECT value FROM store_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    let latest = sf_store::schema::MIGRATIONS.last().unwrap().version;
    assert_eq!(
        version,
        latest.to_string(),
        "the file still claims an old version, so the next open would run the migration again",
    );
}

/// The migration must be idempotent in the only sense that matters: opening twice must not run it
/// twice. `ALTER TABLE ADD COLUMN` fails on a second run, so a version that was not recorded
/// correctly turns into a project that opens once and never again.
#[test]
fn opening_twice_does_not_run_the_migration_twice() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");
    a_version_one_database(&file);

    drop(Store::open(&file).unwrap());
    let store =
        Store::open(&file).expect("the second open failed, so the version was not recorded");
    assert!(store.project().unwrap().is_some());
}

/// A row that existed before the migration reports no derivation, because it had none: it was
/// imported from outside the project. A migration that back-filled a plausible-looking value here
/// would be inventing provenance, which is worse than admitting there is none.
#[test]
fn a_revision_imported_before_the_migration_claims_no_origin() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");
    a_version_one_database(&file);

    Store::open(&file).unwrap();

    let connection = Connection::open(&file).unwrap();
    let (derived_from, derivation): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT derived_from, derivation FROM document_revisions WHERE id = ?1",
            [REVISION],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();

    assert_eq!(derived_from, None);
    assert_eq!(derivation, None);
}

/// A version-1 file must arrive at the *current* version, not merely the next one. Migrations run
/// as a sequence, and a project two versions behind is the ordinary case for anybody who skipped a
/// release — the one that would break if the loop stopped early.
#[test]
fn a_version_one_database_reaches_every_later_migration() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");
    a_version_one_database(&file);

    Store::open(&file).unwrap();

    let connection = Connection::open(&file).unwrap();
    // Version 2 added these columns; version 3 added this table. Asking the schema itself rather
    // than trusting the recorded version number, which is the thing that could be wrong.
    let derived: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('document_revisions') WHERE name = 'derived_from'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(derived, 1, "migration 2 did not run");

    let register: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sheets'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(register, 1, "migration 3 did not run");
}

/// A database from a *newer* build must be refused rather than opened and half-understood. Reading
/// a file whose shape you do not know is how data gets silently dropped on the next write.
#[test]
fn a_project_from_a_newer_build_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("database.sqlite");

    {
        let actor = ActorId::local();
        let store = Store::open(&file).unwrap();
        let project = Project::new("Riverside Tower", None, None, actor.clone()).unwrap();
        store.create_project(&project).unwrap();
        let document = SourceDocument::new(project.id, "A-201", None).unwrap();
        store.insert_source_document(&document).unwrap();
        let revision = DocumentRevision::new(
            project.id,
            document.id,
            Some("C"),
            ContentHash::from_bytes([0xab; 32]),
            1024,
            12,
            actor,
        )
        .unwrap();
        store.insert_revision(&revision).unwrap();
    }

    // Claim a version from the future.
    let connection = Connection::open(&file).unwrap();
    connection
        .execute(
            "UPDATE store_meta SET value = '9999' WHERE key = 'schema_version'",
            [],
        )
        .unwrap();
    drop(connection);

    assert!(
        Store::open(&file).is_err(),
        "a file written by a newer build was opened anyway, which risks writing to it in a shape \
         that build does not expect",
    );
}
