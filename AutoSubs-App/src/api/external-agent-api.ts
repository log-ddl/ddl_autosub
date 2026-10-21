import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EditTarget } from "@/api/ai-edit-api";
import type { WorkspaceProject } from "@/api/cli-chat-api";

/** One agent app (Claude Code, Antigravity, ...) that connected this session. */
export interface ExternalAgentClient {
  label: string;
  name: string;
  version: string;
  connectedSec: number;
  lastSeenSec: number;
  lastTool: string | null;
  lastToolSec: number | null;
  /** Called a tool in the last two minutes. */
  active: boolean;
}

/** Mirrors `external::Status` in src-tauri/src/ai_edit/mcp/external.rs. */
export interface ExternalAgentStatus {
  enabled: boolean;
  listening: boolean;
  error: string | null;
  url: string;
  token: string;
  serverName: string;
  /** Folder to open an agent app in (default ~/Documents/AutoSub). */
  home: string;
  editor: string | null;
  project: string | null;
  clients: ExternalAgentClient[];
  /** Label of the client driving right now. */
  controller: string | null;
  claudeInstalled: boolean;
  agyInstalled: boolean;
  /** The desktop apps the open buttons launch. */
  claudeApp: boolean;
  antigravityApp: boolean;
  claudeRegistered: boolean;
  agyRegistered: boolean;
  nowSec: number;
}

export const EXTERNAL_AGENT_STATUS_EVENT = "external-agent-status";

export function getExternalAgentStatus(): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>("external_agent_status");
}

export function setExternalAgentEnabled(enabled: boolean): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>("external_agent_set_enabled", { enabled });
}

export function setExternalAgentHome(home: string): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>("external_agent_set_home", { home });
}

/** Registers the server with an installed agent CLI for the user. */
export function connectExternalAgent(client: "claude" | "agy"): Promise<ExternalAgentStatus> {
  return invoke<ExternalAgentStatus>("external_agent_connect", { client });
}

/**
 * Opens the agent folder in Claude (a Code session, else Claude Code in a
 * terminal) or Antigravity. False when the app opened without the folder.
 */
export function openExternalAgentApp(which: "claude" | "antigravity"): Promise<boolean> {
  return invoke<boolean>("external_agent_open_app", { which });
}

/** The editor project external agents act on; pushed whenever it changes. */
export function setExternalAgentTarget(
  target: EditTarget | null,
  project: WorkspaceProject | null,
  label: string | null,
): Promise<void> {
  return invoke("external_agent_set_target", { target, project, label });
}

export function onExternalAgentStatus(cb: (s: ExternalAgentStatus) => void): Promise<UnlistenFn> {
  return listen<ExternalAgentStatus>(EXTERNAL_AGENT_STATUS_EVENT, (e) => cb(e.payload));
}
