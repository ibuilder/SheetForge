//! Renaming a drawing once its title block has been read.
//!
//! A drawing is filed under its filename and renamed to the sheet number printed on it. The rename
//! has to reach the file, and has to leave everything that refers to the drawing alone.

use sf_domain::{ActorId, Project, SourceDocument};
use sf_store::{Store, StoreError};

#[test]
fn a_drawing_renamed_from_its_title_block_is_renamed_and_not_duplicated() {
    let store = Store::open_in_memory().unwrap();
    let project = Project::new("Riverside Tower", None, None, ActorId::local()).unwrap();
    store.create_project(&project).unwrap();

    let mut document = SourceDocument::new(project.id, "scan0042", None).unwrap();
    store.insert_source_document(&document).unwrap();

    document.rename("A-201").unwrap();
    store.rename_source_document(&document).unwrap();

    assert_eq!(store.source_document(document.id).unwrap().name, "A-201");
    let all = store.source_documents(project.id).unwrap();
    assert_eq!(all.len(), 1, "renamed, not filed a second time");
    assert_eq!(all[0].id, document.id);
}

#[test]
fn a_drawing_that_was_never_filed_cannot_be_renamed_or_found() {
    let store = Store::open_in_memory().unwrap();
    let project = Project::new("Riverside Tower", None, None, ActorId::local()).unwrap();
    store.create_project(&project).unwrap();

    let stranger = SourceDocument::new(project.id, "never filed", None).unwrap();
    assert!(matches!(
        store.rename_source_document(&stranger),
        Err(StoreError::NotFound(_))
    ));
    assert!(matches!(
        store.source_document(stranger.id),
        Err(StoreError::NotFound(_))
    ));
}
