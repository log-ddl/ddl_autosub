import * as React from "react";
import { intro, userAndMemorySections, workspaceSection } from "../prompts/shared";
import { editorLabel } from "../ai-edit-helpers";
import { useCapCutAdapter } from "./capcut";
import { useDavinciAdapter } from "./davinci";
import { usePremiereAdapter } from "./premiere";
import type { EditorAdapter } from "./types";

export type { EditorAdapter } from "./types";

/**
 * The adapter for the selected editor. Adding an editor: a new file here, a
 * prompt in ../prompts, and a case below. Every adapter hook runs on every
 * render (rules of hooks); only the selected one is returned.
 */
export function useEditorAdapter(integration: string): EditorAdapter {
  const davinci = useDavinciAdapter();
  const premiere = usePremiereAdapter();
  const capcut = useCapCutAdapter(integration === "capcut");
  const unsupported = React.useMemo(() => unsupportedAdapter(integration), [integration]);

  switch (integration) {
    case "davinci":
      return davinci;
    case "premiere":
      return premiere;
    case "capcut":
      return capcut;
    default:
      return unsupported;
  }
}

/** An editor AI Edit cannot drive yet (After Effects): chat only, no timeline tools. */
function unsupportedAdapter(integration: string): EditorAdapter {
  const name = editorLabel(integration);
  return {
    target: null,
    projectId: null,
    projectName: null,
    workspaceProject: null,
    title: `${name} (AI Edit chưa hỗ trợ dựng)`,
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
