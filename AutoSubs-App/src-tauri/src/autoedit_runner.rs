use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// Emitted for every line the script prints on stdout or stderr.
// The frontend appends these to the on-screen log.
#[derive(Clone, Serialize)]
struct OutputEvent {
    stream: &'static str, // "stdout" | "stderr"
    line: String,
}

// Emitted once the child process has exited (or failed to start).
#[derive(Clone, Serialize)]
struct DoneEvent {
    exit_code: Option<i32>,
    error: Option<String>,
}

const EVENT_OUTPUT: &str = "autoedit-runner-output";
const EVENT_DONE: &str = "autoedit-runner-done";

// Directory holding our stand-in `DaVinciResolveScript.py`, which proxies the
// Resolve API over HTTP to the AutoSubs Lua server running inside Resolve.
//
// We deliberately do NOT use Resolve's own scripting module here: the free
// edition of Resolve refuses out-of-process scripting connections outright
// (`scriptapp("Resolve")` returns None regardless of environment), so talking
// to the in-Resolve bridge is the only path that works for every edition.
fn shim_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/autoedit-shim", BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate the AutoEdit Python shim: {}", e))
}

// Locate the Python interpreter to use. Prefers the runtime downloaded on
// demand into the app data dir (see autoedit_python.rs), which side-steps
// Microsoft Store Python sandboxing and version drift on the user's system.
// Falls back to `python3`/`python` on PATH so developer setups without a
// downloaded runtime still work.
fn python_executable(app: &AppHandle) -> PathBuf {
    if let Ok(runtime) = crate::autoedit_python::python_binary(app) {
        if runtime.exists() {
            return runtime;
        }
    }
    #[cfg(target_os = "windows")]
    {
        PathBuf::from("python")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("python3")
    }
}

// Spawn `python <script>` with the Resolve scripting env vars wired up, then
// stream stdout/stderr back to the frontend as events. Returns as soon as the
// process has been spawned; completion is signalled via `EVENT_DONE`.
#[tauri::command]
pub async fn run_python_script(app: AppHandle, script_path: String) -> Result<(), String> {
    if !Path::new(&script_path).exists() {
        return Err(format!("Script not found: {}", script_path));
    }

    let shim = shim_dir(&app)?;
    if !shim.exists() {
        return Err(format!(
            "AutoEdit Python shim is missing from {}",
            shim.display()
        ));
    }

    // Clear object handles held from the previous run so a long session
    // doesn't accumulate them inside Resolve. A failure here is not fatal —
    // Resolve may simply not be running yet, which the script itself reports.
    let _ = crate::resolve_bridge::send_resolve_payload(
        serde_json::json!({ "func": "ResetResolveRpc" }),
        std::time::Duration::from_secs(5),
    )
    .await;

    // Prepend our shim dir so `import DaVinciResolveScript` picks up the
    // bridge-backed module rather than anything else on the path.
    let pythonpath = match std::env::var_os("PYTHONPATH") {
        Some(existing) => {
            let mut parts = vec![shim.clone().into_os_string()];
            parts.push(existing);
            std::env::join_paths(parts).map_err(|e| e.to_string())?
        }
        None => shim.clone().into_os_string(),
    };

    let python = python_executable(&app);
    let mut cmd = Command::new(&python);
    cmd.arg("-u") // unbuffered so we get live output
        .arg(&script_path)
        .env("PYTHONPATH", &pythonpath)
        // Python pipes default to the OS locale encoding on Windows (cp1252
        // here), so a script printing anything non-Latin-1 would die with
        // UnicodeEncodeError. We read the pipes as UTF-8 on this end.
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch {} — is Python installed and on PATH? ({})",
            python.display(),
            e
        )
    })?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let out_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = out_app.emit(
                EVENT_OUTPUT,
                OutputEvent {
                    stream: "stdout",
                    line,
                },
            );
        }
    });

    let err_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = err_app.emit(
                EVENT_OUTPUT,
                OutputEvent {
                    stream: "stderr",
                    line,
                },
            );
        }
    });

    let done_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        let event = match status {
            Ok(s) => DoneEvent {
                exit_code: s.code(),
                error: None,
            },
            Err(e) => DoneEvent {
                exit_code: None,
                error: Some(e.to_string()),
            },
        };
        let _ = done_app.emit(EVENT_DONE, event);
    });

    Ok(())
}
