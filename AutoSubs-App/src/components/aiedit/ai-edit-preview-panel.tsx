import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  MonitorPlay,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getPreviewLogs,
  startPreview,
  stopPreview,
  type PreviewInfo,
  type PreviewTarget,
} from "@/api/preview-api";

export interface AiEditPreview {
  target: PreviewTarget | null;
  info: PreviewInfo | null;
  loading: boolean;
  error: string;
  reloadKey: number;
  open: (target: PreviewTarget) => void;
  reload: () => void;
  close: () => void;
}

/** One preview at a time: opening another target stops the previous one. */
export function useAiEditPreview(): AiEditPreview {
  const [target, setTarget] = React.useState<PreviewTarget | null>(null);
  const [info, setInfo] = React.useState<PreviewInfo | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reloadKey, setReloadKey] = React.useState(0);
  const requestRef = React.useRef(0);

  const open = React.useCallback((next: PreviewTarget) => {
    const request = ++requestRef.current;
    setTarget(next);
    setInfo(null);
    setError("");
    setLoading(true);
    startPreview(next.path)
      .then((result) => {
        if (request !== requestRef.current) return;
        setInfo(result);
        setReloadKey((k) => k + 1);
      })
      .catch((err) => {
        if (request !== requestRef.current) return;
        setError(err?.message || String(err));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, []);

  const close = React.useCallback(() => {
    requestRef.current++;
    setTarget(null);
    setInfo(null);
    setError("");
    setLoading(false);
    void stopPreview();
  }, []);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  // Leaving the AI Edit tab shouldn't leave a dev server running.
  React.useEffect(() => () => void stopPreview(), []);

  return { target, info, loading, error, reloadKey, open, reload, close };
}

function useLogs(active: boolean) {
  const [logs, setLogs] = React.useState("");
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () =>
      getPreviewLogs()
        .then((text) => !cancelled && setLogs(text))
        .catch(() => {});
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);
  return logs;
}

export function AiEditPreviewPanel({ preview }: { preview: AiEditPreview }) {
  const { t } = useTranslation();
  const { target, info, loading, error, reloadKey } = preview;
  const [showLogs, setShowLogs] = React.useState(false);
  const isDev = (info?.kind ?? target?.kind) === "dev";
  const logs = useLogs(Boolean(target) && (loading || showLogs || !!error));

  if (!target) return null;

  return (
    <div className="flex w-[46%] min-w-[360px] max-w-[900px] shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorPlay className="size-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium" title={target.path}>
            {target.name}
          </span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {isDev ? "Dev server" : "HTML/TS"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7", showLogs && "bg-muted text-foreground")}
            onClick={() => setShowLogs((v) => !v)}
            title={t("aiEdit.preview.logs")}
          >
            <Terminal className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={!info}
            onClick={preview.reload}
            title={t("aiEdit.preview.reload")}
          >
            <RotateCw className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={!info}
            onClick={() => info && void openUrl(info.url)}
            title={t("aiEdit.preview.openBrowser")}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={preview.close}
            title={t("aiEdit.preview.close")}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-black">
        {info && !error && (
          <iframe
            key={reloadKey}
            src={info.url}
            title={target.name}
            className="absolute inset-0 size-full border-0 bg-white"
            allow="autoplay; fullscreen; clipboard-read; clipboard-write"
          />
        )}
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background text-xs text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" />
            <span>
              {target.kind === "dev"
                ? t("aiEdit.preview.startingDev")
                : t("aiEdit.preview.opening")}
            </span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col gap-2 overflow-auto bg-background p-4 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="size-3.5" />
              {t("aiEdit.preview.failed")}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {error}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 w-fit gap-1 text-xs"
              onClick={() => preview.open(target)}
            >
              <RotateCw className="size-3" />
              {t("aiEdit.preview.retry")}
            </Button>
          </div>
        )}
      </div>

      {(showLogs || (loading && isDev)) && (
        <pre className="max-h-48 shrink-0 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-muted/30 p-2 font-mono text-[10.5px] text-muted-foreground">
          {logs || t("aiEdit.preview.noLogs")}
        </pre>
      )}
    </div>
  );
}
