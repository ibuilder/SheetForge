//! # `sf-store` — the local project store
//!
//! SQLite, one file per project package, reached only through the repository methods on [`Store`].
//! Nothing above this crate sees a connection, a statement or a row.
//!
//! ## Why SQLite and not a file format
//!
//! A drawing review is thousands of small records that get filtered, counted and rolled up while
//! somebody is scrolling a sheet. A document format would mean loading all of it to answer "open
//! structural comments on Level 4", and rewriting all of it to change one status — which is also
//! the moment a power cut costs an afternoon's review. SQLite gives indexed queries over the set
//! and an atomic, crash-safe write of one record.
//!
//! ## Durability
//!
//! WAL journalling with `synchronous = FULL`. The usual advice for WAL is `NORMAL`, which is
//! faster and can lose the last transactions on an OS crash or a power cut. That trade is wrong
//! here: a superintendent's tablet losing power in a basement is the *expected* failure, not the
//! exotic one, and the write being durable is the whole promise of local-first. The cost is a
//! flush per commit, and commits are debounced by autosave rather than issued per pen stroke.
//!
//! ## Concurrency
//!
//! Writes are version-checked against the domain's optimistic-concurrency token. A stale write is
//! refused with both versions named, so a second reviewer's edit surfaces as a conflict somebody
//! resolves rather than as one of the two edits quietly disappearing.

pub mod schema;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sf_audit::{AuditError, AuditEvent, Outcome, Record};
use sf_domain::{
    ActorId, Calibration, CalibrationId, ContentHash, DocumentRevision, DocumentRevisionId,
    DomainError, Geometry, Markup, MarkupKind, MarkupMetadata, MarkupPatch, MarkupStatus, Project,
    ProjectId, Quantity, SourceDocument, SourceDocumentId, MODEL_VERSION,
};
use std::path::Path;
use std::str::FromStr;
use thiserror::Error;

/// What the store refused, or could not do.
#[derive(Debug, Error)]
pub enum StoreError {
    /// The database itself failed.
    ///
    /// The underlying message can contain a path, so anything that logs this must pass it through
    /// [`sf_audit::redact`] first.
    #[error("the project database could not be read or written")]
    Database(#[from] rusqlite::Error),

    /// A domain invariant was violated by data on its way in or out.
    #[error(transparent)]
    Domain(#[from] DomainError),

    /// The audit trail failed to extend or to verify.
    #[error(transparent)]
    Audit(#[from] AuditError),

    /// A stored JSON column did not parse. Means a corrupted or hand-edited file.
    #[error("a stored record is not in a form this version understands")]
    Corrupt,

    /// The row was not there.
    #[error("that {0} is not in this project")]
    NotFound(&'static str),

    /// The file was written by a newer build.
    ///
    /// Refused rather than opened: reading it would mean ignoring fields this build does not know
    /// about, and the next write would drop them permanently.
    #[error("this project was created by a newer version of SheetForge (format {found}, this build reads {supported})")]
    NewerFormat {
        /// The version in the file.
        found: u32,
        /// The newest this build understands.
        supported: u32,
    },

    /// The file already holds a project and a second was offered.
    #[error("this project file already contains a project")]
    AlreadyInitialised,
}

/// This crate's result alias.
pub type Result<T> = std::result::Result<T, StoreError>;

impl From<serde_json::Error> for StoreError {
    fn from(_: serde_json::Error) -> Self {
        // Deliberately dropped: a serde error quotes the offending input, which here is markup
        // content or document metadata.
        Self::Corrupt
    }
}

/// The project database.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open or create the database at `path`, running any outstanding migrations.
    ///
    /// # Errors
    /// If the file cannot be opened, if a migration fails, or if the file was written by a build
    /// newer than this one.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// An ephemeral store. Used by tests and by an import that is validated before being kept.
    ///
    /// # Errors
    /// If the schema cannot be created.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        // Referential integrity is off by default in SQLite and has to be asked for per
        // connection. Without it the ON DELETE CASCADE clauses in the schema are decoration.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // See the module docs: durability beats throughput for a tablet on a construction site.
        conn.pragma_update(None, "synchronous", "FULL")?;
        // Wait rather than fail when another connection holds the write lock — an autosave landing
        // while an export reads should queue, not error.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Bring the schema up to date.
    fn migrate(&mut self) -> Result<()> {
        let current: u32 = self
            .conn
            .query_row(
                "SELECT value FROM store_meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            // The table itself does not exist on a brand-new file, which is not an error.
            .unwrap_or(None)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);

        let newest = schema::MIGRATIONS.last().map_or(0, |m| m.version);
        if current > newest {
            return Err(StoreError::NewerFormat {
                found: current,
                supported: newest,
            });
        }

        for migration in schema::MIGRATIONS.iter().filter(|m| m.version > current) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO store_meta (key, value) VALUES ('schema_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![migration.version.to_string()],
            )?;
            tx.execute(
                "INSERT INTO store_meta (key, value) VALUES ('model_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![MODEL_VERSION.to_string()],
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    /// The schema version this file is at.
    ///
    /// # Errors
    /// If the metadata table cannot be read.
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .meta("schema_version")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM store_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    // -----------------------------------------------------------------------
    // Project
    // -----------------------------------------------------------------------

    /// Write the project this file holds. Once only — the file is the project.
    ///
    /// # Errors
    /// [`StoreError::AlreadyInitialised`] if a project is already stored here.
    pub fn create_project(&self, project: &Project) -> Result<()> {
        if self.project()?.is_some() {
            return Err(StoreError::AlreadyInitialised);
        }
        self.conn.execute(
            "INSERT INTO projects (id, name, job_number, description, created_at, updated_at, created_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                project.id.to_string(),
                project.name,
                project.job_number,
                project.description,
                stamp(project.created_at),
                stamp(project.updated_at),
                project.created_by.as_str(),
            ],
        )?;
        Ok(())
    }

    /// The project, if this file holds one.
    ///
    /// # Errors
    /// If the row cannot be read or does not parse.
    pub fn project(&self) -> Result<Option<Project>> {
        self.conn
            .query_row(
                "SELECT id, name, job_number, description, created_at, updated_at, created_by
                 FROM projects LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?
            .map(
                |(id, name, job_number, description, created_at, updated_at, created_by)| {
                    Ok(Project {
                        id: ProjectId::from_str(&id)?,
                        name,
                        job_number,
                        description,
                        created_at: parse_stamp(&created_at)?,
                        updated_at: parse_stamp(&updated_at)?,
                        created_by: ActorId::new(&created_by)?,
                    })
                },
            )
            .transpose()
    }

    // -----------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------

    /// Record a logical document.
    ///
    /// # Errors
    /// If the insert fails.
    pub fn insert_source_document(&self, document: &SourceDocument) -> Result<()> {
        self.conn.execute(
            "INSERT INTO source_documents (id, project_id, name, discipline, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                document.id.to_string(),
                document.project_id.to_string(),
                document.name,
                document.discipline,
                stamp(document.created_at),
            ],
        )?;
        Ok(())
    }

    /// Record an imported revision.
    ///
    /// # Errors
    /// If the insert fails, including when the document it names is not in this project.
    pub fn insert_revision(&self, revision: &DocumentRevision) -> Result<()> {
        self.conn.execute(
            "INSERT INTO document_revisions
               (id, project_id, source_document_id, revision_label, content_sha256, byte_len,
                page_count, imported_at, imported_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                revision.id.to_string(),
                revision.project_id.to_string(),
                revision.source_document_id.to_string(),
                revision.revision_label,
                revision.content_sha256.to_hex(),
                to_sql_int(revision.byte_len)?,
                revision.page_count,
                stamp(revision.imported_at),
                revision.imported_by.as_str(),
            ],
        )?;
        Ok(())
    }

    /// Every document in the project, in creation order.
    ///
    /// # Errors
    /// If the query fails or a row does not parse.
    pub fn source_documents(&self, project: ProjectId) -> Result<Vec<SourceDocument>> {
        let mut statement = self.conn.prepare(
            "SELECT id, project_id, name, discipline, created_at
             FROM source_documents WHERE project_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map(params![project.to_string()], |row| {
            let id: String = row.get(0)?;
            let project_id: String = row.get(1)?;
            let name: String = row.get(2)?;
            let discipline: Option<String> = row.get(3)?;
            let created_at: String = row.get(4)?;
            Ok((|| {
                Ok(SourceDocument {
                    id: SourceDocumentId::from_str(&id)?,
                    project_id: ProjectId::from_str(&project_id)?,
                    name,
                    discipline,
                    created_at: parse_stamp(&created_at)?,
                })
            })())
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect()
    }

    /// The revision holding these exact bytes, if this project already has one.
    ///
    /// What makes reopening a file return you to your markups instead of silently creating a
    /// second revision of the same drawing and appearing to lose them.
    ///
    /// # Errors
    /// If the query fails or the row does not parse.
    pub fn revision_by_hash(&self, hash: ContentHash) -> Result<Option<DocumentRevision>> {
        self.conn
            .query_row(
                "SELECT id, project_id, source_document_id, revision_label, content_sha256,
                        byte_len, page_count, imported_at, imported_by
                 FROM document_revisions WHERE content_sha256 = ?1 ORDER BY id LIMIT 1",
                params![hash.to_hex()],
                read_revision,
            )
            .optional()?
            .transpose()
    }

    /// One revision by id.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] if there is no such revision.
    pub fn revision(&self, id: DocumentRevisionId) -> Result<DocumentRevision> {
        self.conn
            .query_row(
                "SELECT id, project_id, source_document_id, revision_label, content_sha256,
                        byte_len, page_count, imported_at, imported_by
                 FROM document_revisions WHERE id = ?1",
                params![id.to_string()],
                read_revision,
            )
            .optional()?
            .ok_or(StoreError::NotFound("drawing revision"))?
    }

    /// Every revision of one document, oldest first.
    ///
    /// # Errors
    /// If the query fails or a row does not parse.
    pub fn revisions_of(&self, document: SourceDocumentId) -> Result<Vec<DocumentRevision>> {
        let mut statement = self.conn.prepare(
            "SELECT id, project_id, source_document_id, revision_label, content_sha256,
                    byte_len, page_count, imported_at, imported_by
             FROM document_revisions WHERE source_document_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map(params![document.to_string()], read_revision)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect()
    }

    // -----------------------------------------------------------------------
    // Calibration
    // -----------------------------------------------------------------------

    /// Set a page's scale, replacing any scale already on it.
    ///
    /// # Errors
    /// If the write fails.
    pub fn set_calibration(
        &self,
        revision: DocumentRevisionId,
        calibration: &Calibration,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO calibrations
               (id, document_revision_id, page, units_per_page_unit, unit, source, preset_label, is_verified)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(document_revision_id, page) DO UPDATE SET
               id = excluded.id,
               units_per_page_unit = excluded.units_per_page_unit,
               unit = excluded.unit,
               source = excluded.source,
               preset_label = excluded.preset_label,
               is_verified = excluded.is_verified",
            params![
                calibration.id.to_string(),
                revision.to_string(),
                calibration.page,
                calibration.units_per_page_unit,
                calibration.unit,
                serde_json::to_string(&calibration.source)?.trim_matches('"'),
                calibration.preset_label,
                i32::from(calibration.is_verified),
            ],
        )?;
        Ok(())
    }

    /// The scale on one page, if it has one.
    ///
    /// # Errors
    /// If the query fails or the row does not parse.
    pub fn calibration(
        &self,
        revision: DocumentRevisionId,
        page: u32,
    ) -> Result<Option<Calibration>> {
        self.conn
            .query_row(
                "SELECT id, page, units_per_page_unit, unit, source, preset_label, is_verified
                 FROM calibrations WHERE document_revision_id = ?1 AND page = ?2",
                params![revision.to_string(), page],
                read_calibration,
            )
            .optional()?
            .transpose()
    }

    // -----------------------------------------------------------------------
    // Markups
    // -----------------------------------------------------------------------

    /// Store a new markup.
    ///
    /// # Errors
    /// If the insert fails, including when the revision it names is not in this project.
    pub fn insert_markup(&self, markup: &Markup) -> Result<()> {
        self.conn.execute(
            "INSERT INTO markups
               (id, project_id, document_revision_id, page, kind, status, geometry_schema,
                geometry, metadata, quantity, version, created_by, created_at, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                markup.id.to_string(),
                markup.project_id.to_string(),
                markup.document_revision_id.to_string(),
                markup.page,
                markup.kind.as_str(),
                markup.status.as_str(),
                markup.geometry.schema_version,
                serde_json::to_string(&markup.geometry.data)?,
                serde_json::to_string(&markup.metadata)?,
                markup.quantity.as_ref().map(serde_json::to_string).transpose()?,
                to_sql_int(markup.version)?,
                markup.created_by.as_str(),
                stamp(markup.created_at),
                markup.updated_by.as_str(),
                stamp(markup.updated_at),
            ],
        )?;
        Ok(())
    }

    /// One markup by id.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] if there is no such markup.
    pub fn markup(&self, id: sf_domain::MarkupId) -> Result<Markup> {
        self.conn
            .query_row(
                &format!("{MARKUP_COLUMNS} WHERE id = ?1"),
                params![id.to_string()],
                read_markup,
            )
            .optional()?
            .ok_or(StoreError::NotFound("markup"))?
    }

    /// Every markup on one page, in creation order.
    ///
    /// # Errors
    /// If the query fails or a row does not parse.
    pub fn markups_on_page(&self, revision: DocumentRevisionId, page: u32) -> Result<Vec<Markup>> {
        let mut statement = self.conn.prepare(&format!(
            "{MARKUP_COLUMNS} WHERE document_revision_id = ?1 AND page = ?2 ORDER BY id"
        ))?;
        let rows = statement.query_map(params![revision.to_string(), page], read_markup)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect()
    }

    /// Every markup against one revision, in creation order.
    ///
    /// # Errors
    /// If the query fails or a row does not parse.
    pub fn markups(&self, revision: DocumentRevisionId) -> Result<Vec<Markup>> {
        let mut statement = self.conn.prepare(&format!(
            "{MARKUP_COLUMNS} WHERE document_revision_id = ?1 ORDER BY id"
        ))?;
        let rows = statement.query_map(params![revision.to_string()], read_markup)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect()
    }

    /// Apply a patch under an optimistic-concurrency check.
    ///
    /// Read, apply and write happen in one transaction, so two concurrent writers cannot both read
    /// version *n*, both pass the check and both write version *n+1*.
    ///
    /// # Errors
    /// - [`StoreError::NotFound`] if the markup is gone.
    /// - [`DomainError::VersionConflict`] if `base_version` is stale.
    /// - [`DomainError::IllegalTransition`] for a status move the workflow forbids.
    pub fn update_markup(
        &mut self,
        id: sf_domain::MarkupId,
        patch: MarkupPatch,
        base_version: u64,
        actor: ActorId,
    ) -> Result<Markup> {
        let tx = self.conn.transaction()?;
        let mut markup = tx
            .query_row(
                &format!("{MARKUP_COLUMNS} WHERE id = ?1"),
                params![id.to_string()],
                read_markup,
            )
            .optional()?
            .ok_or(StoreError::NotFound("markup"))??;

        markup.apply(patch, base_version, actor)?;

        tx.execute(
            "UPDATE markups SET
               page = ?2, status = ?3, geometry_schema = ?4, geometry = ?5, metadata = ?6,
               quantity = ?7, version = ?8, updated_by = ?9, updated_at = ?10
             WHERE id = ?1",
            params![
                markup.id.to_string(),
                markup.page,
                markup.status.as_str(),
                markup.geometry.schema_version,
                serde_json::to_string(&markup.geometry.data)?,
                serde_json::to_string(&markup.metadata)?,
                markup
                    .quantity
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                to_sql_int(markup.version)?,
                markup.updated_by.as_str(),
                stamp(markup.updated_at),
            ],
        )?;
        tx.commit()?;
        Ok(markup)
    }

    /// Remove a markup, refusing a stale delete for the same reason an update is refused.
    ///
    /// # Errors
    /// [`StoreError::NotFound`] or [`DomainError::VersionConflict`].
    pub fn delete_markup(&mut self, id: sf_domain::MarkupId, base_version: u64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let stored: Option<i64> = tx
            .query_row(
                "SELECT version FROM markups WHERE id = ?1",
                params![id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let stored = from_sql_int(stored.ok_or(StoreError::NotFound("markup"))?)?;
        if stored != base_version {
            return Err(DomainError::VersionConflict {
                expected: base_version,
                found: stored,
            }
            .into());
        }
        tx.execute("DELETE FROM markups WHERE id = ?1", params![id.to_string()])?;
        tx.commit()?;
        Ok(())
    }

    /// How many markups are in each status, for the review board.
    ///
    /// # Errors
    /// If the query fails.
    pub fn status_counts(&self) -> Result<Vec<(MarkupStatus, u64)>> {
        let mut statement = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM markups GROUP BY status ORDER BY status")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(status, count)| Ok((MarkupStatus::from_str(&status)?, from_sql_int(count)?)))
            .collect()
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    /// Append to the audit trail, linking to whatever is currently last.
    ///
    /// # Errors
    /// If the read of the tail or the insert fails, or the event is malformed.
    pub fn append_audit(
        &mut self,
        actor: &ActorId,
        action: &str,
        outcome: Outcome,
        record: Record,
    ) -> Result<AuditEvent> {
        let tx = self.conn.transaction()?;
        let previous = read_last_audit(&tx)?;
        let event = AuditEvent::new(
            previous.as_ref(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            actor.as_str().to_owned(),
            action.to_owned(),
            outcome,
            record,
        )?;
        insert_audit(&tx, &event)?;
        tx.commit()?;
        Ok(event)
    }

    /// The whole trail, oldest first.
    ///
    /// # Errors
    /// If the query fails or a row does not parse.
    pub fn audit_events(&self) -> Result<Vec<AuditEvent>> {
        let mut statement = self.conn.prepare(
            "SELECT seq, at, actor, action, outcome, reason, subject_id, subject_kind,
                    document_revision_id, page, detail, prev_hash, chain_hash
             FROM audit_events ORDER BY seq",
        )?;
        let rows = statement.query_map([], read_audit)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect()
    }

    /// Verify the trail end to end.
    ///
    /// # Errors
    /// [`AuditError::ChainBroken`] naming the first entry that fails.
    pub fn verify_audit(&self) -> Result<()> {
        sf_audit::verify_chain(&self.audit_events()?)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/// SQLite's `INTEGER` is a signed 64-bit value, so the model's unsigned counters cross the
/// boundary explicitly rather than by cast.
///
/// Neither direction is reachable in practice — a version counter would need 9×10^18 edits to
/// overflow — but converting rather than casting means a negative value in a corrupted or
/// hand-edited file surfaces as a parse failure instead of an enormous plausible number.
fn to_sql_int(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| StoreError::Corrupt)
}

fn from_sql_int(value: i64) -> std::result::Result<u64, DomainError> {
    u64::try_from(value).map_err(|_| DomainError::Malformed {
        subject: "stored counter",
    })
}

const MARKUP_COLUMNS: &str = "SELECT id, project_id, document_revision_id, page, kind, status,
        geometry_schema, geometry, metadata, quantity, version, created_by, created_at,
        updated_by, updated_at FROM markups";

fn stamp(at: DateTime<Utc>) -> String {
    // Millisecond precision, always with the `Z` suffix: one spelling, so a string comparison
    // orders correctly and a round trip is byte-identical.
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_stamp(value: &str) -> std::result::Result<DateTime<Utc>, DomainError> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| DomainError::Malformed {
            subject: "timestamp",
        })
}

#[allow(clippy::type_complexity)]
fn read_revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<DocumentRevision>> {
    let id: String = row.get(0)?;
    let project_id: String = row.get(1)?;
    let source_document_id: String = row.get(2)?;
    let revision_label: Option<String> = row.get(3)?;
    let content_sha256: String = row.get(4)?;
    let byte_len: i64 = row.get(5)?;
    let page_count: u32 = row.get(6)?;
    let imported_at: String = row.get(7)?;
    let imported_by: String = row.get(8)?;

    Ok((|| {
        Ok(DocumentRevision {
            id: DocumentRevisionId::from_str(&id)?,
            project_id: ProjectId::from_str(&project_id)?,
            source_document_id: SourceDocumentId::from_str(&source_document_id)?,
            revision_label,
            content_sha256: ContentHash::from_hex(&content_sha256)?,
            byte_len: from_sql_int(byte_len)?,
            page_count,
            imported_at: parse_stamp(&imported_at)?,
            imported_by: ActorId::new(&imported_by)?,
        })
    })())
}

fn read_calibration(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Calibration>> {
    let id: String = row.get(0)?;
    let page: u32 = row.get(1)?;
    let units_per_page_unit: f64 = row.get(2)?;
    let unit: String = row.get(3)?;
    let source: String = row.get(4)?;
    let preset_label: Option<String> = row.get(5)?;
    let is_verified: i32 = row.get(6)?;

    Ok((|| {
        let source = serde_json::from_str(&format!("\"{source}\""))?;
        Ok(Calibration {
            id: CalibrationId::from_str(&id)?,
            page,
            units_per_page_unit,
            unit,
            source,
            preset_label,
            is_verified: is_verified != 0,
        })
    })())
}

fn read_markup(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Markup>> {
    let id: String = row.get(0)?;
    let project_id: String = row.get(1)?;
    let document_revision_id: String = row.get(2)?;
    let page: u32 = row.get(3)?;
    let kind: String = row.get(4)?;
    let status: String = row.get(5)?;
    let geometry_schema: u16 = row.get(6)?;
    let geometry: String = row.get(7)?;
    let metadata: String = row.get(8)?;
    let quantity: Option<String> = row.get(9)?;
    let version: i64 = row.get(10)?;
    let created_by: String = row.get(11)?;
    let created_at: String = row.get(12)?;
    let updated_by: String = row.get(13)?;
    let updated_at: String = row.get(14)?;

    Ok((|| {
        let kind: MarkupKind = serde_json::from_str(&format!("\"{kind}\""))?;
        let metadata: MarkupMetadata = serde_json::from_str(&metadata)?;
        let quantity: Option<Quantity> =
            quantity.as_deref().map(serde_json::from_str).transpose()?;
        Ok(Markup {
            id: sf_domain::MarkupId::from_str(&id)?,
            project_id: ProjectId::from_str(&project_id)?,
            document_revision_id: DocumentRevisionId::from_str(&document_revision_id)?,
            page,
            kind,
            status: MarkupStatus::from_str(&status)?,
            geometry: Geometry::new(geometry_schema, serde_json::from_str(&geometry)?)?,
            metadata,
            quantity,
            version: from_sql_int(version)?,
            created_by: ActorId::new(&created_by)?,
            created_at: parse_stamp(&created_at)?,
            updated_by: ActorId::new(&updated_by)?,
            updated_at: parse_stamp(&updated_at)?,
        })
    })())
}

fn read_audit(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<AuditEvent>> {
    let seq: i64 = row.get(0)?;
    let at: String = row.get(1)?;
    let actor: String = row.get(2)?;
    let action: String = row.get(3)?;
    let outcome: String = row.get(4)?;
    let reason: Option<String> = row.get(5)?;
    let subject_id: Option<String> = row.get(6)?;
    let subject_kind: Option<String> = row.get(7)?;
    let document_revision_id: Option<String> = row.get(8)?;
    let page: Option<u32> = row.get(9)?;
    let detail: String = row.get(10)?;
    let prev_hash: String = row.get(11)?;
    let chain_hash: String = row.get(12)?;

    Ok((|| {
        Ok(AuditEvent {
            seq: from_sql_int(seq)?,
            at,
            actor,
            action,
            outcome: serde_json::from_str(&format!("\"{outcome}\""))?,
            reason,
            subject_id,
            subject_kind,
            document_revision_id,
            page,
            detail: serde_json::from_str(&detail)?,
            prev_hash,
            chain_hash,
        })
    })())
}

fn read_last_audit(tx: &Transaction<'_>) -> Result<Option<AuditEvent>> {
    tx.query_row(
        "SELECT seq, at, actor, action, outcome, reason, subject_id, subject_kind,
                document_revision_id, page, detail, prev_hash, chain_hash
         FROM audit_events ORDER BY seq DESC LIMIT 1",
        [],
        read_audit,
    )
    .optional()?
    .transpose()
}

fn insert_audit(tx: &Transaction<'_>, event: &AuditEvent) -> Result<()> {
    tx.execute(
        "INSERT INTO audit_events
           (seq, at, actor, action, outcome, reason, subject_id, subject_kind,
            document_revision_id, page, detail, prev_hash, chain_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            to_sql_int(event.seq)?,
            event.at,
            event.actor,
            event.action,
            event.outcome.as_str(),
            event.reason,
            event.subject_id,
            event.subject_kind,
            event.document_revision_id,
            event.page,
            serde_json::to_string(&event.detail)?,
            event.prev_hash,
            event.chain_hash,
        ],
    )?;
    Ok(())
}
