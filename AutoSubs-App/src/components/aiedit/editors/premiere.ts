import * as React from "react";
import { getEditTimeline, type EditTarget } from "@/api/ai-edit-api";
import { useAdobe } from "@/contexts/AdobeContext";
import { buildPremierePrompt, type PremiereTimelineSnapshot } from "../prompts";
import type { EditorAdapter } from "./types";

const TARGET: EditTarget = { integration: "premiere", draftId: null };

/** AI Edit adapter for Premiere Pro: always edits the active sequence. */
export function usePremiereAdapter(): EditorAdapter {
  const { premiereTimeline, refresh } = useAdobe();
  const name = premiereTimeline?.name || null;

  return React.useMemo(
    () => ({
      target: TARGET,
      projectId: name,
      projectName: name,
      title: "Premiere Pro",
      refreshAfterEdit: refresh,
      buildPrompt: async (userSystemPrompt, workspaceInfo, useTools) => {
        // The clip list is read fresh per message, through the CEP panel.
        let snapshot: PremiereTimelineSnapshot | null = null;
        try {
          snapshot = (await getEditTimeline(TARGET)) as PremiereTimelineSnapshot;
        } catch {
          snapshot = null;
        }
        return buildPremierePrompt(name ?? undefined, snapshot, userSystemPrompt, workspaceInfo, useTools);
      },
    }),
    [name, refresh],
  );
}
