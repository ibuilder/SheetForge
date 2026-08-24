//! The projects this person had open lately.
//!
//! Closing the application currently means finding your work again through a folder dialog, which
//! is a poor deal for the thing somebody does every single morning. This remembers what was open
//! and offers it back.
//!
//! ## The list holds paths; the interface never sees one
//!
//! [The rules](../../../../CLAUDE.md) say no command takes a path and the native picker runs in
//! Rust. A recent-projects list is exactly the feature that tempts you to break that: the obvious
//! shape is "send the interface a list of paths and let it ask for one back", and then a
//! compromised or merely buggy webview can name any location on the disk and have the host open
//! it.
//!
//! So the path stays here. Each entry is named to the interface by an opaque handle, and the
//! interface asks to open *a handle*. A handle that does not match an entry opens nothing. The
//! webview cannot express "open C:\Users\someone\Documents" because there is no argument in which
//! to say it.
//!
//! The handle is derived from the location rather than stored beside it, which keeps two things
//! true at once: it is stable, so a handle still works after a restart, and it cannot drift out of
//! step with the entry it names because there is nothing to drift. It is a hash, so it carries no
//! part of the path back to the interface — and it does not need to resist an attacker, because it
//! is only ever compared against a list this process wrote.
//!
//! ## Where it lives, and what is in it
//!
//! Beside the application's own configuration, not inside any project: it is a fact about this
//! installation, not about a job, and a project package that carried a list of other projects
//! would leak one client's name into another client's folder.
//!
//! It holds the project name, its location, and when it was last opened. The name is already
//! visible in the interface and the timestamp is about the person's own machine. Nothing from
//! inside a project — no drawing name, no markup, no count — goes in here.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How many are kept.
///
/// Ten is about a week of work for somebody who moves between jobs, and a list longer than a menu
/// can show is a list nobody reads to the bottom of.
const KEEP: usize = 10;

/// One entry, as it is stored. The path is the part that never leaves this process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// The project's name, as it was when it was last opened.
    pub name: String,
    /// Where it is. Never serialised across the IPC boundary — see [`Recent::listing`].
    pub root: PathBuf,
    /// RFC 3339 UTC.
    pub opened_at: String,
}

/// The handle the interface uses to name a location it is not allowed to see.
///
/// FNV-1a, written out rather than pulled in: it is eight lines, it is stable for ever — which
/// matters, because a handle held across a restart must still resolve — and it has no security
/// job to do. Nothing is trusted because it hashes to something; a handle is only ever compared
/// against entries this process itself recorded.
fn handle(root: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// One entry as the interface sees it: enough to choose, and no location.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The opaque handle the interface uses to ask for this project. Not a path, and not
    /// derived from one in any way the interface can reverse.
    pub id: String,
    /// The project's name, which is the only thing worth showing in a list of projects.
    pub name: String,
    /// RFC 3339 UTC, so the list can be shown newest first with a date beside each.
    pub opened_at: String,
    /// Whether the folder is still there. A project moved or deleted outside the application is a
    /// normal thing to have happened, and an entry that silently vanished would leave somebody
    /// wondering whether they had imagined it.
    pub available: bool,
}

/// The remembered list, newest first.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Recent {
    #[serde(default)]
    entries: Vec<Entry>,
}

impl Recent {
    /// Read the list, or an empty one.
    ///
    /// A corrupt or unreadable file is treated as an empty list rather than as an error. This is a
    /// convenience; refusing to start because a convenience file had a stray byte in it would be a
    /// worse failure than forgetting where somebody was working.
    #[must_use]
    pub fn load(file: &Path) -> Self {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Write the list, best effort.
    ///
    /// # Errors
    /// If the directory cannot be created or the file cannot be written.
    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        std::fs::write(file, json)
    }

    /// Record a project as just opened, moving it to the front.
    ///
    /// Matched on the path rather than on the name, because two jobs may share a name and the same
    /// job may be renamed.
    pub fn record(&mut self, name: &str, root: &Path, now: &str) {
        self.entries.retain(|entry| entry.root != root);
        self.entries.insert(
            0,
            Entry {
                name: name.to_owned(),
                root: root.to_owned(),
                opened_at: now.to_owned(),
            },
        );
        self.entries.truncate(KEEP);
    }

    /// What the interface is allowed to know.
    #[must_use]
    pub fn listing(&self) -> Vec<Listing> {
        self.entries
            .iter()
            .map(|entry| Listing {
                id: handle(&entry.root),
                name: entry.name.clone(),
                opened_at: entry.opened_at.clone(),
                available: entry.root.is_dir(),
            })
            .collect()
    }

    /// The location of an entry the interface named.
    ///
    /// Returns `None` for anything not in the list, which is the whole of the defence: the only
    /// paths this can produce are ones the host itself put there.
    #[must_use]
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.entries
            .iter()
            .find(|entry| handle(&entry.root) == id)
            .map(|entry| entry.root.clone())
    }

    /// Forget an entry.
    pub fn forget(&mut self, id: &str) {
        self.entries.retain(|entry| handle(&entry.root) != id);
    }

    /// How many are remembered.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether anything is remembered at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(name: &str) -> PathBuf {
        PathBuf::from(format!("/jobs/{name}.sfproj"))
    }

    #[test]
    fn the_most_recently_opened_project_comes_first() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");
        recent.record("Northgate", &at("northgate"), "2026-08-24T01:00:00Z");

        let listing = recent.listing();
        assert_eq!(listing[0].name, "Northgate");
        assert_eq!(listing[1].name, "Riverside");
    }

    #[test]
    fn reopening_a_project_moves_it_up_rather_than_listing_it_twice() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");
        recent.record("Northgate", &at("northgate"), "2026-08-24T01:00:00Z");
        recent.record("Riverside", &at("riverside"), "2026-08-24T02:00:00Z");

        assert_eq!(recent.len(), 2, "the same project twice is one entry");
        assert_eq!(recent.listing()[0].name, "Riverside");
    }

    /// Renaming a job must not produce two entries pointing at one folder. Matching on the path is
    /// what makes that true, and this is the test that says so.
    #[test]
    fn a_renamed_project_is_still_the_same_entry() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");
        recent.record("Riverside Tower", &at("riverside"), "2026-08-24T01:00:00Z");

        assert_eq!(recent.len(), 1);
        assert_eq!(recent.listing()[0].name, "Riverside Tower");
    }

    #[test]
    fn the_list_does_not_grow_without_bound() {
        let mut recent = Recent::default();
        for index in 0..40 {
            recent.record(
                &format!("Job {index}"),
                &at(&index.to_string()),
                "2026-08-24T00:00:00Z",
            );
        }
        assert_eq!(recent.len(), KEEP);
        assert_eq!(
            recent.listing()[0].name,
            "Job 39",
            "newest kept, oldest dropped"
        );
    }

    /// The reason this module exists in the shape it does. If a location ever appears in what
    /// crosses the boundary, the interface has been handed a filesystem it is not allowed to have.
    #[test]
    fn no_location_appears_in_what_the_interface_is_sent() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");

        let json = serde_json::to_string(&recent.listing()).unwrap();
        assert!(
            !json.contains("jobs"),
            "a path component reached the interface: {json}"
        );
        assert!(
            !json.contains("sfproj"),
            "a path reached the interface: {json}"
        );
        assert!(
            json.contains("Riverside"),
            "the name is the point of the list"
        );
    }

    /// A handle that names no entry resolves to nothing. This is the whole of the argument that
    /// the interface cannot ask for an arbitrary location.
    #[test]
    fn an_identifier_the_host_never_issued_resolves_to_nothing() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");

        assert!(recent.path_of("../../etc/passwd").is_none());
        assert!(recent.path_of("C:\\Windows\\System32").is_none());
        assert!(recent.path_of("").is_none());
        assert!(recent.path_of("0000000000000000").is_none());

        let real = recent.listing()[0].id.clone();
        assert_eq!(recent.path_of(&real), Some(at("riverside")));
    }

    /// The handle has to survive the file being written and read back, or a list restored at
    /// start-up would name projects the interface could no longer open.
    #[test]
    fn a_handle_still_resolves_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");

        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");
        let before = recent.listing()[0].id.clone();
        recent.save(&file).unwrap();

        let after = Recent::load(&file).listing()[0].id.clone();
        assert_eq!(before, after, "the handle changed across a save and load");
    }

    /// Two projects must not share a handle, or opening one would open the other.
    #[test]
    fn different_projects_get_different_handles() {
        let mut recent = Recent::default();
        for index in 0..KEEP {
            recent.record(
                &format!("Job {index}"),
                &at(&index.to_string()),
                "2026-08-24T00:00:00Z",
            );
        }
        let mut handles: Vec<String> = recent.listing().into_iter().map(|each| each.id).collect();
        handles.sort();
        let before = handles.len();
        handles.dedup();
        assert_eq!(handles.len(), before, "two entries share a handle");
    }

    #[test]
    fn a_corrupt_list_is_an_empty_list_rather_than_a_failure_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recent.json");
        std::fs::write(&file, b"{ this is not json").unwrap();
        assert!(Recent::load(&file).is_empty());
    }

    #[test]
    fn a_saved_list_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("recent.json");

        let mut recent = Recent::default();
        recent.record("Riverside", dir.path(), "2026-08-24T00:00:00Z");
        recent.save(&file).unwrap();

        let read = Recent::load(&file);
        assert_eq!(read.len(), 1);
        // The directory exists, so the entry reports as available — which is the check that tells
        // somebody a project has been moved rather than leaving them to wonder.
        assert!(read.listing()[0].available);
    }

    #[test]
    fn a_project_that_has_moved_is_listed_but_marked_unavailable() {
        let mut recent = Recent::default();
        recent.record("Gone", &at("nowhere-at-all"), "2026-08-24T00:00:00Z");
        assert!(!recent.listing()[0].available);
    }

    #[test]
    fn forgetting_an_entry_removes_it() {
        let mut recent = Recent::default();
        recent.record("Riverside", &at("riverside"), "2026-08-24T00:00:00Z");
        let id = recent.listing()[0].id.clone();

        recent.forget(&id);
        assert!(recent.is_empty());
        assert!(recent.path_of(&id).is_none());
    }
}
