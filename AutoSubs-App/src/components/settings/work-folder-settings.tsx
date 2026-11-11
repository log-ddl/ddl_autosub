import * as React from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Check, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  getStudioStatus,
  onStudioStatus,
  setStudioRoot,
  setupStudio,
  type StudioStatus,
} from "@/api/studio-api";

/**
 * Settings section for AI Edit's working folder (where skills, code videos
 * and the agent rules live, also opened by Claude / Antigravity) and the
 * Remotion environment linked into it for previews and renders.
 */
export function WorkFolderSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<StudioStatus | null>(null);

  React.useEffect(() => {
    getStudioStatus().then(setStatus).catch(() => {});
    const un = onStudioStatus(setStatus);
    return () => {
      void un.then((f) => f());
    };
  }, []);

  if (!status) return null;

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, defaultPath: status.root });
    if (typeof dir !== "string") return;
    try {
      setStatus(await setStudioRoot(dir));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const install = () => {
    setupStudio().catch(() => {});
  };

  const envText = status.busy
    ? t(`settings.workFolder.stages.${status.stage ?? "files"}`)
    : status.ready
      ? t("settings.workFolder.envReady")
      : status.node && status.python
        ? t("settings.workFolder.envNotLinked")
        : t("settings.workFolder.envMissing");

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("settings.sections.aiEdit")}
      </h4>

      <FieldGroup className="gap-3">
        <Field>
          <Item variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{t("settings.workFolder.title")}</ItemTitle>
              <ItemDescription className="truncate text-xs leading-tight" title={status.root}>
                {status.root}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => void revealItemInDir(status.root)}
                title={t("settings.workFolder.open")}
              >
                <FolderOpen className="size-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={status.busy} onClick={() => void pickFolder()}>
                {t("settings.workFolder.change")}
              </Button>
            </ItemActions>
          </Item>
        </Field>

        <Field>
          <Item variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{t("settings.workFolder.envTitle")}</ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1">{envText}</ItemDescription>
            </ItemContent>
            <ItemActions className="shrink-0">
              {status.busy ? (
                <Loader2 className="size-4 animate-spin text-primary" />
              ) : status.ready ? (
                <Button variant="ghost" size="sm" onClick={install} title={t("settings.workFolder.updateTooltip")}>
                  <Check className="size-3.5 text-green-600" />
                  {t("settings.workFolder.update")}
                </Button>
              ) : (
                <Button size="sm" onClick={install}>
                  {t("settings.workFolder.install")}
                </Button>
              )}
            </ItemActions>
          </Item>
          {status.error && !status.busy && (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] text-destructive">
              {status.error}
            </pre>
          )}
        </Field>
      </FieldGroup>
    </div>
  );
}
