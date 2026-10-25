import * as React from "react";
import i18n from "i18next";
import { intro, userAndMemorySections, workspaceSection } from "../prompts/shared";
import { editorLabel } from "../ai-edit-helpers";
import { usePremiereAdapter } from "./premiere";
import type { EditorAdapter } from "./types";

export type { EditorAdapter } from "./types";

/**
 * The adapter for the selected editor. Adding an editor: a new file here, a
 * prompt in ../prompts, and a case below. Every adapter hook runs on every
 * render (rules of hooks); only the selected one is returned.
 */
export function useEditorAdapter(integration: string): EditorAdapter {
  const premiere = usePremiereAdapter();
  const unsupported = React.useMemo(() => unsupportedAdapter(integration), [integration]);

  switch (integration) {
    case "premiere":
      return premiere;
    default:
      return unsupported;
  }
}

/** An editor AI Edit cannot drive: chat only, no timeline tools. */
function unsupportedAdapter(integration: string): EditorAdapter {
  const name = editorLabel(integration);
  return {
    target: null,
    projectId: null,
    projectName: null,
    workspaceProject: null,
    title: i18n.t("aiEdit.unsupportedEditor", { name }),
    refreshAfterEdit: async () => {},
    buildPrompt: async (userSystemPrompt, workspaceInfo) =>
      [
        intro(name.toUpperCase()),
        `### Lưu ý: AI Edit chưa điều khiển được ${name}. Bạn chỉ có thể tư vấn và chuẩn bị file trong workspace, không có công cụ hay \`timeline-action\` nào để sửa timeline.`,
        ...workspaceSection(workspaceInfo),
        ...userAndMemorySections(userSystemPrompt, workspaceInfo),
      ].join("\n\n"),
  };
}
