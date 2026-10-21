//! 2-Tier Workspace & Project Asset Management for AI Video Director (`AI EDIT`).
//!
//! Tier A (Global Library): `<app_data_dir>/ai-director-workspace/`
//!   ├── `global-memory.md`
//!   └── `library/` (shared, read-only for the agent)
//!       ├── `music/`, `sfx/`        packs the user keeps; copied into a project when used
//!       ├── `motion-graphics/`      templates
//!       └── `skills/`               skills, copied into a project to use
//!
//! Tier B (Per-Project Folder): `<base>/projects/<editor>/<project-slug>[-<id hash>]/`
//!   One folder per editor project (DaVinci project, Premiere `.prproj`, CapCut
//!   draft), never shared: templates are the only thing projects share, and
//!   only when the user saves one there.
//!   ├── `memory.md`
//!   ├── `visual-plan.json`
//!   ├── `media/video/`, `media/images/`        downloaded or AI-made media
//!   ├── `media/audio/music/`, `media/audio/sfx/`
//!   ├── `motion-graphics/`                      motion source code
//!   ├── `exports/`                              rendered motion
//!   ├── `articles/`                             saved web articles
//!   └── `.agent/skills/<name>/SKILL.md`         skills the agent reads (any CLI)

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetItem {
    pub name: String,
    pub path: String,
    /// Project: "video" | "images" | "music" | "sfx" | "motion-graphics" | "exports" | "skills".
    /// Shared library: "templates" | "library-music" | "library-sfx" | "library-skills".
    pub category: String,
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
    pub exports_dir: String,
    pub video_dir: String,
    pub images_dir: String,
    pub music_dir: String,
    pub sfx_dir: String,
    /// `library/motion-graphics`: shared templates.
    pub templates_dir: String,
    pub library_music_dir: String,
    pub library_sfx_dir: String,
    /// `.agent/skills` of this project.
    pub skills_dir: String,
    /// `library/skills`: shared skills.
    pub library_skills_dir: String,
    pub assets: Vec<ProjectAssetItem>,
}

/// Where each kind of media lives inside a project workspace.
pub const VIDEO_DIR: &str = "media/video";
pub const IMAGES_DIR: &str = "media/images";
pub const MUSIC_DIR: &str = "media/audio/music";
pub const SFX_DIR: &str = "media/audio/sfx";
/// Skills live in a CLI-neutral folder; the app lists them in the system
/// prompt (`skills_prompt`) instead of relying on each CLI's own folder.
pub const SKILLS_DIR: &str = ".agent/skills";

/// `<global>/library`, shared by every project.
pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(global_workspace_root(app)?.join("library"))
}

/// Creates `library/` and moves the old `templates/motion-graphics` into it.
fn ensure_library(global_dir: &Path) -> Result<PathBuf, String> {
    let library = global_dir.join("library");
    let templates = library.join("motion-graphics");
    let old = global_dir.join("templates").join("motion-graphics");
    if old.is_dir() && !templates.exists() {
        let _ = fs::create_dir_all(&library);
        if fs::rename(&old, &templates).is_ok() {
            let _ = fs::remove_dir(global_dir.join("templates"));
        }
    }
    for sub in ["music", "sfx", "motion-graphics", "skills"] {
        fs::create_dir_all(library.join(sub))
            .map_err(|e| format!("Failed to create library/{}: {}", sub, e))?;
    }
    Ok(library)
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
    check_project_known(project)?;
    let projects = global_workspace_root(app)?.join("projects");
    let dir = projects.join(project_rel_dir(project).0);
    adopt_legacy_dir(&projects, project, &dir);
    write_project_meta(&dir, project);
    Ok(dir)
}

/// An editor with no project name would land in a shared `<editor>/untitled`
/// folder and mix assets of unrelated projects, so refuse it.
fn check_project_known(project: Option<&WorkspaceProject>) -> Result<(), String> {
    let Some(p) = project else { return Ok(()) };
    let editor = p.editor.as_deref().unwrap_or("").trim();
    let named = p.name.as_deref().is_some_and(|n| !n.trim().is_empty())
        || p.id.as_deref().is_some_and(|i| !i.trim().is_empty());
    if !editor.is_empty() && editor != "standalone" && !named {
        return Err(format!(
            "Chưa đọc được project đang mở trong {editor}. Hãy mở project rồi thử lại."
        ));
    }
    Ok(())
}

/// Written into every project folder so Settings can show the real project
/// name (the folder name is a slug plus a hash) and when it was last used.
const META_FILE: &str = ".autosubs-project.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    editor: String,
    name: Option<String>,
    id: Option<String>,
    last_used_sec: i64,
}

fn now_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn write_project_meta(dir: &Path, project: Option<&WorkspaceProject>) {
    let p = project.cloned().unwrap_or_default();
    let meta = ProjectMeta {
        editor: p.editor.unwrap_or_else(|| "standalone".into()),
        name: p.name.filter(|n| !n.trim().is_empty()),
        id: p.id.filter(|i| !i.trim().is_empty()),
        last_used_sec: now_sec(),
    };
    if fs::create_dir_all(dir).is_ok() {
        if let Ok(text) = serde_json::to_string_pretty(&meta) {
            let _ = fs::write(dir.join(META_FILE), text);
        }
    }
}

/// One project folder, as the Settings list shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectEntry {
    pub path: String,
    pub editor: String,
    /// The editor's project name, or the folder name for folders without metadata.
    pub name: String,
    pub id: Option<String>,
    pub size_bytes: u64,
    pub last_used_sec: i64,
}

/// Disk use of `path`, not following symlinks (Remotion projects link the
/// shared kit's node_modules, which isn't theirs to count).
fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

fn list_projects(projects: &Path) -> Vec<WorkspaceProjectEntry> {
    let mut out = Vec::new();
    for editor in EDITOR_DIRS {
        let Ok(rd) = fs::read_dir(projects.join(editor)) else { continue };
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let meta: Option<ProjectMeta> = fs::read_to_string(dir.join(META_FILE))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok());
            let folder = entry.file_name().to_string_lossy().into_owned();
            out.push(WorkspaceProjectEntry {
                path: dir.to_string_lossy().into_owned(),
                editor: editor.to_string(),
                name: meta.as_ref().and_then(|m| m.name.clone()).unwrap_or(folder),
                id: meta.as_ref().and_then(|m| m.id.clone()),
                size_bytes: dir_size(&dir),
                last_used_sec: meta.map(|m| m.last_used_sec).unwrap_or_else(|| {
                    fs::metadata(&dir)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0)
                }),
            });
        }
    }
    out.sort_by(|a, b| b.last_used_sec.cmp(&a.last_used_sec));
    out
}

/// Every project folder the AI Edit tab has made, newest first.
#[tauri::command]
pub async fn cli_list_workspace_projects(app: AppHandle) -> Result<Vec<WorkspaceProjectEntry>, String> {
    let projects = global_workspace_root(&app)?.join("projects");
    Ok(tauri::async_runtime::spawn_blocking(move || list_projects(&projects))
        .await
        .map_err(|e| e.to_string())?)
}

/// `path` must be one project folder, `projects/<editor>/<folder>`.
fn check_project_folder(projects: &Path, path: &Path) -> Result<PathBuf, String> {
    let projects = projects.canonicalize().map_err(|e| e.to_string())?;
    let dir = path.canonicalize().map_err(|e| e.to_string())?;
    let rel = dir.strip_prefix(&projects).map_err(|_| "Not an AI Edit project folder.".to_string())?;
    let parts: Vec<_> = rel.components().collect();
    let editor = parts.first().map(|c| c.as_os_str().to_string_lossy().into_owned());
    if parts.len() != 2 || !editor.is_some_and(|e| EDITOR_DIRS.contains(&e.as_str())) {
        return Err("Not an AI Edit project folder.".into());
    }
    Ok(dir)
}

/// Moves one project folder (its media, motion graphics, exports) to the
/// Trash. The app deletes the conversations bound to it; the project in the
/// editor itself is never touched.
#[tauri::command]
pub async fn cli_delete_workspace_project(app: AppHandle, path: String) -> Result<(), String> {
    let projects = global_workspace_root(&app)?.join("projects");
    let dir = check_project_folder(&projects, Path::new(&path))?;
    trash::delete(&dir).map_err(|e| format!("Could not move {} to the Trash: {}", dir.display(), e))
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
    let library = ensure_library(&global_dir)?;
    let templates_dir = library.join("motion-graphics");
    crate::media::remotion::seed_starter(&templates_dir);

    let global_mem_path = global_dir.join("global-memory.md");
    if !global_mem_path.exists() {
        let _ = fs::write(&global_mem_path, "");
    }
    let global_memory = fs::read_to_string(&global_mem_path).unwrap_or_default();

    let project_slug = project_rel_dir(project).1;
    let dir = resolve_workspace_dir(app, workspace_path, project)?;
    let mg_dir = dir.join("motion-graphics");
    let exports_dir = dir.join("exports");
    let video_dir = dir.join(VIDEO_DIR);
    let images_dir = dir.join(IMAGES_DIR);
    let music_dir = dir.join(MUSIC_DIR);
    let sfx_dir = dir.join(SFX_DIR);
    let skills_dir = dir.join(SKILLS_DIR);

    for sub in [&dir, &mg_dir, &exports_dir, &video_dir, &images_dir, &music_dir, &sfx_dir, &skills_dir] {
        fs::create_dir_all(sub)
            .map_err(|e| format!("Failed to create directory {}: {}", sub.display(), e))?;
    }

    let mem_path = dir.join("memory.md");
    if !mem_path.exists() {
        let _ = fs::write(&mem_path, "");
    }
    let memory = fs::read_to_string(&mem_path).unwrap_or_default();

    let mut assets = Vec::new();
    scan_category_dir(&video_dir, "video", &mut assets);
    scan_category_dir(&images_dir, "images", &mut assets);
    scan_category_dir(&music_dir, "music", &mut assets);
    scan_category_dir(&sfx_dir, "sfx", &mut assets);
    scan_category_dir(&mg_dir, "motion-graphics", &mut assets);
    scan_category_dir(&exports_dir, "exports", &mut assets);
    scan_category_dir(&skills_dir, "skills", &mut assets);
    scan_category_dir(&templates_dir, "templates", &mut assets);
    scan_category_dir(&library.join("music"), "library-music", &mut assets);
    scan_category_dir(&library.join("sfx"), "library-sfx", &mut assets);
    scan_category_dir(&library.join("skills"), "library-skills", &mut assets);
    assets.sort_by(|a, b| b.modified_sec.cmp(&a.modified_sec));

    Ok(WorkspaceInfo {
        path: dir.to_string_lossy().into_owned(),
        global_path: global_dir.to_string_lossy().into_owned(),
        project_slug,
        memory,
        global_memory,
        motion_graphics_dir: mg_dir.to_string_lossy().into_owned(),
        exports_dir: exports_dir.to_string_lossy().into_owned(),
        video_dir: video_dir.to_string_lossy().into_owned(),
        images_dir: images_dir.to_string_lossy().into_owned(),
        music_dir: music_dir.to_string_lossy().into_owned(),
        sfx_dir: sfx_dir.to_string_lossy().into_owned(),
        templates_dir: templates_dir.to_string_lossy().into_owned(),
        library_music_dir: library.join("music").to_string_lossy().into_owned(),
        library_sfx_dir: library.join("sfx").to_string_lossy().into_owned(),
        skills_dir: skills_dir.to_string_lossy().into_owned(),
        library_skills_dir: library.join("skills").to_string_lossy().into_owned(),
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

/// The skill folders inside `source`: `source` itself when it holds a
/// `SKILL.md`, else each subfolder that does.
fn find_skill_dirs(source: &Path) -> Vec<PathBuf> {
    if source.join("SKILL.md").is_file() {
        return vec![source.to_path_buf()];
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(source)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("SKILL.md").is_file())
        .collect();
    dirs.sort();
    dirs
}

/// Imports skills from any folder on disk into a project's `.agent/skills`
/// or `library/skills`. Returns the imported folder names.
#[tauri::command]
pub async fn cli_import_skills(
    app: AppHandle,
    source: String,
    destination_dir: String,
) -> Result<Vec<String>, String> {
    let root = global_workspace_root(&app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&destination_dir).map_err(|e| e.to_string())?;
    let dst_dir = PathBuf::from(&destination_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !dst_dir.starts_with(&root) {
        return Err("Chỉ nhập skill vào thư mục AI workspace.".into());
    }
    let skills = find_skill_dirs(Path::new(&source));
    if skills.is_empty() {
        return Err("Không thấy SKILL.md trong thư mục này hoặc các thư mục con.".into());
    }
    let mut names = Vec::new();
    for src in skills {
        let name = src
            .file_name()
            .ok_or("Đường dẫn không hợp lệ")?
            .to_string_lossy()
            .into_owned();
        let dst = free_destination(&dst_dir, &name);
        copy_recursive(&src, &dst).map_err(|e| format!("Không chép được {name}: {e}"))?;
        names.push(dst.file_name().unwrap().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// `name` and `description` from a SKILL.md frontmatter. Handles plain,
/// quoted and folded (`>` / `|`) values.
fn skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut desc) = (None, None);
    let mut folding: Option<(&str, Vec<String>)> = None;
    fn finish(key: &str, value: String, name: &mut Option<String>, desc: &mut Option<String>) {
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if value.is_empty() {
            return;
        }
        match key {
            "name" => *name = Some(value),
            "description" => *desc = Some(value),
            _ => {}
        }
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((_, parts)) = folding.as_mut() {
            if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() {
                parts.push(line.trim().to_string());
                continue;
            }
            let (key, parts) = folding.take().unwrap();
            finish(key, parts.join(" "), &mut name, &mut desc);
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = match key.trim() {
            "name" => "name",
            "description" => "description",
            _ => continue,
        };
        let value = value.trim();
        if value.starts_with('>') || value.starts_with('|') {
            folding = Some((key, Vec::new()));
        } else {
            finish(key, value.to_string(), &mut name, &mut desc);
        }
    }
    if let Some((key, parts)) = folding {
        finish(key, parts.join(" "), &mut name, &mut desc);
    }
    (name, desc)
}

/// The system prompt block listing this project's skills, or None when it
/// has none. Only names and descriptions go in; the agent reads a SKILL.md
/// itself when a task matches, so every CLI gets skills the same way.
pub fn skills_prompt(workspace: &Path) -> Option<String> {
    let dirs = find_skill_dirs(&workspace.join(SKILLS_DIR));
    let entries: Vec<String> = dirs
        .iter()
        .filter_map(|dir| {
            let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
            let (name, desc) = skill_frontmatter(&text);
            let folder = dir.file_name()?.to_string_lossy().into_owned();
            let name = name.unwrap_or_else(|| folder.clone());
            let desc = desc.unwrap_or_default();
            Some(format!("- {name} (`{SKILLS_DIR}/{folder}/SKILL.md`): {desc}"))
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    Some(format!(
        "<skills>\nProject skills. When a task matches one, or the user names it, read its SKILL.md first and follow it; files it mentions are relative to its folder.\n{}\n</skills>",
        entries.join("\n")
    ))
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
    fn lists_projects_by_their_real_name_and_checks_delete_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let p = project("premiere", "My Film", "/x/My Film.prproj");
        let dir = projects.join(project_rel_dir(Some(&p)).0);
        write_project_meta(&dir, Some(&p));
        fs::create_dir_all(dir.join("media/video")).unwrap();
        fs::write(dir.join("media/video/a.mp4"), "12345").unwrap();
        fs::create_dir_all(projects.join("Timeline-1")).unwrap();

        let list = list_projects(&projects);
        assert_eq!(list.len(), 1, "legacy top-level folders are not projects");
        assert_eq!(list[0].name, "My Film");
        assert_eq!(list[0].editor, "premiere");
        assert!(list[0].size_bytes >= 5);

        assert!(check_project_folder(&projects, &dir).is_ok());
        assert!(check_project_folder(&projects, &projects.join("premiere")).is_err());
        assert!(check_project_folder(&projects, &dir.join("media")).is_err());
        assert!(check_project_folder(&projects, tmp.path()).is_err());
    }

    #[test]
    fn refuses_an_editor_without_a_project() {
        let mut p = project("premiere", "", "");
        p.name = None;
        assert!(check_project_known(Some(&p)).is_err());
        assert!(check_project_known(Some(&project("premiere", "Temp", ""))).is_ok());
        assert!(check_project_known(None).is_ok());
    }

    #[test]
    fn falls_back_without_project() {
        assert_eq!(project_rel_dir(None).0, PathBuf::from("standalone/untitled"));
        let named = project_rel_dir(Some(&project("capcut", "Vlog 1", ""))).0;
        assert_eq!(named, PathBuf::from("capcut/Vlog-1"));
    }

    #[test]
    fn finds_and_lists_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(SKILLS_DIR);
        fs::create_dir_all(skills.join("script-split")).unwrap();
        fs::write(
            skills.join("script-split/SKILL.md"),
            "---\nname: script-split\ndescription: >\n  Split a script\n  into scenes.\n---\n# Body",
        )
        .unwrap();
        fs::create_dir_all(skills.join("plain")).unwrap();
        fs::write(skills.join("plain/SKILL.md"), "# No frontmatter").unwrap();
        fs::create_dir_all(skills.join("not-a-skill")).unwrap();

        assert_eq!(find_skill_dirs(&skills).len(), 2);
        assert_eq!(find_skill_dirs(&skills.join("plain")).len(), 1);
        let prompt = skills_prompt(tmp.path()).unwrap();
        assert!(prompt.contains("- script-split (`.agent/skills/script-split/SKILL.md`): Split a script into scenes."));
        assert!(prompt.contains("- plain (`.agent/skills/plain/SKILL.md`): "));
        assert!(!prompt.contains("not-a-skill"));
        assert!(skills_prompt(&tmp.path().join("empty")).is_none());
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
