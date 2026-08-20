//! Markups — the structured record a redline actually is.
//!
//! The premise of the product: a markup is not ink. It is a project record that happens to have a
//! shape. Who raised it, against which revision of which sheet, in which discipline, what it
//! measures, who owns it, when it is due, and every status it has passed through — those are the
//! fields a review runs on. The geometry is one projection of the record; CSV, XFDF, BCF and a
//! flattened PDF are others.
//!
//! ## Where geometry lives
//!
//! Geometry is stored as an opaque, versioned JSON payload rather than as typed Rust structs. This
//! is deliberate and it is a trade. The drawing engine owns the vocabulary of shapes and evolves it
//! (a cloud gains an arc density, ink gains pressure samples); re-declaring that vocabulary here
//! would mean two definitions that must agree, and the failure mode when they drift is a markup
//! that will not round-trip. What the domain enforces instead is the part it can be authoritative
//! about: that the payload is well-formed JSON, that it is bounded in size, that it declares a
//! schema version, and that its page number is inside the revision it claims to be on.
//!
//! All coordinates inside that payload are **PDF user space** — 1/72", top-left origin, unrotated.
//! Never viewport pixels. A markup stored in pixels is correct at exactly one zoom level on exactly
//! one monitor.

use crate::error::{bounded_text, optional_text};
use crate::ids::{ActorId, DocumentRevisionId, MarkupId, ProjectId};
use crate::measurement::Quantity;
use crate::status::MarkupStatus;
use crate::{DomainError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// The redline vocabulary. Named for what a reviewer calls the tool, not for its geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MarkupKind {
    /// Freehand ink.
    Ink,
    /// Straight line.
    Line,
    /// Line with an arrowhead.
    Arrow,
    /// Open multi-segment path.
    Polyline,
    /// Closed multi-segment shape.
    Polygon,
    /// Axis-aligned box.
    Rectangle,
    /// Ellipse or circle.
    Ellipse,
    /// A scalloped revision cloud.
    Cloud,
    /// Free-standing text.
    Text,
    /// Text with a leader pointing at something.
    Callout,
    /// Glyph-accurate highlight over real text.
    Highlight,
    /// Glyph-accurate strikeout.
    Strikeout,
    /// Glyph-accurate underline.
    Underline,
    /// A dynamic stamp from a tool chest.
    Stamp,
    /// A placed symbol from a library.
    Symbol,
    /// An issue pin — the thing that becomes a BCF topic or an RFI.
    Pin,
    /// A photo or file anchored to the sheet.
    Attachment,
    /// A measurement. Carries a [`Quantity`].
    Measurement,
}

impl MarkupKind {
    /// Whether this kind is expected to carry a [`Quantity`].
    #[must_use]
    pub const fn is_measurement(self) -> bool {
        matches!(self, Self::Measurement)
    }

    /// The stable wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ink => "ink",
            Self::Line => "line",
            Self::Arrow => "arrow",
            Self::Polyline => "polyline",
            Self::Polygon => "polygon",
            Self::Rectangle => "rectangle",
            Self::Ellipse => "ellipse",
            Self::Cloud => "cloud",
            Self::Text => "text",
            Self::Callout => "callout",
            Self::Highlight => "highlight",
            Self::Strikeout => "strikeout",
            Self::Underline => "underline",
            Self::Stamp => "stamp",
            Self::Symbol => "symbol",
            Self::Pin => "pin",
            Self::Attachment => "attachment",
            Self::Measurement => "measurement",
        }
    }
}

impl fmt::Display for MarkupKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The drawing engine's shape data, kept opaque and bounded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    /// The engine schema this payload was written against. Migrations key on it.
    pub schema_version: u16,
    /// The shape itself, in PDF user space.
    pub data: serde_json::Value,
}

impl Geometry {
    /// The largest geometry payload accepted, in bytes of compact JSON.
    ///
    /// Generous — a long freehand ink stroke with pressure samples is genuinely large — but finite,
    /// because an import is untrusted input and a row with no ceiling is a memory exhaustion
    /// primitive that arrives looking like a drawing.
    pub const MAX_BYTES: usize = 4 * 1024 * 1024;

    /// Wrap and validate a payload.
    ///
    /// # Errors
    /// If the payload is not a JSON object, or serialises to more than [`Geometry::MAX_BYTES`].
    pub fn new(schema_version: u16, data: serde_json::Value) -> Result<Self> {
        if !data.is_object() {
            return Err(DomainError::Malformed {
                subject: "markup geometry",
            });
        }
        let encoded = serde_json::to_vec(&data).map_err(|_| DomainError::Malformed {
            subject: "markup geometry",
        })?;
        if encoded.len() > Self::MAX_BYTES {
            return Err(DomainError::TooLong {
                field: "geometry",
                max: Self::MAX_BYTES,
            });
        }
        Ok(Self {
            schema_version,
            data,
        })
    }
}

/// The construction fields that make a markup a record rather than a comment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MarkupMetadata {
    /// What it is about, in one line. The column a reviewer scans.
    pub subject: Option<String>,
    /// Longer body text.
    pub body: Option<String>,
    /// Which trade or discipline owns it, e.g. `MEP`.
    pub discipline: Option<String>,
    /// Who it is assigned to.
    pub assignee: Option<ActorId>,
    /// When it is due.
    pub due_at: Option<DateTime<Utc>>,
    /// Cost code for roll-up into an estimate.
    pub cost_code: Option<String>,
    /// Free labels for filtering.
    pub labels: Vec<String>,
    /// Organisation-defined fields.
    ///
    /// A `BTreeMap` rather than a `HashMap` so serialisation is deterministic: the same record
    /// hashes the same across runs, which the audit chain and the package integrity check depend on.
    pub custom_fields: BTreeMap<String, serde_json::Value>,
}

impl MarkupMetadata {
    /// Longest subject line.
    pub const MAX_SUBJECT: usize = 300;
    /// Longest body.
    pub const MAX_BODY: usize = 20_000;
    /// Most labels on one markup.
    pub const MAX_LABELS: usize = 32;
    /// Most custom fields on one markup.
    pub const MAX_CUSTOM_FIELDS: usize = 64;

    /// Validate and normalise. Called on every write, including writes that arrive from an import.
    ///
    /// # Errors
    /// If any bounded field is over its limit.
    pub fn validated(mut self) -> Result<Self> {
        self.subject = optional_text(self.subject.as_deref(), "subject", Self::MAX_SUBJECT)?;
        self.body = optional_text(self.body.as_deref(), "body", Self::MAX_BODY)?;
        self.discipline = optional_text(self.discipline.as_deref(), "discipline", 64)?;
        self.cost_code = optional_text(self.cost_code.as_deref(), "cost code", 64)?;

        if self.labels.len() > Self::MAX_LABELS {
            return Err(DomainError::TooLong {
                field: "labels",
                max: Self::MAX_LABELS,
            });
        }
        let mut labels = Vec::with_capacity(self.labels.len());
        for label in &self.labels {
            labels.push(bounded_text(label, "label", 64)?);
        }
        // Deduplicate while keeping first-seen order: two identical labels are one fact, and a
        // filter that counts them twice reports a set larger than it is.
        labels.dedup();
        self.labels = labels;

        if self.custom_fields.len() > Self::MAX_CUSTOM_FIELDS {
            return Err(DomainError::TooLong {
                field: "custom fields",
                max: Self::MAX_CUSTOM_FIELDS,
            });
        }
        for key in self.custom_fields.keys() {
            bounded_text(key, "custom field name", 64)?;
        }
        Ok(self)
    }
}

/// A markup record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Markup {
    /// This markup.
    pub id: MarkupId,
    /// Its project.
    pub project_id: ProjectId,
    /// The revision it was raised against. Never the logical document: a comment belongs to the
    /// issue it was made on.
    pub document_revision_id: DocumentRevisionId,
    /// 1-based page within that revision.
    pub page: u32,
    /// Which tool made it.
    pub kind: MarkupKind,
    /// Where it sits in its review.
    pub status: MarkupStatus,
    /// The shape, in PDF user space.
    pub geometry: Geometry,
    /// The construction fields.
    pub metadata: MarkupMetadata,
    /// Present on measurement markups.
    pub quantity: Option<Quantity>,
    /// Optimistic-concurrency token. Increments on every accepted mutation.
    pub version: u64,
    /// Who raised it. Never changes.
    pub created_by: ActorId,
    /// When it was raised.
    pub created_at: DateTime<Utc>,
    /// Who last changed it.
    pub updated_by: ActorId,
    /// When it was last changed.
    pub updated_at: DateTime<Utc>,
}

/// A requested change to a markup. Absent fields are left alone.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MarkupPatch {
    /// New geometry.
    pub geometry: Option<Geometry>,
    /// New metadata, wholesale.
    pub metadata: Option<MarkupMetadata>,
    /// A status move, checked against the state machine.
    pub status: Option<MarkupStatus>,
    /// A re-derived quantity. `Some(None)` clears it.
    pub quantity: Option<Option<Quantity>>,
}

impl Markup {
    /// Raise a new markup.
    ///
    /// # Errors
    /// If the page is not inside `page_count`, if the metadata fails validation, or if a
    /// measurement kind arrives without a quantity.
    // Nine arguments, and a builder would be worse: every one of these is required to have a
    // valid markup, so a builder would move the "you forgot the revision" failure from compile
    // time to run time.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        project_id: ProjectId,
        document_revision_id: DocumentRevisionId,
        page: u32,
        page_count: u32,
        kind: MarkupKind,
        geometry: Geometry,
        metadata: MarkupMetadata,
        quantity: Option<Quantity>,
        actor: ActorId,
    ) -> Result<Self> {
        if page < 1 || page > page_count {
            return Err(DomainError::OutOfRange {
                field: "page",
                reason: format!(
                    "page {page} is outside this document, which has {page_count} pages"
                ),
            });
        }
        if kind.is_measurement() && quantity.is_none() {
            return Err(DomainError::OutOfRange {
                field: "quantity",
                reason: "a measurement markup must carry the quantity it measured".into(),
            });
        }
        let now = crate::now();
        Ok(Self {
            id: MarkupId::new(),
            project_id,
            document_revision_id,
            page,
            kind,
            status: MarkupStatus::default(),
            geometry,
            metadata: metadata.validated()?,
            quantity,
            // Starts at 1, not 0: a stored version of 0 and "no version recorded" are then
            // distinguishable in a wire payload where the field is optional.
            version: 1,
            created_by: actor.clone(),
            created_at: now,
            updated_by: actor,
            updated_at: now,
        })
    }

    /// Apply a patch under an optimistic-concurrency check.
    ///
    /// `base_version` is the version the edit was made *against*. If the stored record has moved
    /// on, the write is refused with both versions named, so the caller can show the user what
    /// changed instead of silently discarding one of the two edits.
    ///
    /// # Errors
    /// - [`DomainError::VersionConflict`] if `base_version` is stale.
    /// - [`DomainError::IllegalTransition`] if the status move is not permitted.
    /// - Validation errors from the new metadata.
    pub fn apply(&mut self, patch: MarkupPatch, base_version: u64, actor: ActorId) -> Result<()> {
        if base_version != self.version {
            return Err(DomainError::VersionConflict {
                expected: base_version,
                found: self.version,
            });
        }

        // Validate everything before mutating anything: a patch that fails halfway through would
        // otherwise leave a record with new geometry and old metadata, which is a state no user
        // asked for and no test covers.
        let next_status = match patch.status {
            Some(requested) => Some(self.status.transition_to(requested)?),
            None => None,
        };
        let next_metadata = match patch.metadata {
            Some(metadata) => Some(metadata.validated()?),
            None => None,
        };
        if let Some(status) = next_status {
            self.status = status;
        }
        if let Some(metadata) = next_metadata {
            self.metadata = metadata;
        }
        if let Some(geometry) = patch.geometry {
            self.geometry = geometry;
        }
        if let Some(quantity) = patch.quantity {
            self.quantity = quantity;
        }

        self.version += 1;
        self.updated_by = actor;
        self.updated_at = crate::now();
        Ok(())
    }

    /// Whether `actor` raised this markup.
    ///
    /// The distinction editing your own comment and editing somebody else's turns on — see
    /// `sf-security`'s capability set.
    #[must_use]
    pub fn is_authored_by(&self, actor: &ActorId) -> bool {
        &self.created_by == actor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::measurement::{Calibration, MeasureKind, ScaleSource};

    fn geometry() -> Geometry {
        Geometry::new(
            1,
            serde_json::json!({ "points": [[10.0, 20.0], [30.0, 40.0]] }),
        )
        .unwrap()
    }

    fn a_markup(kind: MarkupKind, quantity: Option<Quantity>) -> Result<Markup> {
        Markup::create(
            ProjectId::new(),
            DocumentRevisionId::new(),
            1,
            3,
            kind,
            geometry(),
            MarkupMetadata {
                subject: Some("Coordination issue".into()),
                ..Default::default()
            },
            quantity,
            ActorId::local(),
        )
    }

    fn a_quantity() -> Quantity {
        let calibration =
            Calibration::new(1, 0.1, "ft", ScaleSource::UserCalibrated, None).unwrap();
        Quantity::derive(MeasureKind::Area, 100.0, 1, Some(&calibration), 2).unwrap()
    }

    #[test]
    fn a_new_markup_starts_open_at_version_one() {
        let markup = a_markup(MarkupKind::Cloud, None).unwrap();
        assert_eq!(markup.status, MarkupStatus::Open);
        assert_eq!(
            markup.version, 1,
            "0 would be indistinguishable from 'no version recorded'"
        );
        assert_eq!(markup.created_at, markup.updated_at);
    }

    #[test]
    fn a_page_outside_the_document_is_refused() {
        for page in [0, 4, u32::MAX] {
            let result = Markup::create(
                ProjectId::new(),
                DocumentRevisionId::new(),
                page,
                3,
                MarkupKind::Cloud,
                geometry(),
                MarkupMetadata::default(),
                None,
                ActorId::local(),
            );
            assert!(
                result.is_err(),
                "page {page} of a 3-page document must be refused"
            );
        }
    }

    #[test]
    fn a_measurement_without_a_quantity_is_refused() {
        let err = a_markup(MarkupKind::Measurement, None).unwrap_err();
        assert!(err.to_string().contains("quantity"), "got: {err}");
        assert!(a_markup(MarkupKind::Measurement, Some(a_quantity())).is_ok());
    }

    #[test]
    fn a_stale_edit_is_refused_and_names_both_versions() {
        let mut markup = a_markup(MarkupKind::Cloud, None).unwrap();
        markup
            .apply(MarkupPatch::default(), 1, ActorId::local())
            .unwrap();
        assert_eq!(markup.version, 2);

        // A second reviewer who loaded the record before that write.
        let err = markup
            .apply(MarkupPatch::default(), 1, ActorId::local())
            .unwrap_err();
        assert_eq!(
            err,
            DomainError::VersionConflict {
                expected: 1,
                found: 2
            }
        );
    }

    #[test]
    fn a_refused_patch_leaves_the_record_untouched() {
        // The invariant behind validating before mutating: a half-applied patch is a state
        // nobody asked for.
        let mut markup = a_markup(MarkupKind::Cloud, None).unwrap();
        markup
            .apply(
                MarkupPatch {
                    status: Some(MarkupStatus::Closed),
                    ..Default::default()
                },
                1,
                ActorId::local(),
            )
            .unwrap();
        let before = markup.clone();

        let bad = MarkupPatch {
            geometry: Some(Geometry::new(2, serde_json::json!({ "points": [] })).unwrap()),
            status: Some(MarkupStatus::ForReview), // illegal from Closed
            ..Default::default()
        };
        assert!(markup.apply(bad, 2, ActorId::local()).is_err());
        assert_eq!(
            markup, before,
            "the geometry must not have been written either"
        );
    }

    #[test]
    fn an_over_long_subject_is_refused_and_the_record_is_unchanged() {
        let mut markup = a_markup(MarkupKind::Cloud, None).unwrap();
        let before = markup.clone();
        let patch = MarkupPatch {
            metadata: Some(MarkupMetadata {
                subject: Some("x".repeat(MarkupMetadata::MAX_SUBJECT + 1)),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(markup.apply(patch, 1, ActorId::local()).is_err());
        assert_eq!(markup, before);
    }

    #[test]
    fn a_successful_patch_bumps_the_version_and_records_who_did_it() {
        let mut markup = a_markup(MarkupKind::Cloud, None).unwrap();
        let other = ActorId::new("j.foreman@example.com").unwrap();
        markup
            .apply(
                MarkupPatch {
                    status: Some(MarkupStatus::InProgress),
                    ..Default::default()
                },
                1,
                other.clone(),
            )
            .unwrap();

        assert_eq!(markup.version, 2);
        assert_eq!(markup.status, MarkupStatus::InProgress);
        assert_eq!(markup.updated_by, other);
        assert_eq!(
            markup.created_by,
            ActorId::local(),
            "authorship never changes"
        );
        assert!(!markup.is_authored_by(&other));
    }

    #[test]
    fn a_quantity_can_be_re_derived_or_cleared_through_a_patch() {
        let mut markup = a_markup(MarkupKind::Measurement, Some(a_quantity())).unwrap();
        markup
            .apply(
                MarkupPatch {
                    quantity: Some(None),
                    ..Default::default()
                },
                1,
                ActorId::local(),
            )
            .unwrap();
        assert!(markup.quantity.is_none());
    }

    #[test]
    fn geometry_must_be_an_object_and_must_be_bounded() {
        assert!(
            Geometry::new(1, serde_json::json!([1, 2, 3])).is_err(),
            "an array is not a shape record"
        );
        assert!(Geometry::new(1, serde_json::json!("ink")).is_err());

        let huge = serde_json::json!({ "ink": "x".repeat(Geometry::MAX_BYTES + 1) });
        assert!(
            Geometry::new(1, huge).is_err(),
            "an unbounded row is a memory-exhaustion primitive"
        );
    }

    #[test]
    fn custom_fields_serialise_deterministically() {
        // The audit chain and the package integrity check both hash serialised records, so two
        // runs must produce identical bytes.
        let mut metadata = MarkupMetadata::default();
        for key in ["zone", "area", "level", "bid-package"] {
            metadata
                .custom_fields
                .insert(key.into(), serde_json::json!(key));
        }
        let once = serde_json::to_string(&metadata.clone().validated().unwrap()).unwrap();
        let twice = serde_json::to_string(&metadata.validated().unwrap()).unwrap();
        assert_eq!(once, twice);
        assert!(
            once.find("\"area\"").unwrap() < once.find("\"zone\"").unwrap(),
            "sorted, not insertion-ordered"
        );
    }

    #[test]
    fn too_many_labels_or_custom_fields_are_refused() {
        let many_labels = MarkupMetadata {
            labels: (0..=MarkupMetadata::MAX_LABELS)
                .map(|i| format!("label-{i}"))
                .collect(),
            ..Default::default()
        };
        assert!(many_labels.validated().is_err());

        let many_fields = MarkupMetadata {
            custom_fields: (0..=MarkupMetadata::MAX_CUSTOM_FIELDS)
                .map(|i| (format!("f{i}"), serde_json::json!(i)))
                .collect(),
            ..Default::default()
        };
        assert!(many_fields.validated().is_err());
    }

    #[test]
    fn blank_optional_fields_normalise_to_absent() {
        let metadata = MarkupMetadata {
            subject: Some("   ".into()),
            cost_code: Some(String::new()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(metadata.subject, None);
        assert_eq!(metadata.cost_code, None);
    }
}
