import { invoke } from "@tauri-apps/api/core";

/** Which editor and project an AI Edit conversation works on. */
export interface EditTarget {
  integration: "davinci" | "capcut" | "premiere";
  /** CapCut draft id; DaVinci and Premiere always edit the open timeline. */
  draftId?: string | null;
  /** Transcript open in the app, which the agent's get_transcript reads first. */
  transcriptFile?: string | null;
}

export interface ActionOutcome {
  /** One-line result. */
  message: string;
  /** Per-item details (skipped markers, ignored fields, ...). */
  lines: string[];
  /** True when part of the action was not applied. */
  partial: boolean;
}

/**
 * Run one timeline action (build_storyboard, add_marker, add_text,
 * update_segment, delete_segment, split_clips, remove_ranges). The same Rust
 * code serves the MCP tools.
 */
export async function executeTimelineAction(
  target: EditTarget,
  action: Record<string, unknown>,
  /** Project workspace: media from outside it is copied into its media/ folder first. */
  workspace?: string | null,
): Promise<ActionOutcome> {
  return invoke<ActionOutcome>("ai_edit_execute_action", {
    target,
    action,
    workspace: workspace || null,
  });
}

/** Tracks, clips and markers of the target timeline, as the agent sees them. */
export async function getEditTimeline(target: EditTarget): Promise<unknown> {
  return invoke("ai_edit_get_timeline", { target });
}
