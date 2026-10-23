import { invoke } from "@tauri-apps/api/core";
import type { EditTarget } from "@/api/ai-edit-api";
import { listen } from "@tauri-apps/api/event";

export type ContentCliAdapter = "agy" | "claude";

export interface CliStatusInfo {
  available: boolean;
  version?: string | null;
  error?: string | null;
  path?: string | null;
}

export interface CliRuntimeStatus {
  agy: CliStatusInfo;
  claude: CliStatusInfo;
}

export interface CliModelsResult {
  models: string[];
  efforts: string[];
  effortsByModel?: Record<string, string[]>;
  error?: string | null;
}

export interface ProjectAssetItem {
  name: string;
  path: string;
  /** Project: video, images, voice, music, sfx, motion-graphics, exports, skills. Shared: templates, library-music, library-sfx, library-skills. */
  category:
    | "video"
    | "images"
    | "voice"
    | "music"
    | "sfx"
    | "motion-graphics"
    | "exports"
    | "templates"
    | "library-music"
    | "library-sfx"
    | "skills"
    | "library-skills"
    | string;
  isDir: boolean;
  sizeBytes: number;
  modifiedSec: number;
}

/** The editor project a workspace folder belongs to (one folder per project). */
export interface WorkspaceProject {
  editor: string;
  name: string | null;
  /** Tells apart projects with the same name: Resolve id, .prproj path, CapCut draft id. */
  id: string | null;
  /** Timeline / sequence name older builds keyed the folder by; moved in on first use. */
  legacyName?: string | null;
}

export interface WorkspaceInfo {
  path: string;
  globalPath: string;
  projectSlug: string;
  memory: string;
  globalMemory: string;
  motionGraphicsDir: string;
  videoDir: string;
  imagesDir: string;
  voiceDir: string;
  musicDir: string;
  sfxDir: string;
  exportsDir: string;
  /** library/motion-graphics: shared templates. */
  templatesDir: string;
  libraryMusicDir: string;
  librarySfxDir: string;
  /** `.agent/skills` of this project; listed to the agent on every run. */
  skillsDir: string;
  /** library/skills: shared skills. */
  librarySkillsDir: string;
  assets: ProjectAssetItem[];
}

export interface RunCliTextResult {
  success: boolean;
  outputText: string;
  sessionId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  canceled: boolean;
  error?: string | null;
}

interface CliStreamEventPayload {
  requestId: string;
  eventType: string;
  chunk?: string | null;
  sessionId?: string | null;
}

export async function getCliRuntimeStatus(): Promise<CliRuntimeStatus> {
  return invoke<CliRuntimeStatus>("cli_get_status");
}

export async function getCliModels(
  adapter: ContentCliAdapter,
): Promise<CliModelsResult> {
  return invoke<CliModelsResult>("cli_get_models", { adapter });
}

export async function ensureCliWorkspace(
  workspacePath?: string | null,
  project?: WorkspaceProject | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("cli_ensure_workspace", {
    workspacePath: workspacePath || null,
    project: project || null,
  });
}

export async function saveCliMemory(
  workspacePath: string | null | undefined,
  content: string,
  project?: WorkspaceProject | null,
  globalContent?: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("cli_save_memory", {
    workspacePath: workspacePath || null,
    project: project || null,
    content,
    globalContent: globalContent !== undefined ? globalContent : null,
  });
}

/** Copies a project asset into the template library, or a template into a project. Returns the new path. */
/** One project folder AI Edit keeps (media, motion graphics, exports). */
export interface WorkspaceProjectEntry {
  path: string;
  editor: string;
  name: string;
  id: string | null;
  sizeBytes: number;
  lastUsedSec: number;
}

export async function listWorkspaceProjects(): Promise<WorkspaceProjectEntry[]> {
  return invoke<WorkspaceProjectEntry[]>("cli_list_workspace_projects");
}

/** Moves the project's folder to the Trash; the project in the editor is untouched. */
export async function deleteWorkspaceProject(path: string): Promise<void> {
  return invoke<void>("cli_delete_workspace_project", { path });
}

/** Whether a conversation's files live in this project folder. */
export function conversationUsesProject(
  workspace: WorkspaceProject | null | undefined,
  entry: WorkspaceProjectEntry,
): boolean {
  if (!workspace || workspace.editor !== entry.editor) return false;
  return entry.id ? workspace.id === entry.id : !workspace.id && workspace.name === entry.name;
}

/** Shared library entries (templates, music and SFX packs), not this project's own files. */
export function isLibraryAsset(asset: ProjectAssetItem): boolean {
  return asset.category === "templates" || asset.category.startsWith("library-");
}

export async function copyCliAsset(
  source: string,
  destinationDir: string,
): Promise<string> {
  return invoke<string>("cli_copy_asset", { source, destinationDir });
}

/** Copies the skills in `source` (itself, or its subfolders with a SKILL.md) into `destinationDir`. */
export async function importCliSkills(
  source: string,
  destinationDir: string,
): Promise<string[]> {
  return invoke<string[]>("cli_import_skills", { source, destinationDir });
}

export async function cancelCliTextTask(requestId: string): Promise<boolean> {
  return invoke<boolean>("cli_cancel_text_task", { requestId });
}

export async function runCliTextTask(params: {
  adapter: ContentCliAdapter;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  effort?: string;
  sessionKey?: string;
  workingDirectory?: string;
  project?: WorkspaceProject | null;
  /** Editor and project for the AutoSubs MCP tools. */
  editTarget?: EditTarget;
  /** Let the MCP tools edit the timeline (Turbo); otherwise read-only. */
  allowEdits?: boolean;
  onChunk?: (chunk: string) => void;
  onThinking?: (thinkingChunk: string) => void;
  onStep?: (stepInfo: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  if (params.signal?.aborted) {
    throw new Error("Cancelled by user");
  }

  const requestId = crypto.randomUUID();
  const unlisten = await listen<CliStreamEventPayload>(
    "cli-chat-event",
    (event) => {
      const p = event.payload;
      if (!p || p.requestId !== requestId) return;
      if (p.eventType === "chunk" && p.chunk) {
        params.onChunk?.(p.chunk);
      } else if (p.eventType === "thinking" && p.chunk) {
        params.onThinking?.(p.chunk);
      } else if (p.eventType === "step" && p.chunk) {
        params.onStep?.(p.chunk);
      }
    },
  );

  const onAbort = () => {
    void cancelCliTextTask(requestId);
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await invoke<RunCliTextResult>("cli_run_text_task", {
      payload: {
        adapter: params.adapter,
        prompt: params.prompt,
        systemPrompt: params.systemPrompt || null,
        model: params.model || null,
        effort: params.effort || null,
        sessionKey: params.sessionKey || null,
        requestId,
        workingDirectory: params.workingDirectory || null,
        project: params.project || null,
        editTarget: params.editTarget ?? null,
        allowEdits: params.allowEdits ?? false,
      },
    });

    if (params.signal?.aborted || res.canceled) {
      throw new Error("Cancelled by user");
    }
    if (!res.success || !res.outputText) {
      throw new Error(res.error || "CLI text generation failed");
    }
    return res.outputText;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    unlisten();
  }
}
