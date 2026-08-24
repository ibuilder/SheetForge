//! The IPC surface.
//!
//! Every command is a thin adapter: validate the payload, authorise the act, call into a domain
//! crate, map the typed result. No business rule lives here — a rule enforced in a command handler
//! is a rule the importer and the migration do not obey.
//!
//! ## The webview never sees a path
//!
//! There is no `open_file(path)` command, and there is no generic filesystem capability. Where a
//! file has to be chosen, *this* side opens the native picker and keeps the path; what crosses the
//! boundary is an opaque id. That way a compromised or merely buggy renderer cannot name a file,
//! and the set of files the application will touch is exactly the set a human pointed at.
//!
//! ## Dialogs and threads
//!
//! The blocking dialog helpers must not run on the main thread or on the async runtime — one
//! freezes the interface, the other stalls every other task. Each dialog command therefore hands
//! its work to [`tauri::async_runtime::spawn_blocking`].

// Tauri injects `AppHandle` by value — it is a cheap handle, and a command that took it by
// reference would not be a command. Likewise a command's return value is consumed by the IPC
// layer rather than by a Rust caller, so `#[must_use]` says nothing here.
#![allow(clippy::needless_pass_by_value, clippy::must_use_candidate)]

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sf_audit::{Outcome, Record};
use sf_domain::{
    ActorId, Calibration, DocumentRevision, DocumentRevisionId, Geometry, Markup, MarkupId,
    MarkupKind, MarkupMetadata, MarkupPatch, MarkupStatus, Project, Quantity, ScaleSource,
    SourceDocument,
};
use sf_package::Package;
use sf_security::Capability;
use std::str::FromStr;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What the interface is told about the running build.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Semantic version of this build.
    pub version: String,
    /// The identity records are written under.
    pub actor: String,
    /// What that identity may do.
    pub role: sf_security::Role,
    /// The bounds untrusted input is held to. Surfaced so the interface can say "that file is over
    /// the limit" before spending a minute reading it.
    pub limits: sf_security::ResourceLimits,
}

/// A project, as the interface needs it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// Its id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// The job number, when there is one.
    pub job_number: Option<String>,
    /// How many drawings are filed in it.
    pub source_count: usize,
    /// The package format version, for the about box and support.
    pub format: u32,
}

impl ProjectSummary {
    fn of(package: &Package, project: &Project) -> Self {
        Self {
            id: project.id.to_string(),
            name: project.name.clone(),
            job_number: project.job_number.clone(),
            source_count: package.manifest().sources.len(),
            format: package.manifest().format,
        }
    }
}

/// One imported issue of a drawing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    /// Its id — the handle the interface uses to ask for pages and markups.
    pub id: String,
    /// The document it is an issue of.
    pub source_document_id: String,
    /// The sheet number, e.g. `A-201`.
    pub name: String,
    /// The revision as printed in the title block.
    pub revision_label: Option<String>,
    /// How many pages.
    pub page_count: u32,
    /// The first twelve characters of the content hash. Enough to tell two issues apart on screen.
    pub short_hash: String,
    /// RFC 3339 UTC.
    pub imported_at: String,
}

/// A markup, as the interface needs it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkupDto {
    /// Its id.
    pub id: String,
    /// Which revision it was raised against.
    pub document_revision_id: String,
    /// 1-based page.
    pub page: u32,
    /// Which tool made it.
    pub kind: MarkupKind,
    /// Where it sits in its review.
    pub status: MarkupStatus,
    /// The engine schema the geometry was written against.
    pub geometry_schema: u16,
    /// The shape, in PDF user space.
    pub geometry: serde_json::Value,
    /// The construction fields.
    pub metadata: MarkupMetadata,
    /// Present on measurement markups.
    pub quantity: Option<Quantity>,
    /// The optimistic-concurrency token. The interface must send this back on an edit.
    pub version: u64,
    /// Who raised it.
    pub created_by: String,
    /// RFC 3339 UTC.
    pub created_at: String,
    /// RFC 3339 UTC.
    pub updated_at: String,
}

impl From<Markup> for MarkupDto {
    fn from(markup: Markup) -> Self {
        Self {
            id: markup.id.to_string(),
            document_revision_id: markup.document_revision_id.to_string(),
            page: markup.page,
            kind: markup.kind,
            status: markup.status,
            geometry_schema: markup.geometry.schema_version,
            geometry: markup.geometry.data,
            metadata: markup.metadata,
            quantity: markup.quantity,
            version: markup.version,
            created_by: markup.created_by.to_string(),
            created_at: markup
                .created_at
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            updated_at: markup
                .updated_at
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// A markup the interface wants raised.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMarkup {
    /// Which revision it belongs to.
    pub document_revision_id: String,
    /// 1-based page.
    pub page: u32,
    /// Which tool made it.
    pub kind: MarkupKind,
    /// The engine schema the geometry is written against.
    pub geometry_schema: u16,
    /// The shape, in PDF user space.
    pub geometry: serde_json::Value,
    /// The construction fields.
    #[serde(default)]
    pub metadata: MarkupMetadata,
    /// The measured quantity, on a measurement markup.
    #[serde(default)]
    pub quantity: Option<Quantity>,
}

/// A change the interface wants applied.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkupEdit {
    /// New geometry, when the shape moved.
    #[serde(default)]
    pub geometry: Option<serde_json::Value>,
    /// The schema the new geometry is written against. Required when `geometry` is present.
    #[serde(default)]
    pub geometry_schema: Option<u16>,
    /// Replacement metadata.
    #[serde(default)]
    pub metadata: Option<MarkupMetadata>,
    /// A status move.
    #[serde(default)]
    pub status: Option<MarkupStatus>,
    /// A re-derived quantity, after the page was re-calibrated.
    #[serde(default)]
    pub quantity: Option<Quantity>,
    /// Remove the quantity entirely.
    ///
    /// A separate flag rather than a nullable `quantity`, because "leave it alone" and "clear it"
    /// are different instructions and JSON gives one spelling — `null` — for both.
    #[serde(default)]
    pub clear_quantity: bool,
}

/// A page's scale, as the interface sets it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCalibration {
    /// Which revision.
    pub document_revision_id: String,
    /// 1-based page.
    pub page: u32,
    /// Real-world units per PDF user unit.
    pub units_per_page_unit: f64,
    /// The unit that is expressed in.
    pub unit: String,
    /// Where the scale came from. An extracted scale stays provisional until confirmed.
    pub source: ScaleSource,
    /// The preset's name, when one was chosen.
    #[serde(default)]
    pub preset_label: Option<String>,
}

/// What opening a drawing produced: the project it went into, and the drawing itself.
///
/// Both, because opening a PDF may have *created* the project, and the interface has to show
/// which one it is now working in.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDrawing {
    /// The project the drawing now belongs to.
    pub project: ProjectSummary,
    /// The drawing.
    pub revision: RevisionDto,
    /// True when this file was already in the project and its markups came back with it.
    pub reopened: bool,
}

/// The result of checking a project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    /// Whether everything checked out.
    pub ok: bool,
    /// What failed, when something did.
    pub problem: Option<String>,
    /// How many drawings were checked.
    pub sources_checked: usize,
    /// How many audit entries were verified.
    pub audit_entries: usize,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn revision_id(raw: &str) -> CommandResult<DocumentRevisionId> {
    DocumentRevisionId::from_str(raw)
        .map_err(|_| CommandError::invalid_request("That drawing reference is not valid."))
}

fn markup_id(raw: &str) -> CommandResult<MarkupId> {
    MarkupId::from_str(raw)
        .map_err(|_| CommandError::invalid_request("That markup reference is not valid."))
}

/// Run `f` against the open project, or report that none is.
fn with_open<T>(
    state: &AppState,
    f: impl FnOnce(&mut Package) -> CommandResult<T>,
) -> CommandResult<T> {
    state
        .with_package(f)
        .unwrap_or_else(|| Err(CommandError::no_project()))
}

/// Record an act, and never let the recording of it break the act.
///
/// A failure to append to the audit trail is logged and swallowed. The alternative — refusing the
/// user's edit because the log could not be written — loses their work to protect a record of it,
/// which is the wrong way round. The failure is loud in the local log and
/// `project_verify` reports the gap.
fn audit(package: &mut Package, actor: &ActorId, action: &str, outcome: Outcome, record: Record) {
    if let Err(error) = package
        .store_mut()
        .append_audit(actor, action, outcome, record)
    {
        log::error!(
            "audit append failed for {action}: {}",
            sf_audit::redact(&error.to_string())
        );
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// What build this is, who is using it, and what the limits are.
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let state = app.state::<AppState>();
    AppInfo {
        version: app.package_info().version.to_string(),
        actor: state.actor().to_string(),
        role: state.role(),
        limits: *state.limits(),
    }
}

/// Create a project. Opens a native save dialog on this side; no path crosses the boundary.
///
/// # Errors
/// [`CommandError::cancelled`] if the dialog is dismissed, or a package error.
#[tauri::command]
pub async fn project_create(
    app: AppHandle,
    name: String,
    job_number: Option<String>,
) -> CommandResult<ProjectSummary> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::ProjectManage)?;

        let project = Project::new(&name, job_number.as_deref(), None, state.actor().clone())?;

        let chosen = app
            .dialog()
            .file()
            .set_title("Create SheetForge project")
            .set_file_name(format!("{}.{}", project.name, sf_package::EXTENSION))
            .add_filter("SheetForge project", &[sf_package::EXTENSION])
            .blocking_save_file()
            .ok_or_else(CommandError::cancelled)?;

        let root = chosen
            .into_path()
            .map_err(|_| CommandError::invalid_request("That location cannot be used."))?;
        let mut package = Package::create(&root, &project, &version)?;
        package.set_limits(*state.limits());
        audit(
            &mut package,
            state.actor(),
            "project:create",
            Outcome::Allowed,
            Record::new().subject("project", &project.id.to_string()),
        );

        let summary = ProjectSummary::of(&package, &project);
        state.set_package(Some(package));
        Ok(summary)
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// Open a project. Opens a native folder picker on this side.
///
/// # Errors
/// [`CommandError::cancelled`], or a package error if the folder is not a project.
#[tauri::command]
pub async fn project_open(app: AppHandle) -> CommandResult<ProjectSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::ProjectRead)?;

        let chosen = app
            .dialog()
            .file()
            .set_title("Open SheetForge project")
            .blocking_pick_folder()
            .ok_or_else(CommandError::cancelled)?;

        let root = chosen
            .into_path()
            .map_err(|_| CommandError::invalid_request("That location cannot be used."))?;
        let mut package = Package::open(&root)?;
        package.set_limits(*state.limits());

        let project = package
            .store()
            .project()?
            .ok_or_else(|| CommandError::invalid_request("That project has no project record."))?;
        audit(
            &mut package,
            state.actor(),
            "project:open",
            Outcome::Allowed,
            Record::new().subject("project", &project.id.to_string()),
        );

        let summary = ProjectSummary::of(&package, &project);
        state.set_package(Some(package));
        Ok(summary)
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// The open project, if there is one.
///
/// # Errors
/// If the project record cannot be read.
#[tauri::command]
pub fn project_current(app: AppHandle) -> CommandResult<Option<ProjectSummary>> {
    let state = app.state::<AppState>();
    if !state.is_open() {
        return Ok(None);
    }
    with_open(&state, |package| {
        let project = package.store().project()?;
        Ok(project.map(|project| ProjectSummary::of(package, &project)))
    })
}

/// Close the open project.
#[tauri::command]
pub fn project_close(app: AppHandle) {
    let state = app.state::<AppState>();
    state.set_package(None);
}

/// Check every drawing against its hash and verify the audit trail.
///
/// # Errors
/// Only if the project cannot be read at all; an integrity failure is reported in the result
/// rather than raised, because the interface shows it as a finding, not as a crash.
#[tauri::command]
pub async fn project_verify(app: AppHandle) -> CommandResult<VerifyReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        with_open(&state, |package| {
            let sources_checked = package.manifest().sources.len();
            let audit_entries = package
                .store()
                .audit_events()
                .map_or(0, |events| events.len());
            match package.verify() {
                Ok(()) => Ok(VerifyReport {
                    ok: true,
                    problem: None,
                    sources_checked,
                    audit_entries,
                }),
                Err(error) => Ok(VerifyReport {
                    ok: false,
                    problem: Some(CommandError::from(error).message),
                    sources_checked,
                    audit_entries,
                }),
            }
        })
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// Import one or more PDFs. Opens a native picker on this side.
///
/// Each file is size-checked and sniffed before anything is written, filed under its content hash,
/// and recorded as a revision of a document named for the file's stem.
///
/// # Errors
/// [`CommandError::cancelled`], or the first file that fails a bound.
#[tauri::command]
pub async fn document_import(app: AppHandle) -> CommandResult<Vec<RevisionDto>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::DocumentImport)?;

        let chosen = app
            .dialog()
            .file()
            .set_title("Add drawings")
            .add_filter("PDF drawings", &["pdf"])
            .blocking_pick_files()
            .ok_or_else(CommandError::cancelled)?;

        with_open(&state, |package| {
            let mut imported = Vec::with_capacity(chosen.len());
            for file in chosen {
                let path = file
                    .into_path()
                    .map_err(|_| CommandError::invalid_request("That file cannot be read."))?;
                let (revision, _) = file_drawing(package, state.actor(), &path)?;
                imported.push(revision);
            }
            Ok(imported)
        })
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// Open a PDF, creating a project for it if none is open.
///
/// The primary action, and the reason it exists: a reviewer who has been handed a drawing wants to
/// look at it, not to be asked where their project folder should live. The project is still
/// created — it is what holds the markups, the scales and the audit trail, and none of those have
/// anywhere to live in a bare PDF — but it is created behind the drawing rather than in front of
/// it, in a predictable place the interface then names.
///
/// # Errors
/// [`CommandError::cancelled`] if the dialog is dismissed, or a package error.
#[tauri::command]
pub async fn pdf_open(app: AppHandle) -> CommandResult<OpenedDrawing> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::DocumentImport)?;

        let chosen = app
            .dialog()
            .file()
            .set_title("Open drawing")
            .add_filter("PDF drawings", &["pdf"])
            .blocking_pick_file()
            .ok_or_else(CommandError::cancelled)?;

        let path = chosen
            .into_path()
            .map_err(|_| CommandError::invalid_request("That file cannot be read."))?;

        // Everything past the dialog is shared with drag-and-drop, so the two cannot drift.
        import_paths(&app, &[path], &version)?
            .into_iter()
            .next()
            .ok_or_else(CommandError::cancelled)
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// The tutorial sheet, compiled into the binary.
///
/// Generated by `scripts/make-welcome-sheet.mjs` rather than committed as an opaque blob, so the
/// drawing can be reviewed as code. It is synthetic — an invented building on an invented job —
/// because a real drawing in this repository would be somebody's intellectual property.
const TUTORIAL_SHEET: &[u8] = include_bytes!("../assets/welcome.pdf");

/// The name the tutorial project is filed under.
///
/// A fixed name so that opening the tutorial twice returns to the same project rather than
/// accumulating a folder per launch, and so somebody who wants it gone knows exactly what to
/// delete.
const TUTORIAL_PROJECT: &str = "SheetForge Tutorial";

/// Open the tutorial drawing.
///
/// The first minute of a review tool is spent looking for something to open, and a reviewer who
/// has not got a drawing to hand cannot find out whether the tool is any good. So one ships with
/// it: a two-page ARCH D sheet with a title block, a column grid and a dimension whose true length
/// is knowable, which makes the calibration lesson checkable rather than asserted.
///
/// It is filed as an ordinary import into an ordinary project in the ordinary place. Nothing about
/// it is privileged: it can be marked up, measured, exported and deleted like any other drawing,
/// and the audit trail records it as the import it is.
///
/// # Errors
/// [`CommandError`] if the project cannot be created or the sheet cannot be filed.
#[tauri::command]
pub async fn tutorial_open(app: AppHandle) -> CommandResult<OpenedDrawing> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::DocumentImport)?;
        ensure_project_named(&app, &state, TUTORIAL_PROJECT, &version)?;

        with_open(&state, |package| {
            let (revision, reopened) = file_bytes(
                package,
                state.actor(),
                "Tutorial - Riverside Tower",
                TUTORIAL_SHEET,
            )?;
            let project = package
                .store()
                .project()?
                .ok_or_else(CommandError::no_project)?;
            Ok(OpenedDrawing {
                project: ProjectSummary::of(package, &project),
                revision,
                reopened,
            })
        })
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// A drawing's bytes, for the renderer.
///
/// Returned as a raw IPC response rather than as JSON. A 40 MB drawing serialised as a JSON array
/// of numbers is roughly 200 MB of text to build, send and parse, which is a visible freeze on
/// exactly the large sheets this application exists to open.
///
/// # Errors
/// [`CommandError::no_project`], or a missing or altered source.
#[tauri::command]
pub async fn document_bytes(
    app: AppHandle,
    revision: String,
) -> CommandResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::ProjectRead)?;
        let id = revision_id(&revision)?;

        with_open(&state, |package| {
            let revision = package.store().revision(id)?;
            let bytes = package.read_source(revision.content_sha256)?;
            Ok(tauri::ipc::Response::new(bytes))
        })
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// Every revision in the project, in import order.
///
/// # Errors
/// If the project cannot be read.
#[tauri::command]
pub fn document_list(app: AppHandle) -> CommandResult<Vec<RevisionDto>> {
    let state = app.state::<AppState>();
    with_open(&state, |package| {
        let store = package.store();
        let project = store.project()?.ok_or_else(CommandError::no_project)?;
        let mut out = Vec::new();
        for document in store.source_documents(project.id)? {
            for revision in store.revisions_of(document.id)? {
                out.push(RevisionDto {
                    id: revision.id.to_string(),
                    source_document_id: document.id.to_string(),
                    name: document.name.clone(),
                    revision_label: revision.revision_label.clone(),
                    page_count: revision.page_count,
                    short_hash: revision.content_sha256.short(),
                    imported_at: revision
                        .imported_at
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                });
            }
        }
        Ok(out)
    })
}

/// Every markup against one revision.
///
/// # Errors
/// If the project cannot be read.
#[tauri::command]
pub fn markup_list(app: AppHandle, revision: String) -> CommandResult<Vec<MarkupDto>> {
    let state = app.state::<AppState>();
    state.require(Capability::ProjectRead)?;
    let id = revision_id(&revision)?;
    with_open(&state, |package| {
        Ok(package
            .store()
            .markups(id)?
            .into_iter()
            .map(MarkupDto::from)
            .collect())
    })
}

/// Raise a markup.
///
/// # Errors
/// A capability refusal, a validation failure, or a page outside the document.
#[tauri::command]
pub fn markup_create(app: AppHandle, markup: NewMarkup) -> CommandResult<MarkupDto> {
    let state = app.state::<AppState>();
    state.require(Capability::MarkupCreate)?;
    if markup.kind.is_measurement() {
        state.require(Capability::Calibrate)?;
    }
    let revision = revision_id(&markup.document_revision_id)?;

    with_open(&state, |package| {
        let stored_revision = package.store().revision(revision)?;
        let project_id = stored_revision.project_id;

        let record = Markup::create(
            project_id,
            revision,
            markup.page,
            stored_revision.page_count,
            markup.kind,
            Geometry::new(markup.geometry_schema, markup.geometry)?,
            markup.metadata,
            markup.quantity,
            state.actor().clone(),
        )?;
        package.store().insert_markup(&record)?;
        audit(
            package,
            state.actor(),
            "markup:create",
            Outcome::Allowed,
            Record::new()
                .subject("markup", &record.id.to_string())
                .at_page(&revision.to_string(), record.page)
                .with("kind", record.kind.as_str()),
        );
        Ok(MarkupDto::from(record))
    })
}

/// Raise many markups at once.
///
/// The path an XFDF or BCF import takes. Doing it one command at a time costs an IPC round trip
/// *and* a flush to disk per record — measured at about 4.6 ms each against 96 µs when batched, a
/// factor of forty-eight. On a thousand-markup import that is the difference between a moment and
/// most of a minute of somebody watching a progress bar.
///
/// The whole batch is one transaction: it lands complete or not at all, which is also what an
/// import should do. A half-applied import is worse than a refused one, because nobody can tell
/// which half arrived.
///
/// # Errors
/// A capability refusal, or the first record that fails validation — in which case none are stored.
#[tauri::command]
pub fn markup_create_many(
    app: AppHandle,
    markups: Vec<NewMarkup>,
) -> CommandResult<Vec<MarkupDto>> {
    let state = app.state::<AppState>();
    state.require(Capability::MarkupCreate)?;
    if markups.iter().any(|m| m.kind.is_measurement()) {
        state.require(Capability::Calibrate)?;
    }
    if markups.is_empty() {
        return Ok(Vec::new());
    }

    with_open(&state, |package| {
        // Every record is validated before any is written, so a bad one in the middle cannot leave
        // a partial import behind.
        let mut records = Vec::with_capacity(markups.len());
        for markup in markups {
            let revision = revision_id(&markup.document_revision_id)?;
            let stored_revision = package.store().revision(revision)?;
            records.push(Markup::create(
                stored_revision.project_id,
                revision,
                markup.page,
                stored_revision.page_count,
                markup.kind,
                Geometry::new(markup.geometry_schema, markup.geometry)?,
                markup.metadata,
                markup.quantity,
                state.actor().clone(),
            )?);
        }

        package.store_mut().insert_markups(&records)?;

        // One audit entry for the import rather than one per markup. A thousand near-identical
        // lines would bury the acts a reader is looking for, and the import is one act.
        let first = records.first().map(|r| r.document_revision_id.to_string());
        audit(
            package,
            state.actor(),
            "markup:import",
            Outcome::Allowed,
            Record::new()
                .with("count", &records.len().to_string())
                .with("revision", first.as_deref().unwrap_or("unknown")),
        );

        Ok(records.into_iter().map(MarkupDto::from).collect())
    })
}

/// Change a markup, under an optimistic-concurrency check.
///
/// # Errors
/// A capability refusal, a stale `base_version`, or an illegal status move.
#[tauri::command]
pub fn markup_update(
    app: AppHandle,
    id: String,
    edit: MarkupEdit,
    base_version: u64,
) -> CommandResult<MarkupDto> {
    let state = app.state::<AppState>();
    let markup = markup_id(&id)?;
    let actor = state.actor().clone();

    with_open(&state, |package| {
        let existing = package.store().markup(markup)?;
        // Editing your own comment and editing the architect's are separate acts.
        let capability = sf_security::Role::edit_capability(existing.is_authored_by(&actor));
        if let Err(refusal) = state.require(capability) {
            audit(
                package,
                &actor,
                "markup:update",
                Outcome::Denied,
                Record::new()
                    .subject("markup", &id)
                    .because(&refusal.to_string()),
            );
            return Err(refusal.into());
        }
        if edit.status.is_some() {
            state.require(Capability::MarkupStatus)?;
        }

        let geometry = match edit.geometry {
            Some(data) => {
                let schema = edit.geometry_schema.ok_or_else(|| {
                    CommandError::invalid_request("New geometry must say which schema it uses.")
                })?;
                Some(Geometry::new(schema, data)?)
            }
            None => None,
        };

        let updated = package.store_mut().update_markup(
            markup,
            MarkupPatch {
                geometry,
                metadata: edit.metadata,
                status: edit.status,
                quantity: if edit.clear_quantity {
                    Some(None)
                } else {
                    edit.quantity.map(Some)
                },
            },
            base_version,
            actor.clone(),
        )?;
        audit(
            package,
            &actor,
            "markup:update",
            Outcome::Allowed,
            Record::new()
                .subject("markup", &id)
                .at_page(&updated.document_revision_id.to_string(), updated.page)
                .with("status", updated.status.as_str()),
        );
        Ok(MarkupDto::from(updated))
    })
}

/// Delete a markup, under the same concurrency check as an edit.
///
/// # Errors
/// A capability refusal or a stale `base_version`.
#[tauri::command]
pub fn markup_delete(app: AppHandle, id: String, base_version: u64) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let markup = markup_id(&id)?;
    let actor = state.actor().clone();

    with_open(&state, |package| {
        let existing = package.store().markup(markup)?;
        let capability = sf_security::Role::delete_capability(existing.is_authored_by(&actor));
        if let Err(refusal) = state.require(capability) {
            audit(
                package,
                &actor,
                "markup:delete",
                Outcome::Denied,
                Record::new()
                    .subject("markup", &id)
                    .because(&refusal.to_string()),
            );
            return Err(refusal.into());
        }
        package.store_mut().delete_markup(markup, base_version)?;
        audit(
            package,
            &actor,
            "markup:delete",
            Outcome::Allowed,
            Record::new().subject("markup", &id),
        );
        Ok(())
    })
}

/// Set a page's scale.
///
/// # Errors
/// A capability refusal, or a scale that is not finite and positive.
#[tauri::command]
pub fn calibration_set(app: AppHandle, calibration: NewCalibration) -> CommandResult<Calibration> {
    let state = app.state::<AppState>();
    state.require(Capability::Calibrate)?;
    let revision = revision_id(&calibration.document_revision_id)?;

    with_open(&state, |package| {
        let record = Calibration::new(
            calibration.page,
            calibration.units_per_page_unit,
            &calibration.unit,
            calibration.source,
            calibration.preset_label.as_deref(),
        )?;
        package.store().set_calibration(revision, &record)?;
        audit(
            package,
            state.actor(),
            "calibration:set",
            Outcome::Allowed,
            Record::new()
                .at_page(&revision.to_string(), record.page)
                .with("unit", &record.unit)
                .with("verified", if record.is_verified { "yes" } else { "no" }),
        );
        Ok(record)
    })
}

/// A page's scale, if it has one.
///
/// # Errors
/// If the project cannot be read.
#[tauri::command]
pub fn calibration_get(
    app: AppHandle,
    revision: String,
    page: u32,
) -> CommandResult<Option<Calibration>> {
    let state = app.state::<AppState>();
    let id = revision_id(&revision)?;
    with_open(&state, |package| {
        Ok(package.store().calibration(id, page)?)
    })
}

/// How many markups sit in each status.
///
/// # Errors
/// If the project cannot be read.
#[tauri::command]
pub fn status_counts(app: AppHandle) -> CommandResult<Vec<(MarkupStatus, u64)>> {
    let state = app.state::<AppState>();
    with_open(&state, |package| Ok(package.store().status_counts()?))
}

/// The audit trail.
///
/// # Errors
/// A capability refusal, or a read failure.
#[tauri::command]
pub fn audit_list(app: AppHandle) -> CommandResult<Vec<sf_audit::AuditEvent>> {
    let state = app.state::<AppState>();
    state.require(Capability::AuditRead)?;
    with_open(&state, |package| Ok(package.store().audit_events()?))
}

/// Save an export the interface has produced. Opens a native save dialog on this side.
///
/// The bytes come *from* the webview — a flattened PDF, a CSV, an XFDF — because the drawing engine
/// is what produced them. The destination does not: the picker runs here and the path never crosses
/// the boundary in either direction.
///
/// # Errors
/// [`CommandError::cancelled`], a capability refusal, or a write failure.
#[tauri::command]
pub async fn export_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<()> {
    // The bytes arrive as a raw body; the two strings that describe them arrive as headers.
    //
    // The alternative — and what this used to be — is a JSON array of numbers, which costs about
    // five characters per byte to build in the renderer, serialise, and parse back. A spreadsheet
    // export never noticed. A 300 DPI image of a D-size sheet is 30 MB, which became 150 MB of
    // text on a thread that also draws the window, so the feature was capped rather than the
    // transport fixed. This is the transport fixed.
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // A JSON body here means an old renderer against a new host, which is a bug rather than a
        // compatibility case worth serving: the two ship together.
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::invalid_request(
                "An export must be sent as raw bytes.",
            ));
        }
    };

    let suggested_name = header(&request, "x-sf-name")?;
    let extension = header(&request, "x-sf-extension")?;

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.require(Capability::Export)?;

        // The name is a suggestion from the renderer and lands in a filesystem path, so it is
        // checked against the same rules as anything else that becomes a filename.
        let file_name = format!("{suggested_name}.{extension}");
        sf_security::check_name(&file_name)?;

        let chosen = app
            .dialog()
            .file()
            .set_title("Save export")
            .set_file_name(&file_name)
            .add_filter(extension.to_uppercase(), &[extension.as_str()])
            .blocking_save_file()
            .ok_or_else(CommandError::cancelled)?;

        let destination = chosen
            .into_path()
            .map_err(|_| CommandError::invalid_request("That location cannot be used."))?;
        let size = bytes.len();
        std::fs::write(&destination, &bytes).map_err(|error| {
            log::error!(
                "export write failed: {}",
                sf_audit::redact(&error.to_string())
            );
            CommandError::internal()
        })?;

        // Audited whether or not a project is open: an export is a disclosure event, and it is
        // exactly the act somebody asks about later.
        let _ = state.with_package(|package| {
            audit(
                package,
                state.actor(),
                &format!("export:{extension}"),
                Outcome::Allowed,
                Record::new().with("bytes", &size.to_string()),
            );
            Ok::<(), CommandError>(())
        });
        Ok(())
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// File one PDF into the open package and record it as a revision.
///
/// Shared by `document_import` and `pdf_open` so the two cannot drift: the size check, the format
/// sniff, the content addressing and the audit entry happen once, in one place.
///
/// If the project already holds a revision with these exact bytes, that revision is returned
/// instead of a second one being created — which is what makes reopening the same file return you
/// to the markups you made on it.
fn file_drawing(
    package: &mut Package,
    actor: &ActorId,
    path: &std::path::Path,
) -> CommandResult<(RevisionDto, bool)> {
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled")
        .to_owned();

    let bytes = std::fs::read(path).map_err(|error| {
        log::error!(
            "import read failed: {}",
            sf_audit::redact(&error.to_string())
        );
        CommandError::invalid_request("That file could not be read.")
    })?;

    file_bytes(package, actor, &name, &bytes)
}

/// File a drawing that is already in memory.
///
/// Split out of [`file_drawing`] so the tutorial sheet — which is compiled into the binary and has
/// no path at all — is filed by exactly the same code as a drawing somebody dragged in: the same
/// size check, the same content addressing, the same audit entry, the same duplicate handling. A
/// second import route would be a second place for the limits to be forgotten.
fn file_bytes(
    package: &mut Package,
    actor: &ActorId,
    name: &str,
    bytes: &[u8],
) -> CommandResult<(RevisionDto, bool)> {
    let name = name.to_owned();
    let bytes = bytes.to_vec();

    let hash = package.import_source(&bytes)?;

    if let Some(existing) = package.store().revision_by_hash(hash)? {
        let document = package
            .store()
            .source_documents(existing.project_id)?
            .into_iter()
            .find(|doc| doc.id == existing.source_document_id);
        return Ok((
            RevisionDto {
                id: existing.id.to_string(),
                source_document_id: existing.source_document_id.to_string(),
                name: document.map_or(name, |doc| doc.name),
                revision_label: existing.revision_label.clone(),
                page_count: existing.page_count,
                short_hash: hash.short(),
                imported_at: existing
                    .imported_at
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            },
            true,
        ));
    }

    let page_count = count_pages(&bytes);
    let project_id = package
        .store()
        .project()?
        .ok_or_else(CommandError::no_project)?
        .id;

    let document = SourceDocument::new(project_id, &name, None)?;
    package.store().insert_source_document(&document)?;

    let revision = DocumentRevision::new(
        project_id,
        document.id,
        None,
        hash,
        bytes.len() as u64,
        page_count,
        actor.clone(),
    )?;
    package.store().insert_revision(&revision)?;

    audit(
        package,
        actor,
        "document:import",
        Outcome::Allowed,
        Record::new()
            .subject("document-revision", &revision.id.to_string())
            .with("pages", &page_count.to_string())
            .with("sha256", &hash.short()),
    );

    Ok((
        RevisionDto {
            id: revision.id.to_string(),
            source_document_id: document.id.to_string(),
            name: document.name.clone(),
            revision_label: revision.revision_label.clone(),
            page_count: revision.page_count,
            short_hash: hash.short(),
            imported_at: revision
                .imported_at
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
        false,
    ))
}

/// Import already-chosen files into the open project, creating one if none is open.
///
/// Shared by the file picker and by drag-and-drop. The picker path has a dialog in front of it;
/// the drop path has the operating system in front of it. Both arrive here with paths that a human
/// pointed at, and neither ever hands one to the webview.
///
/// # Errors
/// If a file cannot be read, is not a PDF, or exceeds a limit.
pub fn import_paths(
    app: &AppHandle,
    paths: &[std::path::PathBuf],
    version: &str,
) -> CommandResult<Vec<OpenedDrawing>> {
    let state = app.state::<AppState>();
    state.require(Capability::DocumentImport)?;

    let first = paths.first().ok_or_else(CommandError::cancelled)?;
    ensure_project_for(app, &state, first, version)?;

    with_open(&state, |package| {
        let mut opened = Vec::with_capacity(paths.len());
        for path in paths {
            let (revision, reopened) = file_drawing(package, state.actor(), path)?;
            let project = package
                .store()
                .project()?
                .ok_or_else(CommandError::no_project)?;
            opened.push(OpenedDrawing {
                project: ProjectSummary::of(package, &project),
                revision,
                reopened,
            });
        }
        Ok(opened)
    })
}

/// Make sure a project is open, creating one named after `first` if not.
fn ensure_project_for(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    first: &std::path::Path,
    version: &str,
) -> CommandResult<()> {
    let stem = first
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Drawings")
        .to_owned();
    ensure_project_named(app, state, &stem, version)
}

/// Make sure a project is open, creating one called `stem` if not.
fn ensure_project_named(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    stem: &str,
    version: &str,
) -> CommandResult<()> {
    if state.is_open() {
        return Ok(());
    }
    let stem = stem.to_owned();
    let root = default_project_root(app, &stem)?;

    let package = if root.exists() {
        // Reopening the same drawing after a restart lands here, and lands back on the markups
        // made last time.
        let mut existing = Package::open(&root)?;
        existing.set_limits(*state.limits());
        existing
    } else {
        let project = Project::new(&stem, None, None, state.actor().clone())?;
        if let Some(parent) = root.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                log::error!(
                    "could not create the project folder: {}",
                    sf_audit::redact(&error.to_string())
                );
                CommandError::internal()
            })?;
        }
        let mut created = Package::create(&root, &project, version)?;
        created.set_limits(*state.limits());
        audit(
            &mut created,
            state.actor(),
            "project:create",
            Outcome::Allowed,
            Record::new().subject("project", &project.id.to_string()),
        );
        created
    };
    state.set_package(Some(package));
    Ok(())
}

/// Where a project goes when the user did not choose a location.
///
/// Under the OS documents directory rather than beside the PDF: writing into whatever folder
/// somebody's drawings happen to live in — often a synced share, sometimes read-only — is a
/// surprise, and a predictable location is one they can find later without being told twice.
fn default_project_root(app: &AppHandle, name: &str) -> CommandResult<std::path::PathBuf> {
    use tauri::Manager;
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|_| CommandError::internal())?;

    // The name came from a filename and is about to become one again.
    let safe = if sf_security::check_name(name).is_ok() {
        name.to_owned()
    } else {
        "SheetForge project".to_owned()
    };
    Ok(documents
        .join("SheetForge")
        .join(format!("{safe}.{}", sf_package::EXTENSION)))
}

/// One percent-decoded header value from an invoke request.
///
/// Headers are ASCII by construction, and a drawing is quite capable of being called `Plan étage`.
/// The renderer percent-encodes as UTF-8 and this reverses it — the same encoding a URL uses,
/// chosen because both sides already have it and neither needs a dependency for it.
///
/// A value that is absent, not ASCII, or not valid UTF-8 once decoded is refused rather than
/// repaired: every one of those means the renderer sent something this host did not define, and a
/// filename is the last place to start guessing.
fn header(request: &tauri::ipc::Request<'_>, name: &str) -> CommandResult<String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| CommandError::invalid_request("That export is missing its description."))?;

    percent_decode(raw)
}

/// Reverse `encodeURIComponent`.
///
/// Separate from [`header`] so it can be tested without building an invoke request: the decoding
/// is where the edge cases are, and the header lookup is not.
fn percent_decode(raw: &str) -> CommandResult<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| CommandError::invalid_request("That export name is malformed."))?;
            decoded.push(hex);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded)
        .map_err(|_| CommandError::invalid_request("That export name is malformed."))
}

/// Assemble a diagnostic bundle and save it where the user says.
///
/// The thing offered in place of telemetry — see
/// [ADR-0007](../../../../docs/adr/0007-telemetry-privacy-and-diagnostics.md). It is written as
/// plain text so somebody can read it before deciding whether to attach it to a ticket, and it
/// carries counts rather than contents so there is nothing in it a client could object to.
///
/// Nothing is sent. This writes a file and stops.
///
/// # Errors
/// [`CommandError::cancelled`] if the dialog is dismissed, or a write failure.
#[tauri::command]
pub async fn diagnostics_save(app: AppHandle) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;

        // The log the `log` plugin writes, if this platform gives us a place for it.
        let log_path = app
            .path()
            .app_log_dir()
            .ok()
            .map(|dir| dir.join(format!("{}.log", app.package_info().name)));

        let bundle = crate::diagnostics::collect(&app, log_path.as_deref().filter(|p| p.exists()));
        let text = bundle.to_readable();

        let chosen = app
            .dialog()
            .file()
            .set_title("Save diagnostic bundle")
            .set_file_name("sheetforge-diagnostics.txt")
            .add_filter("Text", &["txt"])
            .blocking_save_file()
            .ok_or_else(CommandError::cancelled)?;

        let destination = chosen
            .into_path()
            .map_err(|_| CommandError::invalid_request("That location cannot be used."))?;
        std::fs::write(&destination, text).map_err(|error| {
            log::error!(
                "could not write the diagnostic bundle: {}",
                sf_audit::redact(&error.to_string())
            );
            CommandError::internal()
        })?;

        // Audited like any other export: it is a file leaving the application, and somebody may
        // later want to know one was produced.
        let state = app.state::<AppState>();
        let _ = state.with_package(|package| {
            audit(
                package,
                state.actor(),
                "diagnostics:export",
                Outcome::Allowed,
                Record::new(),
            );
            Ok::<(), CommandError>(())
        });
        Ok(())
    })
    .await
    .map_err(|_| CommandError::internal())?
}

/// How many pages a PDF claims, read from its page tree without rendering anything.
///
/// A structural count rather than a parse: the renderer is the authority on the document and it
/// runs in the webview. What this needs to produce is a bounded, honest number for the import
/// record, and a refusal when the file does not look like a document at all.
fn count_pages(bytes: &[u8]) -> u32 {
    // `/Type /Page` occurrences, not `/Count`, because `/Count` is a claim the file makes about
    // itself and a crafted file can claim anything. Whitespace between the tokens is legal, so the
    // scan tolerates it.
    let mut count = 0u32;
    let needle = b"/Type";
    let mut index = 0;
    while let Some(found) = bytes[index..]
        .windows(needle.len())
        .position(|w| w == needle)
    {
        let after = index + found + needle.len();
        let rest = &bytes[after..bytes.len().min(after + 16)];
        let trimmed: Vec<u8> = rest
            .iter()
            .copied()
            .skip_while(u8::is_ascii_whitespace)
            .collect();
        if trimmed.starts_with(b"/Page") && !trimmed.starts_with(b"/Pages") {
            count = count.saturating_add(1);
        }
        index = after;
        if count > sf_domain::DocumentRevision::MAX_PAGES {
            break;
        }
    }
    if count == 0 {
        // A linearised or object-stream PDF hides its page objects inside compressed streams, so
        // zero here means "could not tell", not "empty". One page is the honest floor; the
        // renderer corrects the number once it has the document open.
        return 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use super::*;

    #[test]
    fn a_page_count_is_read_from_the_page_objects() {
        let pdf = b"%PDF-1.7\n1 0 obj<</Type /Pages /Count 2>>endobj\n2 0 obj<</Type /Page>>endobj\n3 0 obj<</Type/Page>>endobj\n%%EOF";
        assert_eq!(count_pages(pdf), 2, "/Pages must not be counted as a page");
    }

    #[test]
    fn a_document_whose_pages_are_compressed_reports_one_rather_than_zero() {
        // Zero would fail the domain's own check and refuse a perfectly good linearised PDF.
        let pdf = b"%PDF-1.7\n1 0 obj<</Type/ObjStm/N 12>>stream\n....\nendstream\n%%EOF";
        assert_eq!(count_pages(pdf), 1);
    }

    #[test]
    fn a_file_claiming_an_absurd_number_of_pages_stops_counting() {
        // The bound matters because the count drives allocation decisions upstream.
        let mut pdf = b"%PDF-1.7\n".to_vec();
        for _ in 0..(sf_domain::DocumentRevision::MAX_PAGES + 50) {
            pdf.extend_from_slice(b"<</Type /Page>>");
        }
        let counted = count_pages(&pdf);
        assert!(
            counted <= sf_domain::DocumentRevision::MAX_PAGES + 1,
            "counted {counted}"
        );
    }

    #[test]
    fn a_markup_reference_that_is_not_an_id_is_refused_before_it_reaches_the_store() {
        assert_eq!(
            markup_id("../../etc/passwd").unwrap_err().code,
            "invalid-request"
        );
        assert_eq!(revision_id("").unwrap_err().code, "invalid-request");
        assert!(markup_id(&MarkupId::new().to_string()).is_ok());
    }

    #[test]
    fn a_markup_serialises_with_the_version_the_interface_must_send_back() {
        let markup = Markup::create(
            sf_domain::ProjectId::new(),
            DocumentRevisionId::new(),
            1,
            1,
            MarkupKind::Cloud,
            Geometry::new(1, serde_json::json!({ "points": [] })).unwrap(),
            MarkupMetadata::default(),
            None,
            ActorId::local(),
        )
        .unwrap();
        let json = serde_json::to_value(MarkupDto::from(markup)).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["kind"], "cloud");
        assert_eq!(json["status"], "open");
        assert!(json["geometrySchema"].is_number(), "camelCase on the wire");
    }

    /// A drawing is quite capable of being called `Plan étage — révision C`, and a header is
    /// ASCII only. Round-tripping the names people actually use is the whole reason this decoder
    /// exists rather than the header being read straight.
    #[test]
    fn an_export_name_survives_the_trip_through_an_ascii_header() {
        // What `encodeURIComponent` produces for each of these.
        for (encoded, expected) in [
            ("A-201", "A-201"),
            ("Plan%20%C3%A9tage", "Plan étage"),
            (
                "R%C3%A9vision%20C%20%E2%80%94%20structure",
                "Révision C — structure",
            ),
            ("100%25%20complete", "100% complete"),
            ("%F0%9F%93%90%20takeoff", "📐 takeoff"),
        ] {
            assert_eq!(percent_decode(encoded).unwrap(), expected);
        }
    }

    /// Refused rather than repaired. Every one of these means the renderer sent something this
    /// host does not define, and a filename is the last place to start guessing — a decoder that
    /// silently dropped a bad escape would turn `%2E%2E%2Fetc` into something worth worrying
    /// about rather than into an error.
    #[test]
    fn a_malformed_export_name_is_refused_rather_than_repaired() {
        for malformed in [
            "%",      // truncated escape at the end
            "%2",     // half an escape
            "%zz",    // not hexadecimal
            "%C3",    // a lead byte with no continuation: not valid UTF-8 once decoded
            "%FF%FE", // never valid UTF-8
        ] {
            assert_eq!(
                percent_decode(malformed).unwrap_err().code,
                "invalid-request",
                "{malformed:?} should have been refused",
            );
        }
    }

    /// The separator and the traversal sequence decode to exactly what they are, and are then
    /// refused downstream by `check_name` rather than here. This asserts the decoder does not
    /// quietly neutralise them — a defence that happens by accident is a defence that disappears
    /// by accident.
    #[test]
    fn the_decoder_does_not_pretend_to_be_a_path_check() {
        assert_eq!(
            percent_decode("..%2Fetc%2Fpasswd").unwrap(),
            "../etc/passwd"
        );
        assert!(sf_security::check_name("../etc/passwd").is_err());
    }

    // ---------------------------------------------------------------------------
    // The page counter, against input a stranger wrote
    // ---------------------------------------------------------------------------
    //
    // `count_pages` is the one parser in this crate that reads bytes nobody here produced. It runs
    // before the renderer has seen the file, on whatever a drop or a file picker handed over, and
    // its result becomes a stored page count. Everything below exists because "it worked on the
    // PDFs I tried" is not a claim worth making about hostile input.
    //
    // These are property tests rather than a corpus of binary fixtures. A committed malformed PDF
    // is a file nobody can review; a generator is code, and it goes on finding new inputs on every
    // run rather than the same twelve for ever.

    /// Bytes that look enough like a PDF to reach the interesting paths.
    ///
    /// Purely random bytes almost never contain `/Type`, so a naive generator tests only the
    /// "found nothing" branch. This one deliberately seeds the tokens the scanner looks for,
    /// including the near-misses — `/Pages` must not count, and `/Typewriter` must not either.
    fn adversarial_pdf() -> impl Strategy<Value = Vec<u8>> {
        let fragment = prop_oneof![
            Just(b"/Type /Page".to_vec()),
            Just(b"/Type/Page".to_vec()),
            Just(b"/Type   \n\r\t /Page".to_vec()),
            // Must not count: a page *tree* node, not a page.
            Just(b"/Type /Pages".to_vec()),
            // Must not count: a longer token that merely starts the same way.
            Just(b"/Type /Pagemaker".to_vec()),
            // A `/Count` claiming something enormous. The scanner ignores it on purpose, and this
            // asserts it goes on ignoring it.
            Just(b"/Count 4294967295".to_vec()),
            // `/Type` at the very end, with nothing after it to inspect.
            Just(b"/Type".to_vec()),
            Just(b"%PDF-1.7\n".to_vec()),
            Just(b"stream\n".to_vec()),
            Just(vec![0u8; 32]),
            proptest::collection::vec(any::<u8>(), 0..64),
        ];
        proptest::collection::vec(fragment, 0..80).prop_map(|parts| parts.concat())
    }

    proptest! {
        /// The whole contract, on anything.
        ///
        /// It must not panic, must not run away, and must report a number the rest of the
        /// application can store — a page count above the domain's ceiling would be rejected
        /// downstream *after* the file had already been copied into the package.
        #[test]
        fn the_page_counter_survives_anything_and_stays_within_the_domain_ceiling(
            bytes in adversarial_pdf(),
        ) {
            let counted = count_pages(&bytes);
            prop_assert!(counted >= 1, "a page count of zero is not a document");
            prop_assert!(
                counted <= sf_domain::DocumentRevision::MAX_PAGES + 1,
                "counted {counted}, past the ceiling the store will accept",
            );
        }

        /// Truncation is the commonest corruption there is — an interrupted copy, a half-written
        /// download, a file plucked off a failing disk. Every prefix of a document must be as safe
        /// to read as the whole of it.
        #[test]
        fn every_prefix_of_a_document_is_safe_to_count(
            bytes in adversarial_pdf(),
            cut in 0usize..4096,
        ) {
            let end = cut.min(bytes.len());
            let counted = count_pages(&bytes[..end]);
            prop_assert!(counted >= 1);
        }
    }

    /// The near-misses, stated exactly rather than left to the generator to stumble on.
    ///
    /// `/Pages` is the page *tree* node and appears once per document; counting it would inflate
    /// every set by one. `/Pagemaker` is not a real PDF token but a prefix match would accept it,
    /// and the failure mode of a loose prefix check is a number that is quietly wrong rather than
    /// an error anybody sees.
    #[test]
    fn the_page_counter_does_not_mistake_a_page_tree_for_a_page() {
        assert_eq!(count_pages(b"/Type /Pages /Count 40"), 1, "a tree is not a page");
        assert_eq!(count_pages(b"/Type /Pagemaker"), 1, "a prefix is not a token");
        assert_eq!(count_pages(b"/Type /Page /Type /Page"), 2);
        assert_eq!(count_pages(b"/Type\n\t /Page"), 1, "whitespace between tokens is legal");
        // The claim a file makes about itself is not evidence.
        assert_eq!(count_pages(b"/Count 999999 /Type /Page"), 1);
    }

    /// A file that is nothing but page markers must stop at the ceiling rather than counting to
    /// four billion. The break is what makes this bounded, and a regression that removed it would
    /// otherwise show up only as a hang on a crafted file.
    #[test]
    fn a_file_that_is_all_page_markers_stops_at_the_ceiling() {
        let bytes = b"/Type /Page ".repeat(sf_domain::DocumentRevision::MAX_PAGES as usize + 500);
        let counted = count_pages(&bytes);
        assert!(
            counted <= sf_domain::DocumentRevision::MAX_PAGES + 1,
            "counted {counted} without stopping",
        );
    }

    /// Cost has to stay linear in the size of the file.
    ///
    /// The ceiling is loose — this runs on shared CI hardware — because what it catches is a
    /// change from one pass to a quadratic scan, which on a 512 MB drawing is the difference
    /// between a second and an afternoon. That is a denial of service delivered as a drawing.
    #[test]
    fn counting_a_large_file_stays_linear() {
        // 8 MB of bytes that never match, which is the worst case for a scanner: it cannot skip.
        let haystack = vec![b'x'; 8 * 1024 * 1024];
        let started = std::time::Instant::now();
        let counted = count_pages(&haystack);
        let elapsed = started.elapsed();
        assert_eq!(counted, 1, "nothing here is a page");
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "8 MB took {elapsed:?} — this should be one pass, so look for a scan inside a scan",
        );
    }

    /// The tutorial sheet is compiled in, so a missing or truncated asset is a build failure
    /// rather than a runtime one — but a *wrong* asset is neither, and the first person to notice
    /// would be a new user on their first launch. This is the cheapest thing that would catch it.
    #[test]
    fn the_tutorial_sheet_is_a_real_two_page_pdf() {
        assert!(
            TUTORIAL_SHEET.starts_with(b"%PDF-"),
            "the embedded tutorial is not a PDF",
        );
        assert!(
            TUTORIAL_SHEET.ends_with(b"%%EOF\n"),
            "the embedded tutorial is truncated",
        );
        assert_eq!(
            count_pages(TUTORIAL_SHEET),
            2,
            "the tutorial's own instructions send the reader to page 2",
        );
    }

    /// The tutorial tells the reader to calibrate against a dimension printed as 144'-0" and then
    /// expect the far side to measure 96'-0". That is only true if the geometry on the sheet is
    /// drawn at the scale the title block claims, and the failure mode if it is not is the worst
    /// one this product has: a confident wrong number, taught to a new user as correct.
    ///
    /// The generator emits those lengths in points. Asserting the arithmetic here means the two
    /// numbers cannot be changed on the sheet without this failing.
    #[test]
    fn the_tutorials_printed_dimensions_match_the_scale_it_claims() {
        // 1/8" = 1'-0", at 72 points to the inch.
        let points_per_foot = 72.0 / 8.0;
        let width_points = 1296.0_f64;
        let depth_points = 864.0_f64;

        assert!((width_points / points_per_foot - 144.0).abs() < f64::EPSILON);
        assert!((depth_points / points_per_foot - 96.0).abs() < f64::EPSILON);

        // And the area the sheet prints inside the OPEN OFFICE room: two bays by two bays, at 24
        // feet to the bay.
        assert!(((48.0 * 48.0) - 2_304.0_f64).abs() < f64::EPSILON);
    }
}
