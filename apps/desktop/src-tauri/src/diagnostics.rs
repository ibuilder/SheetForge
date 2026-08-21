//! The diagnostic bundle.
//!
//! SheetForge collects no telemetry — see
//! [ADR-0007](../../../../docs/adr/0007-telemetry-privacy-and-diagnostics.md). The cost of that
//! decision is that when something goes wrong we know nothing about it, and the thing offered in
//! its place is this: a bundle the **user** assembles, can read before sending, and chooses whether
//! to send at all.
//!
//! That only works if it is genuinely readable. A support bundle that is an opaque archive is a
//! telemetry upload with extra steps, so this is plain text a person can scroll through in a
//! minute, and everything in it is there because a support conversation would otherwise have to ask
//! for it.
//!
//! ## What is deliberately absent
//!
//! No document content. No markup text. No OCR output. No filesystem paths. No project name. No
//! credentials. The bundle names *counts and versions*, never contents — a project is described as
//! "14 drawings, 320 markups, audit trail intact", which is what a support question needs and is
//! nothing a client could object to being sent.
//!
//! Log lines pass through [`sf_audit::redact`] on the way in. The logs are already written not to
//! contain paths, and this is the second belt: a message from the operating system or a dependency
//! was not written to our rules.

use crate::state::AppState;
use serde::Serialize;
use std::fmt::Write as _;

/// What the bundle reports about the machine.
///
/// Chosen from what a support conversation actually asks: which build, which OS, which webview,
/// and how much memory — because "it is slow on a 200-sheet set" means different things on a
/// workstation and on a site tablet.
#[derive(Debug, Serialize)]
pub struct Environment {
    /// The SheetForge build.
    pub app_version: String,
    /// `debug` or `release`. A performance report from a debug build means something else.
    pub build_profile: &'static str,
    /// `windows`, `macos`, `linux`, …
    pub os: String,
    /// The OS build, which is what a webview bug is usually pinned to.
    pub os_version: String,
    /// `x86_64`, `aarch64`.
    pub architecture: String,
    /// WebView2 or WKWebView. The renderer is the webview, so this is the renderer version.
    pub webview_version: String,
    /// The shell version.
    pub tauri_version: &'static str,
    /// Affects number and date formatting, which is where locale bugs surface.
    pub locale: String,
}

/// What it reports about the open project — counts, never contents.
#[derive(Debug, Serialize)]
pub struct ProjectFacts {
    /// Whether a project was open when the bundle was made.
    pub open: bool,
    /// The `.sfproj` layout version.
    pub package_format: Option<u32>,
    /// The database schema version.
    pub schema_version: Option<u32>,
    /// How many drawings are filed. Never their names.
    pub drawings: Option<usize>,
    /// How many markups exist. Never their text.
    pub markups: Option<usize>,
    /// How long the audit trail is.
    pub audit_entries: Option<usize>,
    /// Whether the hash chain verifies. The single most useful fact when a project misbehaves.
    pub audit_intact: Option<bool>,
}

/// The whole bundle.
#[derive(Debug, Serialize)]
pub struct Bundle {
    /// RFC 3339 UTC.
    pub generated_at: String,
    /// The build and the machine.
    pub environment: Environment,
    /// Counts from the open project.
    pub project: ProjectFacts,
    /// The bounds untrusted input is held to, which a support question often turns on.
    pub limits: sf_security::ResourceLimits,
    /// What the user is permitted to do.
    pub role: sf_security::Role,
    /// The tail of the application log, redacted.
    pub recent_log: Vec<String>,
    /// Anything that could not be gathered, and why. An absent section with no explanation reads
    /// as a bug in the bundle rather than as a fact about the machine.
    pub gaps: Vec<String>,
}

impl Bundle {
    /// Render as text a person can read without a tool.
    ///
    /// Not JSON. The bundle exists so somebody can satisfy themselves it carries nothing sensitive
    /// before they attach it to a ticket, and a wall of JSON does not get read.
    #[must_use]
    pub fn to_readable(&self) -> String {
        let mut out = String::with_capacity(4096);
        self.write_preamble(&mut out);
        self.write_machine(&mut out);
        self.write_project(&mut out);
        self.write_limits(&mut out);
        self.write_log(&mut out);
        self.write_gaps(&mut out);
        out
    }

    fn write_preamble(&self, out: &mut String) {
        let _ = writeln!(out, "SheetForge diagnostic bundle");
        let _ = writeln!(out, "generated {}", self.generated_at);
        let _ = writeln!(out);
        let _ = writeln!(
            out,
            "This file contains no document content, no markup text, no file paths and no
             credentials. It is safe to read, and safe to attach to a support request. Nothing
             was sent anywhere in producing it."
        );
    }

    fn write_machine(&self, out: &mut String) {
        let env = &self.environment;
        let _ = writeln!(
            out,
            "
== Build and machine =="
        );
        let _ = writeln!(
            out,
            "SheetForge       {} ({})",
            env.app_version, env.build_profile
        );
        let _ = writeln!(out, "Tauri            {}", env.tauri_version);
        let _ = writeln!(out, "Operating system {} {}", env.os, env.os_version);
        let _ = writeln!(out, "Architecture     {}", env.architecture);
        let _ = writeln!(out, "Webview          {}", env.webview_version);
        let _ = writeln!(out, "Locale           {}", env.locale);
    }

    fn write_project(&self, out: &mut String) {
        let _ = writeln!(
            out,
            "
== Open project =="
        );
        if !self.project.open {
            let _ = writeln!(out, "No project open.");
            return;
        }

        let count = |value: Option<usize>| value.map_or("unknown".to_owned(), |n| n.to_string());
        let version = |value: Option<u32>| value.map_or("unknown".to_owned(), |n| n.to_string());

        let _ = writeln!(out, "Drawings         {}", count(self.project.drawings));
        let _ = writeln!(out, "Markups          {}", count(self.project.markups));
        let _ = writeln!(
            out,
            "Audit entries    {}",
            count(self.project.audit_entries)
        );
        let _ = writeln!(
            out,
            "Audit trail      {}",
            match self.project.audit_intact {
                Some(true) => "intact",
                // The fact a support conversation most needs, and the one a user most needs to act
                // on. Burying it would be the worst possible place to be tactful.
                Some(false) => "BROKEN — see docs/guides/editing-pdfs.md",
                None => "not checked",
            }
        );
        let _ = writeln!(
            out,
            "Package format   {}",
            version(self.project.package_format)
        );
        let _ = writeln!(
            out,
            "Schema version   {}",
            version(self.project.schema_version)
        );
        let _ = writeln!(
            out,
            "
(The project's name and location are deliberately not recorded.)"
        );
    }

    fn write_limits(&self, out: &mut String) {
        let limits = &self.limits;
        let _ = writeln!(
            out,
            "
== Limits in force =="
        );
        let _ = writeln!(out, "Role                  {:?}", self.role);
        let _ = writeln!(out, "Largest drawing       {} MB", limits.max_pdf_mb);
        let _ = writeln!(out, "Largest attachment    {} MB", limits.max_attachment_mb);
        let _ = writeln!(out, "Largest package       {} MB", limits.max_package_mb);
        let _ = writeln!(out, "Pages per document    {}", limits.max_pages);
        let _ = writeln!(out, "Concurrent jobs       {}", limits.max_concurrent_jobs);
        let _ = writeln!(out, "Job timeout           {} s", limits.job_timeout_secs);
    }

    fn write_log(&self, out: &mut String) {
        let _ = writeln!(
            out,
            "
== Recent log ({} lines, redacted) ==",
            self.recent_log.len()
        );
        if self.recent_log.is_empty() {
            let _ = writeln!(out, "(nothing recorded)");
        }
        for line in &self.recent_log {
            let _ = writeln!(out, "{line}");
        }
    }

    fn write_gaps(&self, out: &mut String) {
        if self.gaps.is_empty() {
            return;
        }
        let _ = writeln!(
            out,
            "
== Could not be gathered =="
        );
        for gap in &self.gaps {
            let _ = writeln!(out, "- {gap}");
        }
    }
}

/// How many log lines to carry.
///
/// Enough to cover the session that went wrong, few enough that somebody will actually read them
/// before deciding whether to send the file.
const LOG_LINES: usize = 200;

/// Collect everything, without sending anything.
pub fn collect(app: &tauri::AppHandle, log_path: Option<&std::path::Path>) -> Bundle {
    use tauri::Manager as _;

    let mut gaps = Vec::new();
    let state = app.state::<AppState>();

    let environment = Environment {
        app_version: app.package_info().version.to_string(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        os: std::env::consts::OS.to_owned(),
        os_version: tauri_plugin_os::version().to_string(),
        architecture: std::env::consts::ARCH.to_owned(),
        webview_version: tauri::webview_version().unwrap_or_else(|_| "unknown".to_owned()),
        tauri_version: tauri::VERSION,
        locale: tauri_plugin_os::locale().unwrap_or_else(|| "unknown".to_owned()),
    };

    let project = state
        .with_package(|package| {
            let store = package.store();
            let drawings = package.manifest().sources.len();
            let markups = store
                .project()
                .ok()
                .flatten()
                .and_then(|project| store.source_documents(project.id).ok())
                .map(|documents| {
                    documents
                        .iter()
                        .filter_map(|document| store.revisions_of(document.id).ok())
                        .flatten()
                        .filter_map(|revision| store.markups(revision.id).ok())
                        .map(|list| list.len())
                        .sum::<usize>()
                });
            let audit_entries = store.audit_events().ok().map(|events| events.len());

            Ok::<_, ()>(ProjectFacts {
                open: true,
                package_format: Some(package.manifest().format),
                schema_version: store.schema_version().ok(),
                drawings: Some(drawings),
                markups,
                audit_entries,
                audit_intact: Some(store.verify_audit().is_ok()),
            })
        })
        .and_then(Result::ok)
        .unwrap_or(ProjectFacts {
            open: false,
            package_format: None,
            schema_version: None,
            drawings: None,
            markups: None,
            audit_entries: None,
            audit_intact: None,
        });

    let recent_log = if let Some(path) = log_path {
        std::fs::read_to_string(path).map_or_else(
            |_| {
                gaps.push("the application log could not be read".to_owned());
                Vec::new()
            },
            |contents| {
                contents
                    .lines()
                    .rev()
                    .take(LOG_LINES)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    // Second belt. The logs are written not to contain paths, but a message from
                    // the operating system or a dependency was not written to our rules.
                    .map(sf_audit::redact)
                    .collect()
            },
        )
    } else {
        gaps.push("the application log location is not known on this platform".to_owned());
        Vec::new()
    };

    Bundle {
        generated_at: sf_domain::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        environment,
        project,
        limits: *state.limits(),
        role: state.role(),
        recent_log,
        gaps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_bundle() -> Bundle {
        Bundle {
            generated_at: "2026-08-21T10:00:00Z".into(),
            environment: Environment {
                app_version: "0.1.0".into(),
                build_profile: "release",
                os: "windows".into(),
                os_version: "10.0.26200".into(),
                architecture: "x86_64".into(),
                webview_version: "120.0.0.0".into(),
                tauri_version: "2.11.5",
                locale: "en-GB".into(),
            },
            project: ProjectFacts {
                open: true,
                package_format: Some(1),
                schema_version: Some(1),
                drawings: Some(14),
                markups: Some(320),
                audit_entries: Some(412),
                audit_intact: Some(true),
            },
            limits: sf_security::ResourceLimits::default(),
            role: sf_security::Role::Owner,
            recent_log: vec![
                "[INFO] SheetForge 0.1.0 started".into(),
                "[ERROR] failed to open <path>".into(),
            ],
            gaps: vec![],
        }
    }

    #[test]
    fn it_reports_counts_rather_than_contents() {
        let text = a_bundle().to_readable();
        assert!(text.contains("14"), "the number of drawings is useful");
        assert!(text.contains("320"));
        assert!(text.contains("intact"));
        // The whole point: a support bundle a client could object to being sent is a bundle that
        // does not get sent.
        assert!(text.contains("deliberately not recorded"));
    }

    #[test]
    fn it_carries_no_path_no_filename_and_no_project_name() {
        let mut bundle = a_bundle();
        bundle.recent_log = vec![
            sf_audit::redact("failed to open C:\\Projects\\Riverside\\A-201.pdf"),
            sf_audit::redact("token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5 rejected"),
        ];
        let text = bundle.to_readable();

        assert!(
            !text.contains(".pdf"),
            "a filename reached the bundle:\n{text}"
        );
        assert!(
            !text.contains("Riverside"),
            "a project name reached the bundle:\n{text}"
        );
        assert!(
            !text.contains("ghp_"),
            "a token reached the bundle:\n{text}"
        );
        assert!(!text.contains(":\\"), "a path reached the bundle:\n{text}");
    }

    #[test]
    fn a_broken_audit_trail_is_stated_plainly() {
        // This is the fact a support conversation most needs, and the one a user most needs to act
        // on. Burying it would be the worst possible place to be tactful.
        let mut bundle = a_bundle();
        bundle.project.audit_intact = Some(false);
        assert!(bundle.to_readable().contains("BROKEN"));
    }

    #[test]
    fn an_absent_section_says_why() {
        // A section that is simply missing reads as a bug in the bundle rather than as a fact
        // about the machine, and sends the reader chasing the wrong thing.
        let mut bundle = a_bundle();
        bundle.recent_log = Vec::new();
        bundle.gaps = vec!["the application log could not be read".to_owned()];
        let text = bundle.to_readable();
        assert!(text.contains("Could not be gathered"));
        assert!(text.contains("could not be read"));
        assert!(text.contains("(nothing recorded)"));
    }

    #[test]
    fn it_says_when_no_project_is_open() {
        let mut bundle = a_bundle();
        bundle.project = ProjectFacts {
            open: false,
            package_format: None,
            schema_version: None,
            drawings: None,
            markups: None,
            audit_entries: None,
            audit_intact: None,
        };
        assert!(bundle.to_readable().contains("No project open."));
    }

    #[test]
    fn it_is_readable_without_a_tool() {
        // If this were JSON nobody would check it before attaching it, which would make it a
        // telemetry upload with extra steps.
        let text = a_bundle().to_readable();
        assert!(text.starts_with("SheetForge diagnostic bundle"));
        assert!(!text.starts_with('{'));
        assert!(text.contains("== Build and machine =="));
        assert!(text.contains("== Limits in force =="));
    }
}
