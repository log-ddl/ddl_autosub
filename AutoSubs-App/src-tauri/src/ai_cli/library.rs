//! The shared library's agent parts: skills and subagents every project uses.
//!
//! The app ships defaults (`templates/library/`) and writes each one into
//! `library/` when it is missing there, or replaces it with a newer default
//! when the user never edited it, so the user's edits always stay.
//!
//! Subagents live CLI-neutral in `library/agents/<name>.md` (frontmatter
//! `name`, `description`, `model: fast | inherit | strong`, then the
//! instructions). Before every run they are written into the project folder in
//! the form each CLI reads: `.claude/agents/` for Claude Code and
//! `.agents/agents/` for agy, with the model mapped to that CLI's names.

use std::fs;
use std::path::Path;

/// Files shipped with the app, relative to `library/`.
const DEFAULTS: &[(&str, &str)] = &[
    ("agents/clip-analyst.md", include_str!("../../templates/library/agents/clip-analyst.md")),
    ("agents/footage-scout.md", include_str!("../../templates/library/agents/footage-scout.md")),
    (
        "skills/footage-planning/SKILL.md",
        include_str!("../../templates/library/skills/footage-planning/SKILL.md"),
    ),
    (
        "skills/remotion-motion/SKILL.md",
        include_str!("../../templates/library/skills/remotion-motion/SKILL.md"),
    ),
    (
        "skills/story-planning/SKILL.md",
        include_str!("../../templates/library/skills/story-planning/SKILL.md"),
    ),
    (
        "skills/premiere-full-edit/SKILL.md",
        include_str!("../../templates/library/skills/premiere-full-edit/SKILL.md"),
    ),
    (
        "skills/remotion-full-video/SKILL.md",
        include_str!("../../templates/library/skills/remotion-full-video/SKILL.md"),
    ),
    (
        "skills/remotion-premiere-hybrid/SKILL.md",
        include_str!("../../templates/library/skills/remotion-premiere-hybrid/SKILL.md"),
    ),
];

pub const AGENTS_DIR: &str = "agents";

/// Marks the subagent files the app wrote, so it only ever replaces or
/// removes its own.
pub const SYNC_MARK: &str = "# Written by AutoSubs from library/agents. Edit the library copy.";

/// Hashes of defaults earlier builds wrote, before `DEFAULTS_RECORD` existed:
/// a file matching one is an untouched default.
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

/// Writes every default `library` is missing, and updates the ones the user
/// left as they were.
pub fn seed_defaults(library: &Path) {
    let record_path = library.join(DEFAULTS_RECORD);
    let mut record: std::collections::BTreeMap<String, String> = fs::read_to_string(&record_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut changed = false;
    for (rel, contents) in DEFAULTS {
        let path = library.join(rel);
        let shipped = fnv(contents.as_bytes());
        let write = match fs::read(&path) {
            Err(_) => true,
            Ok(current) => {
                let current = fnv(&current);
                let untouched = record.get(*rel) == Some(&current) || LEGACY_DEFAULTS.contains(&current.as_str());
                untouched && current != shipped
            }
        };
        if write {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::write(&path, contents).is_ok() {
                record.insert(rel.to_string(), shipped);
                changed = true;
            }
        } else if !record.contains_key(*rel) && fs::read(&path).is_ok_and(|c| fnv(&c) == shipped) {
            record.insert(rel.to_string(), shipped);
            changed = true;
        }
    }
    if changed {
        if let Ok(text) = serde_json::to_string_pretty(&record) {
            let _ = fs::write(&record_path, text);
        }
    }
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
        name: field("name").filter(|n| !n.is_empty()).unwrap_or_else(|| fallback_name.to_string()),
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
        let mut paths: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "md")).collect();
        paths.sort();
        for p in paths {
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if let Some(agent) = fs::read_to_string(&p).ok().and_then(|t| parse_agent(&t, &stem)) {
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

/// Writes the library's agents into one CLI's own folder (`~/.claude/agents`
/// when `claude`, else agy's `~/.gemini/config/agents`).
pub fn sync_agents_to(library: &Path, dir: &Path, claude: bool) {
    write_agents(&read_agents(library), if claude { Cli::Claude } else { Cli::Agy }, dir);
}

/// Marks a skill folder the app copied, so the next sync may replace it.
const SKILL_MARK_FILE: &str = ".autosubs";

/// Copies every `library/skills/<name>` into `dest/<name>` (Claude Code's
/// skills folder), replacing earlier copies and leaving the user's own alone.
pub fn sync_skills(library: &Path, dest: &Path) {
    let Ok(rd) = fs::read_dir(library.join("skills")) else { return };
    let skills: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
    for src in skills {
        let Some(name) = src.file_name() else { continue };
        let to = dest.join(name);
        if to.exists() {
            if !to.join(SKILL_MARK_FILE).exists() {
                continue;
            }
            let _ = fs::remove_dir_all(&to);
        }
        if copy_dir(&src, &to).is_ok() {
            let _ = fs::write(to.join(SKILL_MARK_FILE), "Copied by AutoSubs from library/skills; edit the library copy.\n");
        }
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let (from, to) = (e.path(), dst.join(e.file_name()));
        // Links stay links: a skill's `reference/` points at the Remotion
        // kit, and Remotion's own skills link to each other.
        #[cfg(unix)]
        if e.file_type().is_ok_and(|t| t.is_symlink()) {
            let _ = fs::remove_file(&to);
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
            continue;
        }
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_untouched_defaults_only() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path();
        seed_defaults(lib);
        let path = lib.join("agents/footage-scout.md");
        // As if an older build had written it: recorded, then the default changed.
        fs::write(&path, "old default").unwrap();
        let mut record: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&fs::read_to_string(lib.join(DEFAULTS_RECORD)).unwrap()).unwrap();
        record.insert("agents/footage-scout.md".into(), fnv(b"old default"));
        fs::write(lib.join(DEFAULTS_RECORD), serde_json::to_string(&record).unwrap()).unwrap();
        seed_defaults(lib);
        assert_ne!(fs::read_to_string(&path).unwrap(), "old default", "untouched: updated");

        fs::write(&path, "my edit").unwrap();
        seed_defaults(lib);
        assert_eq!(fs::read_to_string(&path).unwrap(), "my edit", "edited: kept");
    }

    #[test]
    fn seeds_defaults_without_overwriting() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path();
        fs::create_dir_all(lib.join("agents")).unwrap();
        fs::write(lib.join("agents/clip-analyst.md"), "mine").unwrap();
        seed_defaults(lib);
        assert_eq!(fs::read_to_string(lib.join("agents/clip-analyst.md")).unwrap(), "mine");
        assert!(lib.join("agents/footage-scout.md").is_file());
        assert!(lib.join("skills/footage-planning/SKILL.md").is_file());
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
        fs::write(ws.join(".claude/agents/hand-made.md"), "---\nname: hand-made\n---\n").unwrap();

        assert_eq!(sync_agents(&lib, &ws), vec!["viewer"]);
        let claude = fs::read_to_string(ws.join(".claude/agents/viewer.md")).unwrap();
        let agy = fs::read_to_string(ws.join(".agents/agents/viewer.md")).unwrap();
        assert!(claude.contains("model: haiku") && claude.contains("description: \"Looks: at clips\""));
        assert!(agy.contains("model: flash") && agy.ends_with("Do the thing.\n"));

        fs::remove_file(lib.join("agents/viewer.md")).unwrap();
        sync_agents(&lib, &ws);
        assert!(!ws.join(".claude/agents/viewer.md").exists());
        assert!(!ws.join(".agents/agents/viewer.md").exists());
        assert!(ws.join(".claude/agents/hand-made.md").is_file(), "never touch the user's own");
    }

    #[test]
    fn copies_skills_and_keeps_the_users_own() {
        let tmp = tempfile::tempdir().unwrap();
        let (lib, dest) = (tmp.path().join("lib"), tmp.path().join("skills"));
        for name in ["a", "b"] {
            fs::create_dir_all(lib.join("skills").join(name)).unwrap();
            fs::write(lib.join("skills").join(name).join("SKILL.md"), format!("v1 {name}")).unwrap();
        }
        fs::create_dir_all(dest.join("b")).unwrap();
        fs::write(dest.join("b/SKILL.md"), "mine").unwrap();
        sync_skills(&lib, &dest);
        assert_eq!(fs::read_to_string(dest.join("a/SKILL.md")).unwrap(), "v1 a");
        assert_eq!(fs::read_to_string(dest.join("b/SKILL.md")).unwrap(), "mine");
        fs::write(lib.join("skills/a/SKILL.md"), "v2 a").unwrap();
        sync_skills(&lib, &dest);
        assert_eq!(fs::read_to_string(dest.join("a/SKILL.md")).unwrap(), "v2 a");
    }
}
