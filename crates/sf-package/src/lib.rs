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
    /// What the package holds on disk: measured when it is opened or created, and kept current by
    /// every file this type writes. See [`Package::admit_file`].
    footprint: Footprint,
}

/// What a package holds on disk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Footprint {
    bytes: u64,
    entries: u32,
}

/// The most room a write leaves below the size ceiling, for the database to grow into.
const WRITE_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;

/// The most room a write leaves below the entry ceiling, for the database's journal files.
const WRITE_HEADROOM_ENTRIES: u32 = 16;

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
        let mut package = Self {
            root: root.to_path_buf(),
            manifest,
            store,
            limits: ResourceLimits::default(),
            footprint: Footprint::default(),
        };
        package.write_manifest()?;
        package.footprint = measure(root, &package.limits)?;
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
        Self::open_within(root, ResourceLimits::default())
    }

    /// Open an existing package, refusing one past `limits`.
    ///
    /// A package is a directory somebody can hand you — by email, on a share, from a USB stick —
    /// so its size and the number of files in it are untrusted input like anything else. The
    /// threat model has always listed both ceilings and nothing compared anything with either;
    /// opening read the manifest and went ahead. This measures the package first, and refuses one
    /// that is past either bound before the database is opened or anything is read out of it.
    ///
    /// # Errors
    /// As [`Package::open`], plus [`SecurityError::TooLarge`] or
    /// [`SecurityError::TooManyEntries`].
    pub fn open_within(root: &Path, limits: ResourceLimits) -> Result<Self> {
        let raw = fs::read_to_string(root.join(MANIFEST)).map_err(|_| PackageError::NotAPackage)?;
        let manifest: Manifest =
            serde_json::from_str(&raw).map_err(|_| PackageError::NotAPackage)?;
        if manifest.format > PACKAGE_FORMAT {
            return Err(PackageError::NewerFormat {
                found: manifest.format,
                supported: PACKAGE_FORMAT,
            });
        }
        let footprint = measure(root, &limits)?;
        let store = Store::open(&root.join(DATABASE))?;
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            store,
            limits,
            footprint,
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

    /// The ceilings this package enforces, for callers reading files that will be filed into it.
    #[must_use]
    pub const fn limits(&self) -> &ResourceLimits {
        &self.limits
    }

    /// Replace the resource bounds. Enterprise policy can tighten these.
    pub const fn set_limits(&mut self, limits: ResourceLimits) {
        self.limits = limits;
    }

    /// Refuse a new file that would take the package past a ceiling it is opened against.
    ///
    /// Opening measures a package and refuses one past its size or its file count. That is right
    /// for a package from somebody else, and a lock-out if writing did not obey the same bounds:
    /// nine drawings, each under the 512 MB drawing ceiling, are over the 4 GB package ceiling
    /// together, and nothing compared the total until the next open refused the user's own
    /// project. So every file this type writes is admitted against both bounds first. Anything the
    /// application builds, it can open.
    ///
    /// ## Why a margin
    ///
    /// Markups, calibrations and the audit trail grow the database, and SQLite puts its journal
    /// beside it, without passing through here. A package filled to exactly the ceiling would
    /// refuse to open after its next markup. So files are refused a margin short of each ceiling:
    /// a sixteenth of it, capped, so that a tightened policy ceiling is not swallowed by the margin.
    fn admit_file(&self, len: u64) -> Result<()> {
        let ceiling_bytes = self.limits.max_package_mb.saturating_mul(1024 * 1024);
        let headroom_bytes = (ceiling_bytes / 16).min(WRITE_HEADROOM_BYTES);
        let bytes = self
            .footprint
            .bytes
            .saturating_add(len)
            .saturating_add(headroom_bytes);
        if bytes > ceiling_bytes {
            return Err(SecurityError::PackageFull {
                limit_mb: self.limits.max_package_mb,
            }
            .into());
        }

        let headroom_entries = (self.limits.max_archive_entries / 16).min(WRITE_HEADROOM_ENTRIES);
        let entries = self
            .footprint
            .entries
            .saturating_add(1)
            .saturating_add(headroom_entries);
        self.limits.check_entries(entries)?;
        Ok(())
    }

    /// Count a file this type has just written.
    const fn held(&mut self, len: u64) {
        self.footprint.bytes = self.footprint.bytes.saturating_add(len);
        self.footprint.entries = self.footprint.entries.saturating_add(1);
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
        self.admit_file(bytes.len() as u64)?;
        write_atomically(&destination, bytes)?;
        self.held(bytes.len() as u64);

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
    /// File an attachment — a site photo, a voice note, a specification extract.
    ///
    /// Content-addressed like a source, and for the same reasons: the same photo attached to three
    /// markups is stored once, and a byte that changes changes the name, so there is no such thing
    /// as a stale copy under a familiar filename.
    ///
    /// Unlike a source, the format is **not** sniffed. A source has to be a PDF because the
    /// renderer will be asked to open it; an attachment is whatever somebody photographed or
    /// recorded, and refusing an unfamiliar type would be refusing evidence. It is never executed
    /// and never rendered as anything but the media type the interface asks for.
    ///
    /// # Errors
    /// [`PackageError`] if it exceeds the attachment limit or cannot be written.
    pub fn import_attachment(&mut self, bytes: &[u8]) -> Result<ContentHash> {
        self.limits.check_attachment(bytes.len() as u64)?;

        let hash = hash_bytes(bytes);
        let destination = self.attachment_path(hash)?;
        if destination.exists() {
            return Ok(hash);
        }
        self.admit_file(bytes.len() as u64)?;
        write_atomically(&destination, bytes)?;
        self.held(bytes.len() as u64);
        Ok(hash)
    }

    /// Read an attachment back.
    ///
    /// # Errors
    /// [`PackageError::MissingSource`] if there is no such attachment, or
    /// [`PackageError::IntegrityFailure`] if the stored bytes no longer hash to their name.
    pub fn attachment_bytes(&self, hash: ContentHash) -> Result<Vec<u8>> {
        let path = self.attachment_path(hash)?;
        // Bounded, because a package can come from somebody else: an entry swollen past the
        // attachment ceiling is refused rather than loaded, and a missing one is still "missing".
        let bytes = self
            .limits
            .read_attachment(&path)
            .map_err(|error| match error {
                SecurityError::TooLarge { .. } => PackageError::Security(error),
                _ => PackageError::MissingSource {
                    short_hash: hash.short(),
                },
            })?;

        // Verified on the way out, not merely on the way in. A photo that is evidence of a defect
        // is exactly the file somebody might later claim was altered, and the hash is the whole
        // answer to that — checking it costs one pass over bytes already in memory.
        if hash_bytes(&bytes) != hash {
            return Err(PackageError::IntegrityFailure {
                short_hash: hash.short(),
            });
        }
        Ok(bytes)
    }

    /// Where an attachment lives. Extension-free: the bytes are whatever they are, and a filename
    /// claiming a type the content does not have is a small lie waiting to be believed.
    ///
    /// # Errors
    /// If the hash would escape the package, which it cannot — it is hexadecimal — but the check
    /// is the same one every other path goes through and having one exception is how the exception
    /// becomes the rule.
    pub fn attachment_path(&self, hash: ContentHash) -> Result<PathBuf> {
        Ok(sf_security::contained_path(
            &self.root,
            &format!("{ATTACHMENTS}/{}", hash.to_hex()),
        )?)
    }

    /// Where a source drawing lives, named for its content hash.
    ///
    /// # Errors
    /// If the resulting path would fall outside the package, which a hexadecimal hash cannot — but
    /// every path in this module goes through the same check, and an exception is how the check
    /// stops being one.
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
        // The source a drawing was filed from, read against the drawing ceiling — the same one it
        // was admitted under, so an entry that grew since, or arrived in somebody else's package,
        // cannot be loaded whole by being asked for.
        Ok(self.limits.read_pdf(&path)?)
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
            let bytes = self.limits.read_pdf(&path)?;
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

/// Measure a package, refusing one past either ceiling.
///
/// ## Why it stops early
///
/// The bounds exist because the package is untrusted, so the measurement itself must be bounded:
/// counting every file in a package built to hold a hundred million of them is the attack, not the
/// defence. Both ceilings are checked as the walk goes, and the walk stops at the first refusal.
///
/// ## Why symlinks are not followed
///
/// `file_type` from a directory entry does not follow links, and only real directories are
/// descended into. A package containing a link to `C:\` or `/` would otherwise make this walk the
/// whole disk — a refusal that never arrives is as bad as no refusal. A link is still *counted*,
/// and its own size measured, because it is an entry in the package; what is not done is reading
/// through it.
///
/// Cache files are counted too. They are part of what the package costs to hold, and a package
/// arriving with a cache directory of ten million files is precisely the case being refused.
fn measure(root: &Path, limits: &ResourceLimits) -> Result<Footprint> {
    let mut pending = vec![root.to_path_buf()];
    let mut entries: u32 = 0;
    let mut bytes: u64 = 0;

    while let Some(directory) = pending.pop() {
        // Refused, not skipped. Skipping a directory that cannot be listed, or a file whose size
        // cannot be read, lowers the total silently, and a package part of which could not be
        // measured has not been shown to be inside its bounds. An earlier version skipped both,
        // beneath a comment saying the total must not be lowered.
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            entries = entries.saturating_add(1);
            limits.check_entries(entries)?;

            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            } else {
                bytes = bytes.saturating_add(entry.metadata()?.len());
                limits.check_package(bytes)?;
            }
        }
    }
    Ok(Footprint { bytes, entries })
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

    /// The package ceiling was declared in the threat model and compared with nothing: opening read
    /// the manifest and went ahead, whatever the package held. A package is a directory somebody
    /// hands you, so both its size and its file count are untrusted.
    #[test]
    fn a_package_past_its_size_ceiling_is_refused_on_the_way_in() {
        let (dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);
        fs::write(root.join(SOURCES).join("big"), vec![0u8; 3 * 1024 * 1024]).unwrap();

        let refusal = Package::open_within(
            &root,
            ResourceLimits {
                max_package_mb: 1,
                ..ResourceLimits::default()
            },
        )
        .err()
        .expect("a package over the ceiling must be refused");
        assert!(
            matches!(
                refusal,
                PackageError::Security(SecurityError::TooLarge {
                    subject: "a project package",
                    ..
                })
            ),
            "{refusal:?}"
        );
        // The same package opens against the shipped ceilings: the bound refuses the absurd, not
        // the ordinary.
        assert!(
            Package::open(&root).is_ok(),
            "the default ceiling must admit it"
        );
        drop(dir);
    }

    /// The other half of the package ceiling: a project the application built has to be one it can
    /// open. Each drawing here is far under the drawing ceiling; together they would pass the
    /// package ceiling, and before writes were admitted against it the next open refused the
    /// user's own project with no way back in.
    #[test]
    fn a_file_that_would_overfill_the_package_is_refused_before_it_is_written() {
        let (_dir, mut package) = new_package();
        let limits = ResourceLimits {
            max_package_mb: 16,
            ..ResourceLimits::default()
        };
        package.set_limits(limits);
        // 5.5 MB each, distinct bytes. Two fit under 16 MB with the margin and the database; a
        // third would not, whatever size the database happens to be.
        let drawing = |fill: u8| {
            let mut bytes = b"%PDF-1.7\n".to_vec();
            bytes.resize(5 * 1024 * 1024 + 512 * 1024, fill);
            bytes
        };

        package
            .import_source(&drawing(b'a'))
            .expect("the first fits");
        package
            .import_source(&drawing(b'b'))
            .expect("the second fits");
        let refusal = package
            .import_source(&drawing(b'c'))
            .expect_err("the third would overfill the package");
        assert!(
            matches!(
                refusal,
                PackageError::Security(SecurityError::PackageFull { limit_mb: 16 })
            ),
            "{refusal:?}"
        );
        assert_eq!(
            fs::read_dir(package.root().join(SOURCES)).unwrap().count(),
            2,
            "nothing is written for a refused file"
        );

        let root = package.root().to_path_buf();
        drop(package);
        assert!(
            Package::open_within(&root, limits).is_ok(),
            "a package the application built must open under the ceiling it was built under"
        );
    }

    /// Measuring skipped what it could not read, lowering the total beneath a comment saying the
    /// total must not be lowered. A package that cannot all be measured is now refused.
    #[cfg(unix)]
    #[test]
    fn a_package_that_cannot_all_be_measured_is_refused_rather_than_undercounted() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);
        let hidden = root.join(CACHE);
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();
        // Root lists anything, and some CI containers run as root: the premise does not hold there.
        if fs::read_dir(&hidden).is_ok() {
            fs::set_permissions(&hidden, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let opened = Package::open(&root);
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            matches!(opened, Err(PackageError::Io(_))),
            "a package part of which could not be measured must not open"
        );
        drop(dir);
    }

    #[test]
    fn a_package_holding_more_files_than_the_ceiling_allows_is_refused() {
        let (dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);
        for index in 0..20u32 {
            fs::write(root.join(CACHE).join(index.to_string()), b"x").unwrap();
        }

        let refusal = Package::open_within(
            &root,
            ResourceLimits {
                max_archive_entries: 8,
                ..ResourceLimits::default()
            },
        )
        .err()
        .expect("a package with too many files must be refused");
        assert!(
            matches!(
                refusal,
                PackageError::Security(SecurityError::TooManyEntries { limit: 8 })
            ),
            "{refusal:?}"
        );
        drop(dir);
    }

    /// A package carrying a link to the root of the disk must not make the measurement walk the
    /// whole machine. The link is counted as the entry it is; nothing is read through it.
    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_package_is_counted_but_not_followed() {
        let (dir, package) = new_package();
        let root = package.root().to_path_buf();
        drop(package);
        std::os::unix::fs::symlink("/", root.join(SOURCES).join("everything")).unwrap();

        // Bounded, so if the walk followed the link this would not return at all.
        let opened = Package::open_within(
            &root,
            ResourceLimits {
                max_archive_entries: 64,
                ..ResourceLimits::default()
            },
        );
        assert!(opened.is_ok(), "a link must not be walked through");
        drop(dir);
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

    /// The same photo attached to three markups is stored once. Content addressing does that for
    /// free, and this is the test that says it is relied upon rather than incidental.
    #[test]
    fn the_same_attachment_twice_is_stored_once() {
        let (_dir, mut package) = new_package();

        // A JPEG magic number followed by nothing in particular: an attachment is whatever
        // somebody photographed, and the package deliberately does not sniff it.
        let photo = [&[0xff_u8, 0xd8, 0xff, 0xe0][..], b"and then some bytes"].concat();
        let first = package.import_attachment(&photo).unwrap();
        let second = package.import_attachment(&photo).unwrap();

        assert_eq!(first, second, "identical bytes produced two names");
        assert_eq!(package.attachment_bytes(first).unwrap(), photo);
    }

    /// A photo is evidence of a defect, and evidence is exactly what somebody later claims was
    /// altered. The hash is the answer, and checking it on the way *out* is what makes it one.
    #[test]
    fn an_attachment_altered_on_disk_is_refused_rather_than_returned() {
        let (_dir, mut package) = new_package();

        let photo = b"the wall, before it was rendered".to_vec();
        let hash = package.import_attachment(&photo).unwrap();
        let path = package.attachment_path(hash).unwrap();

        std::fs::write(&path, b"the wall, after somebody had a word").unwrap();

        assert!(
            package.attachment_bytes(hash).is_err(),
            "altered bytes were handed back as though they were the ones filed",
        );
    }

    /// An attachment nobody filed is missing, not corrupt. The two want different responses from
    /// the person reading the message.
    #[test]
    fn an_attachment_that_was_never_filed_reports_missing() {
        let (_dir, package) = new_package();
        let never = ContentHash::from_bytes([0x99; 32]);

        assert!(matches!(
            package.attachment_bytes(never),
            Err(PackageError::MissingSource { .. })
        ));
    }

    /// A site photo from a modern phone is 3 to 12 MB; the limit is 64. What this refuses is a
    /// video somebody dropped in by accident, before it is copied into the package.
    #[test]
    fn an_attachment_past_the_limit_is_refused_before_it_is_written() {
        let (dir, mut package) = new_package();

        let limits = sf_security::ResourceLimits {
            max_attachment_mb: 1,
            ..Default::default()
        };
        package.set_limits(limits);

        let too_big = vec![0u8; 2 * 1024 * 1024];
        assert!(package.import_attachment(&too_big).is_err());

        // And nothing was written on the way to refusing.
        let attachments = fs::read_dir(
            dir.path()
                .join("Riverside Tower.sfproj")
                .join("attachments"),
        )
        .map_or(0, Iterator::count);
        assert_eq!(attachments, 0, "a refused attachment left bytes behind");
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
