import * as React from "react";
import { getEditTimeline, type EditTarget } from "@/api/ai-edit-api";
import { useAdobe } from "@/contexts/AdobeContext";
import { buildPremierePrompt, type PremiereTimelineSnapshot } from "../prompts";
import type { EditorAdapter } from "./types";

const TARGET: EditTarget = { integration: "premiere" };

/** AI Edit adapter for Premiere Pro: always edits the active sequence. */
export function usePremiereAdapter(): EditorAdapter {
  const { timelineInfo: premiereTimeline, refresh } = useAdobe();
  const name = premiereTimeline?.name || null;
  // One asset folder per project; older bridges report no project, so the
  // timeline name stands in for it.
  const projectName = premiereTimeline?.projectName || name;
  const projectKey = premiereTimeline?.projectId || null;
  const workspaceProject = React.useMemo(
    () =>
      // Nothing read from the editor yet: no folder, rather than a shared one.
      projectName
        ? {
            editor: "premiere",
            name: projectName,
            id: projectKey,
            legacyName: name,
          }
        : null,
    [projectName, projectKey, name],
  );

  return React.useMemo(
    () => ({
      target: TARGET,
      projectId: name,
      projectName: name,
      workspaceProject,
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
    [name, workspaceProject, refresh],
  );
}
