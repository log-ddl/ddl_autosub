//! CLI Runtime & Model Discovery (`agy` Antigravity CLI & `claude` Claude Code CLI).
//!
//! Handles PATH construction, binary location, version health checks, and dynamic
//! model list discovery for `agy` and `claude`.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const STATIC_AGY_MODELS: &[&str] = &[
    "gemini-4-argon-high",
    "gemini-4-argon-medium",
    "gemini-4-argon-low",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "claude-opus-5-5-high",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-low",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-low",
    "gpt-oss-120b-medium",
];

const STATIC_CLAUDE_MODELS: &[&str] = &[
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "claude-sonnet-5-5",
    "claude-sonnet-5-5[1m]",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
];

const COMMON_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatusInfo {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRuntimeStatus {
    pub agy: CliStatusInfo,
    pub claude: CliStatusInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModelsResult {
    pub models: Vec<String>,
    pub efforts: Vec<String>,
    pub efforts_by_model: HashMap<String, Vec<String>>,
    pub error: Option<String>,
}

pub fn build_cli_path_env() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/Shared"));
    let mut entries: Vec<String> = Vec::new();
    if let Ok(existing) = std::env::var("PATH") {
        entries.push(existing);
    }

    let extra = [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
        home.join(".antigravity/bin"),
        home.join(".gemini/antigravity/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".claude/bin"),
        home.join(".claude/local"),
        home.join("Library/pnpm"),
    ];
    for p in extra {
        entries.push(p.to_string_lossy().into_owned());
    }

    let nvm_dir = home.join(".nvm/versions/node");
    if let Ok(rd) = fs::read_dir(nvm_dir) {
        for entry in rd.flatten() {
            let bin = entry.path().join("bin");
            if bin.is_dir() {
                entries.push(bin.to_string_lossy().into_owned());
            }
        }
    }

    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    entries.join(sep)
}

pub fn detect_cli_path(command: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let mut candidates = vec![
        home.join(".local/bin").join(command),
        home.join(".antigravity/bin").join(command),
        home.join(".gemini/antigravity/bin").join(command),
        home.join(".claude/bin").join(command),
        home.join(".claude/local").join(command),
        home.join(".bun/bin").join(command),
        PathBuf::from("/opt/homebrew/bin").join(command),
        PathBuf::from("/usr/local/bin").join(command),
    ];

    #[cfg(target_os = "macos")]
    if command == "agy" {
        candidates.push(PathBuf::from(
            "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Antigravity.app/Contents/MacOS/agy",
        ));
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(out) = Command::new("/bin/zsh")
            .args(["-lic", &format!("command -v {}", command)])
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(last) = text.lines().rev().find(|l| !l.trim().is_empty()) {
                    let p = PathBuf::from(last.trim());
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }

    None
}

fn check_single_cli(command: &str) -> CliStatusInfo {
    let Some(bin) = detect_cli_path(command) else {
        return CliStatusInfo {
            available: false,
            version: None,
            error: Some(format!("{} not found in PATH", command)),
            path: None,
        };
    };

    let path_str = bin.to_string_lossy().into_owned();
    match Command::new(&bin)
        .arg("--version")
        .env("PATH", build_cli_path_env())
        .output()
    {
        Ok(out) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let first_line = combined
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|s| s.trim().to_string());
            if out.status.success() {
                CliStatusInfo {
                    available: true,
                    version: first_line.or_else(|| Some("OK".to_string())),
                    error: None,
                    path: Some(path_str),
                }
            } else {
                CliStatusInfo {
                    available: false,
                    version: None,
                    error: first_line.or_else(|| Some(format!("{} exited with error", command))),
                    path: Some(path_str),
                }
            }
        }
        Err(e) => CliStatusInfo {
            available: false,
            version: None,
            error: Some(e.to_string()),
            path: Some(path_str),
        },
    }
}

#[tauri::command]
pub async fn cli_get_status() -> Result<CliRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let agy = check_single_cli("agy");
        let claude = check_single_cli("claude");
        Ok(CliRuntimeStatus { agy, claude })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&'[') {
                let _ = chars.next();
                while let Some(&c) = chars.peek() {
                    let _ = chars.next();
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn discover_agy_models() -> Vec<String> {
    static CACHE: OnceLock<Mutex<Option<Vec<String>>>> = OnceLock::new();
    let mutex = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = mutex.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }

    let mut discovered: Vec<String> = Vec::new();
    if let Some(bin) = detect_cli_path("agy") {
        if let Ok(out) = Command::new(bin)
            .arg("models")
            .env("PATH", build_cli_path_env())
            .output()
        {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout);
                let clean = strip_ansi_codes(&raw);
                for line in clean.lines() {
                    let token = line.trim();
                    if (token.starts_with("gemini-")
                        || token.starts_with("claude-")
                        || token.starts_with("gpt-"))
                        && !token.contains(' ')
                        && !discovered.iter().any(|m| m == token)
                    {
                        discovered.push(token.to_string());
                    }
                }
            }
        }
    }

    if discovered.is_empty() {
        discovered = STATIC_AGY_MODELS.iter().map(|s| s.to_string()).collect();
    } else if let Ok(mut guard) = mutex.lock() {
        *guard = Some(discovered.clone());
    }

    discovered
}

fn is_clean_claude_model_id(s: &str) -> bool {
    if !(s.starts_with("claude-opus-")
        || s.starts_with("claude-sonnet-")
        || s.starts_with("claude-haiku-"))
    {
        return false;
    }
    if s.len() > 36
        || s.contains('@')
        || s.contains(':')
        || s.contains(' ')
        || s.ends_with('-')
        || s.ends_with("-v1")
    {
        return false;
    }
    if s.contains("-3-") || s.contains("-4-0") || s.contains("-4-1") || s.ends_with("-4") {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '[' || c == ']')
}

fn discover_claude_models() -> Vec<String> {
    static CACHE: OnceLock<Mutex<Option<Vec<String>>>> = OnceLock::new();
    let mutex = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = mutex.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }

    let mut models: Vec<String> = STATIC_CLAUDE_MODELS.iter().map(|s| s.to_string()).collect();

    if let Some(home) = dirs::home_dir() {
        let settings_path = home.join(".claude/settings.json");
        if let Ok(text) = fs::read_to_string(settings_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                if let Some(m) = val.get("model").and_then(|v| v.as_str()) {
                    let trimmed = m.trim();
                    if !trimmed.is_empty() && !models.iter().any(|x| x == trimmed) {
                        models.insert(0, trimmed.to_string());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(bin) = detect_cli_path("claude") {
        let resolved = fs::canonicalize(&bin).unwrap_or(bin);
        if let Ok(out) = Command::new("/usr/bin/strings").arg(&resolved).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if is_clean_claude_model_id(trimmed) && !models.iter().any(|x| x == trimmed) {
                        models.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    if let Ok(mut guard) = mutex.lock() {
        *guard = Some(models.clone());
    }

    models
}

#[tauri::command]
pub async fn cli_get_models(adapter: String) -> Result<CliModelsResult, String> {
    tauri::async_runtime::spawn_blocking(move || match adapter.as_str() {
        "agy" => Ok(CliModelsResult {
            models: discover_agy_models(),
            efforts: COMMON_EFFORTS.iter().map(|s| s.to_string()).collect(),
            efforts_by_model: HashMap::new(),
            error: None,
        }),
        "claude" => Ok(CliModelsResult {
            models: discover_claude_models(),
            efforts: COMMON_EFFORTS.iter().map(|s| s.to_string()).collect(),
            efforts_by_model: HashMap::new(),
            error: None,
        }),
        other => Err(format!("Unsupported CLI adapter: {}", other)),
    })
    .await
    .map_err(|e| e.to_string())?
}
