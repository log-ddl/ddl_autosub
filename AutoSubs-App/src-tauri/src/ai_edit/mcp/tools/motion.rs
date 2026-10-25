//! `render_motion`: render a Remotion motion graphic from the project's
//! motion-graphics/ folder into exports/ and wait for the file (see
//! `media::remotion` for the shared kit it runs on). `preview_motion` renders
//! a few frames into a contact sheet first, so the agent sees what it wrote
//! before paying for the full render. Listed when the run has a workspace,
//! like the download tools; neither touches the timeline.
//!
//! Every render is a job in one app-wide queue (`remotion::RENDER_SLOTS` at a
//! time), so many agents can hand renders in without loading the machine.
//! `wait: false` only queues it; `render_status` lists the jobs and can wait
//! for them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::{assets, tool};
use crate::media::analyze;
use crate::media::remotion::{self, RenderRequest, StillsRequest, STARTER_NAME};

/// Frames a preview takes by default, at most, and per sheet.
const DEFAULT_FRAMES: usize = 12;
const MAX_FRAMES: usize = 24;
const FRAMES_PER_SHEET: usize = 12;

/// Longest a tool call waits for renders: under the CLIs' 30 min tool
/// timeout (`MCP_TOOL_TIMEOUT`). The render itself goes on after that.
const MAX_WAIT: Duration = Duration::from_secs(25 * 60);
/// Finished jobs kept for `render_status`.
const KEEP_FINISHED: usize = 200;

/// One `render_motion` call.
struct Job {
    id: String,
    workspace: PathBuf,
    output: PathBuf,
    state: JobState,
}

enum JobState {
    Queued,
    Rendering(Instant),
    /// The line `render_motion` answers with.
    Done(String),
    Failed(String),
}

impl JobState {
    fn finished(&self) -> bool {
        matches!(self, JobState::Done(_) | JobState::Failed(_))
    }
}

static JOBS: Lazy<Mutex<Vec<Job>>> = Lazy::new(|| Mutex::new(Vec::new()));
static NEXT_JOB: AtomicUsize = AtomicUsize::new(1);

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
                 Remotion, which takes a minute or two. Renders take turns across the whole app ({} at a \
                 time), others wait in line. wait (default true) answers when the file is written, or \
                 after 25 min with the job still going; wait false only queues it and answers at once with \
                 a job id, so you can keep working: place the file once render_status says it is done.",
                STARTER_NAME,
                remotion::RENDER_SLOTS
            ),
            json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Folder name inside motion-graphics/" },
                    "composition": { "type": "string", "description": "Composition id (default \"Main\")" },
                    "output": { "type": "string", "description": "File name in exports/ without extension (default: the project name)" },
                    "transparent": { "type": "boolean", "description": "ProRes 4444 with alpha (default true), else H.264 MP4" },
                    "props": { "type": "object", "description": "Input props for the composition" },
                    "wait": { "type": "boolean", "description": "Wait for the file (default true); false only queues the render" }
                },
                "required": ["project"]
            }),
        ),
        tool(
            "render_status",
            "The project's Remotion renders: waiting (with how many are ahead), rendering, done (with the \
             file's media id) or failed (with why). waitSec waits up to that long (at most 1500) until \
             every listed render has finished, instead of asking again and again. ids picks renders \
             (job ids from render_motion, e.g. r3); default all of this project's.",
            json!({
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "description": "Job ids; default all" },
                    "waitSec": { "type": "number", "minimum": 0, "maximum": 1500, "description": "Wait until these renders finish, at most this long" }
                }
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
        "render_status" => Some(status(workspace, args).await),
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
    let wait = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);
    let output = workspace
        .join("exports")
        .join(format!("{}.{}", output_name, if transparent { "mov" } else { "mp4" }));
    let id = enqueue(workspace, &output)?;

    let (app, job_id, ws, composition, props) = (
        app.clone(),
        id.clone(),
        workspace.to_path_buf(),
        composition(args).to_string(),
        args.get("props").cloned(),
    );
    tauri::async_runtime::spawn(async move {
        let started = job_id.clone();
        let result = remotion::render(
            &app,
            RenderRequest { project: &project, composition: &composition, output: &output, transparent, props: props.as_ref() },
            move || set_state(&started, JobState::Rendering(Instant::now())),
        )
        .await;
        let state = match result {
            Ok((took, installed)) => JobState::Done(rendered_line(&ws, &output, transparent, took, installed)),
            Err(e) => JobState::Failed(e),
        };
        set_state(&job_id, state);
    });

    if !wait {
        let lines = job_lines(workspace, Some(&[id.clone()]));
        return Ok(format!("Queued as {}. {}", id, lines.join(" ")));
    }
    wait_for(workspace, Some(&[id.clone()]), MAX_WAIT).await;
    let jobs = JOBS.lock().unwrap();
    match jobs.iter().find(|j| j.id == id).map(|j| &j.state) {
        Some(JobState::Done(line)) => Ok(line.clone()),
        Some(JobState::Failed(e)) => Err(e.clone()),
        _ => Ok(format!(
            "Still rendering as {} after {} min; it goes on. Check it with render_status (waitSec to wait).",
            id,
            MAX_WAIT.as_secs() / 60
        )),
    }
}

/// `render_status`: the project's jobs, after waiting for them if asked.
async fn status(workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let workspace = workspace.ok_or("This run has no project workspace.")?;
    let ids: Option<Vec<String>> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_str()).map(|i| i.trim().to_string()).collect())
        .filter(|ids: &Vec<String>| !ids.is_empty());
    let wait = args.get("waitSec").and_then(|v| v.as_f64()).unwrap_or(0.0).clamp(0.0, MAX_WAIT.as_secs_f64());
    if wait > 0.0 {
        wait_for(workspace, ids.as_deref(), Duration::from_secs_f64(wait)).await;
    }
    let lines = job_lines(workspace, ids.as_deref());
    if lines.is_empty() {
        return Ok(match ids {
            Some(ids) => format!("No renders {} in this project.", ids.join(", ")),
            None => "No renders in this project yet.".into(),
        });
    }
    Ok(lines.join("\n"))
}

/// A new queued job for `output`, refused while another job still writes it.
fn enqueue(workspace: &Path, output: &Path) -> Result<String, String> {
    let mut jobs = JOBS.lock().unwrap();
    if let Some(busy) = jobs.iter().find(|j| j.output == output && !j.state.finished()) {
        return Err(format!(
            "{} is already being rendered as {}; wait for it (render_status) or pick another output.",
            rel(workspace, output),
            busy.id
        ));
    }
    let finished = jobs.iter().filter(|j| j.state.finished()).count();
    if finished >= KEEP_FINISHED {
        if let Some(oldest) = jobs.iter().position(|j| j.state.finished()) {
            jobs.remove(oldest);
        }
    }
    let id = format!("r{}", NEXT_JOB.fetch_add(1, Ordering::Relaxed));
    jobs.push(Job { id: id.clone(), workspace: workspace.to_path_buf(), output: output.to_path_buf(), state: JobState::Queued });
    Ok(id)
}

fn set_state(id: &str, state: JobState) {
    if let Some(job) = JOBS.lock().unwrap().iter_mut().find(|j| j.id == id) {
        job.state = state;
    }
}

fn selected(job: &Job, workspace: &Path, ids: Option<&[String]>) -> bool {
    job.workspace == workspace && ids.map_or(true, |ids| ids.iter().any(|i| i == &job.id))
}

/// Wait until every selected job has finished, or `limit` has passed.
async fn wait_for(workspace: &Path, ids: Option<&[String]>, limit: Duration) {
    let deadline = Instant::now() + limit;
    loop {
        let pending = JOBS.lock().unwrap().iter().any(|j| selected(j, workspace, ids) && !j.state.finished());
        if !pending || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// One line per selected job. A waiting job counts every job ahead of it in
/// the app-wide queue, other projects' included.
fn job_lines(workspace: &Path, ids: Option<&[String]>) -> Vec<String> {
    let jobs = JOBS.lock().unwrap();
    let mut ahead = 0;
    let mut lines = Vec::new();
    for job in jobs.iter() {
        let line = match &job.state {
            JobState::Queued => {
                let line = format!("waiting, {} render(s) ahead", ahead);
                ahead += 1;
                line
            }
            JobState::Rendering(since) => {
                ahead += 1;
                format!("rendering for {}", minutes(since.elapsed()))
            }
            JobState::Done(line) => format!("done. {}", line),
            JobState::Failed(e) => format!("failed: {}", e),
        };
        if selected(job, workspace, ids) {
            lines.push(format!("{} {}: {}", job.id, rel(workspace, &job.output), line));
        }
    }
    lines
}

/// `exports/x.mov`: the output inside the workspace.
fn rel(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn minutes(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 { format!("{} s", s) } else { format!("{} min {} s", s / 60, s % 60) }
}

fn rendered_line(workspace: &Path, output: &Path, transparent: bool, took: Duration, installed: bool) -> String {
    let size_mb = std::fs::metadata(output).map(|m| m.len() as f64 / 1_048_576.0).unwrap_or(0.0);
    format!(
        "Rendered {} ({:.0} MB, {}) in {:.0}s{}.",
        assets::describe(workspace, output),
        size_mb,
        if transparent { "ProRes 4444 with alpha" } else { "H.264" },
        took.as_secs_f64(),
        if installed { "; Remotion was installed first (one time)" } else { "" }
    )
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

    #[test]
    fn renders_queue_in_order_and_never_share_an_output() {
        let ws = std::env::temp_dir().join(format!("autosubs-jobs-{}", uuid::Uuid::new_v4().simple()));
        let a = enqueue(&ws, &ws.join("exports/a.mov")).unwrap();
        let b = enqueue(&ws, &ws.join("exports/b.mov")).unwrap();
        assert!(enqueue(&ws, &ws.join("exports/a.mov")).unwrap_err().contains(&a));

        set_state(&a, JobState::Rendering(Instant::now()));
        let lines = job_lines(&ws, None);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with(&format!("{} exports/a.mov: rendering", a)));
        assert!(lines[1].contains("waiting") && lines[1].starts_with(&b));

        set_state(&a, JobState::Failed("boom".into()));
        assert!(job_lines(&ws, Some(&[a.clone()]))[0].ends_with("failed: boom"));
        // A finished output can be rendered again.
        assert!(enqueue(&ws, &ws.join("exports/a.mov")).is_ok());
    }
}
