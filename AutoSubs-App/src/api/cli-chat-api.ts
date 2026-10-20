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
  category: "motion-graphics" | "ai-broll" | "exports" | "templates" | string;
  isDir: boolean;
  sizeBytes: number;
  modifiedSec: number;
}

export interface WorkspaceInfo {
  path: string;
  globalPath: string;
  projectSlug: string;
  memory: string;
  globalMemory: string;
  motionGraphicsDir: string;
  aiBrollDir: string;
  exportsDir: string;
  templatesDir: string;
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
  projectName?: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("cli_ensure_workspace", {
    workspacePath: workspacePath || null,
    projectName: projectName || null,
  });
}

export async function saveCliMemory(
  workspacePath: string | null | undefined,
  content: string,
  projectName?: string | null,
  globalContent?: string,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("cli_save_memory", {
    workspacePath: workspacePath || null,
    projectName: projectName || null,
    content,
    globalContent: globalContent !== undefined ? globalContent : null,
  });
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
  projectName?: string;
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
        projectName: params.projectName || null,
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
