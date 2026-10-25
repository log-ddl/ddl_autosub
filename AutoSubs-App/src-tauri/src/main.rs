// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Large flat JSON structures built with serde_json::json!() expand recursively
// per token and need more headroom than the default.
#![recursion_limit = "512"]

use serde_json::json;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri::Emitter; // for app.emit
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

// Import plugins
use tauri_plugin_fs::init as fs_plugin;
use tauri_plugin_http::init as http_plugin;
use tauri_plugin_process::init as process_plugin;
use tauri_plugin_shell::init as shell_plugin;
use tauri_plugin_shell::ShellExt; // for app.shell()
use tauri_plugin_store::Builder as StoreBuilder;
use tauri_plugin_clipboard_manager::init as clipboard_plugin;
use tauri_plugin_opener::init as opener_plugin;
use tauri_plugin_single_instance::init as single_instance_plugin;
use tokio::process::Command as TokioCommand;

mod audio_preprocess;
mod models;
mod transcription_api;
mod transcript_types;
mod logging;
mod bridges;
mod media;
mod process_ext;
mod ai_cli;
mod ai_edit;

use crate::bridges::adobe::bridge as adobe_bridge;
use crate::media::{article, download as media_download, site_session};
use crate::process_ext::HiddenConsole; // keep above the cfg'd items below

// Include integration-like tests that need crate visibility
#[cfg(test)]
mod tests;

// Global guard to avoid re-entrant exit handling
static EXITING: AtomicBool = AtomicBool::new(false);

/// Read the Windows system proxy from the Internet Settings registry key and inject it
/// into the process environment as HTTP_PROXY / HTTPS_PROXY so that HTTP clients that
/// read proxy settings from env vars (ureq used by hf-hub, reqwest) can use the proxy
/// that VPN and proxy software configures via Windows Settings.
///
/// Only runs when the env vars are not already set, so explicit overrides (e.g. from a
/// launch script) are always preserved.
#[cfg(target_os = "windows")]
fn setup_proxy_env() {
    let already_set = std::env::var_os("HTTP_PROXY").is_some()
        || std::env::var_os("HTTPS_PROXY").is_some()
        || std::env::var_os("http_proxy").is_some()
        || std::env::var_os("https_proxy").is_some()
        || std::env::var_os("ALL_PROXY").is_some();
    if already_set {
        return;
    }

    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(ie) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings") else {
        return;
    };

    let enabled: u32 = ie.get_value("ProxyEnable").unwrap_or(0u32);
    if enabled == 0 {
        return;
    }

    let server: String = match ie.get_value("ProxyServer") {
        Ok(s) => s,
        Err(_) => return,
    };
    if server.is_empty() {
        return;
    }

    // ProxyServer is either a bare "host:port" or a semicolon-separated
    // "proto=host:port" list (e.g. "http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:1080").
    let make_url = |addr: &str| -> String {
        if addr.starts_with("http://") || addr.starts_with("https://") || addr.starts_with("socks") {
            addr.to_string()
        } else {
            format!("http://{}", addr)
        }
    };

    // Parse HTTP_PROXY / HTTPS_PROXY from the ProxyServer value.
    // ProxyServer is either a bare "host:port" (applies to all protocols, use as HTTP proxy)
    // or a semicolon-separated "proto=host:port" list. Only map http/https entries —
    // never fall back to socks entries, because reqwest has no SOCKS support in this build
    // and speaking HTTP proxy protocol to a SOCKS listener causes immediate failures.
    let (http_url, https_url) = if server.contains('=') {
        let find = |proto: &str| -> Option<String> {
            server
                .split(';')
                .find(|s| s.to_ascii_lowercase().starts_with(&format!("{}=", proto)))
                .and_then(|s| s.splitn(2, '=').nth(1))
                .map(|addr| make_url(addr))
        };
        // Only use explicitly named http/https entries; skip socks-only configurations.
        let http = find("http");
        let https = find("https").or_else(|| find("http"));
        (http, https)
    } else {
        // Bare "host:port" means use for all protocols including HTTP — this is correct.
        let url = make_url(&server);
        (Some(url.clone()), Some(url))
    };

    if let Some(ref url) = http_url {
        unsafe {
            std::env::set_var("HTTP_PROXY", url);
            std::env::set_var("http_proxy", url);
        }
    }
    if let Some(ref url) = https_url {
        unsafe {
            std::env::set_var("HTTPS_PROXY", url);
            std::env::set_var("https_proxy", url);
        }
    }

    // Build NO_PROXY from the WinINet ProxyOverride list so that local
    // connections (the Premiere bridge on 127.0.0.1:8185, etc.) are never
    // routed through the proxy. Always include loopback addresses even if
    // ProxyOverride is absent; WinINet's "<local>" sentinel is replaced
    // with the canonical addresses that ureq/reqwest understand.
    let existing_no_proxy = std::env::var_os("NO_PROXY")
        .or_else(|| std::env::var_os("no_proxy"))
        .is_some();
    if !existing_no_proxy {
        let mut no_proxy_entries: Vec<String> =
            vec!["127.0.0.1".into(), "localhost".into(), "::1".into()];

        if let Ok(override_val) = ie.get_value::<String, _>("ProxyOverride") {
            for entry in override_val.split(';') {
                let entry = entry.trim();
                if entry.is_empty() || entry.eq_ignore_ascii_case("<local>") {
                    // <local> is already covered by the loopback entries above.
                    continue;
                }
                no_proxy_entries.push(entry.to_string());
            }
        }

        let no_proxy = no_proxy_entries.join(",");
        unsafe {
            std::env::set_var("NO_PROXY", &no_proxy);
            std::env::set_var("no_proxy", &no_proxy);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn setup_proxy_env() {}


/// Build the main GUI window programmatically.
///
/// The window is not declared in `tauri.conf.json` so its macOS title bar can be
/// set up here. It starts hidden and is shown later (after the macOS
/// traffic-light positioner is installed).
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    #[allow(unused_mut)]
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("AutoSubs")
            .inner_size(850.0, 850.0)
            .decorations(true)
            .accept_first_mouse(true)
            .visible(false);

    #[cfg(target_os = "macos")]
    {
        // Empty native title for the overlay title bar (no centered text), set
        // at creation so we don't need a post-creation set_title that would
        // trigger an AppKit relayout. Traffic-light position is left to Tauri's
        // built-in `traffic_light_position`.
        builder = builder
            .title("")
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(16.0_f64, 25.0_f64));
    }

    // `zoom_hotkeys_enabled` is only available off macOS without the
    // `macos-private-api` feature; matches the old config's `zoomHotkeysEnabled`.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.zoom_hotkeys_enabled(true);
    }

    builder.build()
}

fn main() {
    // Inject system proxy env vars before any thread or HTTP client is created so
    // that both ureq (hf-hub) and reqwest pick up the Windows system proxy set by
    // VPN software via WinINet.
    setup_proxy_env();

    // Route whisper.cpp C-side logs through Rust's tracing system so they can be
    // filtered rather than being dumped raw to stderr.
    transcription_engine::install_logging_hooks();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(StoreBuilder::default().build())
        // Register each plugin
        .plugin(http_plugin())
        .plugin(fs_plugin())
        .plugin(process_plugin())
        // Self-update. Signature verification against the pubkey in
        // tauri.conf.json is what makes downloading and running an installer
        // from the internet safe, so the key there is not optional.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(shell_plugin())
        .plugin(clipboard_plugin())
        .plugin(opener_plugin())
        .plugin(single_instance_plugin(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            let _ = app.get_webview_window("main").map(|w| w.set_focus());
        }))
        .setup(move |app| {
            // Initialize backend logging (file + in-memory ring buffer). Logs go to
            // the log file only, never stdout/stderr.
            crate::logging::init_logging(&app.handle());

            // Create the main window programmatically (see create_main_window).
            create_main_window(app.handle())?;

            crate::bridges::adobe::bridge::init_adobe_server(app.handle().clone());

            // Set window title to "AutoSubs" on Windows and Linux for taskbar display
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("AutoSubs");
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            // Startup sidecar health check: ffmpeg availability & version
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut ffmpeg_ok = false;
                    let mut ffmpeg_version = String::new();

                    // ffmpeg -version (sidecar first, then system fallback)
                    match app_handle.shell().sidecar("ffmpeg") {
                        Ok(cmd) => {
                            match cmd.args(["-version"]).output().await {
                                Ok(out) if out.status.success() => {
                                    ffmpeg_ok = true;
                                    let stdout = String::from_utf8_lossy(&out.stdout);
                                    ffmpeg_version = stdout.lines().next().unwrap_or("").to_string();
                                    tracing::info!("ffmpeg check (sidecar): ok=true, version=\"{}\"", ffmpeg_version);
                                }
                                Ok(out) => {
                                    let stderr = String::from_utf8_lossy(&out.stderr);
                                    tracing::warn!("ffmpeg sidecar -version exited non-zero. stderr: {}", stderr);
                                    // fallback to system
                                    if let Ok(sys) = TokioCommand::new("ffmpeg").arg("-version").hidden().output().await {
                                        ffmpeg_ok = sys.status.success();
                                        let stdout = String::from_utf8_lossy(&sys.stdout);
                                        ffmpeg_version = stdout.lines().next().unwrap_or("").to_string();
                                        tracing::info!("ffmpeg check (system): ok={}, version=\"{}\"", ffmpeg_ok, ffmpeg_version);
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("ffmpeg sidecar execution failed: {:?}", e);
                                    if let Ok(sys) = TokioCommand::new("ffmpeg").arg("-version").hidden().output().await {
                                        ffmpeg_ok = sys.status.success();
                                        let stdout = String::from_utf8_lossy(&sys.stdout);
                                        ffmpeg_version = stdout.lines().next().unwrap_or("").to_string();
                                        tracing::info!("ffmpeg check (system): ok={}, version=\"{}\"", ffmpeg_ok, ffmpeg_version);
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("ffmpeg sidecar not found/failed to init: {:?}", e);
                            if let Ok(sys) = TokioCommand::new("ffmpeg").arg("-version").hidden().output().await {
                                ffmpeg_ok = sys.status.success();
                                let stdout = String::from_utf8_lossy(&sys.stdout);
                                ffmpeg_version = stdout.lines().next().unwrap_or("").to_string();
                                tracing::info!("ffmpeg check (system): ok={}, version=\"{}\"", ffmpeg_ok, ffmpeg_version);
                            }
                        }
                    }

                    // Emit an event to frontend so users can access diagnostics quickly
                    let payload = json!({
                        "ffmpeg_ok": ffmpeg_ok,
                        "ffmpeg_version": ffmpeg_version,
                    });
                    let _ = app_handle.emit("sidecar-health", payload);

                    if !ffmpeg_ok {
                        tracing::warn!("One or more sidecars appear unavailable. On Windows, AV or SmartScreen may block sidecars; try 'Open Logs Folder' for details.");
                    }
                });
            }

            ai_edit::mcp::start(app.handle().clone());
            ai_edit::mcp::external::start(app.handle());
            tauri::async_runtime::spawn(media::remotion::prepare(app.handle().clone()));


            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transcription_api::transcribe_audio,
            transcription_api::ensure_models,
            transcription_api::cancel_transcription,
            transcription_api::reformat_subtitles,
            models::get_downloaded_models,
            models::delete_model,
            logging::get_backend_logs,
            logging::clear_backend_logs,
            logging::get_log_dir,
            logging::export_backend_logs,
            logging::open_log_dir,
            adobe_bridge::send_to_adobe,
            ai_edit::actions::ai_edit_execute_action,
            ai_edit::actions::ai_edit_get_timeline,
            ai_cli::runtime::cli_get_status,
            ai_cli::runtime::cli_get_models,
            ai_cli::workspace::cli_ensure_workspace,
            ai_edit::mcp::external::external_agent_status,
            ai_edit::mcp::external::external_agent_set_enabled,
            ai_edit::mcp::external::external_agent_set_home,
            ai_edit::mcp::external::external_agent_set_target,
            ai_edit::mcp::external::external_agent_connect,
            ai_edit::mcp::external::external_agent_open_app,
            ai_cli::workspace::cli_save_memory,
            ai_cli::workspace::cli_copy_asset,
            ai_cli::workspace::cli_import_skills,
            ai_cli::workspace::cli_list_workspace_projects,
            ai_cli::workspace::cli_delete_workspace_project,
            ai_cli::chat::cli_run_text_task,
            ai_cli::chat::cli_cancel_text_task,
            ai_cli::preview::preview_start,
            ai_cli::preview::preview_stop,
            ai_cli::preview::preview_logs,
            ai_cli::preview::preview_candidates,
            audio_preprocess::extract_audio_peaks,
            media_download::media_download_status,
            media_download::media_download_install,
            media_download::media_download_update,
            media_download::media_download_version_check,
            media_download::media_download_analyze,
            media_download::media_download_start,
            media_download::media_download_cancel,
            site_session::site_session_sites,
            site_session::site_session_login,
            article::article_snapshot
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(move |app, event| {
            match event {
                RunEvent::Ready => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        for delay_ms in [100_u64, 500, 1200] {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    });
                }
                RunEvent::ExitRequested { api, code, .. } => {
                    if code == Some(tauri::RESTART_EXIT_CODE) {
                        return;
                    }

                    // If we're already exiting, don't intercept again; allow exit to proceed
                    if EXITING.swap(true, AtomicOrdering::SeqCst) {
                        return;
                    }

                    // keep the app alive long enough to send the shutdown signal
                    api.prevent_exit();

                    // Proactively cancel any active long-running tasks (e.g., transcription)
                    if let Ok(mut should_cancel) = crate::transcription_api::SHOULD_CANCEL.lock() {
                        *should_cancel = true;
                    }

                    // A preview dev server is a separate process tree; don't orphan it.
                    crate::ai_cli::preview::shutdown();

                    #[cfg(target_os = "windows")]
                    {
                        app.exit(0);

                        // last resort hard exit after a grace period
                        std::thread::spawn(|| {
                            std::thread::sleep(Duration::from_millis(1200));
                            std::process::exit(0);
                        });
                    }

                    #[cfg(not(target_os = "windows"))]
                    {
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            app_handle.exit(0);
                        });
                    }
                }
                RunEvent::WindowEvent { event, .. } => {
                    // Ensure clicking the window close (X) reliably routes through ExitRequested
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if !EXITING.load(AtomicOrdering::SeqCst) {
                            app.exit(0);
                        }
                    }
                }
                _ => {}
            }
        });
}
