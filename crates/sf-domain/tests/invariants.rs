//! Property tests over the domain's arithmetic and its state machine.
//!
//! Measurement is where a bug is least visible: a quantity that is wrong by a factor still looks
//! like a quantity, prints to two decimal places, and goes into a bid. There is no crash and no
//! error message — just a number nobody can defend six months later. So the properties here are
//! about the arithmetic being *self-consistent* rather than about specific expected values, which
//! is the only kind of check that survives the formulas being rewritten.

// These comparisons are exact on purpose: the assertion is that a value was carried through
// unchanged, not that it is approximately equal to itself. Where the assertion really is about
// arithmetic, it uses a tolerance explicitly.
#![allow(clippy::float_cmp)]

use proptest::prelude::*;
use sf_domain::{Calibration, MarkupStatus, MeasureKind, Quantity, ScaleSource};

const KINDS: [MeasureKind; 7] = [
    MeasureKind::Distance,
    MeasureKind::PolylineLength,
    MeasureKind::Area,
    MeasureKind::Perimeter,
    MeasureKind::Count,
    MeasureKind::Angle,
    MeasureKind::Volume,
];

const STATUSES: [MarkupStatus; 5] = [
    MarkupStatus::Open,
    MarkupStatus::InProgress,
    MarkupStatus::ForReview,
    MarkupStatus::Closed,
    MarkupStatus::Void,
];

fn calibration(factor: f64) -> Calibration {
    Calibration::new(1, factor, "ft", ScaleSource::UserCalibrated, None).expect("a valid scale")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2048))]

    /// Deriving a quantity never produces a value that is not a number.
    ///
    /// A NaN reaching a takeoff would render as `NaN ft` in a spreadsheet cell, and every sum
    /// containing it becomes NaN too — one bad measurement poisons a whole bid.
    #[test]
    fn a_derived_value_is_always_finite(
        kind_index in 0usize..7,
        magnitude in -1e12f64..1e12,
        factor in 1e-9f64..1e9,
        precision in 0u8..=6,
    ) {
        let kind = KINDS[kind_index];
        let scale = calibration(factor);
        if let Ok(quantity) = Quantity::derive(kind, magnitude, 1, Some(&scale), precision) {
            if let Some(value) = quantity.value {
                prop_assert!(value.is_finite(), "{kind} of {magnitude} at {factor} gave {value}");
            }
            if let Some(shown) = quantity.display_value() {
                prop_assert!(shown.is_finite());
            }
            // Whatever happens, the magnitude that makes re-derivation possible is preserved.
            prop_assert_eq!(quantity.raw_page_magnitude, magnitude);
        }
    }

    /// Re-calibrating is equivalent to having measured at the new scale in the first place.
    ///
    /// This is the promise the takeoff makes: fix the scale, and every number on the page is as if
    /// it had always been right. If the two paths ever diverged, an estimator who re-calibrated
    /// would get different answers from one who calibrated correctly at the start.
    #[test]
    fn re_calibrating_matches_measuring_at_the_new_scale_from_the_start(
        kind_index in 0usize..7,
        magnitude in -1e9f64..1e9,
        first in 1e-6f64..1e6,
        second in 1e-6f64..1e6,
    ) {
        let kind = KINDS[kind_index];
        let wrong = calibration(first);
        let right = calibration(second);

        let measured = Quantity::derive(kind, magnitude, 1, Some(&wrong), 2).unwrap();
        let corrected = measured.recalibrate(1, Some(&right)).unwrap();
        let afresh = Quantity::derive(kind, magnitude, 1, Some(&right), 2).unwrap();

        match (corrected.value, afresh.value) {
            (Some(a), Some(b)) => prop_assert!(
                (a - b).abs() <= b.abs() * 1e-12 + 1e-12,
                "re-calibrated to {a} but measuring afresh gave {b}",
            ),
            (None, None) => {}
            (a, b) => prop_assert!(false, "one path derived and the other did not: {a:?} vs {b:?}"),
        }
    }

    /// Removing the scale returns a quantity to underived, never to zero.
    ///
    /// A zero is indistinguishable from a real measurement of nothing, and would be summed as one.
    #[test]
    fn clearing_the_scale_never_yields_a_number(
        kind_index in 0usize..7,
        magnitude in -1e9f64..1e9,
        factor in 1e-6f64..1e6,
    ) {
        let kind = KINDS[kind_index];
        let measured = Quantity::derive(kind, magnitude, 1, Some(&calibration(factor)), 2).unwrap();
        let cleared = measured.recalibrate(1, None).unwrap();

        if kind.needs_calibration() {
            prop_assert!(!cleared.is_derived(), "{kind} produced a value with no scale");
            prop_assert_eq!(cleared.display(), "—");
        } else {
            // A count or an angle is the same number at any plot size.
            prop_assert!(cleared.is_derived());
        }
        prop_assert_eq!(cleared.raw_page_magnitude, magnitude);
    }

    /// Scaling is monotonic in the factor for a positive magnitude.
    ///
    /// Catches an exponent applied the wrong way round, which is otherwise invisible: a bigger
    /// scale must never produce a smaller quantity.
    #[test]
    fn a_larger_scale_never_produces_a_smaller_quantity(
        kind_index in 0usize..7,
        magnitude in 1e-3f64..1e6,
        smaller in 1e-3f64..1e3,
        bump in 1.0001f64..100.0,
    ) {
        let kind = KINDS[kind_index];
        let larger = smaller * bump;
        let a = Quantity::derive(kind, magnitude, 1, Some(&calibration(smaller)), 6).unwrap();
        let b = Quantity::derive(kind, magnitude, 1, Some(&calibration(larger)), 6).unwrap();

        if let (Some(a), Some(b)) = (a.value, b.value) {
            if kind.needs_calibration() {
                prop_assert!(b >= a, "{kind}: scale {smaller}→{larger} took {a} down to {b}");
            } else {
                prop_assert_eq!(a, b, "{} must not depend on the scale at all", kind);
            }
        }
    }

    /// A calibration belonging to another page is always refused.
    #[test]
    fn a_scale_from_another_page_is_never_applied(
        page in 1u32..500,
        other in 1u32..500,
        magnitude in 0.0f64..1e6,
    ) {
        prop_assume!(page != other);
        let scale = Calibration::new(other, 0.1, "ft", ScaleSource::UserCalibrated, None).unwrap();
        prop_assert!(
            Quantity::derive(MeasureKind::Area, magnitude, page, Some(&scale), 2).is_err(),
            "page {other}'s scale was applied to a measurement on page {page}",
        );
    }

    /// A nonsense scale is refused rather than clamped into something plausible.
    #[test]
    fn only_finite_positive_scales_are_accepted(factor in any::<f64>()) {
        let accepted = Calibration::new(1, factor, "ft", ScaleSource::UserCalibrated, None).is_ok();
        prop_assert_eq!(accepted, factor.is_finite() && factor > 0.0);
    }

    /// Every permitted transition is one the workflow will actually take, and every refused one is
    /// refused consistently. The two must never disagree.
    #[test]
    fn the_status_machine_agrees_with_itself(from in 0usize..5, to in 0usize..5) {
        let (from, to) = (STATUSES[from], STATUSES[to]);
        prop_assert_eq!(from.can_transition_to(to), from.transition_to(to).is_ok());
    }

    /// Every status is reachable from every other in at most two steps, via `Open`.
    ///
    /// The interface relies on this: it walks a refused jump through the start of the workflow
    /// rather than weakening the rule, and that only works if `Open` is always reachable.
    #[test]
    fn any_status_is_reachable_in_at_most_two_steps(from in 0usize..5, to in 0usize..5) {
        let (from, to) = (STATUSES[from], STATUSES[to]);
        let reachable = from.can_transition_to(to)
            || (from.can_transition_to(MarkupStatus::Open)
                && MarkupStatus::Open.can_transition_to(to));
        prop_assert!(reachable, "{from} cannot reach {to} in two steps");
    }

    /// Withdrawal is always available, whatever state an item is in.
    #[test]
    fn anything_can_always_be_withdrawn(from in 0usize..5) {
        prop_assert!(STATUSES[from].can_transition_to(MarkupStatus::Void));
    }

    /// Outstanding and terminal partition the statuses. A report that counts both would
    /// double-count or miss items.
    #[test]
    fn outstanding_and_terminal_never_overlap(index in 0usize..5) {
        let status = STATUSES[index];
        prop_assert_ne!(status.is_outstanding(), status.is_terminal());
    }
}
