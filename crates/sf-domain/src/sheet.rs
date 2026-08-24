//! The sheet register: what each page of a set actually is.
//!
//! A drawing set is not a PDF with pages, it is a *register* — `A-201 SECOND FLOOR PLAN`, revision
//! C, issued on a date, at a scale. The question a reviewer asks constantly is "which sheets are at
//! revision C?", and until this existed the answer was to scroll two hundred pages looking at title
//! blocks.
//!
//! ## Where the numbers come from, and why that is recorded
//!
//! Almost none of this is typed in. The drawing engine reads title blocks — the sheet number is the
//! largest text in the right-hand strip matching a sheet-number pattern — and on a scanned set that
//! reading comes through OCR, which is confidently wrong about small lettering. `A-201` and `A-2O1`
//! are one substituted letter apart and look identical at a glance.
//!
//! So [`SheetSource`] travels with every field, and the interface is expected to show the
//! difference. This is the same rule the measurement code follows for an OCR-read scale: a value
//! nobody has checked is *usable and provisional*, never presented as verified. A register that
//! silently mixes "somebody typed this" with "a machine guessed this from a 1974 dyeline" is a
//! register that will be believed at the wrong moment.
//!
//! ## What this is not
//!
//! It is not a second source of truth about pages. The page count belongs to the revision; this
//! says what the pages *are*. A sheet row pointing at a page that does not exist is refused rather
//! than stored, because the register is the thing people navigate by and a dead entry in it wastes
//! somebody's afternoon.

use crate::{
    error::{optional_text, DomainError, Result},
    ids::{DocumentRevisionId, ProjectId},
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// How a field in the register came to be known.
///
/// Ordered by how much weight it deserves, least first, so a comparison reads the way the trust
/// does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SheetSource {
    /// Read off the sheet by optical character recognition. The least trustworthy: OCR is
    /// confidently wrong about small title-block lettering, and this is the state that must never
    /// be presented as though somebody had checked it.
    Recognised,
    /// Read from the PDF's own text layer by the title-block heuristic. Better than OCR — the
    /// characters are exact — but the *choice* of which text is the sheet number is still a guess.
    Extracted,
    /// Read from an imported register: a drawing schedule, a transmittal, another system.
    /// Trustworthy about the characters, and only as trustworthy as its source about the facts.
    Imported,
    /// Typed or confirmed by a person looking at the sheet. The only state that means somebody
    /// takes responsibility for it.
    Confirmed,
}

impl SheetSource {
    /// Whether this is a value a person has stood behind.
    ///
    /// The one question the interface actually asks, and having it here stops each caller
    /// re-deciding where the line is.
    #[must_use]
    pub const fn is_confirmed(self) -> bool {
        matches!(self, Self::Confirmed)
    }

    /// How it should be described to somebody reading the register.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recognised => "recognised",
            Self::Extracted => "extracted",
            Self::Imported => "imported",
            Self::Confirmed => "confirmed",
        }
    }
}

impl fmt::Display for SheetSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SheetSource {
    type Err = DomainError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "recognised" => Ok(Self::Recognised),
            "extracted" => Ok(Self::Extracted),
            "imported" => Ok(Self::Imported),
            "confirmed" => Ok(Self::Confirmed),
            _ => Err(DomainError::Malformed {
                subject: "SheetSource",
            }),
        }
    }
}

/// One page of a set, as the register describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sheet {
    /// The project this belongs to.
    pub project_id: ProjectId,
    /// The revision whose pages these are.
    pub document_revision_id: DocumentRevisionId,
    /// 1-based page within that revision.
    pub page: u32,
    /// The sheet number as printed — `A-201`. Absent when nothing could be read and nobody typed
    /// one, which is honest and common on sketches.
    pub number: Option<String>,
    /// The sheet title as printed — `SECOND FLOOR PLAN`.
    pub title: Option<String>,
    /// Discipline, as the engine classifies it.
    pub discipline: Option<String>,
    /// The revision letter printed in the title block. Distinct from the *document* revision: a
    /// 200-sheet issue routinely contains sheets at different revisions, which is exactly why
    /// "every sheet at Rev C" is a question worth being able to ask.
    pub revision: Option<String>,
    /// Where all of this came from.
    pub source: SheetSource,
}

impl Sheet {
    /// The longest a printed sheet number is allowed to be.
    ///
    /// Generous: `A-201`, `M-4.01a`, `SK-12`, and the long package-prefixed numbers some clients
    /// insist on. A bound at all, because this is read off a hostile document by a heuristic and
    /// ends up in an interface — a title block misread as three hundred characters of noise should
    /// be refused, not rendered.
    pub const MAX_NUMBER: usize = 64;

    /// The longest a sheet title is allowed to be.
    pub const MAX_TITLE: usize = 200;

    /// Record what a page is.
    ///
    /// # Errors
    /// If the page is zero, past the revision's page count, or if a field is over-long.
    pub fn new(
        project_id: ProjectId,
        document_revision_id: DocumentRevisionId,
        page: u32,
        page_count: u32,
        number: Option<&str>,
        title: Option<&str>,
        source: SheetSource,
    ) -> Result<Self> {
        if page == 0 {
            return Err(DomainError::OutOfRange {
                field: "page",
                reason: "pages are numbered from one".into(),
            });
        }
        if page > page_count {
            return Err(DomainError::OutOfRange {
                field: "page",
                reason: format!(
                    "page {page} is past the end of a document with {page_count} pages, so the \
                     register would point at nothing"
                ),
            });
        }

        Ok(Self {
            project_id,
            document_revision_id,
            page,
            number: optional_text(number, "sheet number", Self::MAX_NUMBER)?,
            title: optional_text(title, "sheet title", Self::MAX_TITLE)?,
            discipline: None,
            revision: None,
            source,
        })
    }

    /// Whether this row says anything at all.
    ///
    /// A page the heuristic could read nothing from produces an empty row, and storing thousands of
    /// those turns the register into a list of blanks. Worth asking before writing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.number.is_none()
            && self.title.is_none()
            && self.discipline.is_none()
            && self.revision.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> (ProjectId, DocumentRevisionId) {
        (ProjectId::new(), DocumentRevisionId::new())
    }

    #[test]
    fn a_sheet_records_what_was_read_and_where_it_came_from() {
        let (project, revision) = ids();
        let sheet = Sheet::new(
            project,
            revision,
            7,
            200,
            Some("A-201"),
            Some("SECOND FLOOR PLAN"),
            SheetSource::Extracted,
        )
        .unwrap();

        assert_eq!(sheet.number.as_deref(), Some("A-201"));
        assert_eq!(sheet.source, SheetSource::Extracted);
        assert!(
            !sheet.source.is_confirmed(),
            "a heuristic did not confirm it"
        );
    }

    /// The whole reason the source is stored. Anything but `Confirmed` is a value nobody has stood
    /// behind, and an interface that shows them alike will be believed at the wrong moment.
    #[test]
    fn only_a_person_confirms_a_sheet_number() {
        assert!(!SheetSource::Recognised.is_confirmed());
        assert!(!SheetSource::Extracted.is_confirmed());
        assert!(!SheetSource::Imported.is_confirmed());
        assert!(SheetSource::Confirmed.is_confirmed());
    }

    /// Ordered least trustworthy first, so `<` reads the way the trust does and a caller sorting a
    /// register does not have to remember which way round it goes.
    #[test]
    fn the_sources_are_ordered_by_how_much_they_deserve_to_be_believed() {
        assert!(SheetSource::Recognised < SheetSource::Extracted);
        assert!(SheetSource::Extracted < SheetSource::Imported);
        assert!(SheetSource::Imported < SheetSource::Confirmed);
    }

    #[test]
    fn a_source_round_trips_through_its_stored_form() {
        for source in [
            SheetSource::Recognised,
            SheetSource::Extracted,
            SheetSource::Imported,
            SheetSource::Confirmed,
        ] {
            assert_eq!(SheetSource::from_str(source.as_str()).unwrap(), source);
        }
        assert!(SheetSource::from_str("guessed").is_err());
    }

    /// The register is what people navigate by. An entry pointing at a page that is not there
    /// wastes somebody's afternoon, and is cheaper to refuse than to explain.
    #[test]
    fn a_sheet_past_the_end_of_the_document_is_refused() {
        let (project, revision) = ids();
        assert!(Sheet::new(
            project,
            revision,
            201,
            200,
            Some("A-999"),
            None,
            SheetSource::Extracted
        )
        .is_err());
        assert!(Sheet::new(
            project,
            revision,
            0,
            200,
            Some("A-001"),
            None,
            SheetSource::Extracted
        )
        .is_err());
        assert!(
            Sheet::new(
                project,
                revision,
                200,
                200,
                Some("A-200"),
                None,
                SheetSource::Extracted
            )
            .is_ok(),
            "the last page is a page",
        );
    }

    /// A title block misread as a wall of noise should be refused rather than rendered. This is
    /// read off a document somebody else wrote, by a heuristic, and it ends up in an interface.
    #[test]
    fn an_absurd_sheet_number_is_refused() {
        let (project, revision) = ids();
        let noise = "A".repeat(Sheet::MAX_NUMBER + 1);
        assert!(Sheet::new(
            project,
            revision,
            1,
            10,
            Some(&noise),
            None,
            SheetSource::Recognised
        )
        .is_err());

        let long_title = "T".repeat(Sheet::MAX_TITLE + 1);
        assert!(Sheet::new(
            project,
            revision,
            1,
            10,
            None,
            Some(&long_title),
            SheetSource::Recognised
        )
        .is_err());
    }

    #[test]
    fn a_page_nothing_could_be_read_from_reports_itself_empty() {
        let (project, revision) = ids();
        let blank =
            Sheet::new(project, revision, 1, 10, None, None, SheetSource::Extracted).unwrap();
        assert!(
            blank.is_empty(),
            "storing thousands of these is a register of blanks"
        );

        let read = Sheet::new(
            project,
            revision,
            1,
            10,
            Some("A-201"),
            None,
            SheetSource::Extracted,
        )
        .unwrap();
        assert!(!read.is_empty());
    }
}
