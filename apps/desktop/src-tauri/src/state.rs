//! Process state: the open project, who is using it, and what they may do.
//!
//! One project is open at a time. A second window onto the same project would need either two
//! connections racing on the same SQLite file or a shared handle behind a lock that is held across
//! user interaction — and neither is worth the complexity before anybody has asked for it. The
//! shape here does not preclude it later: everything goes through [`AppState::with_package`].

use sf_package::Package;
use sf_security::{Capability, ResourceLimits, Role, SecurityError};
use std::sync::Mutex;

/// Everything the commands share.
pub struct AppState {
    /// The open project, if there is one.
    package: Mutex<Option<Package>>,
    /// Who is marking up. Fixed at startup for a local install.
    actor: sf_domain::ActorId,
    /// What they may do.
    role: Role,
    /// The bounds untrusted input is held to.
    limits: ResourceLimits,
}

impl AppState {
    /// Start with nothing open.
    ///
    /// The actor falls back to a local label when the platform gives no username. That is the
    /// honest answer for a single-user install: inventing an identity would put a fabricated name
    /// on records that become contract evidence.
    #[must_use]
    pub fn new() -> Self {
        let actor = std::env::var("SHEETFORGE_ACTOR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .and_then(|value| sf_domain::ActorId::new(&value).ok())
            .unwrap_or_else(sf_domain::ActorId::local);

        Self {
            package: Mutex::new(None),
            actor,
            // A local install has no directory to ask, so the person at the machine owns their own
            // files. A managed deployment substitutes this from its own identity provider.
            role: Role::Owner,
            limits: ResourceLimits::default(),
        }
    }

    /// Who is acting.
    #[must_use]
    pub const fn actor(&self) -> &sf_domain::ActorId {
        &self.actor
    }

    /// Their role.
    #[must_use]
    pub const fn role(&self) -> Role {
        self.role
    }

    /// The configured bounds.
    #[must_use]
    pub const fn limits(&self) -> &ResourceLimits {
        &self.limits
    }

    /// Assert a capability before doing something.
    ///
    /// # Errors
    /// [`SecurityError::NotPermitted`] carrying the capability, so the refusal reaches both the
    /// user and the audit trail with a reason.
    pub fn require(&self, capability: Capability) -> Result<(), SecurityError> {
        self.role.require(capability)
    }

    /// Replace the open project. Returns the previous one so it can be closed cleanly.
    pub fn set_package(&self, package: Option<Package>) -> Option<Package> {
        // A poisoned lock means a command panicked while holding it. Recovering the guard is
        // correct here: the alternative is that one panic makes the application permanently
        // unable to open a project until it is restarted.
        let mut slot = self
            .package
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::replace(&mut *slot, package)
    }

    /// Whether a project is open.
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.package
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Run something against the open project.
    ///
    /// The lock is held for the duration, which is why every closure passed here must be short and
    /// must never wait on the user. Anything that needs a dialog opens it first and comes back.
    ///
    /// # Errors
    /// Whatever `f` returns, or `None` mapped by the caller when no project is open.
    pub fn with_package<T, E>(
        &self,
        f: impl FnOnce(&mut Package) -> Result<T, E>,
    ) -> Option<Result<T, E>> {
        let mut slot = self
            .package
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.as_mut().map(f)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_open_at_startup() {
        let state = AppState::new();
        assert!(!state.is_open());
        assert!(state.with_package(|_| Ok::<_, ()>(())).is_none());
    }

    #[test]
    fn a_local_install_has_an_actor_and_owns_its_own_files() {
        let state = AppState::new();
        assert!(!state.actor().as_str().is_empty());
        assert_eq!(state.role(), Role::Owner);
        assert!(state.require(Capability::MarkupCreate).is_ok());
    }

    #[test]
    fn a_command_that_needs_a_project_gets_nothing_when_none_is_open() {
        // The `None` here is what becomes `CommandError::no_project`, rather than a panic or a
        // default-constructed empty project.
        let state = AppState::new();
        let outcome: Option<Result<u8, ()>> = state.with_package(|_| Ok(1));
        assert!(outcome.is_none());
    }
}
