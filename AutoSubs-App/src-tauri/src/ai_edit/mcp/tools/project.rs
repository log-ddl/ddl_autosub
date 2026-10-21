//! Project tools: what an agent app outside AutoSubs needs in place of the
//! system prompt the AI Edit tab sends with every message. The editor and
//! project, the memory notes, the skills (read on demand), and plan files
//! saved in the project's `plan/` folder, so a multi-step job survives a
//! compacted conversation and never needs the agent to know where the
//! project folder is.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_cli::workspace::{ensure_library, global_workspace_root, SKILLS_DIR};
use crate::ai_edit::actions::Editor;
use crate::ai_edit::mcp::tools::tool;

pub const PLAN_DIR: &str = "plan";
const MAX_PLAN_BYTES: usize = 2 * 1024 * 1024;

pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "get_project_context",
            "What AutoSubs is connected to: the editor, the open project, its folder, the project and \
             global memory notes, and the skills available (read one with read_skill). Call it first \
             in a new conversation.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "read_skill",
            "Read a skill: the step-by-step instructions for a longer job (footage-planning finds \
             footage for a script). get_project_context lists them.",
            json!({
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"]
            }),
        ),
        tool(
            "save_plan",
            "Save a plan file (JSON or text) in the project's plan/ folder, like script.json or \
             shotlist.json, so the work can be picked up later. Replaces the file.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "File name, like shotlist.json" },
                    "content": { "description": "Text, or any JSON value" }
                },
                "required": ["name", "content"]
            }),
        ),
        tool(
            "read_plan",
            "Read a plan file from the project's plan/ folder, or list them when name is left out.",
            json!({
                "type": "object",
                "properties": { "name": { "type": "string" } }
            }),
        ),
    ]
}

/// What the session knows about the project, for get_project_context.
pub struct Context<'a> {
    pub editor: Editor,
    pub label: Option<&'a str>,
    /// False when the app has not seen an editor project yet.
    pub connected: bool,
    pub workspace: Option<&'a Path>,
}

pub fn call(app: &AppHandle, ctx: &Context, name: &str, args: &Value) -> Option<Result<String, String>> {
    let library = global_workspace_root(app).and_then(|g| ensure_library(&g)).ok();
    Some(match name {
        "get_project_context" => Ok(context(ctx, library.as_deref())),
        "read_skill" => read_skill(ctx.workspace, library.as_deref(), args),
        "save_plan" => save_plan(ctx.workspace, args),
        "read_plan" => read_plan(ctx.workspace, args),
        _ => return None,
    })
}

fn context(ctx: &Context, library: Option<&Path>) -> String {
    if !ctx.connected {
        return "AutoSubs has no editor project open yet. Ask the user to open AutoSubs and their project \
                in DaVinci Resolve, Premiere Pro or CapCut, then call this again."
            .into();
    }
    let mut out = format!("Editor: {}", ctx.editor.display_name());
    if let Some(l) = ctx.label {
        out.push_str(&format!("\nProject: {}", l));
    }
    if let Some(ws) = ctx.workspace {
        out.push_str(&format!(
            "\nProject folder: {} (media/video, media/images, media/audio, analysis/, plan/, exports/)",
            ws.display()
        ));
        let memory = fs::read_to_string(ws.join("memory.md")).unwrap_or_default();
        if !memory.trim().is_empty() {
            out.push_str(&format!("\n\nProject memory (memory.md):\n{}", memory.trim()));
        }
        let plans = list_plans(ws);
        if !plans.is_empty() {
            out.push_str(&format!("\n\nPlan files (read_plan): {}", plans.join(", ")));
        }
    }
    if let Some(global) = library.and_then(|l| l.parent()) {
        let memory = fs::read_to_string(global.join("global-memory.md")).unwrap_or_default();
        if !memory.trim().is_empty() {
            out.push_str(&format!("\n\nGlobal memory:\n{}", memory.trim()));
        }
    }
    let skills = skill_list(ctx.workspace, library);
    if !skills.is_empty() {
        out.push_str("\n\nSkills (read_skill when a task matches):");
        for (name, desc, _) in skills {
            out.push_str(&format!("\n- {}: {}", name, desc));
        }
    }
    out
}

/// (name, description, SKILL.md path): project skills first, then shared ones.
fn skill_list(workspace: Option<&Path>, library: Option<&Path>) -> Vec<(String, String, PathBuf)> {
    let mut out: Vec<(String, String, PathBuf)> = Vec::new();
    let roots = workspace.map(|w| w.join(SKILLS_DIR)).into_iter().chain(library.map(|l| l.join("skills")));
    for root in roots {
        let Ok(rd) = fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
        dirs.sort();
        for dir in dirs {
            let file = dir.join("SKILL.md");
            let text = fs::read_to_string(&file).unwrap_or_default();
            let folder = dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            let (name, desc) = crate::ai_cli::workspace::skill_frontmatter(&text);
            let name = name.unwrap_or(folder);
            if out.iter().any(|(n, _, _)| *n == name) {
                continue;
            }
            out.push((name, desc.unwrap_or_default(), file));
        }
    }
    out
}

fn read_skill(workspace: Option<&Path>, library: Option<&Path>, args: &Value) -> Result<String, String> {
    let wanted = args.get("name").and_then(|n| n.as_str()).map(str::trim).unwrap_or("");
    let skills = skill_list(workspace, library);
    let found = skills.iter().find(|(n, _, f)| {
        n.eq_ignore_ascii_case(wanted) || f.parent().and_then(|d| d.file_name()).is_some_and(|d| d.to_string_lossy().eq_ignore_ascii_case(wanted))
    });
    match found {
        Some((_, _, file)) => fs::read_to_string(file).map_err(|e| format!("Could not read {}: {}", file.display(), e)),
        None => Err(format!(
            "No skill named {}. Skills: {}",
            wanted,
            skills.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// `name` as a plain file name inside plan/, refusing paths.
fn plan_path(workspace: &Path, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '));
    if !ok {
        return Err("name must be a plain file name like shotlist.json.".into());
    }
    Ok(workspace.join(PLAN_DIR).join(name))
}

fn list_plans(workspace: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(workspace.join(PLAN_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

fn save_plan(workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let ws = workspace.ok_or("No project is open in AutoSubs.")?;
    let path = plan_path(ws, args.get("name").and_then(|n| n.as_str()).unwrap_or(""))?;
    let text = match args.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !v.is_null() => serde_json::to_string_pretty(v).map_err(|e| e.to_string())?,
        _ => return Err("content is required.".into()),
    };
    if text.len() > MAX_PLAN_BYTES {
        return Err("Plan files are limited to 2 MB.".into());
    }
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, &text).map_err(|e| format!("Could not write {}: {}", path.display(), e))?;
    Ok(format!("Saved {} ({} bytes).", path.display(), text.len()))
}

fn read_plan(workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let ws = workspace.ok_or("No project is open in AutoSubs.")?;
    match args.get("name").and_then(|n| n.as_str()).filter(|n| !n.trim().is_empty()) {
        Some(name) => {
            let path = plan_path(ws, name)?;
            fs::read_to_string(&path).map_err(|_| {
                let have = list_plans(ws);
                format!("No plan file {}. Plan files: {}", name, if have.is_empty() { "none".into() } else { have.join(", ") })
            })
        }
        None => {
            let have = list_plans(ws);
            Ok(if have.is_empty() { "No plan files yet.".into() } else { have.join("\n") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_reads_plans_inside_plan_only() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        save_plan(Some(ws), &json!({ "name": "shotlist.json", "content": [{ "line": 1 }] })).unwrap();
        let text = read_plan(Some(ws), &json!({ "name": "shotlist.json" })).unwrap();
        assert!(text.contains("\"line\": 1"));
        assert_eq!(read_plan(Some(ws), &json!({})).unwrap(), "shotlist.json");
        assert!(save_plan(Some(ws), &json!({ "name": "../x.json", "content": "a" })).is_err());
        assert!(save_plan(Some(ws), &json!({ "name": ".hidden", "content": "a" })).is_err());
        assert!(read_plan(Some(ws), &json!({ "name": "missing.json" })).unwrap_err().contains("shotlist.json"));
    }

    #[test]
    fn finds_skills_by_name_or_folder_project_first() {
        let tmp = tempfile::tempdir().unwrap();
        let (ws, lib) = (tmp.path().join("ws"), tmp.path().join("lib"));
        for (root, body) in [(ws.join(SKILLS_DIR), "project"), (lib.join("skills"), "library")] {
            fs::create_dir_all(root.join("plan-it")).unwrap();
            fs::write(root.join("plan-it/SKILL.md"), format!("---\nname: planner\ndescription: d\n---\n{body}")).unwrap();
        }
        let got = read_skill(Some(&ws), Some(&lib), &json!({ "name": "planner" })).unwrap();
        assert!(got.ends_with("project"));
        assert!(read_skill(Some(&ws), Some(&lib), &json!({ "name": "plan-it" })).is_ok());
        assert!(read_skill(Some(&ws), Some(&lib), &json!({ "name": "nope" })).unwrap_err().contains("planner"));
    }
}
