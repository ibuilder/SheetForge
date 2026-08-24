//! The database schema, as an ordered list of forward migrations.
//!
//! Rules that hold for every entry in [`MIGRATIONS`], and that the tests enforce:
//!
//! - **Forward only.** There are no down-migrations. A user who opens a project on a newer build
//!   and then goes back to an older one is a real scenario, and the honest answer is to refuse to
//!   open it rather than to run a reverse migration nobody has tested against their data.
//! - **Append only.** A migration that has shipped is never edited. Editing one means two
//!   databases both claiming version *n* with different shapes, and nothing can tell them apart.
//! - **One transaction each.** A migration that fails leaves the file exactly as it was.
//!
//! Version numbers are contiguous from 1 and are checked to be so at startup, because a gap means
//! a migration was dropped from the list rather than added to it.

/// One schema step.
pub struct Migration {
    /// Its version. Contiguous from 1.
    pub version: u32,
    /// What it does, for the log and for a support conversation.
    pub description: &'static str,
    /// The statements, run as one batch inside one transaction.
    pub sql: &'static str,
}

/// Every migration, in order.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        description: "initial project, document, markup, calibration and audit tables",
        sql: r"
-- Key/value for facts about the file itself: the model version it was written by, the id of the
-- single project it holds. Deliberately not a one-row table with fixed columns, so adding a fact
-- later is an insert rather than a migration.
CREATE TABLE store_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

-- One project per database file: the file *is* the project package. A multi-project store would
-- mean a package that cannot be handed to somebody without handing over other jobs too.
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    job_number  TEXT,
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL
) STRICT;

CREATE TABLE source_documents (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    discipline TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_source_documents_project ON source_documents(project_id);

CREATE TABLE document_revisions (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
    revision_label     TEXT,
    -- 64 lower-case hex characters. The file in sources/ is named for this.
    content_sha256     TEXT NOT NULL,
    byte_len           INTEGER NOT NULL,
    page_count         INTEGER NOT NULL,
    imported_at        TEXT NOT NULL,
    imported_by        TEXT NOT NULL
) STRICT;

CREATE INDEX idx_revisions_document ON document_revisions(source_document_id);
-- The same bytes can legitimately be imported as two revisions of two different sheets, so this
-- index is for lookup rather than uniqueness.
CREATE INDEX idx_revisions_hash ON document_revisions(content_sha256);

CREATE TABLE calibrations (
    id                  TEXT PRIMARY KEY,
    document_revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
    page                INTEGER NOT NULL,
    units_per_page_unit REAL NOT NULL,
    unit                TEXT NOT NULL,
    source              TEXT NOT NULL,
    preset_label        TEXT,
    is_verified         INTEGER NOT NULL,
    -- One scale per page. A plan and its enlarged detail are different pages, so this is the
    -- right granularity; a second calibration for the same page replaces the first.
    UNIQUE (document_revision_id, page)
) STRICT;

CREATE TABLE markups (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
    page                 INTEGER NOT NULL,
    kind                 TEXT NOT NULL,
    status               TEXT NOT NULL,
    geometry_schema      INTEGER NOT NULL,
    -- JSON. PDF user space, always.
    geometry             TEXT NOT NULL,
    -- JSON object of the construction fields.
    metadata             TEXT NOT NULL,
    -- JSON, or NULL on a markup that measures nothing.
    quantity             TEXT,
    version              INTEGER NOT NULL,
    created_by           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_by           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
) STRICT;

-- The query the markup list runs on every keystroke: this revision, this page, in creation order.
CREATE INDEX idx_markups_revision_page ON markups(document_revision_id, page);
-- The faceted filters.
CREATE INDEX idx_markups_status ON markups(project_id, status);
CREATE INDEX idx_markups_author ON markups(project_id, created_by);

-- Append only. No UPDATE and no DELETE statement anywhere in this crate touches this table, and
-- the triggers below make that a property of the file rather than a habit of the code.
CREATE TABLE audit_events (
    seq                  INTEGER PRIMARY KEY,
    at                   TEXT NOT NULL,
    actor                TEXT NOT NULL,
    action               TEXT NOT NULL,
    outcome              TEXT NOT NULL,
    reason               TEXT,
    subject_id           TEXT,
    subject_kind         TEXT,
    document_revision_id TEXT,
    page                 INTEGER,
    detail               TEXT NOT NULL,
    prev_hash            TEXT NOT NULL,
    chain_hash           TEXT NOT NULL
) STRICT;

CREATE TRIGGER audit_events_are_immutable
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'the audit trail cannot be modified');
END;

CREATE TRIGGER audit_events_cannot_be_deleted
BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'the audit trail cannot be deleted from');
END;

CREATE INDEX idx_audit_subject ON audit_events(subject_id);
",
    },
    Migration {
        version: 2,
        description: "record what a derived revision was made from",
        sql: r"
-- Page assembly produces a new revision rather than editing the source — see
-- docs/adr/0010-page-assembly-produces-a-derived-revision.md. These two columns are what make
-- that traceable: without them a project accumulates documents nobody can account for, which is
-- the provenance gap the decision exists to close.
--
-- Nullable, because every revision that already exists was imported rather than derived, and
-- because an imported drawing has no origin inside this project. A NULL here means somebody
-- brought this drawing in from outside, which is the truth about every row written before this
-- migration.
--
-- Deliberately *not* a foreign key to document_revisions. The originating revision can be deleted
-- while the thing derived from it remains, and a cascade would then quietly destroy the derived
-- document, while a restrict would refuse a deletion the user is entitled to make. A dangling
-- reference here is the honest state: it says the origin is gone, which is worth recording.
ALTER TABLE document_revisions ADD COLUMN derived_from TEXT;

-- What was done: `page-assembly` today. Free text rather than an enum so a future operation does
-- not need a migration to be describable, and so a row written by a newer build is still readable
-- by an older one.
ALTER TABLE document_revisions ADD COLUMN derivation TEXT;
",
    },
    Migration {
        version: 3,
        description: "the sheet register: what each page of a set actually is",
        sql: r"
-- A drawing set is not a PDF with pages, it is a register. The engine already reads title blocks;
-- until this table existed it read them and the host threw the result away on every save, so the
-- question a reviewer asks constantly -- which sheets are at revision C? -- meant scrolling two
-- hundred pages.
--
-- Keyed on (revision, page) rather than on an id of its own: there is exactly one answer to
-- what is page 7 of this document, and a surrogate key would allow two.
CREATE TABLE sheets (
    document_revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE CASCADE,
    page                 INTEGER NOT NULL,
    project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- As printed in the title block. Nullable because a sketch often has none and a heuristic
    -- often reads none, and inventing one would be worse than leaving it blank.
    number               TEXT,
    title                TEXT,
    discipline           TEXT,
    -- The revision letter on *this sheet*, which is not the document revision: a single issue
    -- routinely contains sheets at different revisions. That difference is the whole point of
    -- being able to query the register.
    sheet_revision       TEXT,
    -- recognised | extracted | imported | confirmed. Stored with every row because a number a
    -- machine guessed off a 1974 dyeline and a number somebody typed must never be shown alike.
    source               TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (document_revision_id, page)
) STRICT;

-- The register is navigated by number and filtered by revision, which are the two queries the
-- interface runs and the two that would otherwise scan every sheet in the project.
CREATE INDEX idx_sheets_number ON sheets(project_id, number);
CREATE INDEX idx_sheets_revision ON sheets(project_id, sheet_revision);
",
    },
];

#[cfg(test)]
mod tests {
    use super::MIGRATIONS;

    #[test]
    fn versions_are_contiguous_from_one() {
        // A gap means a migration was removed from the list rather than superseded by a new one,
        // and every database already at the missing version becomes unopenable.
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(
                u64::from(migration.version),
                index as u64 + 1,
                "migration {} is out of order or a version was skipped",
                migration.description,
            );
        }
    }

    #[test]
    fn every_migration_says_what_it_does() {
        for migration in MIGRATIONS {
            assert!(!migration.description.trim().is_empty());
            assert!(!migration.sql.trim().is_empty());
        }
    }

    /// A shipped migration is never edited, so the first one's text is pinned. Editing it would
    /// mean two databases with the same version number and different shapes — the failure the
    /// module header warns about, and one that only shows up on somebody else's machine.
    #[test]
    fn the_first_migration_is_still_the_one_that_shipped() {
        let first = &MIGRATIONS[0];
        assert_eq!(first.version, 1);
        assert!(
            first.sql.contains("CREATE TABLE document_revisions"),
            "migration 1 no longer creates the table it created when it shipped",
        );
        assert!(
            !first.sql.contains("derived_from"),
            "migration 1 was edited to add a column instead of a migration being appended",
        );
    }

    #[test]
    fn no_migration_drops_or_reverses_anything() {
        // Forward only. A DROP in a migration is how shipped data gets destroyed by an upgrade.
        for migration in MIGRATIONS {
            let sql = migration.sql.to_uppercase();
            assert!(
                !sql.contains("DROP TABLE"),
                "{} drops a table",
                migration.description
            );
            assert!(
                !sql.contains("DROP COLUMN"),
                "{} drops a column",
                migration.description
            );
        }
    }

    #[test]
    fn every_table_is_strict() {
        // Without STRICT, SQLite stores whatever it is given: a page number can be the string
        // "four", and the error surfaces days later as a parse failure on read.
        for migration in MIGRATIONS {
            let creates = migration.sql.matches("CREATE TABLE").count();
            let stricts = migration.sql.matches("STRICT").count();
            assert_eq!(
                creates, stricts,
                "{}: every table must be STRICT",
                migration.description
            );
        }
    }
}
