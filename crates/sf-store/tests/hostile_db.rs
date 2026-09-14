//! A project database written by somebody else.
//!
//! The package's database arrives in the same directory as its drawings, by the same email, and is
//! as hostile as they are. Two things are asserted here. Nothing about the file makes opening it
//! panic. And nothing the migrations did not create — a trigger, a view, a column — is allowed to
//! stay in a database this application is about to run its own SQL against, because SQLite runs
//! what is stored in the file inside this connection.

use rusqlite::Connection;
use sf_store::{Store, StoreError};
use std::path::PathBuf;

/// A real store's file, closed, ready to be tampered with.
fn a_store_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.sqlite");
    drop(Store::open(&path).unwrap());
    (dir, path)
}

fn plant(path: &PathBuf, sql: &str) {
    Connection::open(path).unwrap().execute_batch(sql).unwrap();
}

#[test]
fn an_untouched_database_still_opens() {
    let (_dir, path) = a_store_file();
    assert!(Store::open(&path).is_ok());
    // And again: the check must not be something the first open leaves behind.
    assert!(Store::open(&path).is_ok());
}

/// The case that matters. A trigger stored in the file runs on this application's own writes.
#[test]
fn a_trigger_planted_in_the_file_is_refused_before_it_can_run() {
    let (_dir, path) = a_store_file();
    plant(
        &path,
        "CREATE TRIGGER quietly AFTER UPDATE ON store_meta BEGIN SELECT 1; END;",
    );
    assert!(matches!(
        Store::open(&path),
        Err(StoreError::UnexpectedSchema)
    ));
}

#[test]
fn a_view_or_a_table_the_migrations_did_not_create_is_refused() {
    for sql in [
        "CREATE VIEW anything AS SELECT 1;",
        "CREATE TABLE extra (x INTEGER);",
        "CREATE INDEX extra_index ON store_meta (value);",
    ] {
        let (_dir, path) = a_store_file();
        plant(&path, sql);
        assert!(
            matches!(Store::open(&path), Err(StoreError::UnexpectedSchema)),
            "{sql} was accepted"
        );
    }
}

/// An altered table is as foreign as an added one: its stored SQL no longer matches.
#[test]
fn a_column_added_to_one_of_our_tables_is_refused() {
    let (_dir, path) = a_store_file();
    plant(&path, "ALTER TABLE store_meta ADD COLUMN planted TEXT;");
    assert!(matches!(
        Store::open(&path),
        Err(StoreError::UnexpectedSchema)
    ));
}

/// The audit table's protection is a pair of triggers. Removing them is a change to the schema,
/// and is refused as one, rather than leaving a trail that can be edited in place.
#[test]
fn a_database_whose_audit_protection_was_removed_is_refused() {
    let (_dir, path) = a_store_file();
    plant(&path, "DROP TRIGGER audit_events_are_immutable;");
    assert!(matches!(
        Store::open(&path),
        Err(StoreError::UnexpectedSchema)
    ));
}

#[test]
fn a_file_that_is_not_a_database_is_refused_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.sqlite");
    std::fs::write(&path, b"%PDF-1.7 this is a drawing somebody renamed").unwrap();
    assert!(Store::open(&path).is_err());
}

/// A version number that is not a number is read as no version, so the migrations run against
/// tables that already exist — which must be a refusal, not a panic or a half-migrated file.
#[test]
fn a_nonsense_schema_version_is_refused_without_panicking() {
    let (_dir, path) = a_store_file();
    plant(
        &path,
        "UPDATE store_meta SET value = 'not a number' WHERE key = 'schema_version';",
    );
    assert!(Store::open(&path).is_err());
}
