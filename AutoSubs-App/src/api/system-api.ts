import { invoke } from "@tauri-apps/api/core";

/** Backend log file contents, read in Rust to avoid fs permission issues. */
export async function getBackendLogs(): Promise<string> {
    return invoke<string>("get_backend_logs");
}

export async function openLogDir(): Promise<void> {
    await invoke("open_log_dir");
}
