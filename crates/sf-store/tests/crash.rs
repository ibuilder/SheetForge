//! Does a committed write survive the process being killed?
//!
//! The existing durability test leaks the connection so no destructor runs, which is as close as a
//! single process can get to disappearing. It is not close enough to settle the question: it still
//! unwinds cleanly at the end, the operating system still flushes what it holds, and nothing
//! exercises what happens when the process is removed *between* a commit and anything tidy.
//!
//! This kills a real child process with no chance to clean up — `TerminateProcess` on Windows,
//! `SIGKILL` elsewhere — after it has committed, and then reopens the file. That is the failure a
//! tablet on a construction site actually has: the battery goes, mid-review, in a basement.
//!
//! It is still not a power-cut test. Killing a process does not discard what the *operating system*
//! has buffered, so this proves SQLite committed rather than proving the platter did. Testing that
//! honestly needs hardware or a filesystem fault injector, and is named as a gap in
//! `docs/status.md` rather than quietly implied by this passing.

use sf_domain::{
    ActorId, ContentHash, DocumentRevision, Geometry, Markup, MarkupKind, MarkupMetadata, Project,
    SourceDocument,
};
use sf_store::Store;
use std::path::Path;
use std::time::{Duration, Instant};

/// Set on the child so it knows to be the subject rather than the runner.
const ROLE: &str = "SF_CRASH_TEST_DB";
/// The child touches this once its write is committed, so the parent kills it at the right moment.
const READY: &str = "SF_CRASH_TEST_READY";

const SUBJECT: &str = "Duct clashes with beam";

/// Everything the child does: build a project, commit one markup, announce it, then wait to die.
fn be_the_subject(db: &Path, ready: &Path) -> ! {
    let store = Store::open(db).expect("open");
    let actor = ActorId::local();

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
        actor.clone(),
    )
    .unwrap();
    store.insert_revision(&revision).unwrap();

    let markup = Markup::create(
        project.id,
        revision.id,
        4,
        revision.page_count,
        MarkupKind::Cloud,
        Geometry::new(1, serde_json::json!({ "points": [[72.0, 144.0]] })).unwrap(),
        MarkupMetadata {
            subject: Some(SUBJECT.into()),
            ..Default::default()
        },
        None,
        actor,
    )
    .unwrap();
    store.insert_markup(&markup).unwrap();

    // Committed. Announce it, then hand the process over to the parent to destroy — deliberately
    // without closing the connection, checkpointing the WAL, or dropping anything.
    std::fs::write(ready, markup.id.to_string()).unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_committed_write_survives_the_process_being_killed() {
    // The child is this same test binary, re-run with the role variable set. Cargo hands us its
    // own path, so there is nothing to build or locate.
    if let Ok(db) = std::env::var(ROLE) {
        let ready = std::env::var(READY).expect("the ready path travels with the role");
        be_the_subject(Path::new(&db), Path::new(&ready));
    }

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("database.sqlite");
    let ready = dir.path().join("ready");

    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "a_committed_write_survives_the_process_being_killed",
            "--exact",
            "--nocapture",
        ])
        .env(ROLE, &db)
        .env(READY, &ready)
        .spawn()
        .expect("spawn the subject process");

    // Wait for the commit, but never forever: a child that dies early must fail this test rather
    // than hang the suite.
    let deadline = Instant::now() + Duration::from_secs(60);
    let expected_id = loop {
        if let Ok(contents) = std::fs::read_to_string(&ready) {
            if !contents.trim().is_empty() {
                break contents.trim().to_owned();
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("the subject process exited before committing: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "the subject never committed within 60s"
        );
        std::thread::sleep(Duration::from_millis(25));
    };

    // No unwinding, no destructors, no checkpoint. The connection is simply gone.
    child.kill().expect("kill the subject");
    let _ = child.wait();

    let reopened = Store::open(&db).expect("the database reopens after an abrupt kill");
    let project = reopened
        .project()
        .expect("read")
        .expect("the project survived");
    let documents = reopened.source_documents(project.id).unwrap();
    let revisions = reopened.revisions_of(documents[0].id).unwrap();
    let markups = reopened.markups(revisions[0].id).unwrap();

    assert_eq!(
        markups.len(),
        1,
        "the committed markup did not survive the kill"
    );
    assert_eq!(markups[0].id.to_string(), expected_id);
    assert_eq!(
        markups[0].metadata.subject.as_deref(),
        Some(SUBJECT),
        "the markup came back but its content did not",
    );

    // And the file is not merely readable but sound: a half-applied transaction would show up here.
    reopened
        .verify_audit()
        .expect("the audit trail is intact after the kill");
}
