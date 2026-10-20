//! 2-Tier Workspace & Project Asset Management for AI Video Director (`AI EDIT`).
//!
//! Tier A (Global Library): `<app_data_dir>/ai-director-workspace/`
//!   ├── `global-memory.md`
//!   └── `templates/motion-graphics/`
//!
//! Tier B (Per-Project Folder): `<base>/projects/<editor>/<project-slug>[-<id hash>]/`
//!   One folder per editor project (DaVinci project, Premiere `.prproj`, CapCut
//!   draft), never shared: templates are the only thing projects share, and
//!   only when the user saves one there.
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

/// The editor project a workspace belongs to. `id` tells apart projects that
/// share a name (Resolve project id, `.prproj` path, CapCut draft id).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub editor: Option<String>,
    pub name: Option<String>,
    pub id: Option<String>,
    /// Timeline / sequence name, which older builds keyed folders by
    /// (`projects/<slug>`); that folder moves into this project's on first use.
    pub legacy_name: Option<String>,
}

fn sanitize_slug(raw: Option<&str>, fallback: &str) -> String {
    let Some(name) = raw.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return fallback.to_string();
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
        fallback.to_string()
    } else {
        trimmed
    }
}

/// Stable short hash (FNV-1a), so a folder name never changes between runs.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", h as u32)
}

/// `<editor>/<name>` or `<editor>/<name>-<hash of id>`, relative to `projects/`.
fn project_rel_dir(project: Option<&WorkspaceProject>) -> (PathBuf, String) {
    let p = project.cloned().unwrap_or_default();
    let editor = sanitize_slug(p.editor.as_deref(), "standalone");
    let name = sanitize_slug(p.name.as_deref(), "untitled");
    let id = p.id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let folder = match id {
        Some(id) if Some(id) != p.name.as_deref().map(str::trim) => {
            format!("{name}-{}", short_hash(id))
        }
        _ => name.clone(),
    };
    (PathBuf::from(editor).join(folder), name)
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
    project: Option<&WorkspaceProject>,
) -> Result<PathBuf, String> {
    if let Some(c) = candidate {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let projects = global_workspace_root(app)?.join("projects");
    let dir = projects.join(project_rel_dir(project).0);
    adopt_legacy_dir(&projects, project, &dir);
    Ok(dir)
}

/// Folder names under `projects/` that belong to the current layout.
const EDITOR_DIRS: &[&str] = &["davinci", "premiere", "capcut", "standalone"];

/// True when `dir` holds no file with content (fresh folders only have empty
/// subfolders and an empty memory.md).
fn has_no_content(dir: &Path) -> bool {
    let Ok(rd) = fs::read_dir(dir) else { return true };
    rd.flatten().all(|e| {
        let p = e.path();
        if p.is_dir() {
            has_no_content(&p)
        } else {
            e.metadata().map(|m| m.len() == 0).unwrap_or(true)
        }
    })
}

/// Moves `projects/<legacy slug>` (the old per-timeline folder) into `dir`,
/// unless `dir` already has content of its own. Best effort: on failure the
/// old folder simply stays where it is.
fn adopt_legacy_dir(projects: &Path, project: Option<&WorkspaceProject>, dir: &Path) {
    let Some(legacy) = project.and_then(|p| p.legacy_name.as_deref()) else { return };
    if legacy.trim().is_empty() {
        return;
    }
    let slug = sanitize_slug(Some(legacy), "");
    if slug.is_empty() || EDITOR_DIRS.contains(&slug.as_str()) {
        return;
    }
    let old = projects.join(&slug);
    if !old.is_dir() || !has_no_content(dir) {
        return;
    }
    if dir.exists() && fs::remove_dir_all(dir).is_err() {
        return;
    }
    if let Some(parent) = dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::rename(&old, dir) {
        tracing::warn!("Could not move legacy AI workspace {}: {}", old.display(), e);
    }
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
    project: Option<&WorkspaceProject>,
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

    let project_slug = project_rel_dir(project).1;
    let dir = resolve_workspace_dir(app, workspace_path, project)?;
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
    project: Option<WorkspaceProject>,
) -> Result<WorkspaceInfo, String> {
    build_workspace_info(&app, workspace_path.as_deref(), project.as_ref())
}

#[tauri::command]
pub async fn cli_save_memory(
    app: AppHandle,
    workspace_path: Option<String>,
    project: Option<WorkspaceProject>,
    content: String,
    global_content: Option<String>,
) -> Result<WorkspaceInfo, String> {
    let info = build_workspace_info(&app, workspace_path.as_deref(), project.as_ref())?;
    let mem_path = PathBuf::from(&info.path).join("memory.md");
    fs::write(&mem_path, &content).map_err(|e| format!("Failed to write memory.md: {}", e))?;

    if let Some(g_text) = global_content {
        let global_mem_path = PathBuf::from(&info.global_path).join("global-memory.md");
        fs::write(&global_mem_path, &g_text)
            .map_err(|e| format!("Failed to write global-memory.md: {}", e))?;
    }

    build_workspace_info(&app, workspace_path.as_deref(), project.as_ref())
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)?.flatten() {
            let name = entry.file_name();
            // Dependencies and build caches are reinstalled, not copied.
            if matches!(name.to_str(), Some("node_modules" | ".git" | ".cache")) {
                continue;
            }
            copy_recursive(&entry.path(), &dst.join(name))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ())
    }
}

/// `dir/name`, or `dir/name-2`, `-3`, ... if that's taken.
fn free_destination(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && Path::new(&dir.join(name)).is_file() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Copies an asset between a project and the template library ("Lưu thành
/// template" / "Dùng template"). Both ends must be inside the AI workspace.
#[tauri::command]
pub async fn cli_copy_asset(
    app: AppHandle,
    source: String,
    destination_dir: String,
) -> Result<String, String> {
    let root = global_workspace_root(&app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let src = PathBuf::from(&source).canonicalize().map_err(|e| e.to_string())?;
    fs::create_dir_all(&destination_dir).map_err(|e| e.to_string())?;
    let dst_dir = PathBuf::from(&destination_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !src.starts_with(&root) || !dst_dir.starts_with(&root) {
        return Err("Chỉ chép được asset trong thư mục AI workspace.".into());
    }
    if dst_dir.starts_with(&src) {
        return Err("Không thể chép một thư mục vào chính nó.".into());
    }
    let name = src
        .file_name()
        .ok_or("Đường dẫn không hợp lệ")?
        .to_string_lossy()
        .into_owned();
    let dst = free_destination(&dst_dir, &name);
    copy_recursive(&src, &dst).map_err(|e| format!("Không chép được: {e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(editor: &str, name: &str, id: &str) -> WorkspaceProject {
        WorkspaceProject {
            editor: Some(editor.into()),
            name: Some(name.into()),
            id: Some(id.into()),
            legacy_name: None,
        }
    }

    #[test]
    fn adopts_the_old_timeline_folder_once() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path();
        fs::create_dir_all(projects.join("Timeline-1/exports")).unwrap();
        fs::write(projects.join("Timeline-1/exports/a.mp4"), "x").unwrap();
        let p = WorkspaceProject { legacy_name: Some("Timeline 1".into()), ..project("davinci", "Film", "id") };
        let dir = projects.join(project_rel_dir(Some(&p)).0);
        // An already-created empty folder doesn't block the move.
        fs::create_dir_all(dir.join("motion-graphics")).unwrap();
        fs::write(dir.join("memory.md"), "").unwrap();
        adopt_legacy_dir(projects, Some(&p), &dir);
        assert!(dir.join("exports/a.mp4").is_file());
        assert!(!projects.join("Timeline-1").exists());

        // A second project with the same timeline name finds nothing to take.
        fs::create_dir_all(projects.join("Timeline-1")).unwrap();
        fs::write(projects.join("Timeline-1/b.txt"), "y").unwrap();
        adopt_legacy_dir(projects, Some(&p), &dir);
        assert!(projects.join("Timeline-1/b.txt").is_file(), "has content, keep both");
    }

    #[test]
    fn same_name_projects_get_separate_folders() {
        let a = project_rel_dir(Some(&project("davinci", "My Film", "id-a"))).0;
        let b = project_rel_dir(Some(&project("davinci", "My Film", "id-b"))).0;
        let c = project_rel_dir(Some(&project("premiere", "My Film", "id-a"))).0;
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("davinci"));
        assert_eq!(a, project_rel_dir(Some(&project("davinci", "My Film", "id-a"))).0);
    }

    #[test]
    fn falls_back_without_project() {
        assert_eq!(project_rel_dir(None).0, PathBuf::from("standalone/untitled"));
        let named = project_rel_dir(Some(&project("capcut", "Vlog 1", ""))).0;
        assert_eq!(named, PathBuf::from("capcut/Vlog-1"));
    }

    #[test]
    fn copies_without_node_modules_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("title");
        fs::create_dir_all(src.join("node_modules/x")).unwrap();
        fs::write(src.join("index.html"), "hi").unwrap();
        let dst_dir = tmp.path().join("templates");
        fs::create_dir_all(&dst_dir).unwrap();
        for expected in ["title", "title-2"] {
            let dst = free_destination(&dst_dir, "title");
            copy_recursive(&src, &dst).unwrap();
            assert_eq!(dst.file_name().unwrap(), expected);
            assert!(dst.join("index.html").is_file());
            assert!(!dst.join("node_modules").exists());
        }
    }
}
