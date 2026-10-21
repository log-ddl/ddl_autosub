import * as React from "react";
import i18n from "i18next";
import { getCapCutTimelineSnapshot, type CapCutTimelineSnapshot } from "@/api/capcut-api";
import { useCapCut } from "@/contexts/CapCutContext";
import { buildCapCutPrompt } from "../prompts";
import type { EditorAdapter } from "./types";

/**
 * AI Edit adapter for CapCut: edits the draft picked in the integration
 * status. Unlike DaVinci and Premiere, the draft snapshot is kept loaded (it
 * names the project) and reloaded after every edit.
 *
 * `active` keeps the draft from being read while another editor is selected.
 */
export function useCapCutAdapter(active: boolean): EditorAdapter {
  const { selectedDraftId, refresh } = useCapCut();
  const [snapshot, setSnapshot] = React.useState<CapCutTimelineSnapshot | null>(null);

  const loadSnapshot = React.useCallback(async () => {
    if (!active) return;
    try {
      setSnapshot(await getCapCutTimelineSnapshot(selectedDraftId || undefined));
    } catch (err) {
      console.warn("[AiEdit] Could not load CapCut snapshot:", err);
      setSnapshot(null);
    }
  }, [active, selectedDraftId]);

  React.useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  return React.useMemo(
    () => ({
      target: { integration: "capcut", draftId: selectedDraftId || null },
      projectId: snapshot?.draftId || selectedDraftId || null,
      projectName: snapshot?.draftName || null,
      workspaceProject:
        snapshot?.draftId || selectedDraftId
          ? {
              editor: "capcut",
              name: snapshot?.draftName || null,
              id: snapshot?.draftId || selectedDraftId || null,
            }
          : null,
      title: `CapCut (${snapshot?.draftName || i18n.t("aiEdit.notSelected")})`,
      refreshAfterEdit: async () => {
        await refresh();
        await loadSnapshot();
      },
      buildPrompt: async (userSystemPrompt, workspaceInfo, useTools) =>
        buildCapCutPrompt(snapshot, userSystemPrompt, workspaceInfo, useTools),
    }),
    [selectedDraftId, snapshot, refresh, loadSnapshot],
  );
}
