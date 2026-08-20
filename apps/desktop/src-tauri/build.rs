//! Generates the Tauri context: bundles the frontend assets, compiles the capability files into
//! the access-control list, and emits the Windows resource block.

fn main() {
    tauri_build::build();
}
