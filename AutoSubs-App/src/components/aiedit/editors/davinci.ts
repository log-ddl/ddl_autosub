import * as React from "react";
import { getEditTimeline, type EditTarget } from "@/api/ai-edit-api";
import { useResolve } from "@/contexts/ResolveContext";
import { buildDavinciPrompt, type DavinciTimelineSnapshot } from "../prompts";
import type { EditorAdapter } from "./types";

const TARGET: EditTarget = { integration: "davinci", draftId: null };

/** AI Edit adapter for DaVinci Resolve: always edits the open timeline. */
export function useDavinciAdapter(): EditorAdapter {
  const { timelineInfo, refresh } = useResolve();
  const name = timelineInfo?.name || null;

  return React.useMemo(
    () => ({
      target: TARGET,
      projectId: name,
      projectName: name,
      title: "DaVinci Resolve",
      refreshAfterEdit: refresh,
      buildPrompt: async (userSystemPrompt, workspaceInfo, useTools) => {
        // The clip list is read fresh per message.
        let snapshot: DavinciTimelineSnapshot | null = null;
        try {
          snapshot = (await getEditTimeline(TARGET)) as DavinciTimelineSnapshot;
        } catch {
          snapshot = null;
        }
        return buildDavinciPrompt(name ?? undefined, snapshot, userSystemPrompt, workspaceInfo, useTools);
      },
    }),
    [name, refresh],
  );
}
