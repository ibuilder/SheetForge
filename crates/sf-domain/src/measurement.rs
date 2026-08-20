//! Measurement provenance.
//!
//! A number on a takeoff is a claim about a building, and an estimator who cannot answer "where did
//! 1,240 SF come from?" cannot defend a bid. So a quantity is never stored as a bare float. It
//! carries the raw page-space magnitude it was derived from, the calibration that converted it, the
//! formula version that computed it, and the unit and precision it is displayed at.
//!
//! Two consequences fall out of that, and both are the reason the type exists:
//!
//! - **Re-calibrating a page re-derives every quantity on it.** The raw magnitude survives, so a
//!   page whose scale was wrong is fixed by fixing the scale, not by redrawing the takeoff.
//! - **A quantity whose calibration is gone is not silently zero.** It reports as underived, which
//!   is a visible state a user can act on, rather than a plausible number that is wrong.
//!
//! Never infer a scale. A sheet that says `1/8" = 1'-0"` in its title block may still have been
//! plotted to fit A3, and the printed graphic scale is the only witness that survives re-plotting.

use crate::ids::CalibrationId;
use crate::{DomainError, Result};
use serde::{Deserialize, Serialize};
use std::fmt;

/// The formula set a quantity was computed with.
///
/// Bumped when a computation changes — a polygon area algorithm, a unit conversion factor, a
/// rounding rule. Stored on every quantity so an old number stays explicable after the code moves
/// on, and so a report can flag quantities computed under a superseded version rather than mixing
/// them silently.
pub const FORMULA_VERSION: u16 = 1;

/// What is being measured. Determines the dimensionality of the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeasureKind {
    /// A straight run between two points.
    Distance,
    /// The summed length of a multi-segment path.
    PolylineLength,
    /// An enclosed area.
    Area,
    /// The closed length around an area.
    Perimeter,
    /// A tally. Dimensionless.
    Count,
    /// An included angle, in degrees. Dimensionless with respect to scale.
    Angle,
    /// An area multiplied by a supplied depth or height.
    Volume,
}

impl MeasureKind {
    /// How many linear dimensions the scale factor applies to.
    ///
    /// This is the whole reason a scale cannot be applied blindly. A page-space area scales by the
    /// factor *squared*: applying it once produces a number that looks like an area, is off by the
    /// scale factor, and passes every eyeball check.
    #[must_use]
    pub const fn scale_exponent(self) -> i32 {
        match self {
            Self::Count | Self::Angle => 0,
            Self::Distance | Self::PolylineLength | Self::Perimeter => 1,
            Self::Area => 2,
            Self::Volume => 3,
        }
    }

    /// Whether the value depends on the page being calibrated at all.
    #[must_use]
    pub const fn needs_calibration(self) -> bool {
        self.scale_exponent() != 0
    }

    /// The stable wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Distance => "distance",
            Self::PolylineLength => "polyline-length",
            Self::Area => "area",
            Self::Perimeter => "perimeter",
            Self::Count => "count",
            Self::Angle => "angle",
            Self::Volume => "volume",
        }
    }
}

impl fmt::Display for MeasureKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How confident we are that the scale is right.
///
/// Recorded because a scale drawn against a printed graphic scale bar and one typed in from a title
/// block are different claims, and a takeoff that presents them identically is quietly lying about
/// its own reliability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScaleSource {
    /// The user drew a line over a known dimension and typed its real length. The strongest
    /// evidence available on a re-plotted sheet.
    UserCalibrated,
    /// A named preset was chosen, e.g. `1/8" = 1'-0"`.
    DeclaredPreset,
    /// Read out of the sheet's title block or graphic scale by text extraction or OCR.
    ///
    /// **Never trusted without confirmation.** [`Calibration::is_verified`] is false for this
    /// source until a human accepts it.
    ExtractedFromSheet,
}

impl ScaleSource {
    /// Whether a calibration from this source may be used without a human confirming it.
    #[must_use]
    pub const fn self_verifying(self) -> bool {
        matches!(self, Self::UserCalibrated | Self::DeclaredPreset)
    }
}

/// The scale of one page.
///
/// Per page, not per document: a plan sheet and the enlarged detail beside it are different scales,
/// and a document-wide factor produces confidently wrong numbers on half the set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Calibration {
    /// This calibration.
    pub id: CalibrationId,
    /// Which page it governs. 1-based.
    pub page: u32,
    /// Real-world units per PDF user unit (1/72").
    ///
    /// One number rather than a ratio pair, so a quantity is one multiply. Must be finite and
    /// strictly positive — see [`Calibration::new`].
    pub units_per_page_unit: f64,
    /// The unit `units_per_page_unit` is expressed in, e.g. `ft`, `m`, `mm`.
    pub unit: String,
    /// Where the scale came from.
    pub source: ScaleSource,
    /// The preset's name when one was chosen, for display and for re-selection.
    pub preset_label: Option<String>,
    /// Whether a human has accepted this scale. Extracted scales start false.
    pub is_verified: bool,
}

impl Calibration {
    /// Build a calibration.
    ///
    /// # Errors
    /// If the factor is not finite and strictly positive, or the unit is blank. A zero or negative
    /// factor is refused rather than clamped: silently substituting a scale is exactly the class of
    /// bug this module exists to prevent.
    pub fn new(
        page: u32,
        units_per_page_unit: f64,
        unit: &str,
        source: ScaleSource,
        preset_label: Option<&str>,
    ) -> Result<Self> {
        if page == 0 {
            return Err(DomainError::OutOfRange {
                field: "page",
                reason: "pages are numbered from 1".into(),
            });
        }
        if !units_per_page_unit.is_finite() || units_per_page_unit <= 0.0 {
            return Err(DomainError::OutOfRange {
                field: "units_per_page_unit",
                reason: "a scale must be a finite, positive number".into(),
            });
        }
        Ok(Self {
            id: CalibrationId::new(),
            page,
            units_per_page_unit,
            unit: crate::error::bounded_text(unit, "unit", 16)?,
            source,
            preset_label: crate::error::optional_text(preset_label, "preset label", 64)?,
            // An extracted scale is a suggestion until somebody agrees with it.
            is_verified: source.self_verifying(),
        })
    }

    /// Accept an extracted scale. The only way `is_verified` becomes true for
    /// [`ScaleSource::ExtractedFromSheet`], and it takes an explicit act.
    pub fn verify(&mut self) {
        self.is_verified = true;
    }

    /// The multiplier for a given measure kind — the scale factor raised to its dimensionality.
    #[must_use]
    pub fn factor_for(&self, kind: MeasureKind) -> f64 {
        self.units_per_page_unit.powi(kind.scale_exponent())
    }
}

/// A measured value, with everything needed to explain and re-derive it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quantity {
    /// What was measured.
    pub kind: MeasureKind,
    /// The geometric magnitude in page space, before any scale is applied.
    ///
    /// The field that makes re-calibration possible. Preserved for every quantity, including ones
    /// that currently have no calibration at all.
    pub raw_page_magnitude: f64,
    /// The calibration used, when there was one.
    pub calibration_id: Option<CalibrationId>,
    /// The derived value in [`Quantity::unit`], absent when the page is not calibrated.
    pub value: Option<f64>,
    /// The display unit. `count` for tallies, `deg` for angles.
    pub unit: String,
    /// Decimal places for display. Storage keeps full precision; this governs presentation only.
    pub precision: u8,
    /// The formula set that produced `value`.
    pub formula_version: u16,
    /// True when the calibration behind this value has not been confirmed by a human.
    ///
    /// Surfaced next to the number, because an unverified takeoff going into a bid is a commercial
    /// risk somebody should be given the chance to notice.
    pub provisional: bool,
}

impl Quantity {
    /// Largest accepted display precision. Beyond this the digits are noise from an f64.
    pub const MAX_PRECISION: u8 = 6;

    /// Derive a quantity from a page-space magnitude and the page's calibration.
    ///
    /// Passing `None` for the calibration is legitimate and common — a markup drawn before the page
    /// was calibrated. The result keeps its raw magnitude and reports no value.
    ///
    /// # Errors
    /// If the magnitude is not finite, if precision exceeds [`Quantity::MAX_PRECISION`], or if the
    /// calibration is for a different page than `page`.
    pub fn derive(
        kind: MeasureKind,
        raw_page_magnitude: f64,
        page: u32,
        calibration: Option<&Calibration>,
        precision: u8,
    ) -> Result<Self> {
        if !raw_page_magnitude.is_finite() {
            return Err(DomainError::OutOfRange {
                field: "raw_page_magnitude",
                reason: "geometry produced a value that is not a number".into(),
            });
        }
        if precision > Self::MAX_PRECISION {
            return Err(DomainError::OutOfRange {
                field: "precision",
                reason: format!("at most {} decimal places", Self::MAX_PRECISION),
            });
        }
        if let Some(calibration) = calibration {
            if calibration.page != page {
                return Err(DomainError::OutOfRange {
                    field: "calibration",
                    reason: format!(
                        "calibration is for page {} but the measurement is on page {page}",
                        calibration.page
                    ),
                });
            }
        }

        // Dimensionless kinds are complete without a scale: a count of doors and an angle in
        // degrees are the same number at any plot size.
        if !kind.needs_calibration() {
            return Ok(Self {
                kind,
                raw_page_magnitude,
                calibration_id: None,
                value: Some(raw_page_magnitude),
                unit: if matches!(kind, MeasureKind::Angle) {
                    "deg".into()
                } else {
                    "count".into()
                },
                precision,
                formula_version: FORMULA_VERSION,
                provisional: false,
            });
        }

        match calibration {
            Some(calibration) => Ok(Self {
                kind,
                raw_page_magnitude,
                calibration_id: Some(calibration.id),
                value: Some(raw_page_magnitude * calibration.factor_for(kind)),
                unit: calibration.unit.clone(),
                precision,
                formula_version: FORMULA_VERSION,
                provisional: !calibration.is_verified,
            }),
            // Not an error, and deliberately not zero. "Not yet derived" is a state the interface
            // shows; a zero would be indistinguishable from a real measurement of nothing.
            None => Ok(Self {
                kind,
                raw_page_magnitude,
                calibration_id: None,
                value: None,
                unit: String::new(),
                precision,
                formula_version: FORMULA_VERSION,
                provisional: true,
            }),
        }
    }

    /// Re-derive against a new calibration, keeping the raw magnitude.
    ///
    /// What runs over every quantity on a page when its scale is corrected.
    ///
    /// # Errors
    /// As [`Quantity::derive`].
    pub fn recalibrate(&self, page: u32, calibration: Option<&Calibration>) -> Result<Self> {
        Self::derive(
            self.kind,
            self.raw_page_magnitude,
            page,
            calibration,
            self.precision,
        )
    }

    /// Whether this quantity has a usable number.
    #[must_use]
    pub const fn is_derived(&self) -> bool {
        self.value.is_some()
    }

    /// The value rounded for display, or `None` when there is nothing to show.
    ///
    /// Rounds half away from zero, which is what a quantity surveyor expects and what a spreadsheet
    /// does. Rust's `round()` agrees; banker's rounding does not, and the difference compounds
    /// across a thousand-line takeoff.
    #[must_use]
    pub fn display_value(&self) -> Option<f64> {
        let value = self.value?;
        let scale = 10f64.powi(i32::from(self.precision));
        let rounded = (value * scale).round() / scale;
        // A rounding that overflows to infinity is worse than no answer.
        rounded.is_finite().then_some(rounded)
    }

    /// Formatted for a cell or a label, e.g. `1240.50 sf`, or `—` when underived.
    #[must_use]
    pub fn display(&self) -> String {
        match self.display_value() {
            Some(value) if self.unit.is_empty() => {
                format!("{value:.*}", usize::from(self.precision))
            }
            Some(value) => format!("{value:.*} {}", usize::from(self.precision), self.unit),
            None => "—".to_owned(),
        }
    }
}

#[cfg(test)]
// These comparisons are exact on purpose: the assertion is that a raw magnitude was copied
// through unchanged, not that it is approximately equal to itself.
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    fn feet_per_point(scale_denominator: f64) -> f64 {
        // A 1/8" = 1'-0" drawing: one page inch is 8 feet, and a page unit is 1/72".
        scale_denominator / 72.0
    }

    fn calibration_at(page: u32, factor: f64, source: ScaleSource) -> Calibration {
        Calibration::new(page, factor, "ft", source, None).unwrap()
    }

    #[test]
    fn an_area_scales_by_the_square_of_the_factor() {
        // The bug this whole module is arranged to prevent. A 72x72 page-unit square is one inch
        // square; at 1/8" = 1'-0" that is 8ft x 8ft = 64 sf, not 8 sf.
        let calibration = calibration_at(1, feet_per_point(8.0), ScaleSource::DeclaredPreset);
        let area =
            Quantity::derive(MeasureKind::Area, 72.0 * 72.0, 1, Some(&calibration), 2).unwrap();
        assert!(
            (area.value.unwrap() - 64.0).abs() < 1e-9,
            "got {:?}",
            area.value
        );
    }

    #[test]
    fn a_length_scales_linearly_and_a_volume_cubes() {
        let calibration = calibration_at(1, feet_per_point(8.0), ScaleSource::DeclaredPreset);
        let length =
            Quantity::derive(MeasureKind::Distance, 72.0, 1, Some(&calibration), 2).unwrap();
        assert!((length.value.unwrap() - 8.0).abs() < 1e-9);

        let volume = Quantity::derive(
            MeasureKind::Volume,
            72.0 * 72.0 * 72.0,
            1,
            Some(&calibration),
            2,
        )
        .unwrap();
        assert!(
            (volume.value.unwrap() - 512.0).abs() < 1e-6,
            "got {:?}",
            volume.value
        );
    }

    #[test]
    fn counts_and_angles_need_no_scale() {
        for (kind, unit) in [(MeasureKind::Count, "count"), (MeasureKind::Angle, "deg")] {
            let quantity = Quantity::derive(kind, 12.0, 1, None, 0).unwrap();
            assert_eq!(quantity.value, Some(12.0));
            assert_eq!(quantity.unit, unit);
            assert!(!quantity.provisional, "{kind} does not depend on a scale");
        }
    }

    #[test]
    fn an_uncalibrated_length_is_underived_rather_than_zero() {
        let quantity = Quantity::derive(MeasureKind::Distance, 144.0, 1, None, 2).unwrap();
        assert_eq!(
            quantity.value, None,
            "a zero here would read as a real measurement of nothing"
        );
        assert!(!quantity.is_derived());
        assert_eq!(quantity.display(), "—");
        assert_eq!(
            quantity.raw_page_magnitude, 144.0,
            "the magnitude survives for later derivation"
        );
    }

    #[test]
    fn recalibrating_a_page_re_derives_without_redrawing() {
        // The estimator's actual workflow: measure, discover the scale was wrong, fix the scale.
        let wrong = calibration_at(1, feet_per_point(4.0), ScaleSource::DeclaredPreset);
        let measured = Quantity::derive(MeasureKind::Distance, 72.0, 1, Some(&wrong), 2).unwrap();
        assert!((measured.value.unwrap() - 4.0).abs() < 1e-9);

        let right = calibration_at(1, feet_per_point(8.0), ScaleSource::UserCalibrated);
        let fixed = measured.recalibrate(1, Some(&right)).unwrap();
        assert!((fixed.value.unwrap() - 8.0).abs() < 1e-9);
        assert_eq!(fixed.raw_page_magnitude, measured.raw_page_magnitude);
        assert_eq!(fixed.calibration_id, Some(right.id));
    }

    #[test]
    fn removing_a_calibration_returns_a_quantity_to_underived() {
        let calibration = calibration_at(1, feet_per_point(8.0), ScaleSource::UserCalibrated);
        let measured =
            Quantity::derive(MeasureKind::Area, 5184.0, 1, Some(&calibration), 2).unwrap();
        let cleared = measured.recalibrate(1, None).unwrap();
        assert!(!cleared.is_derived());
        assert_eq!(cleared.raw_page_magnitude, 5184.0);
    }

    #[test]
    fn an_extracted_scale_is_provisional_until_a_human_accepts_it() {
        let mut extracted = calibration_at(1, feet_per_point(8.0), ScaleSource::ExtractedFromSheet);
        assert!(
            !extracted.is_verified,
            "OCR is a suggestion, not a verified fact"
        );

        let before = Quantity::derive(MeasureKind::Area, 5184.0, 1, Some(&extracted), 2).unwrap();
        assert!(
            before.provisional,
            "the number must carry the doubt with it"
        );

        extracted.verify();
        let after = Quantity::derive(MeasureKind::Area, 5184.0, 1, Some(&extracted), 2).unwrap();
        assert!(!after.provisional);
    }

    #[test]
    fn a_declared_or_drawn_scale_is_verified_on_creation() {
        for source in [ScaleSource::UserCalibrated, ScaleSource::DeclaredPreset] {
            assert!(calibration_at(1, 0.1, source).is_verified);
        }
    }

    #[test]
    fn a_calibration_from_another_page_is_refused() {
        // Applying page 2's detail scale to a page 1 plan is the single most expensive silent
        // error a takeoff tool can make, so it is a type error rather than a warning.
        let detail = calibration_at(2, feet_per_point(1.0), ScaleSource::UserCalibrated);
        let err = Quantity::derive(MeasureKind::Area, 100.0, 1, Some(&detail), 2).unwrap_err();
        assert!(
            err.to_string().contains("page 2") && err.to_string().contains("page 1"),
            "got: {err}"
        );
    }

    #[test]
    fn a_nonsense_scale_is_refused_rather_than_clamped() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                Calibration::new(1, bad, "ft", ScaleSource::UserCalibrated, None).is_err(),
                "{bad} must not become a usable scale",
            );
        }
    }

    #[test]
    fn non_finite_geometry_is_refused() {
        let calibration = calibration_at(1, 0.1, ScaleSource::UserCalibrated);
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(Quantity::derive(MeasureKind::Area, bad, 1, Some(&calibration), 2).is_err());
        }
    }

    #[test]
    fn display_rounds_half_away_from_zero() {
        let calibration = calibration_at(1, 1.0, ScaleSource::UserCalibrated);
        let quantity =
            Quantity::derive(MeasureKind::Distance, 2.675, 1, Some(&calibration), 2).unwrap();
        // Half-to-even would give 2.67 here and drift a takeoff over many lines.
        assert_eq!(quantity.display(), "2.68 ft");
    }

    #[test]
    fn every_quantity_records_the_formula_that_made_it() {
        let quantity = Quantity::derive(MeasureKind::Count, 3.0, 1, None, 0).unwrap();
        assert_eq!(quantity.formula_version, FORMULA_VERSION);
    }

    #[test]
    fn absurd_precision_is_refused() {
        assert!(
            Quantity::derive(MeasureKind::Count, 1.0, 1, None, Quantity::MAX_PRECISION).is_ok()
        );
        assert!(Quantity::derive(
            MeasureKind::Count,
            1.0,
            1,
            None,
            Quantity::MAX_PRECISION + 1
        )
        .is_err());
    }

    #[test]
    fn scale_exponents_match_the_dimensionality_of_the_kind() {
        assert_eq!(MeasureKind::Count.scale_exponent(), 0);
        assert_eq!(MeasureKind::Angle.scale_exponent(), 0);
        assert_eq!(MeasureKind::Distance.scale_exponent(), 1);
        assert_eq!(MeasureKind::Perimeter.scale_exponent(), 1);
        assert_eq!(MeasureKind::PolylineLength.scale_exponent(), 1);
        assert_eq!(MeasureKind::Area.scale_exponent(), 2);
        assert_eq!(MeasureKind::Volume.scale_exponent(), 3);
    }
}
