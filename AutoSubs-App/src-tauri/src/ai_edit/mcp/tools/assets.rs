//! Short media ids (`m12`) and `list_media`.
//!
//! Absolute paths were half of what the agent wrote when placing media (a
//! clip in this workspace is ~150 characters of path), so every file a tool
//! hands the agent gets a short id instead, and every `path` / `audioPath`
//! argument takes either. Ids are per project workspace and kept in
//! `<workspace>/.media-ids.json`, so they survive a resumed conversation and
//! an app restart. `list_media` is how the agent sees a folder (a sound
//! effect pack, its own downloads) with ids and lengths in one call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai_edit::mcp::tools::tool;
use crate::media::{figure, probe};

const REGISTRY_FILE: &str = ".media-ids.json";
/// Most files `list_media` lists before it answers with a folder summary.
const DEFAULT_LIMIT: usize = 200;
const MEDIA_EXTS: &[&str] = &[
    "mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf", "wav", "wave", "mp3", "m4a", "aac", "flac", "ogg", "aif",
    "aiff", "opus", "png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "heic",
];

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    next: u64,
    paths: HashMap<String, String>,
}

/// Registries by workspace, loaded on first use.
static REGISTRIES: Lazy<Mutex<HashMap<PathBuf, Registry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn with_registry<T>(workspace: &Path, f: impl FnOnce(&mut Registry) -> T) -> T {
    let mut all = REGISTRIES.lock().unwrap_or_else(|e| e.into_inner());
    let reg = all.entry(workspace.to_path_buf()).or_insert_with(|| {
        std::fs::read_to_string(workspace.join(REGISTRY_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    });
    f(reg)
}

fn save(workspace: &Path, reg: &Registry) {
    if let Ok(text) = serde_json::to_string(reg) {
        let _ = std::fs::write(workspace.join(REGISTRY_FILE), text);
    }
}

/// The id for `path`, giving it one if it has none yet.
pub fn id_for(workspace: &Path, path: &Path) -> String {
    let path = path.to_string_lossy().to_string();
    with_registry(workspace, |reg| {
        if let Some((id, _)) = reg.paths.iter().find(|(_, p)| **p == path) {
            return id.clone();
        }
        reg.next += 1;
        let id = format!("m{}", reg.next);
        reg.paths.insert(id.clone(), path);
        save(workspace, reg);
        id
    })
}

fn is_id(s: &str) -> bool {
    s.len() > 1 && s.starts_with('m') && s[1..].bytes().all(|b| b.is_ascii_digit())
}

/// Replace media ids in every `path` / `audioPath` string of `args`
/// (nested too: apply_actions entries, storyboard items) with their paths.
pub fn resolve_ids(workspace: &Path, args: &mut Value) -> Result<(), String> {
    match args {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if matches!(key.as_str(), "path" | "audioPath") {
                    if let Some(s) = value.as_str().map(str::trim).filter(|s| is_id(s)) {
                        let found = with_registry(workspace, |reg| reg.paths.get(s).cloned());
                        match found {
                            Some(p) => *value = Value::String(p),
                            None => {
                                return Err(format!(
                                    "Unknown media id {}. Ids come from list_media, download_media, render_motion \
                                     and remove_background.",
                                    s
                                ))
                            }
                        }
                    }
                } else {
                    resolve_ids(workspace, value)?;
                }
            }
            Ok(())
        }
        Value::Array(items) => items.iter_mut().try_for_each(|v| resolve_ids(workspace, v)),
        _ => Ok(()),
    }
}

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf"];
const AUDIO_EXTS: &[&str] = &["wav", "wave", "mp3", "m4a", "aac", "flac", "ogg", "aif", "aiff", "opus"];

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| list.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

/// Which `media/` folder a file from outside the project belongs in. Audio
/// from `library/sfx` or `library/music` keeps its kind; other audio counts as
/// a voiceover or a sound effect when its folder or name says so, else as music.
fn media_subdir(path: &Path, library: Option<&Path>) -> Option<&'static str> {
    use crate::ai_cli::workspace::{IMAGES_DIR, MUSIC_DIR, SFX_DIR, VIDEO_DIR, VOICE_DIR};
    if ext_in(path, VIDEO_EXTS) {
        return Some(VIDEO_DIR);
    }
    if !ext_in(path, AUDIO_EXTS) {
        return is_media(path).then_some(IMAGES_DIR);
    }
    if let Some(lib) = library {
        if path.starts_with(lib.join("sfx")) {
            return Some(SFX_DIR);
        }
        if path.starts_with(lib.join("music")) {
            return Some(MUSIC_DIR);
        }
    }
    static VOICE_HINT: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?i)voice|narrat|\bvo\b|giọng|thuyết minh|lồng tiếng").unwrap()
    });
    if VOICE_HINT.is_match(&path.to_string_lossy()) {
        return Some(VOICE_DIR);
    }
    static SFX_HINT: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?i)sfx|sound ?(fx|effect)|foley|whoosh|swoosh|impact|riser|transition|click|\bhit\b|\bpop\b")
            .unwrap()
    });
    if SFX_HINT.is_match(&path.to_string_lossy()) { Some(SFX_DIR) } else { Some(MUSIC_DIR) }
}

/// Copies `src` into `dir`, reusing a same-named file of the same size (the
/// same sound placed twice) and never overwriting a different one.
fn copy_in(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let name = src.file_name().ok_or("Invalid media path")?.to_string_lossy().into_owned();
    let size = std::fs::metadata(src).map(|m| m.len()).ok();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{}", e)),
        _ => (name.clone(), String::new()),
    };
    for n in 1.. {
        let candidate = if n == 1 { dir.join(&name) } else { dir.join(format!("{}-{}{}", stem, n, ext)) };
        match std::fs::metadata(&candidate) {
            Ok(m) if Some(m.len()) == size => return Ok(candidate),
            Ok(_) => continue,
            Err(_) => {
                std::fs::copy(src, &candidate)
                    .map_err(|e| format!("Could not copy {} into the project: {}", src.display(), e))?;
                return Ok(candidate);
            }
        }
    }
    unreachable!()
}

/// Media placed on the timeline must live in the project: every `path` /
/// `audioPath` in `args` that points outside `workspace` (a library/ pack,
/// Downloads) is copied into the project's `media/` folder and rewritten to
/// the copy, so the editor never links to a file the user may move or delete.
pub fn import_external(workspace: &Path, library: Option<&Path>, args: &mut Value) -> Result<(), String> {
    let root = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let library = library.map(|l| l.canonicalize().unwrap_or_else(|_| l.to_path_buf()));
    import_walk(&root, library.as_deref(), args)
}

fn import_walk(root: &Path, library: Option<&Path>, args: &mut Value) -> Result<(), String> {
    match args {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if !matches!(key.as_str(), "path" | "audioPath") {
                    import_walk(root, library, value)?;
                    continue;
                }
                let Some(raw) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) else { continue };
                let Ok(src) = Path::new(raw).canonicalize() else { continue };
                if src.starts_with(root) || !src.is_file() {
                    continue;
                }
                let Some(sub) = media_subdir(&src, library) else { continue };
                let copied = copy_in(&src, &root.join(sub))?;
                *value = Value::String(copied.to_string_lossy().into_owned());
            }
            Ok(())
        }
        Value::Array(items) => items.iter_mut().try_for_each(|v| import_walk(root, library, v)),
        _ => Ok(()),
    }
}

/// `m12 name 3.4s`, the way every tool reports a file it made or found.
pub fn describe(workspace: &Path, path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    line(workspace, &name, path)
}

/// `<id> <name> <length>` for audio and video, `<id> <name> <size and
/// visible area>` for images (see `media::figure`).
fn line(workspace: &Path, name: &str, path: &Path) -> String {
    let id = id_for(workspace, path);
    let detail = if figure::is_image(path) {
        figure::measure(path).map(|f| figure::summary(&f))
    } else {
        probe::duration_secs(path).map(|d| format!("{:.1}s", d))
    };
    match detail {
        Some(d) => format!("{} {} {}", id, name, d),
        None => format!("{} {}", id, name),
    }
}

pub fn tools() -> Vec<Value> {
    vec![tool(
        "list_media",
        "List the media files in a folder (video, audio, images), each with a short id and its length: \
         a sound effect pack, a music folder, or the project's own media/ and exports/ (the default). \
         Images give their size instead, and a cut-out (transparent PNG) also where the figure really \
         is on its canvas: its box (x and y from 0 to 1 across the canvas) and its feet, the bottom \
         middle of what is visible. Use them to place it: the feet go on the ground of the background, \
         the box height sets the zoom, and feet work as update_clip anchor. \
         Pass the id (like m12) as path to build_storyboard or any tool instead of the full path. Files \
         in subfolders are listed as subfolder/name. A folder with more files than limit answers with \
         its subfolders and counts; then list every subfolder you need in ONE call with folders, or \
         narrow with filter.",
        json!({
            "type": "object",
            "properties": {
                "folder": { "type": "string", "description": "Absolute folder path (default: the project's media and exports)" },
                "folders": { "type": "array", "items": { "type": "string" }, "description": "Several absolute folder paths, listed in one call" },
                "filter": { "type": "string", "description": "Only names containing this text (case-insensitive)" },
                "limit": { "type": "integer", "description": "Most files to list (default 200)" }
            }
        }),
    )]
}

pub fn call(workspace: Option<&Path>, name: &str, args: &Value) -> Option<Result<String, String>> {
    if name != "list_media" {
        return None;
    }
    Some(match workspace {
        Some(ws) => list_media(ws, args),
        None => Err("This run has no project workspace.".into()),
    })
}

fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MEDIA_EXTS.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

/// Media files under `dir`, as (path relative to `dir`, absolute path).
fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let rel_name = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        if path.is_dir() {
            if depth > 0 {
                walk(&path, &rel_name, depth - 1, out);
            }
        } else if is_media(&path) {
            out.push((rel_name, path));
        }
    }
}

fn list_media(workspace: &Path, args: &Value) -> Result<String, String> {
    // `folders` lists several at once (the Boom, Swoosh and Pop folders of
    // a pack): each separate call costs the agent a model turn.
    let asked: Vec<String> = args
        .get("folders")
        .and_then(|f| f.as_array())
        .into_iter()
        .flatten()
        .chain(args.get("folder"))
        .filter_map(|f| f.as_str().map(str::trim))
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .collect();
    let folders: Vec<PathBuf> = if asked.is_empty() {
        vec![workspace.join("media"), workspace.join("exports")]
    } else {
        let missing: Vec<&str> = asked.iter().map(String::as_str).filter(|f| !Path::new(f).is_dir()).collect();
        if !missing.is_empty() {
            return Err(format!("Not a folder: {}.", missing.join(", ")));
        }
        asked.iter().map(PathBuf::from).collect()
    };
    let filter = args.get("filter").and_then(|f| f.as_str()).map(|f| f.to_lowercase()).filter(|f| !f.is_empty());
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(DEFAULT_LIMIT).max(1);

    let mut files = Vec::new();
    for folder in &folders {
        let prefix = if folders.len() > 1 {
            folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            String::new()
        };
        walk(folder, &prefix, 4, &mut files);
    }
    if let Some(f) = &filter {
        files.retain(|(rel, _)| rel.to_lowercase().contains(f));
    }
    if files.is_empty() {
        return Ok("No media files there.".into());
    }

    if files.len() > limit {
        // Too many to list: answer with where they are.
        let mut counts: Vec<(String, usize)> = Vec::new();
        for (rel, _) in &files {
            let group = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_else(|| ".".into());
            match counts.iter_mut().find(|(g, _)| *g == group) {
                Some((_, n)) => *n += 1,
                None => counts.push((group, 1)),
            }
        }
        let groups: Vec<String> = counts.iter().map(|(g, n)| format!("{} ({})", g, n)).collect();
        let root = if folders.len() == 1 { folders[0].to_string_lossy().to_string() } else { "these folders".into() };
        return Ok(format!(
            "{} files, more than limit {}. Subfolders of {}: {}. List the ones you need in ONE call \
             (folders = [\"{}/<subfolder>\", ...]) or use filter.",
            files.len(),
            limit,
            root,
            groups.join(", "),
            folders[0].to_string_lossy()
        ));
    }

    let lines: Vec<String> = files
        .iter()
        .map(|(rel, path)| line(workspace, rel, path))
        .collect();
    Ok(format!("{} file(s):\n{}", lines.len(), lines.join("\n")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn placing_outside_media_copies_it_into_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let lib = tmp.path().join("library");
        std::fs::create_dir_all(lib.join("sfx/Pack")).unwrap();
        std::fs::create_dir_all(ws.join("media/video")).unwrap();
        let downloads = tmp.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(lib.join("sfx/Pack/boom.wav"), "a").unwrap();
        std::fs::write(downloads.join("song.mp3"), "bb").unwrap();
        std::fs::write(downloads.join("voiceover_final.wav"), "d").unwrap();
        std::fs::write(ws.join("media/video/own.mp4"), "c").unwrap();
        let own = ws.join("media/video/own.mp4").canonicalize().unwrap();
        let mut args = json!({ "items": [
            { "path": lib.join("sfx/Pack/boom.wav") },
            { "path": downloads.join("song.mp3") },
            { "path": own },
            { "path": lib.join("sfx/Pack/boom.wav") },
            { "path": downloads.join("voiceover_final.wav") }
        ]});
        import_external(&ws, Some(&lib), &mut args).unwrap();
        let items = args["items"].as_array().unwrap();
        let p = |i: usize| PathBuf::from(items[i]["path"].as_str().unwrap());
        assert!(p(0).ends_with("media/audio/sfx/boom.wav") && p(0).is_file());
        assert!(p(1).ends_with("media/audio/music/song.mp3") && p(1).is_file());
        assert_eq!(p(2), own);
        assert_eq!(p(3), p(0), "same sound twice reuses one copy");
        assert!(p(4).ends_with("media/audio/voice/voiceover_final.wav") && p(4).is_file());
    }

    use super::*;

    #[test]
    fn ids_round_trip_through_arguments() {
        let ws = std::env::temp_dir().join(format!("autosubs-ids-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&ws).unwrap();
        let a = ws.join("a.wav");
        let id = id_for(&ws, &a);
        assert_eq!(id, "m1");
        assert_eq!(id_for(&ws, &a), "m1", "same file, same id");

        let mut args = json!({ "actions": [{ "tool": "build_storyboard", "args": {
            "items": [{ "path": "m1", "start": 2 }, { "path": "/x/b.mp4", "start": 0 }],
            "audioPath": " m1 "
        } }] });
        resolve_ids(&ws, &mut args).unwrap();
        let inner = &args["actions"][0]["args"];
        assert_eq!(inner["items"][0]["path"], json!(a.to_string_lossy()));
        assert_eq!(inner["items"][1]["path"], json!("/x/b.mp4"));
        assert_eq!(inner["audioPath"], json!(a.to_string_lossy()));

        assert!(resolve_ids(&ws, &mut json!({ "path": "m99" })).is_err());
        // A file named like an id but not one stays a path.
        let mut plain = json!({ "path": "music.wav" });
        resolve_ids(&ws, &mut plain).unwrap();
        assert_eq!(plain["path"], json!("music.wav"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn summarises_big_folders() {
        let ws = std::env::temp_dir().join(format!("autosubs-list-{}", uuid::Uuid::new_v4().simple()));
        for sub in ["Boom", "Swoosh"] {
            std::fs::create_dir_all(ws.join("pack").join(sub)).unwrap();
            for i in 0..3 {
                std::fs::write(ws.join("pack").join(sub).join(format!("{} {}.wav", sub, i)), b"").unwrap();
            }
        }
        let folder = ws.join("pack").to_string_lossy().to_string();
        let all = list_media(&ws, &json!({ "folder": folder })).unwrap();
        assert!(all.starts_with("6 file(s):"), "{}", all);
        assert!(all.contains("Swoosh/Swoosh 2.wav"), "{}", all);
        let summary = list_media(&ws, &json!({ "folder": folder, "limit": 4 })).unwrap();
        assert!(summary.contains("Boom (3), Swoosh (3)"), "{}", summary);
        let filtered = list_media(&ws, &json!({ "folder": folder, "filter": "boom 1" })).unwrap();
        assert!(filtered.starts_with("1 file(s):"), "{}", filtered);

        // Several subfolders in one call, each file under its folder's name.
        let both = json!({ "folders": [format!("{}/Boom", folder), format!("{}/Swoosh", folder)] });
        let listed = list_media(&ws, &both).unwrap();
        assert!(listed.starts_with("6 file(s):"), "{}", listed);
        assert!(listed.contains(" Boom/Boom 0.wav") && listed.contains(" Swoosh/Swoosh 2.wav"), "{}", listed);
        let bad = list_media(&ws, &json!({ "folders": [folder.clone(), "/no/such/dir"] })).unwrap_err();
        assert!(bad.contains("/no/such/dir"), "{}", bad);
        let _ = std::fs::remove_dir_all(&ws);
    }
}
