import { invoke } from "@tauri-apps/api/core";

/** Backend log file contents, read in Rust to avoid fs permission issues. */
export async function getBackendLogs(): Promise<string> {
    return invoke<string>("get_backend_logs");
}

export async function openLogDir(): Promise<void> {
    await invoke("open_log_dir");
}

/** The `autosubs` command on PATH, managed per-platform by the backend. */
export interface CliCommandStatus {
    installed: boolean;
    manageable: boolean;
    location: string | null;
    note: string | null;
}

export async function getCliCommandStatus(): Promise<CliCommandStatus> {
    return invoke<CliCommandStatus>("cli_command_status");
}

export async function installCliCommand(): Promise<CliCommandStatus> {
    return invoke<CliCommandStatus>("install_cli_command");
}

export async function uninstallCliCommand(): Promise<CliCommandStatus> {
    return invoke<CliCommandStatus>("uninstall_cli_command");
}
