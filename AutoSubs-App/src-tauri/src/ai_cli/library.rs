//! The shared library's agent parts: skills and subagents every project uses.
//!
//! The app ships none: skills and subagents are the user's. Builds before
//! this one wrote defaults into `library/`; `remove_old_defaults` takes back
//! the ones the user never edited.
//!
//! Subagents live CLI-neutral in `library/agents/<name>.md` (frontmatter
//! `name`, `description`, `model: fast | inherit | strong`, then the
//! instructions). Before every run they are written into the project folder in
//! the form each CLI reads: `.claude/agents/` for Claude Code and
//! `.agents/agents/` for agy, with the model mapped to that CLI's names.

use std::fs;
use std::path::Path;

pub const AGENTS_DIR: &str = "agents";

/// Marks the subagent files the app wrote, so it only ever replaces or
/// removes its own.
pub const SYNC_MARK: &str = "# Written by AutoSubs from library/agents. Edit the library copy.";

/// Hashes of defaults the earliest builds wrote, before `DEFAULTS_RECORD`
/// existed: a file matching one is an untouched default.
const LEGACY_DEFAULTS: &[&str] = &["f8cb9e486740aac9", "b963ae54a6cc7dde", "04c053fd4d92c0f5"];

/// `library/<this>` remembers the hash of each default as last written.
const DEFAULTS_RECORD: &str = ".autosubs-defaults.json";

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// Removes the defaults earlier builds wrote into `library` and the user
/// never edited (their hash is still the one recorded), then folders left
/// empty. Edited ones stay as the user's own.
pub fn remove_old_defaults(library: &Path) {
    let record_path = library.join(DEFAULTS_RECORD);
    let record: std::collections::BTreeMap<String, String> = fs::read_to_string(&record_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut candidates: Vec<(std::path::PathBuf, Option<String>)> = record
        .into_iter()
        .map(|(rel, hash)| (library.join(rel), Some(hash)))
        .collect();
    for entry in fs::read_dir(library.join(AGENTS_DIR))
        .into_iter()
        .flatten()
        .flatten()
    {
        candidates.push((entry.path(), None));
    }
    for (path, recorded) in candidates {
        let Ok(bytes) = fs::read(&path) else { continue };
        let hash = fnv(&bytes);
        if recorded.as_deref() == Some(hash.as_str()) || LEGACY_DEFAULTS.contains(&hash.as_str()) {
            let _ = fs::remove_file(&path);
            if let Some(dir) = path.parent() {
                // The Remotion docs link earlier builds put next to `remotion-motion`.
                let reference = dir.join("reference");
                if fs::symlink_metadata(&reference).is_ok_and(|m| m.file_type().is_symlink()) {
                    let _ = fs::remove_file(&reference);
                }
                let _ = fs::remove_dir(dir);
            }
        }
    }
    let _ = fs::remove_file(&record_path);
}

struct Agent {
    name: String,
    description: String,
    model: String,
    body: String,
}

/// `name`, `description` and `model` from the frontmatter, the rest as body.
fn parse_agent(text: &str, fallback_name: &str) -> Option<Agent> {
    let rest = text.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let (front, body) = (&rest[..end], &rest[end + 4..]);
    let field = |key: &str| {
        front.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim() == key).then(|| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        })
    };
    Some(Agent {
        name: field("name")
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| fallback_name.to_string()),
        description: field("description").unwrap_or_default(),
        model: field("model").unwrap_or_else(|| "inherit".into()),
        body: body.trim_start_matches(['\r', '\n']).to_string(),
    })
}

#[derive(Clone, Copy)]
enum Cli {
    Claude,
    Agy,
}

impl Cli {
    fn dir(self) -> &'static str {
        match self {
            Cli::Claude => ".claude/agents",
            Cli::Agy => ".agents/agents",
        }
    }

    fn model(self, neutral: &str) -> String {
        match (self, neutral) {
            (Cli::Claude, "fast") => "haiku".into(),
            (Cli::Claude, "strong") => "opus".into(),
            (Cli::Agy, "fast") => "flash".into(),
            (Cli::Agy, "strong") => "pro".into(),
            (_, "inherit") | (_, "") => "inherit".into(),
            // Anything else is taken as that CLI's own model name.
            (_, other) => other.into(),
        }
    }

    fn render(self, a: &Agent) -> String {
        // JSON string quoting is valid YAML, and keeps colons in the text safe.
        let quote = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
        format!(
            "---\n{}\nname: {}\ndescription: {}\nmodel: {}\n---\n{}",
            SYNC_MARK,
            a.name,
            quote(&a.description),
            self.model(&a.model),
            a.body
        )
    }
}

fn read_agents(library: &Path) -> Vec<Agent> {
    let mut agents = Vec::new();
    if let Ok(rd) = fs::read_dir(library.join(AGENTS_DIR)) {
        let mut paths: Vec<_> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "md"))
            .collect();
        paths.sort();
        for p in paths {
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Some(agent) = fs::read_to_string(&p)
                .ok()
                .and_then(|t| parse_agent(&t, &stem))
            {
                agents.push(agent);
            }
        }
    }
    agents
}

/// Writes `agents` into `dir` in `cli`'s form, after removing the files a
/// previous sync wrote there (so a renamed or deleted agent goes away).
fn write_agents(agents: &[Agent], cli: Cli, dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if fs::read_to_string(e.path()).is_ok_and(|t| t.contains(SYNC_MARK)) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    if agents.is_empty() || fs::create_dir_all(dir).is_err() {
        return;
    }
    for a in agents {
        let path = dir.join(format!("{}.md", a.name));
        // A file the user put there by hand wins over the library.
        if path.exists() {
            continue;
        }
        let _ = fs::write(&path, cli.render(a));
    }
}

/// Writes `library/agents/*.md` into `workspace` for both CLIs and removes
/// app-written files whose library copy is gone. Returns the agent names.
pub fn sync_agents(library: &Path, workspace: &Path) -> Vec<String> {
    let agents = read_agents(library);
    for cli in [Cli::Claude, Cli::Agy] {
        write_agents(&agents, cli, &workspace.join(cli.dir()));
    }
    agents.into_iter().map(|a| a.name).collect()
}

/// Marked the skill folders older builds copied into the agent home.
pub const SKILL_MARK_FILE: &str = ".autosubs";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_untouched_old_defaults_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path();
        fs::create_dir_all(lib.join("skills/story-planning")).unwrap();
        fs::create_dir_all(lib.join("skills/footage-planning")).unwrap();
        fs::create_dir_all(lib.join("skills/mine")).unwrap();
        fs::write(lib.join("skills/story-planning/SKILL.md"), "shipped").unwrap();
        fs::write(
            lib.join("skills/footage-planning/SKILL.md"),
            "edited by the user",
        )
        .unwrap();
        fs::write(lib.join("skills/mine/SKILL.md"), "mine").unwrap();
        let record = serde_json::json!({
            "skills/story-planning/SKILL.md": fnv(b"shipped"),
            "skills/footage-planning/SKILL.md": fnv(b"shipped too"),
        });
        fs::write(lib.join(DEFAULTS_RECORD), record.to_string()).unwrap();

        remove_old_defaults(lib);

        assert!(
            !lib.join("skills/story-planning").exists(),
            "untouched: removed"
        );
        assert!(
            lib.join("skills/footage-planning/SKILL.md").is_file(),
            "edited: kept"
        );
        assert!(
            lib.join("skills/mine/SKILL.md").is_file(),
            "the user's own: kept"
        );
        assert!(!lib.join(DEFAULTS_RECORD).exists());
    }

    #[test]
    fn writes_agents_for_both_clis_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let (lib, ws) = (tmp.path().join("lib"), tmp.path().join("ws"));
        fs::create_dir_all(lib.join("agents")).unwrap();
        fs::write(
            lib.join("agents/viewer.md"),
            "---\nname: viewer\ndescription: Looks: at clips\nmodel: fast\n---\nDo the thing.\n",
        )
        .unwrap();
        fs::create_dir_all(ws.join(".claude/agents")).unwrap();
        fs::write(
            ws.join(".claude/agents/hand-made.md"),
            "---\nname: hand-made\n---\n",
        )
        .unwrap();

        assert_eq!(sync_agents(&lib, &ws), vec!["viewer"]);
        let claude = fs::read_to_string(ws.join(".claude/agents/viewer.md")).unwrap();
        let agy = fs::read_to_string(ws.join(".agents/agents/viewer.md")).unwrap();
        assert!(
            claude.contains("model: haiku") && claude.contains("description: \"Looks: at clips\"")
        );
        assert!(agy.contains("model: flash") && agy.ends_with("Do the thing.\n"));

        fs::remove_file(lib.join("agents/viewer.md")).unwrap();
        sync_agents(&lib, &ws);
        assert!(!ws.join(".claude/agents/viewer.md").exists());
        assert!(!ws.join(".agents/agents/viewer.md").exists());
        assert!(
            ws.join(".claude/agents/hand-made.md").is_file(),
            "never touch the user's own"
        );
    }
}
