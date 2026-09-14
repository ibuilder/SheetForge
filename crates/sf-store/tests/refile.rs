//! Filing a new issue of a sheet under the drawing already in the project.
//!
//! An import files each drawing as a document of its own. When its title block shows a sheet number
//! that is already a drawing here, and the reviewer says it is a new issue of it, the revision moves
//! under the existing drawing and the empty document is removed. The order of those two writes is
//! the whole risk: the schema cascades a document's deletion to its revisions.

use sf_domain::{
    ActorId, ContentHash, DocumentRevision, Project, Sheet, SheetSource, SourceDocument,
    SourceDocumentId,
};
use sf_store::{Store, StoreError};

struct Filed {
    store: Store,
    project: Project,
    existing: SourceDocument,
    arrived: SourceDocument,
    issue: DocumentRevision,
}

/// A project holding `A-201`, and a second drawing that arrived as `scan0042` whose title block
/// also reads `A-201`.
fn a_project_with_a_reissue() -> Filed {
    let mut store = Store::open_in_memory().unwrap();
    let actor = ActorId::local();
    let project = Project::new("Riverside Tower", None, None, actor.clone()).unwrap();
    store.create_project(&project).unwrap();

    let file = |store: &mut Store, name: &str, byte: u8| {
        let document = SourceDocument::new(project.id, name, None).unwrap();
        store.insert_source_document(&document).unwrap();
        let revision = DocumentRevision::new(
            project.id,
            document.id,
            None,
            ContentHash::from_bytes([byte; 32]),
            1024,
            1,
            actor.clone(),
        )
        .unwrap();
        store.insert_revision(&revision).unwrap();
        let sheet = Sheet::new(
            project.id,
            revision.id,
            1,
            1,
            Some("A-201"),
            Some("SECOND FLOOR PLAN"),
            SheetSource::Extracted,
        )
        .unwrap();
        store.upsert_sheets(&[sheet]).unwrap();
        (document, revision)
    };

    let (existing, _) = file(&mut store, "A-201 SECOND FLOOR PLAN", 1);
    let (arrived, issue) = file(&mut store, "scan0042", 2);
    Filed {
        store,
        project,
        existing,
        arrived,
        issue,
    }
}

#[test]
fn a_sheet_number_finds_the_drawing_already_filed_under_it_and_not_the_new_one() {
    let filed = a_project_with_a_reissue();
    let found = filed
        .store
        .documents_with_sheet_number(filed.project.id, "a-201", filed.arrived.id)
        .unwrap();
    assert_eq!(
        found.iter().map(|document| document.id).collect::<Vec<_>>(),
        vec![filed.existing.id]
    );
    assert!(filed
        .store
        .documents_with_sheet_number(filed.project.id, "A-999", filed.arrived.id)
        .unwrap()
        .is_empty());
}

/// The case that matters. Moved in the wrong order, the cascade would delete the issue itself.
#[test]
fn a_new_issue_moves_under_the_existing_drawing_and_its_empty_document_goes() {
    let mut filed = a_project_with_a_reissue();
    let issues = filed.store.revisions_of(filed.arrived.id).unwrap().len();
    let mut issue = filed.issue.clone();
    let previous = issue.refile_onto(&filed.existing, issues).unwrap();

    filed.store.refile_revision(&issue, previous).unwrap();

    let under_existing = filed.store.revisions_of(filed.existing.id).unwrap();
    assert_eq!(under_existing.len(), 2, "the issue survived the move");
    assert!(under_existing
        .iter()
        .any(|revision| revision.id == issue.id));
    assert!(matches!(
        filed.store.source_document(filed.arrived.id),
        Err(StoreError::NotFound(_))
    ));
}

#[test]
fn a_document_that_still_holds_an_issue_is_not_removed() {
    let mut filed = a_project_with_a_reissue();
    // A stale caller: the move is stored without the domain's check having been made against it.
    let mut issue = filed.issue.clone();
    issue.source_document_id = filed.existing.id;
    filed
        .store
        .refile_revision(&issue, filed.existing.id)
        .unwrap();
    assert!(
        filed.store.source_document(filed.existing.id).is_ok(),
        "a document with issues filed under it must not be deleted"
    );
}

#[test]
fn an_issue_that_was_never_stored_cannot_be_moved() {
    let mut filed = a_project_with_a_reissue();
    let stranger = DocumentRevision::new(
        filed.project.id,
        filed.existing.id,
        None,
        ContentHash::from_bytes([9; 32]),
        1,
        1,
        ActorId::local(),
    )
    .unwrap();
    assert!(matches!(
        filed
            .store
            .refile_revision(&stranger, SourceDocumentId::new()),
        Err(StoreError::NotFound(_))
    ));
}
