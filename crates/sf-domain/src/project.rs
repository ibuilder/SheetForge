//! Projects — the unit of work, and the unit of portability.
//!
//! A project owns its documents, markups, calibrations and audit trail, and a project package is
//! the whole of it in one directory that can be zipped and handed to somebody. That boundary is
//! what makes the application useful on a job site with no network: everything needed to review a
//! set travels together, and nothing outside the package is required to open it.

use crate::error::{bounded_text, optional_text};
use crate::ids::{ActorId, ProjectId};
use crate::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    /// This project.
    pub id: ProjectId,
    /// What the job is called.
    pub name: String,
    /// The client's or the organisation's own job number, when there is one.
    pub job_number: Option<String>,
    /// Free-text description.
    pub description: Option<String>,
    /// When it was created.
    pub created_at: DateTime<Utc>,
    /// When anything in it last changed.
    pub updated_at: DateTime<Utc>,
    /// Who created it.
    pub created_by: ActorId,
}

impl Project {
    /// Longest project name.
    pub const MAX_NAME: usize = 200;
    /// Longest description.
    pub const MAX_DESCRIPTION: usize = 4_000;

    /// Start a project.
    ///
    /// # Errors
    /// If the name is blank or any bounded field is over its limit.
    pub fn new(
        name: &str,
        job_number: Option<&str>,
        description: Option<&str>,
        created_by: ActorId,
    ) -> Result<Self> {
        let now = crate::now();
        Ok(Self {
            id: ProjectId::new(),
            name: bounded_text(name, "project name", Self::MAX_NAME)?,
            job_number: optional_text(job_number, "job number", 64)?,
            description: optional_text(description, "description", Self::MAX_DESCRIPTION)?,
            created_at: now,
            updated_at: now,
            created_by,
        })
    }

    /// Rename.
    ///
    /// # Errors
    /// If the new name is blank or over-long.
    pub fn rename(&mut self, name: &str) -> Result<()> {
        self.name = bounded_text(name, "project name", Self::MAX_NAME)?;
        self.touch();
        Ok(())
    }

    /// Record that something inside the project changed.
    pub fn touch(&mut self) {
        self.updated_at = crate::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_needs_a_name() {
        assert!(Project::new("  ", None, None, ActorId::local()).is_err());
    }

    #[test]
    fn fields_are_trimmed_and_blanks_become_absent() {
        let project = Project::new(
            "  Riverside Tower  ",
            Some("  "),
            Some(" fit-out "),
            ActorId::local(),
        )
        .unwrap();
        assert_eq!(project.name, "Riverside Tower");
        assert_eq!(project.job_number, None);
        assert_eq!(project.description.as_deref(), Some("fit-out"));
    }

    #[test]
    fn renaming_is_validated_and_leaves_the_old_name_on_failure() {
        let mut project = Project::new("Riverside Tower", None, None, ActorId::local()).unwrap();
        assert!(project.rename("   ").is_err());
        assert_eq!(project.name, "Riverside Tower");
        project.rename("Riverside Tower — Phase 2").unwrap();
        assert_eq!(project.name, "Riverside Tower — Phase 2");
    }

    #[test]
    fn an_over_long_name_is_refused() {
        let long = "x".repeat(Project::MAX_NAME + 1);
        assert!(Project::new(&long, None, None, ActorId::local()).is_err());
    }
}
