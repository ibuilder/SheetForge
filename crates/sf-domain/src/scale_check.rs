//! Checking a scale against something the drawing already tells you.
//!
//! Calibration is the single point where a takeoff goes quietly wrong. Every quantity on a page is
//! the raw page measurement multiplied by the scale — and areas by its *square* — so a scale that
//! is out by a factor of two makes every length half right and every area a quarter right, with
//! nothing on screen looking unusual. The numbers are plausible, internally consistent, and wrong.
//!
//! The defence costs nothing and almost nobody does it: measure something whose length is printed
//! on the sheet, and see whether the answer agrees. This is the arithmetic for that, and the
//! grading that turns "0.7% out" into an answer somebody can act on.
//!
//! ## Why the thresholds are where they are
//!
//! A hand-drawn line along a dimension string is worth about a pixel or two at typical zoom, which
//! on a 144-foot dimension is a few tenths of a percent. So **1%** is "you drew it as well as
//! anybody draws it, and the scale is right".
//!
//! Between 1% and **5%** is the awkward band: too much for hand wobble on a long dimension, too
//! little to be a wrong scale — usually a short dimension measured carelessly, occasionally a
//! sheet that was plotted slightly off. It deserves "look again", not "this is fine" and not
//! "this is broken".
//!
//! Past 5% something is actually wrong. The common cases are not subtle — a factor of two from an
//! A3 reduction, a factor of twelve from feet read as inches, a factor of 3.28 from metres and
//! feet — and naming the likely culprit is more useful than reporting a percentage.
//!
//! The bands are deliberately not configurable. A tolerance somebody can widen is a tolerance that
//! gets widened at the moment it becomes inconvenient, which is exactly the moment it is doing its
//! job.

use crate::error::{DomainError, Result};
use serde::{Deserialize, Serialize};

/// What a check concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// Within 1%. The scale is right and the measurement was drawn carefully.
    Agrees,
    /// Within 5%. Not hand wobble on a long dimension, not a wrong scale either. Worth drawing
    /// again before trusting the page.
    Close,
    /// Past 5%. Something is wrong, and it is usually the scale rather than the drawing.
    Wrong,
}

impl Verdict {
    /// Whether the page can be measured on with confidence.
    #[must_use]
    pub const fn is_trustworthy(self) -> bool {
        matches!(self, Self::Agrees)
    }
}

/// The result of checking a measured length against a printed one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleCheck {
    /// What the printed dimension says.
    pub expected: f64,
    /// What the page measures at the current scale.
    pub measured: f64,
    /// Signed difference as a proportion of the expected length. Negative means the measurement
    /// came out short.
    pub error: f64,
    /// The conclusion.
    pub verdict: Verdict,
    /// A likely cause, when the error matches a mistake people actually make. `None` when the
    /// numbers simply disagree without a familiar pattern — inventing an explanation for those
    /// would be worse than admitting there is none.
    pub likely_cause: Option<&'static str>,
}

/// Where "close enough" ends.
const AGREES_WITHIN: f64 = 0.01;
/// Where "look again" ends and "something is wrong" begins.
const CLOSE_WITHIN: f64 = 0.05;

/// Ratios that mean somebody made a specific, common mistake rather than drew badly.
///
/// Named rather than left as a percentage because "your measurement is 1,100% out" tells nobody
/// anything, and "this looks like feet read as inches" tells them exactly where to look.
const FAMILIAR_MISTAKES: &[(f64, &str)] = &[
    // The ratio is measured ÷ expected, so measuring *half* what is printed is what a
    // half-size plot looks like — an A3 reduction of an A1 original, measured as though it were
    // still A1. Getting this pair the right way round matters: naming the opposite mistake sends
    // somebody to check the one thing that is not wrong.
    (
        0.5,
        "the sheet may be plotted at half size — an A3 reduction of an A1 original",
    ),
    (2.0, "the sheet may be plotted at double size"),
    (12.0, "feet may have been entered where inches were meant"),
    (
        1.0 / 12.0,
        "inches may have been entered where feet were meant",
    ),
    (
        3.280_84,
        "metres may have been entered where feet were meant",
    ),
    (
        1.0 / 3.280_84,
        "feet may have been entered where metres were meant",
    ),
    (
        25.4,
        "inches may have been entered where millimetres were meant",
    ),
    (
        1.0 / 25.4,
        "millimetres may have been entered where inches were meant",
    ),
    (
        1000.0,
        "metres may have been entered where millimetres were meant",
    ),
    (
        0.001,
        "millimetres may have been entered where metres were meant",
    ),
];

/// How close a ratio has to be to a familiar mistake before it is named as one.
///
/// Two percent: tight enough that a genuinely wrong scale is not blamed on the wrong culprit,
/// loose enough that a hand-drawn line along the dimension still matches.
const MISTAKE_TOLERANCE: f64 = 0.02;

/// Check a measurement against the length printed on the sheet.
///
/// Both lengths must already be in the same unit — this is arithmetic about magnitudes, not a unit
/// converter, and a caller mixing feet with metres has a bug this function must not paper over.
///
/// # Errors
/// If either length is not a positive, finite number. A check against zero has no meaning: every
/// measurement is infinitely wrong relative to nothing.
pub fn check(expected: f64, measured: f64) -> Result<ScaleCheck> {
    if !expected.is_finite() || expected <= 0.0 {
        return Err(DomainError::OutOfRange {
            field: "expected",
            reason: "the printed dimension has to be a positive length".into(),
        });
    }
    if !measured.is_finite() || measured <= 0.0 {
        return Err(DomainError::OutOfRange {
            field: "measured",
            reason: "the measured dimension has to be a positive length".into(),
        });
    }

    let error = (measured - expected) / expected;
    let magnitude = error.abs();

    let verdict = if magnitude <= AGREES_WITHIN {
        Verdict::Agrees
    } else if magnitude <= CLOSE_WITHIN {
        Verdict::Close
    } else {
        Verdict::Wrong
    };

    // Only worth naming when something is actually wrong. A 3% error is not "feet read as inches";
    // suggesting it would send somebody looking in the wrong place.
    let likely_cause = if verdict == Verdict::Wrong {
        let ratio = measured / expected;
        FAMILIAR_MISTAKES
            .iter()
            .find(|(candidate, _)| (ratio / candidate - 1.0).abs() <= MISTAKE_TOLERANCE)
            .map(|(_, cause)| *cause)
    } else {
        None
    };

    Ok(ScaleCheck {
        expected,
        measured,
        error,
        verdict,
        likely_cause,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_measurement_that_agrees_is_reported_as_agreeing() {
        let check = check(144.0, 144.0).unwrap();
        assert_eq!(check.verdict, Verdict::Agrees);
        assert!(check.verdict.is_trustworthy());
        assert!(check.error.abs() < f64::EPSILON);
        assert_eq!(check.likely_cause, None);
    }

    /// A line drawn along a dimension string is worth a pixel or two at typical zoom, which on a
    /// long dimension is a few tenths of a percent. That has to read as agreement, or the check
    /// cries wolf on every correctly calibrated sheet and stops being used.
    #[test]
    fn hand_wobble_on_a_long_dimension_still_agrees() {
        assert_eq!(check(144.0, 144.5).unwrap().verdict, Verdict::Agrees);
        assert_eq!(check(144.0, 143.5).unwrap().verdict, Verdict::Agrees);
    }

    #[test]
    fn the_bands_are_where_they_say_they_are() {
        // Just inside one percent.
        assert_eq!(check(100.0, 100.9).unwrap().verdict, Verdict::Agrees);
        // Just outside.
        assert_eq!(check(100.0, 101.5).unwrap().verdict, Verdict::Close);
        // Just inside five.
        assert_eq!(check(100.0, 104.9).unwrap().verdict, Verdict::Close);
        // Past it.
        assert_eq!(check(100.0, 106.0).unwrap().verdict, Verdict::Wrong);
    }

    #[test]
    fn the_error_is_signed_so_short_and_long_are_distinguishable() {
        assert!(
            check(100.0, 90.0).unwrap().error < 0.0,
            "short reads negative"
        );
        assert!(
            check(100.0, 110.0).unwrap().error > 0.0,
            "long reads positive"
        );
    }

    /// "Your measurement is 1,100% out" tells nobody anything. "Feet may have been entered where
    /// inches were meant" tells them where to look, and these are the mistakes people actually
    /// make rather than an abstract percentage.
    #[test]
    fn a_familiar_mistake_is_named_rather_than_left_as_a_percentage() {
        let halved = check(144.0, 72.0).unwrap();
        assert_eq!(halved.verdict, Verdict::Wrong);
        assert!(halved.likely_cause.unwrap().contains("half size"));

        let doubled = check(72.0, 144.0).unwrap();
        assert!(doubled.likely_cause.unwrap().contains("double size"));

        let inches = check(10.0, 120.0).unwrap();
        assert!(inches.likely_cause.unwrap().contains("inches"));

        let metric = check(100.0, 328.084).unwrap();
        assert!(metric.likely_cause.unwrap().contains("metres"));

        let millimetres = check(2.5, 2500.0).unwrap();
        assert!(millimetres.likely_cause.unwrap().contains("millimetres"));
    }

    /// Guessing a cause for numbers that simply disagree would send somebody looking in the wrong
    /// place, which is worse than admitting there is no obvious explanation.
    #[test]
    fn an_unfamiliar_error_is_not_given_an_invented_explanation() {
        let odd = check(100.0, 137.0).unwrap();
        assert_eq!(odd.verdict, Verdict::Wrong);
        assert_eq!(odd.likely_cause, None);
    }

    /// A three percent error is hand-drawing on a short dimension, not a unit mix-up. Naming one
    /// would be the tool sounding confident about something it has no reason to believe.
    #[test]
    fn a_cause_is_only_suggested_when_something_is_actually_wrong() {
        assert_eq!(check(100.0, 103.0).unwrap().likely_cause, None);
        assert_eq!(check(100.0, 100.2).unwrap().likely_cause, None);
    }

    /// Every measurement is infinitely wrong relative to nothing, so a check against zero has no
    /// meaning and is refused rather than reported as a large number.
    #[test]
    fn a_check_against_nothing_is_refused() {
        assert!(check(0.0, 10.0).is_err());
        assert!(check(10.0, 0.0).is_err());
        assert!(check(-5.0, 10.0).is_err());
        assert!(check(f64::NAN, 10.0).is_err());
        assert!(check(10.0, f64::INFINITY).is_err());
    }
}
