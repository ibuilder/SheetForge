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
pub mod diagnostics;
pub mod error;
pub mod recent;
pub mod state;

use state::AppState;
use tauri::{Emitter, Manager};

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
            // Drag-and-drop, handled entirely on this side.
            //
            // The drop is a *window* event: Tauri delivers the paths to Rust, and the webview is
            // told only that drawings arrived. That is what lets this exist at all without moving
            // the boundary — the rule is that the renderer never names a file, not that files can
            // never be dropped.
            let version = app.package_info().version.to_string();
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) =
                        event
                    else {
                        return;
                    };
                    // Only PDFs. Dropping a folder or a spreadsheet on the window is a mistake, not
                    // a request, and silently ignoring the rest beats an error for each one.
                    let drawings: Vec<_> = paths
                        .iter()
                        .filter(|path| {
                            path.extension()
                                .and_then(|e| e.to_str())
                                .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
                        })
                        .cloned()
                        .collect();
                    if drawings.is_empty() {
                        return;
                    }

                    let handle = handle.clone();
                    let version = version.clone();
                    // Off the event thread: importing hashes and copies files, and blocking here
                    // freezes the window while it happens.
                    tauri::async_runtime::spawn_blocking(move || {
                        let payload = match commands::import_paths(&handle, &drawings, &version) {
                            Ok(opened) => serde_json::json!({ "opened": opened }),
                            Err(error) => serde_json::json!({ "error": error }),
                        };
                        if let Err(error) = handle.emit("sheetforge://dropped", payload) {
                            log::error!("could not report a drop to the interface: {error}");
                        }
                    });
                });
            }

            log::info!("SheetForge {} started", app.package_info().version);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::project_create,
            commands::project_open,
            commands::recent_list,
            commands::recent_open,
            commands::recent_forget,
            commands::project_current,
            commands::project_close,
            commands::project_verify,
            commands::pdf_open,
            commands::tutorial_open,
            commands::document_import,
            commands::document_derive,
            commands::document_list,
            commands::document_bytes,
            commands::markup_list,
            commands::markup_create,
            commands::markup_create_many,
            commands::markup_update,
            commands::markup_delete,
            commands::calibration_set,
            commands::calibration_get,
            commands::status_counts,
            commands::audit_list,
            commands::export_save,
            commands::diagnostics_save,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start SheetForge");
}
