//! The markup review workflow.
//!
//! A construction review is a workflow, not a label: a comment that is `closed` and then silently
//! becomes `open` again with no record is how a punch item gets lost. So the statuses are a state
//! machine with declared transitions, and the transition — not just the resulting value — is what
//! the store audits.
//!
//! Organisations do rename these (`void` vs `rejected`, `in review` vs `submitted`). The *labels*
//! are configurable at the presentation layer; the underlying set is not, because the transition
//! rules and the roll-up reports have to mean the same thing on every project.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Where a markup sits in its review.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "kebab-case")]
pub enum MarkupStatus {
    /// Raised, not yet acted on.
    #[default]
    Open,
    /// Somebody owns it and is working on it.
    InProgress,
    /// Work is claimed complete and needs checking by the raiser.
    ForReview,
    /// Checked and accepted.
    Closed,
    /// Withdrawn without being actioned — raised in error, or superseded.
    Void,
}

impl MarkupStatus {
    /// Every status, in workflow order. The order is what a board or a report groups by.
    pub const ALL: [Self; 5] = [
        Self::Open,
        Self::InProgress,
        Self::ForReview,
        Self::Closed,
        Self::Void,
    ];

    /// The stable wire name. Persisted and exported, so it must never change.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InProgress => "in-progress",
            Self::ForReview => "for-review",
            Self::Closed => "closed",
            Self::Void => "void",
        }
    }

    /// Whether the item still needs somebody's attention. What "12 outstanding" counts.
    #[must_use]
    pub const fn is_outstanding(self) -> bool {
        matches!(self, Self::Open | Self::InProgress | Self::ForReview)
    }

    /// Whether this status is an end state.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Void)
    }

    /// Whether `self -> next` is permitted.
    ///
    /// Two rules carry the weight:
    ///
    /// - **A terminal state reopens only to `Open`.** Closed going straight back to `for-review`
    ///   would skip the step where somebody says what is wrong with it.
    /// - **Anything may be voided.** Withdrawal is always available, because an item raised in
    ///   error should not have to be walked through a workflow to get rid of it.
    ///
    /// Staying put is allowed and is a no-op, so that a bulk status set over a mixed selection
    /// does not fail on the rows that were already there.
    #[must_use]
    // The arms are kept apart even where two share a body: each states a different rule, and
    // merging them into one pattern would delete the explanation along with the duplication.
    #[allow(clippy::match_same_arms)]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use MarkupStatus::{Closed, ForReview, InProgress, Open, Void};
        match (self, next) {
            // Staying put is a no-op, not a failure: a bulk status set over a mixed selection
            // must not fail on the rows that were already there.
            (Open, Open)
            | (InProgress, InProgress)
            | (ForReview, ForReview)
            | (Closed, Closed)
            | (Void, Void) => true,
            // Withdrawal is always on the table.
            (_, Void) => true,
            // A terminal item reopens at the start of the workflow, never mid-way.
            (Closed | Void, Open) => true,
            (Closed | Void, _) => false,
            // Inside the live workflow, forward and back a step are both real review outcomes.
            (Open | InProgress | ForReview, _) => true,
        }
    }

    /// Apply a transition.
    ///
    /// # Errors
    /// [`DomainError::IllegalTransition`](crate::DomainError::IllegalTransition) if the move is not
    /// permitted, naming both ends so the message is actionable.
    pub fn transition_to(self, next: Self) -> crate::Result<Self> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(crate::DomainError::IllegalTransition {
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

impl fmt::Display for MarkupStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for MarkupStatus {
    type Err = crate::DomainError;
    fn from_str(s: &str) -> crate::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == s)
            .ok_or(crate::DomainError::Malformed {
                subject: "markup status",
            })
    }
}

#[cfg(test)]
mod tests {
    use super::MarkupStatus::{self, Closed, ForReview, InProgress, Open, Void};
    use std::str::FromStr;

    #[test]
    fn every_status_can_stay_where_it_is() {
        for status in MarkupStatus::ALL {
            assert!(
                status.can_transition_to(status),
                "{status} -> {status} must be a no-op, not a failure"
            );
        }
    }

    #[test]
    fn anything_can_be_withdrawn() {
        for status in MarkupStatus::ALL {
            assert!(status.can_transition_to(Void), "{status} must be voidable");
        }
    }

    #[test]
    fn a_terminal_item_reopens_only_at_the_start() {
        assert!(Closed.can_transition_to(Open));
        assert!(Void.can_transition_to(Open));
        for skipped in [InProgress, ForReview] {
            assert!(
                !Closed.can_transition_to(skipped),
                "closed -> {skipped} would skip the step that says what is wrong with it",
            );
            assert!(!Void.can_transition_to(skipped));
        }
    }

    #[test]
    fn work_can_be_pushed_back_a_step() {
        assert!(
            ForReview.can_transition_to(InProgress),
            "'that isn't done' is a real review outcome"
        );
        assert!(ForReview.can_transition_to(Open));
        assert!(InProgress.can_transition_to(Open));
    }

    #[test]
    fn a_refused_transition_names_both_ends() {
        let err = Closed.transition_to(ForReview).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("closed") && message.contains("for-review"),
            "got: {message}"
        );
    }

    #[test]
    fn outstanding_is_the_complement_of_terminal() {
        for status in MarkupStatus::ALL {
            assert_ne!(status.is_outstanding(), status.is_terminal());
        }
    }

    #[test]
    fn wire_names_round_trip_and_are_stable() {
        // These strings are in exported CSV, XFDF payloads and the SQLite file. Changing one
        // silently orphans every record already written, so the expected values are spelled out
        // here rather than derived.
        let expected = ["open", "in-progress", "for-review", "closed", "void"];
        for (status, name) in MarkupStatus::ALL.into_iter().zip(expected) {
            assert_eq!(status.as_str(), name);
            assert_eq!(MarkupStatus::from_str(name).unwrap(), status);
        }
    }

    #[test]
    fn an_unknown_status_is_rejected_rather_than_defaulted() {
        // Defaulting here would turn a corrupted row into a plausible-looking open item.
        assert!(MarkupStatus::from_str("archived").is_err());
        assert!(
            MarkupStatus::from_str("Open").is_err(),
            "casing is part of the wire name"
        );
    }
}
