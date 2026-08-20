//! What a command can return instead of a result.
//!
//! Two rules govern this module, and both are about what crosses the IPC boundary:
//!
//! 1. **Every message is safe to show a user and safe to write to a log.** No filesystem paths, no
//!    document content, no SQL, no stack traces. The underlying errors are richer than this and
//!    deliberately do not travel.
//! 2. **Every error carries a machine-readable `code`.** The interface decides what to *do* about a
//!    failure — offer a retry, open the conflict dialog, prompt for a different file — and matching
//!    on a human sentence is how that breaks the first time someone improves the wording.

use serde::Serialize;

/// A failed command.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// Stable, machine-readable. The interface switches on this.
    pub code: &'static str,
    /// One sentence, safe to display, safe to log.
    pub message: String,
    /// Whether trying the same thing again could plausibly work. Governs whether a retry is
    /// offered at all — offering one for a permission refusal is noise.
    pub retryable: bool,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    /// No project is open, and this command needs one.
    #[must_use]
    pub fn no_project() -> Self {
        Self::new("no-project", "Open or create a project first.", false)
    }

    /// The user dismissed a native dialog. Not a failure, but the command still has no result.
    #[must_use]
    pub fn cancelled() -> Self {
        Self::new("cancelled", "Cancelled.", false)
    }

    /// A payload from the webview did not validate.
    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("invalid-request", message, false)
    }

    /// Something went wrong that has no better description. The detail stays in the local log.
    #[must_use]
    pub fn internal() -> Self {
        Self::new(
            "internal",
            "Something went wrong. The details are in this device's log.",
            true,
        )
    }
}

impl From<sf_domain::DomainError> for CommandError {
    fn from(error: sf_domain::DomainError) -> Self {
        use sf_domain::DomainError as D;
        // Domain messages are written for users and carry no paths, so they travel as-is.
        let code = match error {
            D::VersionConflict { .. } => "version-conflict",
            D::IllegalTransition { .. } => "illegal-transition",
            D::IntegrityFailure { .. } => "integrity",
            D::Empty { .. } | D::TooLong { .. } | D::OutOfRange { .. } => "invalid-request",
            D::Malformed { .. } => "malformed",
        };
        Self::new(code, error.to_string(), false)
    }
}

impl From<sf_security::SecurityError> for CommandError {
    fn from(error: sf_security::SecurityError) -> Self {
        use sf_security::SecurityError as S;
        let code = match error {
            S::TooLarge { .. } => "too-large",
            S::NotTheExpectedFormat { .. } => "wrong-format",
            S::PathEscape | S::UnusableName { .. } => "bad-location",
            S::NotPermitted(_) => "not-permitted",
        };
        Self::new(code, error.to_string(), false)
    }
}

impl From<sf_store::StoreError> for CommandError {
    fn from(error: sf_store::StoreError) -> Self {
        use sf_store::StoreError as S;
        match error {
            // Unwrap rather than restate, so a version conflict reaches the interface as a
            // version conflict no matter which layer noticed it.
            S::Domain(inner) => inner.into(),
            S::Audit(inner) => Self::new("audit-broken", inner.to_string(), false),
            S::NotFound(what) => Self::new(
                "not-found",
                format!("That {what} is no longer in this project."),
                false,
            ),
            S::NewerFormat { .. } => Self::new("newer-format", error.to_string(), false),
            S::AlreadyInitialised => Self::new("already-initialised", error.to_string(), false),
            S::Corrupt => Self::new("corrupt", error.to_string(), false),
            // A rusqlite message can name the database file, so it is logged and not forwarded.
            S::Database(_) => {
                log::error!("{}", sf_audit::redact(&error.to_string()));
                Self::new("storage", "The project could not be read or written.", true)
            }
        }
    }
}

impl From<sf_package::PackageError> for CommandError {
    fn from(error: sf_package::PackageError) -> Self {
        use sf_package::PackageError as P;
        match error {
            P::Store(inner) => inner.into(),
            P::Security(inner) => inner.into(),
            P::NotAPackage => Self::new("not-a-project", error.to_string(), false),
            P::NewerFormat { .. } => Self::new("newer-format", error.to_string(), false),
            P::IntegrityFailure { .. } => Self::new("integrity", error.to_string(), false),
            P::MissingSource { .. } => Self::new("missing-source", error.to_string(), false),
            P::AlreadyExists => Self::new("already-exists", error.to_string(), false),
            P::Io(inner) => {
                log::error!("package io: {}", sf_audit::redact(&inner.to_string()));
                Self::new("storage", "The project could not be read or written.", true)
            }
        }
    }
}

impl From<sf_audit::AuditError> for CommandError {
    fn from(error: sf_audit::AuditError) -> Self {
        Self::new("audit-broken", error.to_string(), false)
    }
}

/// What every command returns.
pub type CommandResult<T> = std::result::Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_conflict_keeps_its_code_through_two_layers_of_wrapping() {
        // The interface opens the conflict dialog on this code. If a layer flattened it to
        // "storage", a concurrent edit would surface as a generic failure and the user would lose
        // the chance to resolve it.
        let domain = sf_domain::DomainError::VersionConflict {
            expected: 1,
            found: 2,
        };
        let through_store: CommandError = sf_store::StoreError::Domain(domain.clone()).into();
        assert_eq!(through_store.code, "version-conflict");

        let through_package: CommandError =
            sf_package::PackageError::Store(sf_store::StoreError::Domain(domain)).into();
        assert_eq!(through_package.code, "version-conflict");
    }

    #[test]
    fn a_permission_refusal_is_not_offered_as_retryable() {
        let error: CommandError =
            sf_security::SecurityError::NotPermitted(sf_security::Capability::Export).into();
        assert_eq!(error.code, "not-permitted");
        assert!(!error.retryable, "offering a retry for a refusal is noise");
    }

    #[test]
    fn no_error_message_that_crosses_the_boundary_carries_a_path_or_a_filename() {
        let errors: Vec<CommandError> = vec![
            CommandError::no_project(),
            CommandError::cancelled(),
            CommandError::internal(),
            sf_package::PackageError::NotAPackage.into(),
            sf_package::PackageError::IntegrityFailure {
                short_hash: "ab12cd34ef56".into(),
            }
            .into(),
            sf_store::StoreError::NotFound("markup").into(),
            sf_store::StoreError::Corrupt.into(),
            sf_security::SecurityError::PathEscape.into(),
            sf_security::SecurityError::TooLarge {
                subject: "a drawing",
                actual_mb: 900,
                limit_mb: 512,
            }
            .into(),
            sf_domain::DomainError::VersionConflict {
                expected: 1,
                found: 2,
            }
            .into(),
        ];
        for error in errors {
            let message = &error.message;
            assert!(!message.contains(":\\"), "path in: {message}");
            assert!(
                !message.contains(".pdf") && !message.contains(".sqlite"),
                "filename in: {message}"
            );
            assert!(
                !message.contains("SELECT") && !message.contains("INSERT"),
                "SQL in: {message}"
            );
            assert!(!message.is_empty());
        }
    }

    #[test]
    fn every_error_serialises_with_the_fields_the_interface_switches_on() {
        let json = serde_json::to_value(CommandError::no_project()).unwrap();
        assert_eq!(json["code"], "no-project");
        assert!(json["message"].is_string());
        assert!(json["retryable"].is_boolean());
    }
}
