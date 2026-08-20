//! # `sf-package` — the `.sfproj` project package
//!
//! A project is a directory, not an opaque file:
//!
//! ```text
//! Riverside Tower.sfproj/
//!   manifest.json          what this package is, and what should be inside it
//!   database.sqlite        markups, calibrations, the audit trail
//!   sources/<sha256>.pdf   the drawings, byte-identical to what was issued
//!   attachments/<sha256>   photos and files pinned to markups
//!   cache/                 thumbnails and rasterised tiles; regenerable, never trusted
//!   audit.ndjson           optional portable export of the trail
//! ```
//!
//! ## Why a directory
//!
//! A single-file container would have to be rewritten to add one markup, which on a 400 MB drawing
//! set is both slow and the moment a power cut destroys the file. A directory lets SQLite do
//! transactional writes to the part that changes while the drawings — the large, immutable part —
//! are never touched again after import. It also means that when something does go wrong, the PDFs
//! are still just PDFs and can be recovered with a file manager.
//!
//! Zipping it for transport is a separate act, and one the user decides on.
//!
//! ## Content addressing
//!
//! Drawings are named for the SHA-256 of their bytes. The same sheet arriving twice under two
//! filenames is stored once; the hash is also the integrity check, so a package whose drawings have
//! been altered on disk fails [`Package::verify`] rather than opening with different drawings than
//! the ones the markups were made against.
//!
//! ## Trust
//!
//! A package that arrives from somebody else is hostile input in its entirety — the manifest, the
//! entry names, the PDFs and the database alike. Every path inside it is resolved through
//! [`sf_security::contained_path`], and no size is taken on faith.

use serde::{Deserialize, Serialize};
use sf_domain::{ContentHash, Project};
use sf_security::{ResourceLimits, SecurityError};
use sf_store::{Store, StoreError};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The package format this build writes.
///
/// Separate from the database schema version: the directory layout and the manifest can change
/// without the tables changing, and the reverse.
pub const PACKAGE_FORMAT: u32 = 1;

/// The extension a project directory carries.
pub const EXTENSION: &str = "sfproj";

const MANIFEST: &str = "manifest.json";
const DATABASE: &str = "database.sqlite";
const SOURCES: &str = "sources";
const ATTACHMENTS: &str = "attachments";
const CACHE: &str = "cache";
const AUDIT_EXPORT: &str = "audit.ndjson";

/// What went wrong with a package.
#[derive(Debug, Error)]
pub enum PackageError {
    /// The filesystem refused.
    ///
    /// The message is deliberately generic: an `io::Error` renders the path it failed on.
    #[error("the project package could not be read or written")]
    Io(#[from] std::io::Error),

    /// The manifest is missing, unreadable, or not a manifest.
    #[error("this folder is not a SheetForge project")]
    NotAPackage,

    /// The package was written by a newer build.
    #[error("this project was created by a newer version of SheetForge (package format {found}, this build reads {supported})")]
    NewerFormat {
        /// The version in the manifest.
        found: u32,
        /// The newest this build understands.
        supported: u32,
    },

    /// A drawing's bytes do not match the hash it is filed under.
    #[error("a drawing in this project has been altered or is damaged ({short_hash})")]
    IntegrityFailure {
        /// The first twelve characters of the expected hash — enough to identify which, without
        /// putting a filename in front of the user.
        short_hash: String,
    },

    /// A drawing the manifest lists is not in the package.
    #[error("a drawing this project refers to is missing ({short_hash})")]
    MissingSource {
        /// Which one.
        short_hash: String,
    },

    /// A security bound refused.
    #[error(transparent)]
    Security(#[from] SecurityError),

    /// The database inside the package refused.
    #[error(transparent)]
    Store(#[from] StoreError),

    /// A path already exists where the package was to be created.
    #[error("something already exists at that location")]
    AlreadyExists,
}

/// This crate's result alias.
pub type Result<T> = std::result::Result<T, PackageError>;

/// One drawing filed in the package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceEntry {
    /// SHA-256 of the file's bytes. Also its filename.
    pub sha256: ContentHash,
    /// Size in bytes, so the package can be sanity-checked without rehashing every drawing.
    pub byte_len: u64,
}

/// What a package says it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// The directory layout version.
    pub format: u32,
    /// The build that last wrote it, for support. Not used to gate anything.
    pub written_by: String,
    /// The project this package holds.
    pub project_id: String,
    /// Its name, duplicated here so a package can be listed without opening its database.
    pub project_name: String,
    /// RFC 3339 UTC.
    pub created_at: String,
    /// Every drawing that should be present.
    pub sources: Vec<SourceEntry>,
}

/// An open project package.
pub struct Package {
    root: PathBuf,
    manifest: Manifest,
    store: Store,
    limits: ResourceLimits,
}

impl Package {
    /// Create a package at `root` and write the project into it.
    ///
    /// # Errors
    /// [`PackageError::AlreadyExists`] if anything is already there, or an I/O error.
    pub fn create(root: &Path, project: &Project, app_version: &str) -> Result<Self> {
        if root.exists() {
            return Err(PackageError::AlreadyExists);
        }
        fs::create_dir_all(root.join(SOURCES))?;
        fs::create_dir_all(root.join(ATTACHMENTS))?;
        fs::create_dir_all(root.join(CACHE))?;

        let store = Store::open(&root.join(DATABASE))?;
        store.create_project(project)?;

        let manifest = Manifest {
            format: PACKAGE_FORMAT,
            written_by: app_version.to_owned(),
            project_id: project.id.to_string(),
            project_name: project.name.clone(),
            created_at: project
                .created_at
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            sources: Vec::new(),
        };
        let package = Self {
            root: root.to_path_buf(),
            manifest,
            store,
            limits: ResourceLimits::default(),
        };
        package.write_manifest()?;
        Ok(package)
    }

    /// Open an existing package.
    ///
    /// Does **not** verify drawing hashes — that is [`Package::verify`], which reads every file and
    /// is far too slow to run on every open of a large set. Opening checks the manifest and the
    /// format version only.
    ///
    /// # Errors
    /// [`PackageError::NotAPackage`] if the manifest is missing or unreadable,
    /// [`PackageError::NewerFormat`] if it was written by a newer build.
    pub fn open(root: &Path) -> Result<Self> {
        let raw = fs::read_to_string(root.join(MANIFEST)).map_err(|_| PackageError::NotAPackage)?;
        let manifest: Manifest =
            serde_json::from_str(&raw).map_err(|_| PackageError::NotAPackage)?;
        if manifest.format > PACKAGE_FORMAT {
            return Err(PackageError::NewerFormat {
                found: manifest.format,
                supported: PACKAGE_FORMAT,
            });
        }
        let store = Store::open(&root.join(DATABASE))?;
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            store,
            limits: ResourceLimits::default(),
        })
    }

    /// The package's own directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// What the package says it is.
    #[must_use]
    pub const fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// The project database.
    #[must_use]
    pub const fn store(&self) -> &Store {
        &self.store
    }

    /// The project database, mutably — for the writes that need a transaction.
    pub const fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    /// Replace the resource bounds. Enterprise policy can tighten these.
    pub const fn set_limits(&mut self, limits: ResourceLimits) {
        self.limits = limits;
    }

    /// File a drawing in the package, returning its content hash.
    ///
    /// Idempotent: importing the same bytes twice stores one file and returns the same hash, which
    /// is what happens on a normal job when a sheet arrives in two different transmittals.
    ///
    /// # Errors
    /// - [`SecurityError::TooLarge`] past the configured ceiling.
    /// - [`SecurityError::NotTheExpectedFormat`] if the bytes are not a PDF.
    /// - An I/O error.
    pub fn import_source(&mut self, bytes: &[u8]) -> Result<ContentHash> {
        self.limits.check_pdf(bytes.len() as u64)?;
        // Sniff before writing anything. A renamed `.docx` should be refused at the door, not
        // discovered by the renderer after it has been copied into the package.
        sf_security::validate_pdf_header(bytes)?;

        let hash = hash_bytes(bytes);
        let destination = self.source_path(hash)?;

        if destination.exists() {
            // Already filed. The hash is the identity, so there is nothing to write and nothing to
            // check — identical bytes produce this filename by construction.
            return Ok(hash);
        }
        write_atomically(&destination, bytes)?;

        if !self
            .manifest
            .sources
            .iter()
            .any(|entry| entry.sha256 == hash)
        {
            self.manifest.sources.push(SourceEntry {
                sha256: hash,
                byte_len: bytes.len() as u64,
            });
            self.write_manifest()?;
        }
        Ok(hash)
    }

    /// Where a drawing lives inside the package.
    ///
    /// # Errors
    /// [`SecurityError::PathEscape`] — unreachable for a real hash, since hex cannot contain a
    /// path separator, but the check is here rather than assumed because this function also takes
    /// hashes that came out of a manifest somebody else wrote.
    pub fn source_path(&self, hash: ContentHash) -> Result<PathBuf> {
        Ok(sf_security::contained_path(
            &self.root,
            &format!("{SOURCES}/{}.pdf", hash.to_hex()),
        )?)
    }

    /// Read a drawing's bytes.
    ///
    /// # Errors
    /// [`PackageError::MissingSource`] if it is not there, or an I/O error.
    pub fn read_source(&self, hash: ContentHash) -> Result<Vec<u8>> {
        let path = self.source_path(hash)?;
        if !path.exists() {
            return Err(PackageError::MissingSource {
                short_hash: hash.short(),
            });
        }
        Ok(fs::read(path)?)
    }

    /// Check every drawing against the hash it is filed under.
    ///
    /// Reads the whole package, so it belongs on an explicit "check this project" action and on
    /// import of a package from somebody else — not on every open.
    ///
    /// # Errors
    /// [`PackageError::MissingSource`] or [`PackageError::IntegrityFailure`] at the first drawing
    /// that fails, along with the audit trail's own verification.
    pub fn verify(&self) -> Result<()> {
        for entry in &self.manifest.sources {
            let path = self.source_path(entry.sha256)?;
            if !path.exists() {
                return Err(PackageError::MissingSource {
                    short_hash: entry.sha256.short(),
                });
            }
            let bytes = fs::read(&path)?;
            // Cheap check first: a truncated download is the common case and does not need a hash.
            if bytes.len() as u64 != entry.byte_len || hash_bytes(&bytes) != entry.sha256 {
                return Err(PackageError::IntegrityFailure {
                    short_hash: entry.sha256.short(),
                });
            }
        }
        self.store.verify_audit()?;
        Ok(())
    }

    /// Write a portable copy of the audit trail as newline-delimited JSON.
    ///
    /// Separate from the database so a trail can be handed to somebody — an auditor, a client —
    /// without handing over the drawings, and so it can be verified by anything that can read JSON.
    ///
    /// # Errors
    /// If the trail cannot be read or the file cannot be written.
    pub fn export_audit(&self) -> Result<PathBuf> {
        let path = self.root.join(AUDIT_EXPORT);
        let events = self.store.audit_events()?;
        let mut buffer = Vec::new();
        for event in &events {
            serde_json::to_writer(&mut buffer, event).map_err(|_| StoreError::Corrupt)?;
            buffer.push(b'\n');
        }
        write_atomically(&path, &buffer)?;
        Ok(path)
    }

    /// Delete everything under `cache/`.
    ///
    /// Regenerable by definition, so this is always safe and is the first thing to try when a
    /// package misbehaves.
    ///
    /// # Errors
    /// If the directory cannot be recreated.
    pub fn clear_cache(&self) -> Result<()> {
        let cache = self.root.join(CACHE);
        if cache.exists() {
            fs::remove_dir_all(&cache)?;
        }
        fs::create_dir_all(&cache)?;
        Ok(())
    }

    fn write_manifest(&self) -> Result<()> {
        let json =
            serde_json::to_vec_pretty(&self.manifest).map_err(|_| PackageError::NotAPackage)?;
        write_atomically(&self.root.join(MANIFEST), &json)
    }
}

/// SHA-256 of some bytes.
#[must_use]
pub fn hash_bytes(bytes: &[u8]) -> ContentHash {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    ContentHash::from_bytes(out)
}

/// Write a file so that it either appears complete or does not appear at all.
///
/// Write to a temporary sibling, flush, sync, then rename. A plain write leaves a truncated
/// manifest behind if the process dies mid-write, and a truncated manifest is a project that will
/// not open — the failure this whole application exists to avoid.
///
/// The rename is atomic within a directory on NTFS, APFS and ext4 alike. `fsync` before the rename
/// is what makes the *contents* durable and not merely the directory entry.
fn write_atomically(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination.parent().ok_or(PackageError::NotAPackage)?;
    fs::create_dir_all(parent)?;

    let temporary = parent.join(format!(
        ".{}.tmp",
        destination
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("write"),
    ));
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
    }
    // Windows will not rename onto an existing file, so the old one goes first. The window between
    // the two is why the temporary file is kept until the very end: a crash here leaves the new
    // contents recoverable next to the gap.
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(&temporary, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sf_domain::ActorId;
    use tempfile::TempDir;

    fn a_pdf(marker: &str) -> Vec<u8> {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(marker.as_bytes());
        bytes.extend_from_slice(b"\n%%EOF\n");
        bytes
    }

    fn new_package() -> (TempDir, Package) {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("Riverside Tower.sfproj");
        let project =
            Project::new("Riverside Tower", Some("2026-014"), None, ActorId::local()).unwrap();
        let package = Package::create(&root, &project, "0.1.0-test").unwrap();
        (dir, package)
    }

    #[test]
    fn creating_a_package_lays_out_the_directory_and_the_manifest() {
        let (_dir, package) = new_package();
        for entry in [MANIFEST, DATABASE, SOURCES, ATTACHMENTS, CACHE] {
            assert!(package.root().join(entry).exists(), "{entry} must exist");
        }
        assert_eq!(package.manifest().format, PACKAGE_FORMAT);
        assert_eq!(package.manifest().project_name, "Riverside Tower");
        assert!(package.manifest().sources.is_empty());
    }

    #[test]
    fn a_package_cannot_be_created_over_something_that_exists() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("taken.sfproj");
        fs::create_dir_all(&root).unwrap();
        let project = Project::new("x", None, None, ActorId::local()).unwrap();
        assert!(matches!(
            Package::create(&root, &project, "t"),
            Err(PackageError::AlreadyExists)
        ));
    }

    #[test]
    fn a_drawing_is_filed_under_its_own_hash_and_read_back_byte_identical() {
        let (_dir, mut package) = new_package();
        let bytes = a_pdf("A-201");
        let hash = package.import_source(&bytes).unwrap();

        assert_eq!(hash, hash_bytes(&bytes));
        assert!(package
            .source_path(hash)
            .unwrap()
            .ends_with(format!("{}.pdf", hash.to_hex())));
        assert_eq!(
            package.read_source(hash).unwrap(),
            bytes,
            "the issued bytes must survive unchanged"
        );
    }

    #[test]
    fn importing_the_same_drawing_twice_stores_it_once() {
        // The normal case: a sheet arrives in two transmittals.
        let (_dir, mut package) = new_package();
        let bytes = a_pdf("A-201");
        let first = package.import_source(&bytes).unwrap();
        let second = package.import_source(&bytes).unwrap();

        assert_eq!(first, second);
        assert_eq!(package.manifest().sources.len(), 1);
        let filed = fs::read_dir(package.root().join(SOURCES)).unwrap().count();
        assert_eq!(filed, 1);
    }

    #[test]
    fn two_different_drawings_are_filed_separately() {
        let (_dir, mut package) = new_package();
        package.import_source(&a_pdf("A-201")).unwrap();
        package.import_source(&a_pdf("A-202")).unwrap();
        assert_eq!(package.manifest().sources.len(), 2);
    }

    #[test]
    fn something_that_is_not_a_pdf_is_refused_before_it_is_written() {
        let (_dir, mut package) = new_package();
        let result = package.import_source(b"PK\x03\x04 this is a zip");
        assert!(matches!(
            result,
            Err(PackageError::Security(
                SecurityError::NotTheExpectedFormat { .. }
            ))
        ));
        assert_eq!(
            fs::read_dir(package.root().join(SOURCES)).unwrap().count(),
            0,
            "nothing may be written"
        );
        assert!(package.manifest().sources.is_empty());
    }

    #[test]
    fn an_oversized_drawing_is_refused() {
        let (_dir, mut package) = new_package();
        package.set_limits(ResourceLimits {
            max_pdf_mb: 0,
            ..Default::default()
        });
        assert!(matches!(
            package.import_source(&a_pdf("A-201")),
            Err(PackageError::Security(SecurityError::TooLarge { .. })),
        ));
    }

    #[test]
    fn a_package_reopens_with_its_manifest_and_drawings_intact() {
        let (dir, mut package) = new_package();
        let hash = package.import_source(&a_pdf("A-201")).unwrap();
        let root = package.root().to_path_buf();
        drop(package);

        let reopened = Package::open(&root).unwrap();
        assert_eq!(reopened.manifest().sources.len(), 1);
        assert_eq!(reopened.read_source(hash).unwrap(), a_pdf("A-201"));
        assert_eq!(
            reopened.store().project().unwrap().unwrap().name,
            "Riverside Tower"
        );
        drop(dir);
    }

    #[test]
    fn an_ordinary_folder_is_not_mistaken_for_a_project() {
        let dir = TempDir::new().unwrap();
        assert!(matches!(
            Package::open(dir.path()),
            Err(PackageError::NotAPackage)
        ));
    }

    #[test]
    fn a_corrupt_manifest_is_refused_rather_than_partially_read() {
        let (_dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);
        fs::write(root.join(MANIFEST), b"{ not json").unwrap();
        assert!(matches!(
            Package::open(&root),
            Err(PackageError::NotAPackage)
        ));
    }

    #[test]
    fn a_package_from_a_newer_build_is_refused() {
        let (_dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);

        let raw = fs::read_to_string(root.join(MANIFEST)).unwrap();
        let bumped = raw.replace(&format!("\"format\": {PACKAGE_FORMAT}"), "\"format\": 9999");
        fs::write(root.join(MANIFEST), bumped).unwrap();

        match Package::open(&root) {
            Err(PackageError::NewerFormat { found, supported }) => {
                assert_eq!((found, supported), (9999, PACKAGE_FORMAT));
            }
            other => panic!("expected a NewerFormat refusal, got {:?}", other.err()),
        }
    }

    #[test]
    fn an_intact_package_verifies() {
        let (_dir, mut package) = new_package();
        package.import_source(&a_pdf("A-201")).unwrap();
        package.import_source(&a_pdf("A-202")).unwrap();
        package.verify().unwrap();
    }

    #[test]
    fn a_drawing_altered_on_disk_fails_verification() {
        // The property content addressing buys: you cannot quietly swap a drawing under a set of
        // markups that were made against the original.
        let (_dir, mut package) = new_package();
        let hash = package.import_source(&a_pdf("A-201")).unwrap();
        let path = package.source_path(hash).unwrap();

        let mut altered = a_pdf("A-201");
        altered.extend_from_slice(b"% tampered, same length lost\n");
        fs::write(&path, &altered).unwrap();

        match package.verify() {
            Err(PackageError::IntegrityFailure { short_hash }) => {
                assert_eq!(short_hash, hash.short());
            }
            other => panic!("expected an integrity failure, got {:?}", other.err()),
        }
    }

    #[test]
    fn a_missing_drawing_is_reported_as_missing_not_as_corrupt() {
        // Different failures need different advice: one is "restore the file", the other is
        // "this package cannot be trusted".
        let (_dir, mut package) = new_package();
        let hash = package.import_source(&a_pdf("A-201")).unwrap();
        fs::remove_file(package.source_path(hash).unwrap()).unwrap();

        match package.verify() {
            Err(PackageError::MissingSource { short_hash }) => assert_eq!(short_hash, hash.short()),
            other => panic!("expected a missing-source error, got {:?}", other.err()),
        }
    }

    #[test]
    fn verification_also_checks_the_audit_trail() {
        let (_dir, mut package) = new_package();
        let actor = ActorId::local();
        package
            .store_mut()
            .append_audit(
                &actor,
                "document:import",
                sf_audit::Outcome::Allowed,
                sf_audit::Record::new(),
            )
            .unwrap();
        package.verify().unwrap();
    }

    #[test]
    fn the_audit_trail_exports_as_one_json_object_per_line() {
        let (_dir, mut package) = new_package();
        let actor = ActorId::local();
        for action in ["document:import", "markup:create", "export:csv"] {
            package
                .store_mut()
                .append_audit(
                    &actor,
                    action,
                    sf_audit::Outcome::Allowed,
                    sf_audit::Record::new(),
                )
                .unwrap();
        }
        let path = package.export_audit().unwrap();
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 3);

        // Verifiable by anything that reads JSON, which is the point of exporting it separately.
        let events: Vec<sf_audit::AuditEvent> = lines
            .iter()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        sf_audit::verify_chain(&events).unwrap();
    }

    #[test]
    fn the_cache_can_always_be_cleared() {
        let (_dir, package) = new_package();
        let cache = package.root().join(CACHE);
        fs::write(cache.join("tile.png"), b"x").unwrap();
        package.clear_cache().unwrap();
        assert!(cache.exists());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    }

    #[test]
    fn an_atomic_write_leaves_no_temporary_file_behind() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("manifest.json");
        write_atomically(&target, b"first").unwrap();
        write_atomically(&target, b"second").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"second");
        let strays: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "a temporary file was left behind");
    }

    #[test]
    fn a_manifest_naming_a_path_outside_the_package_cannot_reach_it() {
        // `source_path` is fed hashes that came from a manifest somebody else wrote.
        let (_dir, package) = new_package();
        let escape = sf_security::contained_path(package.root(), "sources/../../../../etc/passwd");
        assert!(matches!(escape, Err(SecurityError::PathEscape)));
    }

    #[test]
    fn no_package_error_message_leaks_a_path_or_a_filename() {
        let errors = [
            PackageError::NotAPackage.to_string(),
            PackageError::AlreadyExists.to_string(),
            PackageError::IntegrityFailure {
                short_hash: "ab12cd34ef56".into(),
            }
            .to_string(),
            PackageError::MissingSource {
                short_hash: "ab12cd34ef56".into(),
            }
            .to_string(),
            PackageError::NewerFormat {
                found: 9,
                supported: 1,
            }
            .to_string(),
        ];
        for message in errors {
            assert!(!message.contains(".pdf"), "filename in: {message}");
            assert!(
                !message.contains(":\\") && !message.contains(".sfproj"),
                "path in: {message}"
            );
        }
    }
}
