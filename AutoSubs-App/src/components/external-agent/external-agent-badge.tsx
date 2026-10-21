import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getExternalAgentStatus,
  openExternalAgentApp,
  setExternalAgentEnabled,
} from "@/api/external-agent-api";
import { ExternalAgentStatusLines, StatusDot } from "./external-agent-panel";
import { useExternalAgentStatus, useExternalAgentTargetSync } from "./use-external-agent";

/** Keeps the backend's external-agent target on the editor project the app has open. */
export function ExternalAgentSync() {
  useExternalAgentTargetSync();
  return null;
}

/**
 * A dot next to the Settings button while external agents are on: green
 * when an agent app is connected, red when none is. Details on hover.
 */
export function ExternalAgentDot() {
  const [status] = useExternalAgentStatus();
  if (!status?.enabled) return null;
  const connected = status.listening && status.clients.length > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-8 items-center justify-center" aria-label={status.controller || ""}>
          <StatusDot on={connected} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <ExternalAgentStatusLines status={status} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * "Open Claude" / "Open Antigravity" at the bottom of the AI Edit sidebar.
 * Turns external agents on first when they are off, then opens the app in
 * the agent folder (for Antigravity, a project on that folder).
 */
export function OpenAgentAppButtons() {
  const { t } = useTranslation();
  const [status, setStatus] = useExternalAgentStatus();
  const [busy, setBusy] = React.useState(false);
  if (!status) return null;

  const canClaude = status.claudeApp || status.claudeInstalled;
  if (!canClaude && !status.antigravityApp) return null;

  const open = async (which: "claude" | "antigravity") => {
    setBusy(true);
    try {
      if (!status.enabled) setStatus(await setExternalAgentEnabled(true));
      const withFolder = await openExternalAgentApp(which);
      if (!withFolder) {
        // Antigravity was already open: the AutoSub project is there, but
        // only the user can switch a running Antigravity to it.
        const home = (await getExternalAgentStatus()).home;
        const name = home.split(/[\\/]/).filter(Boolean).pop() || "AutoSub";
        toast.info(t("externalAgent.pickProject.title", { name }), {
          description: t("externalAgent.pickProject.description", { name }),
          duration: 10000,
        });
      }
    } catch (err) {
      toast.error(t("externalAgent.errorTitle"), { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 gap-1.5 border-t border-border/60 p-2">
      {canClaude && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 gap-1.5 px-2 text-xs"
          disabled={busy}
          onClick={() => open("claude")}
          title={t("externalAgent.openTooltip", { name: "Claude" })}
        >
          <ExternalLink className="size-3.5" />
          Claude
        </Button>
      )}
      {status.antigravityApp && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 flex-1 gap-1.5 px-2 text-xs"
          disabled={busy}
          onClick={() => open("antigravity")}
          title={t("externalAgent.openTooltip", { name: "Antigravity" })}
        >
          <ExternalLink className="size-3.5" />
          Antigravity
        </Button>
      )}
    </div>
  );
}
