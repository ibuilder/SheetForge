//! # SheetForge desktop shell
//!
//! The Tauri host. Its job is to own the things a webview must never own — the filesystem, the
//! project database, the native dialogs, the update channel — and to expose a small, named set of
//! commands that the interface may call.
//!
//! ## The boundary
//!
//! There is no generic bridge command, no `fs` plugin, no shell access, and no command that takes a
//! path. Everything the renderer can do is enumerated in [`commands`] and gated by the capability
//! files under `capabilities/`. The renderer is treated as untrusted even though it is loaded from
//! bundled assets: an XSS in a PDF-adjacent interface is a realistic bug, and the blast radius of
//! one should be "they can do what the user could do in the interface", not "they can read the
//! disk".
//!
//! ## Mobile
//!
//! iOS and Android build from this same library through `tauri::mobile_entry_point`. The
//! differences that matter are handled where they arise rather than by forking the shell: mobile
//! has no window state to persist, and its file pickers are system document providers, which the
//! dialog plugin already abstracts.

pub mod commands;
pub mod error;
pub mod state;

use state::AppState;
use tauri::Manager;

/// Build and run the application.
///
/// # Panics
/// If Tauri cannot construct the application — a missing bundled asset or an invalid
/// `tauri.conf.json`, both of which are build-time faults rather than runtime conditions.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Logs go to the OS log directory and to stdout in development. They carry no
                // document content, no markup text and no paths — see `sf_audit::redact`, which
                // every message built from an OS error passes through.
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        // Opens a URL in the *system* browser rather than in a webview. A drawing can contain a
        // hyperlink, and following one inside the application would let a document navigate the
        // interface. The capability file restricts this to http and https.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState::new());
            #[cfg(desktop)]
            {
                // Signed, checked updates. The public key lives in `tauri.conf.json`; the private
                // half never leaves the release infrastructure. An unsigned or mis-signed update
                // fails verification and is discarded rather than applied.
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            log::info!("SheetForge {} started", app.package_info().version);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::project_create,
            commands::project_open,
            commands::project_current,
            commands::project_close,
            commands::project_verify,
            commands::document_import,
            commands::document_list,
            commands::document_bytes,
            commands::markup_list,
            commands::markup_create,
            commands::markup_update,
            commands::markup_delete,
            commands::calibration_set,
            commands::calibration_get,
            commands::status_counts,
            commands::audit_list,
            commands::export_save,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start SheetForge");
}
