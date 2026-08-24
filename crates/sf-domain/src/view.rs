//! Saved views: a place in a drawing somebody wants to come back to.
//!
//! "The clash at grid F/4, zoomed in, with only the MEP markups showing" is a thing a reviewer
//! returns to a dozen times during a coordination meeting and cannot describe to anybody else
//! quickly. A saved view is that place, named — the page, the zoom, the position, and the markup
//! filter that was active — so returning to it is one click and *sending* somebody there is
//! possible at all.
//!
//! ## Why the filter travels with it
//!
//! Without the filter, a view restores the geometry and not the point. Half the reason to save
//! "structural queries, level 2" is that everything else was hidden; restoring the position with
//! every discipline switched back on lands somebody in the middle of a drawing they cannot read.
//!
//! ## The bounds, and what they are for
//!
//! The values arrive from the interface and end up steering the renderer. A zoom of `1e12` or a
//! non-finite centre would not corrupt anything, but it would produce a view that cannot be
//! restored and cannot be deleted from a list that will not render — so they are refused at the
//! boundary rather than stored and worked around later.

use crate::{
    error::{optional_text, DomainError, Result},
    ids::{DocumentRevisionId, ProjectId},
};

use serde::{Deserialize, Serialize};

/// A named place in a drawing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedView {
    /// The project this belongs to.
    pub project_id: ProjectId,
    /// The document the view is into.
    pub document_revision_id: DocumentRevisionId,
    /// What the reviewer called it.
    pub name: String,
    /// 1-based page.
    pub page: u32,
    /// Magnification. 1.0 is actual size.
    pub zoom: f64,
    /// Centre of the view in PDF user space, horizontally.
    pub center_x: f64,
    /// Centre of the view in PDF user space, vertically.
    pub center_y: f64,
    /// Page rotation in degrees, as the reviewer had it.
    pub rotation: u32,
    /// The markup filter that was active, as the engine's own opaque JSON.
    ///
    /// Stored verbatim rather than modelled: it is the engine's vocabulary of kinds, statuses and
    /// disciplines, and a second copy of that vocabulary here would be one to keep in step for no
    /// gain. The same decision as markup geometry, for the same reason.
    pub filter: Option<String>,
}

impl SavedView {
    /// The longest a view name may be.
    pub const MAX_NAME: usize = 120;

    /// The widest sensible magnification.
    ///
    /// The engine's own ceiling is 800%; this is well past it, because refusing a view somebody
    /// genuinely saved would be worse than storing an ambitious number. What it stops is a value
    /// that cannot be rendered at all.
    pub const MAX_ZOOM: f64 = 64.0;

    /// Record a view.
    ///
    /// Takes the document rather than its ids and page count separately, so those three cannot
    /// disagree: a view filed against one project, pointing at a document in another, bounded by a
    /// third document's length would be three arguments doing what one should.
    ///
    /// # Errors
    /// If the name is empty or over-long, the page is out of range, or the geometry is not a
    /// number that can be restored.
    pub fn new(
        document: &crate::DocumentRevision,
        name: &str,
        page: u32,
        zoom: f64,
        center: (f64, f64),
        rotation: u32,
    ) -> Result<Self> {
        let page_count = document.page_count;
        let name = optional_text(Some(name), "view name", Self::MAX_NAME)?.ok_or_else(|| {
            DomainError::OutOfRange {
                field: "name",
                reason: "a saved view without a name cannot be found again".into(),
            }
        })?;

        if page == 0 || page > page_count {
            return Err(DomainError::OutOfRange {
                field: "page",
                reason: format!(
                    "page {page} is not one of the {page_count} pages in this document"
                ),
            });
        }

        // Not finite, or zero, or absurd. Any of these produce a view that cannot be restored, and
        // therefore an entry in a list that does nothing when clicked.
        if !zoom.is_finite() || zoom <= 0.0 || zoom > Self::MAX_ZOOM {
            return Err(DomainError::OutOfRange {
                field: "zoom",
                reason: format!("a zoom of {zoom} cannot be restored"),
            });
        }
        if !center.0.is_finite() || !center.1.is_finite() {
            return Err(DomainError::OutOfRange {
                field: "center",
                reason: "a view centred on a value that is not a number cannot be restored".into(),
            });
        }

        Ok(Self {
            project_id: document.project_id,
            document_revision_id: document.id,
            name,
            page,
            zoom,
            center_x: center.0,
            center_y: center.1,
            // Normalised rather than refused: a rotation of 450 means 90, and there is no reader
            // for whom refusing it is more useful than understanding it.
            rotation: rotation % 360,
            filter: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ten-page document to hang the views off.
    fn document() -> crate::DocumentRevision {
        crate::DocumentRevision::new(
            ProjectId::new(),
            crate::SourceDocumentId::new(),
            None,
            crate::ContentHash::from_bytes([0x01; 32]),
            1024,
            10,
            crate::ActorId::local(),
        )
        .unwrap()
    }

    fn view(zoom: f64, center: (f64, f64), page: u32) -> Result<SavedView> {
        SavedView::new(&document(), "Clash at F/4", page, zoom, center, 0)
    }

    #[test]
    fn a_view_records_where_it_was() {
        let saved = view(2.5, (100.0, 200.0), 3).unwrap();
        assert_eq!(saved.name, "Clash at F/4");
        assert_eq!(saved.page, 3);
        assert!((saved.zoom - 2.5).abs() < f64::EPSILON);
        assert!((saved.center_x - 100.0).abs() < f64::EPSILON);
    }

    /// A view nobody can name is a view nobody can find again, which makes it an entry in a list
    /// that wastes a click.
    #[test]
    fn a_view_has_to_be_called_something() {
        let unnamed = SavedView::new(&document(), "   ", 1, 1.0, (0.0, 0.0), 0);
        assert!(unnamed.is_err());
    }

    /// The values steer a renderer. None of these would corrupt anything; all of them would
    /// produce a saved view that does nothing when clicked, which is worse than not saving it.
    #[test]
    fn geometry_that_cannot_be_restored_is_refused() {
        assert!(
            view(f64::NAN, (0.0, 0.0), 1).is_err(),
            "a zoom that is not a number"
        );
        assert!(view(f64::INFINITY, (0.0, 0.0), 1).is_err());
        assert!(view(0.0, (0.0, 0.0), 1).is_err(), "a zoom of nothing");
        assert!(view(-2.0, (0.0, 0.0), 1).is_err());
        assert!(
            view(1e9, (0.0, 0.0), 1).is_err(),
            "past anything renderable"
        );
        assert!(view(1.0, (f64::NAN, 0.0), 1).is_err());
        assert!(view(1.0, (0.0, f64::INFINITY), 1).is_err());
    }

    #[test]
    fn a_page_outside_the_document_is_refused() {
        assert!(view(1.0, (0.0, 0.0), 0).is_err());
        assert!(view(1.0, (0.0, 0.0), 11).is_err());
        assert!(view(1.0, (0.0, 0.0), 10).is_ok(), "the last page is a page");
    }

    /// 450 degrees means 90. Refusing it would be pedantry; understanding it costs one operator.
    #[test]
    fn a_rotation_past_a_full_turn_is_understood_rather_than_refused() {
        let spun = SavedView::new(&document(), "Sideways", 1, 1.0, (0.0, 0.0), 450).unwrap();
        assert_eq!(spun.rotation, 90);
    }
}
