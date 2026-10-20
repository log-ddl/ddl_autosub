import type { EditTarget } from "@/api/ai-edit-api";
import type { WorkspaceInfo } from "@/api/cli-chat-api";

/**
 * Everything the AI Edit tab needs to know about one editor. Each editor has
 * its own file next to this one (davinci.ts, premiere.ts, capcut.ts); the
 * controller only talks to this interface, so editor-specific behaviour never
 * leaks into it. Mirrors `src-tauri/src/ai_edit/editors/` on the Rust side.
 */
export interface EditorAdapter {
  /** Backend target for edits and MCP tools; null when AI Edit has no backend for this editor. */
  target: EditTarget | null;
  /** What a conversation is bound to (draft id, timeline or sequence name). */
  projectId: string | null;
  /** Human-readable project name, also used for the workspace folder. */
  projectName: string | null;
  /** Shown in the empty chat ("Điều khiển trực tiếp ..."). */
  title: string;
  /** Re-read the editor after an edit so the UI shows the new state. */
  refreshAfterEdit: () => Promise<void>;
  /** System prompt for one message; may read a fresh timeline snapshot first. */
  buildPrompt: (
    userSystemPrompt: string,
    workspaceInfo: WorkspaceInfo | null,
    useTools: boolean,
  ) => Promise<string>;
}
