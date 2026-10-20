//! `render_motion`: render a Remotion motion graphic from the project's
//! motion-graphics/ folder into exports/ and wait for the file (see
//! `media::remotion` for the shared kit it runs on). Listed when the run has
//! a workspace, like the download tools; it never touches the timeline.

use std::path::Path;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::tool;
use crate::media::remotion::{self, RenderRequest, STARTER_NAME};

pub fn tools() -> Vec<Value> {
    vec![tool(
        "render_motion",
        format!(
            "Render a Remotion motion graphic and wait until the file is written, then place it with \
             build_storyboard. project is a folder in the project's motion-graphics/: make it by copying \
             templates/motion-graphics/{} (already set up, needs no install) and editing src/Scene.tsx \
             and src/Root.tsx. Never run npm, pnpm or remotion yourself. transparent (default true) \
             renders ProRes 4444 with alpha (.mov) for overlays; false renders H.264 (.mp4) for \
             full-frame cards. props are passed to the composition. The first render installs \
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
    )]
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
    if name != "render_motion" {
        return None;
    }
    Some(render(app, workspace, args).await)
}

async fn render(app: &AppHandle, workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let workspace = workspace.ok_or("This run has no project workspace.")?;
    let project_name = plain_name(args.get("project").and_then(|v| v.as_str()), "project")?
        .ok_or("project is required: a folder name inside motion-graphics/.")?;
    let project = workspace.join("motion-graphics").join(&project_name);
    if !project.is_dir() {
        return Err(format!(
            "There is no motion-graphics/{} folder. Copy templates/motion-graphics/{} there first.",
            project_name, STARTER_NAME
        ));
    }
    let output_name = plain_name(args.get("output").and_then(|v| v.as_str()), "output")?.unwrap_or(project_name);
    let transparent = args.get("transparent").and_then(|v| v.as_bool()).unwrap_or(true);
    let output = workspace
        .join("exports")
        .join(format!("{}.{}", output_name, if transparent { "mov" } else { "mp4" }));
    let composition = args.get("composition").and_then(|v| v.as_str()).filter(|c| !c.trim().is_empty()).unwrap_or("Main");

    let (took, installed) = remotion::render(
        app,
        RenderRequest { project: &project, composition, output: &output, transparent, props: args.get("props") },
    )
    .await?;
    let size_mb = std::fs::metadata(&output).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
    Ok(format!(
        "Rendered {} ({:.0} MB, {}) in {:.0}s{}.",
        output.display(),
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
