fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "server_fetch",
        "server_fetch_cancel",
        "handoff_finish",
        "pair",
        "sign_out",
        "notify",
        "open_link",
        "report_tab",
        "list_servers",
        "page_add_server",
        "page_remove_server",
        "rename_server",
        "list_add_server",
        "list_remove_server",
        "open_server",
        "open_all_servers",
        "retry_store_deletion",
        "take_open_failures",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("tauri-build failed");
}
