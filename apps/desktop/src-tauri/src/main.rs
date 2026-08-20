//! The desktop binary. Everything of substance lives in the library, which iOS and Android build
//! against through their own entry points.

// The Windows subsystem directive stops a console window appearing behind the application in
// release builds. It is deliberately not applied in debug builds, where the console is where
// `log` output goes while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sheetforge_lib::run();
}
