//! What changed between two issues, in numbers rather than in geometry.
//!
//! SheetForge already compares two revisions *visually*: it aligns them, finds the pixels that
//! moved, and clouds them. That answers "what is different about this drawing", which is the right
//! question for a reviewer looking at a sheet.
//!
//! It is the wrong question for somebody deciding whether a variation is real. They are not asking
//! which wall moved; they are asking **which numbers moved, and by how much** — because that is
//! what a claim is made of, and a wall that moved 50 mm may change nothing while a wall that did
//! not move at all may have been re-clad and changed everything.
//!
//! So this compares the *quantities*, grouped the way a bill is grouped, and reports the
//! differences.
//!
//! ## Why the grouping key includes the unit
//!
//! Because adding a length to an area produces a number with no meaning, and a spreadsheet will do
//! it without complaint. Two quantities belong to the same line only if they are the same cost
//! code *and* the same unit; `03 30 00` in square metres and `03 30 00` in linear metres are two
//! lines that happen to share a code.
//!
//! ## What "changed" is allowed to mean
//!
//! Floating-point sums do not compare equal, and a quantity re-derived at the same scale can differ
//! in the last few bits. A tolerance is therefore unavoidable, and it is **relative** — a
//! millimetre matters on a door and not on a car park — with an absolute floor for quantities near
//! zero, where a relative comparison divides by almost nothing and calls everything a change.

use crate::error::{DomainError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A line in the comparison: a cost code and the unit it is measured in.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// The cost code, or whatever the markups were grouped under. Absent when the markups carried
    /// none, which is common and is reported as its own line rather than merged into another.
    pub code: Option<String>,
    /// The unit the quantities are in. Part of the key, because a length and an area under one
    /// code are two lines.
    pub unit: String,
}

/// How a line differs between two issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Movement {
    /// Present in the later issue and not the earlier one.
    Added,
    /// Present in the earlier issue and not the later one. Worth its own name: a line that has
    /// gone is easy to miss and expensive to miss.
    Removed,
    /// In both, and the number moved.
    Changed,
    /// In both, and the number did not move.
    Held,
}

/// One line's story across two issues.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Which line.
    pub line: Line,
    /// The total in the earlier issue. Zero when the line is new.
    pub before: f64,
    /// The total in the later issue. Zero when the line has gone.
    pub after: f64,
    /// `after - before`. Signed, because whether a quantity grew or shrank is the first thing
    /// anybody asks and the last thing an absolute difference tells them.
    pub difference: f64,
    /// What happened.
    pub movement: Movement,
}

impl Change {
    /// The difference as a proportion of the earlier total, when there was one.
    ///
    /// `None` for a line that is new — a percentage against zero is either infinity or a lie, and
    /// reporting "+∞%" in a variation schedule helps nobody.
    #[must_use]
    pub fn proportion(&self) -> Option<f64> {
        if self.before.abs() <= NEAR_ZERO {
            None
        } else {
            Some(self.difference / self.before)
        }
    }
}

/// Below this, a quantity is treated as nothing.
///
/// Any real measurement is orders of magnitude above it; what it catches is a sum of quantities
/// that cancelled, where a relative comparison would divide by almost nothing.
const NEAR_ZERO: f64 = 1e-9;

/// How far two totals may differ and still count as the same number.
///
/// One part in ten thousand: far below any difference a person would call a change, far above the
/// last few bits of a re-derived floating-point sum.
const RELATIVE_TOLERANCE: f64 = 1e-4;

/// Sum quantities into lines.
///
/// Takes `(code, unit, magnitude)` triples — one per measured markup — because that is what a
/// caller has, and building the grouping here means the two sides of a comparison cannot group
/// differently.
///
/// # Errors
/// If any magnitude is not a finite number. A total built from a NaN is a total that compares
/// unequal to itself, and a comparison that reports every line as changed is worse than none.
pub fn total(quantities: &[(Option<String>, String, f64)]) -> Result<BTreeMap<Line, f64>> {
    let mut totals: BTreeMap<Line, f64> = BTreeMap::new();

    for (code, unit, magnitude) in quantities {
        if !magnitude.is_finite() {
            return Err(DomainError::OutOfRange {
                field: "magnitude",
                reason: "a quantity that is not a number cannot be totalled".into(),
            });
        }
        let line = Line {
            code: code.clone(),
            unit: unit.clone(),
        };
        *totals.entry(line).or_insert(0.0) += magnitude;
    }

    Ok(totals)
}

/// Compare two issues, line by line.
///
/// Every line in either side appears in the result, including the ones that did not move. A
/// comparison that showed only the differences would leave somebody unable to tell "this line is
/// unchanged" from "this line was not in the comparison", and those want very different responses.
///
/// Ordered by cost code, so two runs of the same comparison produce the same document.
#[must_use]
pub fn compare(before: &BTreeMap<Line, f64>, after: &BTreeMap<Line, f64>) -> Vec<Change> {
    let mut lines: Vec<&Line> = before.keys().chain(after.keys()).collect();
    lines.sort();
    lines.dedup();

    lines
        .into_iter()
        .map(|line| {
            let was = before.get(line).copied();
            let is = after.get(line).copied();
            let before_value = was.unwrap_or(0.0);
            let after_value = is.unwrap_or(0.0);
            let difference = after_value - before_value;

            let movement = match (was, is) {
                (None, Some(_)) => Movement::Added,
                (Some(_), None) => Movement::Removed,
                _ => {
                    // Relative where there is something to be relative to, absolute where there is
                    // not. Dividing by a total that cancelled to nothing calls every line changed.
                    let scale = before_value.abs().max(after_value.abs());
                    if scale <= NEAR_ZERO || difference.abs() <= scale * RELATIVE_TOLERANCE {
                        Movement::Held
                    } else {
                        Movement::Changed
                    }
                }
            };

            Change {
                line: line.clone(),
                before: before_value,
                after: after_value,
                difference,
                movement,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(code: Option<&str>, unit: &str) -> Line {
        Line {
            code: code.map(str::to_owned),
            unit: unit.to_owned(),
        }
    }

    fn totals(rows: &[(Option<&str>, &str, f64)]) -> BTreeMap<Line, f64> {
        total(
            &rows
                .iter()
                .map(|(code, unit, value)| (code.map(str::to_owned), (*unit).to_owned(), *value))
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn quantities_under_one_code_and_unit_add_up() {
        let summed = totals(&[
            (Some("03 30 00"), "m2", 12.5),
            (Some("03 30 00"), "m2", 7.5),
            (Some("09 91 00"), "m2", 4.0),
        ]);

        assert!((summed[&line(Some("03 30 00"), "m2")] - 20.0).abs() < 1e-9);
        assert!((summed[&line(Some("09 91 00"), "m2")] - 4.0).abs() < 1e-9);
    }

    /// Adding a length to an area produces a number with no meaning, and a spreadsheet does it
    /// without complaint. The unit is part of the key precisely so that cannot happen here.
    #[test]
    fn one_code_in_two_units_is_two_lines() {
        let summed = totals(&[(Some("03 30 00"), "m2", 20.0), (Some("03 30 00"), "m", 8.0)]);

        assert_eq!(summed.len(), 2);
        assert!((summed[&line(Some("03 30 00"), "m2")] - 20.0).abs() < 1e-9);
        assert!((summed[&line(Some("03 30 00"), "m")] - 8.0).abs() < 1e-9);
    }

    /// Markups with no cost code are common and are their own line. Merging them into another
    /// would inflate a line somebody is about to price.
    #[test]
    fn quantities_with_no_code_are_their_own_line() {
        let summed = totals(&[(None, "m2", 5.0), (Some("03 30 00"), "m2", 5.0)]);
        assert_eq!(summed.len(), 2);
        assert!((summed[&line(None, "m2")] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn a_line_that_moved_is_reported_with_its_direction() {
        let changes = compare(
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
            &totals(&[(Some("03 30 00"), "m2", 120.0)]),
        );

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].movement, Movement::Changed);
        assert!((changes[0].difference - 20.0).abs() < 1e-9);
        assert!((changes[0].proportion().unwrap() - 0.2).abs() < 1e-9);
    }

    /// A line that has gone is easy to miss and expensive to miss, so it is named rather than
    /// left as a change to zero.
    #[test]
    fn a_line_that_appeared_or_vanished_is_named_as_such() {
        let changes = compare(
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
            &totals(&[(Some("09 91 00"), "m2", 40.0)]),
        );

        let removed = changes
            .iter()
            .find(|c| c.line.code.as_deref() == Some("03 30 00"))
            .unwrap();
        assert_eq!(removed.movement, Movement::Removed);
        assert!(removed.after.abs() < 1e-9);

        let added = changes
            .iter()
            .find(|c| c.line.code.as_deref() == Some("09 91 00"))
            .unwrap();
        assert_eq!(added.movement, Movement::Added);
        assert!(added.before.abs() < 1e-9);
        // A percentage against nothing is either infinity or a lie.
        assert_eq!(added.proportion(), None);
    }

    /// A quantity re-derived at the same scale can differ in the last few bits. Reporting that as
    /// a change would fill a variation schedule with noise and teach everybody to skim it.
    #[test]
    fn a_difference_in_the_last_few_bits_is_not_a_change() {
        let changes = compare(
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
            &totals(&[(Some("03 30 00"), "m2", 100.000_000_1)]),
        );
        assert_eq!(changes[0].movement, Movement::Held);
    }

    /// But a real difference at the same magnitude is a change. The tolerance must not be so
    /// generous that it hides something somebody would price.
    #[test]
    fn a_difference_worth_pricing_is_a_change() {
        let changes = compare(
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
            &totals(&[(Some("03 30 00"), "m2", 100.5)]),
        );
        assert_eq!(changes[0].movement, Movement::Changed);
    }

    /// "Unchanged" and "not in the comparison" want completely different responses, so every line
    /// appears whether or not it moved.
    #[test]
    fn lines_that_did_not_move_are_still_reported() {
        let changes = compare(
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
            &totals(&[(Some("03 30 00"), "m2", 100.0)]),
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].movement, Movement::Held);
    }

    /// Two runs of the same comparison have to produce the same document, or a diff of the diffs
    /// is noise.
    #[test]
    fn the_order_is_stable() {
        let before = totals(&[
            (Some("09 91 00"), "m2", 1.0),
            (Some("03 30 00"), "m2", 1.0),
            (None, "m", 1.0),
        ]);
        let after = before.clone();

        let first: Vec<Line> = compare(&before, &after)
            .into_iter()
            .map(|c| c.line)
            .collect();
        let second: Vec<Line> = compare(&before, &after)
            .into_iter()
            .map(|c| c.line)
            .collect();
        assert_eq!(first, second);
    }

    /// A total built from a NaN compares unequal to itself, and a comparison that called every
    /// line changed would be worse than no comparison at all.
    #[test]
    fn a_quantity_that_is_not_a_number_is_refused_before_it_reaches_a_total() {
        let refused = total(&[(None, "m2".to_owned(), f64::NAN)]);
        assert!(refused.is_err());
        assert!(total(&[(None, "m2".to_owned(), f64::INFINITY)]).is_err());
    }

    /// Quantities that cancel to nothing must not make the relative comparison divide by almost
    /// zero and call the line changed.
    #[test]
    fn totals_that_cancelled_to_nothing_are_held_rather_than_infinitely_changed() {
        let changes = compare(
            &totals(&[(Some("x"), "m2", 5.0), (Some("x"), "m2", -5.0)]),
            &totals(&[(Some("x"), "m2", 0.0)]),
        );
        assert_eq!(changes[0].movement, Movement::Held);
        assert_eq!(changes[0].proportion(), None);
    }

    /// The panel and the comparison must never disagree.
    ///
    /// The takeoff panel shows `total(x)`. The comparison shows, in its `after` column,
    /// `compare(anything, x)`. Those are two paths to the same number, and if they ever drift
    /// apart the result is a running total on screen that does not match the schedule somebody
    /// exports thirty seconds later — with nothing to say which of the two is wrong.
    ///
    /// This pins them together at the only place they can be pinned: the arithmetic itself.
    #[test]
    fn a_comparison_reports_the_same_totals_the_panel_shows() {
        let quantities = vec![
            (Some("03 30 00".to_owned()), "m3".to_owned(), 12.5),
            (Some("03 30 00".to_owned()), "m3".to_owned(), 7.5),
            (Some("03 30 00".to_owned()), "m2".to_owned(), 100.0),
            (None, "m".to_owned(), 44.0),
        ];

        let panel = total(&quantities).expect("totals");
        let comparison = compare(&BTreeMap::new(), &panel);

        // Every line the panel shows appears in the comparison carrying the identical number.
        for (line, shown) in &panel {
            let change = comparison
                .iter()
                .find(|change| &change.line == line)
                .unwrap_or_else(|| panic!("the comparison dropped the line {line:?}"));
            // Bit equality rather than a tolerance, deliberately. The claim is not "these are
            // close" — it is that both paths hand back the very same f64, because `compare` reads
            // it out of the map `total` built. A tolerance here would let real drift through.
            assert_eq!(
                change.after.to_bits(),
                shown.to_bits(),
                "the panel and the comparison disagree about {line:?}"
            );
        }

        // And the comparison invents nothing the panel does not show.
        assert_eq!(
            comparison.len(),
            panel.len(),
            "the comparison has lines the panel does not"
        );
    }
}
