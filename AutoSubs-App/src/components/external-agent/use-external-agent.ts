import * as React from "react";
import { useIntegration } from "@/contexts/IntegrationContext";
import { useEditorAdapter } from "@/components/aiedit/editors";
import {
  getExternalAgentStatus,
  onExternalAgentStatus,
  setExternalAgentTarget,
  type ExternalAgentStatus,
} from "@/api/external-agent-api";

/**
 * Tells the backend which editor project external agents should act on: the
 * one the app has open, through the same adapter the AI Edit tab uses.
 * Mounted once for the whole app, so it follows the editor on every tab.
 */
export function useExternalAgentTargetSync() {
  const { selectedIntegration } = useIntegration();
  const adapter = useEditorAdapter(selectedIntegration);
  const project = adapter.workspaceProject;
  const label = project?.name || adapter.projectName || null;
  const key = JSON.stringify([adapter.target, project, label]);

  React.useEffect(() => {
    // An editor project only counts once the app has read it from the editor.
    const target = project ? adapter.target : null;
    setExternalAgentTarget(target, project, label).catch((err) =>
      console.warn("[ExternalAgent] could not set target:", err),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Live status of the external agents' connection, refreshed by backend events. */
export function useExternalAgentStatus(): [ExternalAgentStatus | null, (s: ExternalAgentStatus) => void] {
  const [status, setStatus] = React.useState<ExternalAgentStatus | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const load = () =>
      getExternalAgentStatus()
        .then((s) => !disposed && setStatus(s))
        .catch(() => {});
    void load();
    const unlisten = onExternalAgentStatus((s) => !disposed && setStatus(s));
    // "Driving" fades after two minutes without a tool call; re-read so it does.
    const timer = window.setInterval(load, 15000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void unlisten.then((u) => u());
    };
  }, []);

  return [status, setStatus];
}

/** "12s", "3 min", "2 h" since a unix time. */
export function ago(sec: number | null | undefined, nowSec: number): string {
  if (!sec) return "";
  const d = Math.max(0, nowSec - sec);
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  return `${Math.floor(d / 3600)} h`;
}
