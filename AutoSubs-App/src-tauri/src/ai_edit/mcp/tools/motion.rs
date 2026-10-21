//! `render_motion`: render a Remotion motion graphic from the project's
//! motion-graphics/ folder into exports/ and wait for the file (see
//! `media::remotion` for the shared kit it runs on). `preview_motion` renders
//! a few frames into a contact sheet first, so the agent sees what it wrote
//! before paying for the full render. Listed when the run has a workspace,
//! like the download tools; neither touches the timeline.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::{assets, tool};
use crate::media::analyze;
use crate::media::remotion::{self, RenderRequest, StillsRequest, STARTER_NAME};

/// Frames a preview takes by default, at most, and per sheet.
const DEFAULT_FRAMES: usize = 12;
const MAX_FRAMES: usize = 24;
const FRAMES_PER_SHEET: usize = 12;

pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "preview_motion",
            "Look at a Remotion motion graphic before rendering it: renders a few frames (about 5 s, \
             no video) into a JPEG contact sheet, each tile labelled with its time; transparent areas \
             show as a grey checkerboard. Open the sheet and check text fits, nothing is cut off, \
             spacing, colours and the motion over time, fix src/ and preview again, then \
             render_motion. frames spreads that many over the whole graphic (default 12); atSec \
             looks at exact times (1 or 2 times give big tiles, for a close look).",
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Folder name inside motion-graphics/" },
                    "composition": { "type": "string", "description": "Composition id (default \"Main\")" },
                    "props": { "type": "object", "description": "Input props for the composition" },
                    "frames": { "type": "integer", "minimum": 1, "maximum": MAX_FRAMES, "description": "How many frames, spread evenly (default 12)" },
                    "atSec": { "type": "array", "items": { "type": "number" }, "maxItems": MAX_FRAMES, "description": "Exact times to look at, instead of frames" }
                },
                "required": ["project"]
            }),
        ),
        tool(
            "render_motion",
            format!(
                "Render a Remotion motion graphic and wait until the file is written, then place it with \
                 build_storyboard. project is a folder in the project's motion-graphics/: make it by copying \
                 templates/motion-graphics/{} (already set up, needs no install) and editing src/Scene.tsx \
                 and src/Root.tsx (read the remotion-motion skill first for the libraries the kit has). \
                 Check it with preview_motion before rendering. Never run npm, pnpm or remotion \
                 yourself. transparent (default true) renders ProRes 4444 with alpha (.mov) for \
                 overlays; false renders H.264 (.mp4) for full-frame cards. props are passed to the composition. The first render installs \
                 Remotion, which takes a minute or two.",
                STARTER_NAME
            ),
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Folder name inside motion-graphics/" },
                    "composition": { "type": "string", "description": "Composition id (default \"Main\")" },
                    "output": { "type": "string", "description": "File name in exports/ without extension (default: the project name)" },
                    "transparent": { "type": "boolean", "description": "ProRes 4444 with alpha (default true), else H.264 MP4" },
                    "props": { "type": "object", "description": "Input props for the composition" }
                },
                "required": ["project"]
            }),
        ),
    ]
}

/// A plain file or folder name: no separators or `..`, so the agent can only
/// render inside its own workspace.
fn plain_name(value: Option<&str>, what: &str) -> Result<Option<String>, String> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    if v.contains(['/', '\\']) || v == "." || v == ".." {
        return Err(format!("{} must be a plain name, not a path: {}", what, v));
    }
    Ok(Some(v.to_string()))
}

pub async fn call(app: &AppHandle, workspace: Option<&Path>, name: &str, args: &Value) -> Option<Result<String, String>> {
    match name {
        "render_motion" => Some(render(app, workspace, args).await),
        "preview_motion" => Some(preview(app, workspace, args).await),
        _ => None,
    }
}

/// The project folder named by `project`, which must exist.
fn project_dir(workspace: &Path, args: &Value) -> Result<(String, PathBuf), String> {
    let project_name = plain_name(args.get("project").and_then(|v| v.as_str()), "project")?
        .ok_or("project is required: a folder name inside motion-graphics/.")?;
    let project = workspace.join("motion-graphics").join(&project_name);
    if !project.is_dir() {
        return Err(format!(
            "There is no motion-graphics/{} folder. Copy templates/motion-graphics/{} there first.",
            project_name, STARTER_NAME
        ));
    }
    Ok((project_name, project))
}

fn composition(args: &Value) -> &str {
    args.get("composition").and_then(|v| v.as_str()).filter(|c| !c.trim().is_empty()).unwrap_or("Main")
}

async fn preview(app: &AppHandle, workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let workspace = workspace.ok_or("This run has no project workspace.")?;
    let (project_name, project) = project_dir(workspace, args)?;
    let at_sec: Vec<f64> = args
        .get("atSec")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_f64()).filter(|t| *t >= 0.0).take(MAX_FRAMES).collect())
        .unwrap_or_default();
    let count = args.get("frames").and_then(|v| v.as_u64()).map(|n| n as usize).unwrap_or(DEFAULT_FRAMES).clamp(1, MAX_FRAMES);
    let tiles = if at_sec.is_empty() { count } else { at_sec.len() };
    let out_dir = analyze::analysis_root(workspace).join(format!("motion-{}", project_name));

    let (stills, installed) = remotion::stills(
        app,
        StillsRequest {
            project: &project,
            composition: composition(args),
            props: args.get("props"),
            out_dir: &out_dir,
            count,
            at_sec,
            max_side: if tiles <= 2 { 960 } else { 480 },
        },
    )
    .await?;
    let sheets = {
        let out_dir = out_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            remotion::contact_sheet(&stills, &out_dir, FRAMES_PER_SHEET).map(|sheets| (stills, sheets))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let (stills, sheets) = sheets;

    let mut out = format!(
        "{} {}: {}x{}, {} fps, {:.1}s ({} frames).",
        project_name,
        composition(args),
        stills.width,
        stills.height,
        stills.fps,
        stills.duration_in_frames as f64 / stills.fps,
        stills.duration_in_frames
    );
    if installed {
        out.push_str(" Remotion was installed first (one time).");
    }
    out.push_str(" Contact sheets (tile times in seconds):");
    for (path, times) in &sheets {
        let times: Vec<String> = times.iter().map(|t| format!("{:.2}", t)).collect();
        out.push_str(&format!("\n- {} ({})", path.display(), times.join(", ")));
    }
    Ok(out)
}

async fn render(app: &AppHandle, workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let workspace = workspace.ok_or("This run has no project workspace.")?;
    let (project_name, project) = project_dir(workspace, args)?;
    let output_name = plain_name(args.get("output").and_then(|v| v.as_str()), "output")?.unwrap_or(project_name);
    let transparent = args.get("transparent").and_then(|v| v.as_bool()).unwrap_or(true);
    let output = workspace
        .join("exports")
        .join(format!("{}.{}", output_name, if transparent { "mov" } else { "mp4" }));
    let composition = composition(args);

    let (took, installed) = remotion::render(
        app,
        RenderRequest { project: &project, composition, output: &output, transparent, props: args.get("props") },
    )
    .await?;
    let size_mb = std::fs::metadata(&output).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
    Ok(format!(
        "Rendered {} ({:.0} MB, {}) in {:.0}s{}.",
        assets::describe(workspace, &output),
        size_mb,
        if transparent { "ProRes 4444 with alpha" } else { "H.264" },
        took.as_secs_f64(),
        if installed { "; Remotion was installed first (one time)" } else { "" }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_the_workspace() {
        assert_eq!(plain_name(Some(" wave "), "project").unwrap(), Some("wave".into()));
        assert_eq!(plain_name(None, "project").unwrap(), None);
        assert!(plain_name(Some("../etc"), "project").is_err());
        assert!(plain_name(Some("a/b"), "project").is_err());
        assert!(plain_name(Some(".."), "project").is_err());
    }
}
