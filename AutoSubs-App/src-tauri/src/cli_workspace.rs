//! 2-Tier Workspace & Project Asset Management for AI Video Director (`AI EDIT`).
//!
//! Tier A (Global Library): `<app_data_dir>/ai-director-workspace/`
//!   ├── `global-memory.md`
//!   └── `templates/motion-graphics/`
//!
//! Tier B (Per-Project Folder): `<base>/projects/<project-slug>/`
//!   ├── `memory.md`
//!   ├── `visual-plan.json`
//!   ├── `motion-graphics/`
//!   ├── `ai-broll/`
//!   └── `exports/`

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetItem {
    pub name: String,
    pub path: String,
    pub category: String, // "motion-graphics" | "ai-broll" | "exports" | "templates"
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_sec: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub global_path: String,
    pub project_slug: String,
    pub memory: String,
    pub global_memory: String,
    pub motion_graphics_dir: String,
    pub ai_broll_dir: String,
    pub exports_dir: String,
    pub templates_dir: String,
    pub assets: Vec<ProjectAssetItem>,
}

fn sanitize_project_slug(raw: Option<&str>) -> String {
    let Some(name) = raw.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return "default-project".to_string();
    };
    let mut slug = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch);
        } else if ch.is_whitespace() || ch == '.' || ch == '/' || ch == '\\' {
            if !slug.ends_with('-') {
                slug.push('-');
            }
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "default-project".to_string()
    } else {
        trimmed
    }
}

pub fn global_workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai-director-workspace");
    Ok(base)
}

pub fn resolve_workspace_dir(
    app: &AppHandle,
    candidate: Option<&str>,
    project_name: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(c) = candidate {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let global_root = global_workspace_root(app)?;
    let slug = sanitize_project_slug(project_name);
    Ok(global_root.join("projects").join(slug))
}

fn scan_category_dir(dir: &Path, category: &str, out: &mut Vec<ProjectAssetItem>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified_sec = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(ProjectAssetItem {
            name,
            path: path.to_string_lossy().into_owned(),
            category: category.to_string(),
            is_dir: meta.is_dir(),
            size_bytes: meta.len(),
            modified_sec,
        });
    }
}

pub fn build_workspace_info(
    app: &AppHandle,
    workspace_path: Option<&str>,
    project_name: Option<&str>,
) -> Result<WorkspaceInfo, String> {
    let global_dir = global_workspace_root(app)?;
    let templates_dir = global_dir.join("templates").join("motion-graphics");
    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create global templates dir: {}", e))?;

    let global_mem_path = global_dir.join("global-memory.md");
    if !global_mem_path.exists() {
        let _ = fs::write(&global_mem_path, "");
    }
    let global_memory = fs::read_to_string(&global_mem_path).unwrap_or_default();

    let project_slug = sanitize_project_slug(project_name);
    let dir = resolve_workspace_dir(app, workspace_path, project_name)?;
    let mg_dir = dir.join("motion-graphics");
    let broll_dir = dir.join("ai-broll");
    let exports_dir = dir.join("exports");

    for sub in [&dir, &mg_dir, &broll_dir, &exports_dir] {
        fs::create_dir_all(sub)
            .map_err(|e| format!("Failed to create directory {}: {}", sub.display(), e))?;
    }

    let mem_path = dir.join("memory.md");
    if !mem_path.exists() {
        let _ = fs::write(&mem_path, "");
    }
    let memory = fs::read_to_string(&mem_path).unwrap_or_default();

    let mut assets = Vec::new();
    scan_category_dir(&mg_dir, "motion-graphics", &mut assets);
    scan_category_dir(&broll_dir, "ai-broll", &mut assets);
    scan_category_dir(&exports_dir, "exports", &mut assets);
    scan_category_dir(&templates_dir, "templates", &mut assets);
    assets.sort_by(|a, b| b.modified_sec.cmp(&a.modified_sec));

    Ok(WorkspaceInfo {
        path: dir.to_string_lossy().into_owned(),
        global_path: global_dir.to_string_lossy().into_owned(),
        project_slug,
        memory,
        global_memory,
        motion_graphics_dir: mg_dir.to_string_lossy().into_owned(),
        ai_broll_dir: broll_dir.to_string_lossy().into_owned(),
        exports_dir: exports_dir.to_string_lossy().into_owned(),
        templates_dir: templates_dir.to_string_lossy().into_owned(),
        assets,
    })
}

#[tauri::command]
pub async fn cli_ensure_workspace(
    app: AppHandle,
    workspace_path: Option<String>,
    project_name: Option<String>,
) -> Result<WorkspaceInfo, String> {
    build_workspace_info(&app, workspace_path.as_deref(), project_name.as_deref())
}

#[tauri::command]
pub async fn cli_save_memory(
    app: AppHandle,
    workspace_path: Option<String>,
    project_name: Option<String>,
    content: String,
    global_content: Option<String>,
) -> Result<WorkspaceInfo, String> {
    let info = build_workspace_info(&app, workspace_path.as_deref(), project_name.as_deref())?;
    let mem_path = PathBuf::from(&info.path).join("memory.md");
    fs::write(&mem_path, &content).map_err(|e| format!("Failed to write memory.md: {}", e))?;

    if let Some(g_text) = global_content {
        let global_mem_path = PathBuf::from(&info.global_path).join("global-memory.md");
        fs::write(&global_mem_path, &g_text)
            .map_err(|e| format!("Failed to write global-memory.md: {}", e))?;
    }

    build_workspace_info(&app, workspace_path.as_deref(), project_name.as_deref())
}
