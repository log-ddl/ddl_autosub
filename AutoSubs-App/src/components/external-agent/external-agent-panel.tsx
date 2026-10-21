import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, Copy, FolderOpen, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import {
  connectExternalAgent,
  setExternalAgentEnabled,
  setExternalAgentHome,
  type ExternalAgentStatus,
} from "@/api/external-agent-api";
import { ago, useExternalAgentStatus } from "./use-external-agent";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Green when an agent app is connected, red otherwise. */
export function StatusDot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {on && <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-500/60" />}
      <span className={cn("relative inline-flex size-2.5 rounded-full", on ? "bg-green-500" : "bg-red-500")} />
    </span>
  );
}

/** The three status lines: who is connected, which editor project, who is driving. */
export function ExternalAgentStatusLines({ status }: { status: ExternalAgentStatus }) {
  const { t } = useTranslation();
  const now = nowSec();
  const connected = status.listening && status.clients.length > 0;
  const driver = status.clients.find((c) => c.label === status.controller);

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex items-center gap-2">
        <StatusDot on={connected} />
        <span className="font-medium">
          {!status.listening
            ? status.error || t("externalAgent.status.notListening")
            : connected
              ? t("externalAgent.status.connected", { names: status.clients.map((c) => c.label).join(", ") })
              : t("externalAgent.status.waiting")}
        </span>
      </div>
      <div className="pl-[18px] text-muted-foreground">
        {status.editor
          ? t("externalAgent.status.editor", {
              editor: status.editor,
              project: status.project || t("externalAgent.status.noProjectName"),
            })
          : t("externalAgent.status.noEditor")}
      </div>
      <div className="pl-[18px] text-muted-foreground">
        {driver
          ? t("externalAgent.status.driving", {
              name: driver.label,
              tool: driver.lastTool || "",
              ago: ago(driver.lastToolSec, now),
            })
          : t("externalAgent.status.idle")}
      </div>
    </div>
  );
}

/** Settings section: turn external agents on, see who is connected, set them up. */
export function ExternalAgentPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useExternalAgentStatus();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  if (!status) return null;

  const run = async (key: string, job: () => Promise<ExternalAgentStatus>) => {
    setBusy(key);
    try {
      setStatus(await job());
    } catch (err) {
      toast.error(t("externalAgent.errorTitle"), { description: String(err) });
    } finally {
      setBusy(null);
    }
  };

  const copyConfig = async () => {
    const config = {
      mcpServers: {
        [status.serverName]: {
          type: "http",
          url: status.url,
          headers: { Authorization: `Bearer ${status.token}` },
        },
      },
    };
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const pickHome = async () => {
    const dir = await openDialog({ directory: true, defaultPath: status.home });
    if (typeof dir === "string") await run("home", () => setExternalAgentHome(dir));
  };

  const connectButton = (client: "claude" | "agy", name: string, installed: boolean, registered: boolean) =>
    installed && (
      <Button
        variant={registered ? "outline" : "secondary"}
        size="sm"
        disabled={busy !== null}
        onClick={() => run(client, () => connectExternalAgent(client))}
        title={t("externalAgent.connectTooltip", { name })}
      >
        {registered ? <Check className="size-3.5 text-green-600" /> : <Plug className="size-3.5" />}
        {name}
      </Button>
    );

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("settings.sections.externalAgent")}
      </h4>

      <FieldGroup className="gap-3">
        <Field>
          <Item variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{t("externalAgent.enable.title")}</ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1">
                {t("externalAgent.enable.description")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={status.enabled}
                disabled={busy !== null}
                onCheckedChange={(on) => run("enable", () => setExternalAgentEnabled(on))}
                aria-label={t("externalAgent.enable.title")}
              />
            </ItemActions>
          </Item>
        </Field>

        {status.enabled && (
          <Field>
            <div className="space-y-3 rounded-lg border p-3">
              <ExternalAgentStatusLines status={status} />

              {status.clients.length > 0 && (
                <ul className="space-y-1 border-t pt-2 text-[11px] text-muted-foreground">
                  {status.clients.map((c) => (
                    <li key={c.label} className="flex items-center gap-2">
                      <StatusDot on={c.active} className="scale-75" />
                      <span className="font-medium text-foreground">{c.label}</span>
                      {c.version && <span>{c.version}</span>}
                      <span className="ml-auto">
                        {c.lastTool
                          ? t("externalAgent.lastTool", { tool: c.lastTool, ago: ago(c.lastToolSec, nowSec()) })
                          : t("externalAgent.seen", { ago: ago(c.lastSeenSec, nowSec()) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-1.5 border-t pt-2">
                <div className="text-[11px] text-muted-foreground">{t("externalAgent.folderHint")}</div>
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px]" title={status.home}>
                    {status.home}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => void revealItemInDir(status.home)}
                    title={t("externalAgent.openFolder")}
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-[11px]" disabled={busy !== null} onClick={pickHome}>
                    {t("externalAgent.changeFolder")}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
                <span className="mr-1 text-[11px] text-muted-foreground">{t("externalAgent.connectLabel")}</span>
                {connectButton("claude", "Claude Code", status.claudeInstalled, status.claudeRegistered)}
                {connectButton("agy", "Antigravity", status.agyInstalled, status.agyRegistered)}
                <Button variant="ghost" size="sm" onClick={copyConfig} title={t("externalAgent.copyTooltip")}>
                  {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
                  {t("externalAgent.copyConfig")}
                </Button>
              </div>
            </div>
          </Field>
        )}
      </FieldGroup>
    </div>
  );
}
