fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "server_fetch",
            "handoff_finish",
            "pair",
            "sign_out",
            "list_servers",
            "add_server",
            "remove_server",
            "rename_server",
            "open_link",
            "notify",
            "set_notifications",
        ]),
    ))
    .expect("failed to run the Tauri build step");
}
