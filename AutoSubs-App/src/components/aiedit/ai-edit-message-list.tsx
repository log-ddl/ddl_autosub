import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Film,
  Loader2,
  MonitorPlay,
  Play,
  Sparkles,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContentCliAdapter } from "@/api/cli-chat-api";
import type { ContentConversation } from "@/stores/ai-edit-chat-store";
import type { PreviewTarget } from "@/api/preview-api";
import {
  cliLabel,
  extractTimelineActions,
  formatStepLabel,
  stripTimelineActionBlocks,
  type TimelineActionCommand,
} from "./ai-edit-helpers";

export interface AiEditMessageListProps {
  activeConversation: ContentConversation | null;
  activeAdapter: ContentCliAdapter;
  selectedIntegration: string;
  /** Editor and project, from the editor adapter. */
  editorTitle: string;
  activeIsRunning: boolean;
  activeRunText?: string;
  activeThinkingText?: string;
  activeStepList: string[];
  onExecuteTimelineAction: (cmd: TimelineActionCommand) => void;
  onOpenPreview: (target: PreviewTarget) => void;
  endRef: React.RefObject<HTMLDivElement>;
}

function StepTraceBlock({
  thinking,
  steps,
  isRunning,
  adapterLabel,
  defaultExpanded = false,
}: {
  thinking?: string;
  steps?: string[];
  isRunning: boolean;
  adapterLabel: string;
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const stepList = steps || [];
  const hasContent = Boolean(thinking?.trim()) || stepList.length > 0;

  if (!isRunning && !hasContent) return null;

  const latestStep =
    stepList.length > 0
      ? formatStepLabel(stepList[stepList.length - 1]).label
      : "";

  const headerTitle = isRunning
    ? latestStep ||
      (thinking?.trim()
        ? t("aiEdit.message.reasoning")
        : t("aiEdit.message.working", { cli: adapterLabel }))
    : stepList.length > 0 && thinking?.trim()
      ? t("aiEdit.message.reasonedSteps", { count: stepList.length })
      : stepList.length > 0
        ? t("aiEdit.message.ranSteps", {
            count: stepList.length,
            last: latestStep,
          })
        : t("aiEdit.message.reasoned");

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left text-muted-foreground hover:text-foreground transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isRunning ? (
            <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
          ) : (
            <Brain className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="font-medium truncate">{headerTitle}</span>
        </div>
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 opacity-60" />
        )}
      </button>

      {expanded && hasContent && (
        <div className="mt-2 space-y-1.5 border-t border-border/40 pt-2 text-[11.5px] text-muted-foreground">
          {thinking?.trim() && (
            <div className="whitespace-pre-wrap break-words italic text-muted-foreground/85 max-h-48 overflow-y-auto rounded-lg bg-background/50 p-2">
              {thinking.trim()}
            </div>
          )}
          {stepList.length > 0 && (
            <div className="space-y-1">
              {stepList.map((st, i) => {
                const parsed = formatStepLabel(st);
                const isDone = parsed.state === "DONE" || !isRunning;
                const isThinkingStep = parsed.toolName === "thinking";
                return (
                  <div
                    key={`${parsed.id}-${i}`}
                    className="flex items-center gap-2 font-mono text-[11px] min-w-0"
                  >
                    {isDone ? (
                      <Check className="size-3 text-emerald-500 shrink-0" />
                    ) : isThinkingStep ? (
                      <Brain className="size-3 text-amber-500 animate-pulse shrink-0" />
                    ) : (
                      <Terminal className="size-3 text-primary animate-pulse shrink-0" />
                    )}
                    <span
                      className={cn(
                        "truncate",
                        isDone
                          ? "text-muted-foreground"
                          : "text-foreground font-medium",
                      )}
                      title={parsed.label}
                    >
                      {parsed.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AiEditMessageList({
  activeConversation,
  activeAdapter,
  selectedIntegration,
  editorTitle,
  activeIsRunning,
  activeRunText,
  activeThinkingText,
  activeStepList,
  onExecuteTimelineAction,
  onOpenPreview,
  endRef,
}: AiEditMessageListProps) {
  const { t } = useTranslation();
  const [copiedId, setCopiedId] = React.useState("");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-4">
        {(!activeConversation || activeConversation.messages.length === 0) &&
          !activeIsRunning && (
            <div className="my-12 flex flex-col items-center text-center gap-5">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-muted/60 text-foreground">
                <Sparkles className="size-5" />
              </div>
              <div className="space-y-1.5 max-w-md">
                <h3 className="text-base font-medium tracking-tight">
                  {t("aiEdit.empty.title")}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <Trans
                    i18nKey="aiEdit.empty.subtitle"
                    values={{ editor: editorTitle, cli: cliLabel(activeAdapter) }}
                    components={{ b: <span className="font-medium text-foreground" /> }}
                  />
                </p>
              </div>
            </div>
          )}

        {activeConversation?.messages.map((message, index) => {
          const isUser = message.role === "user";
          // A reply is stamped when the run ends and the user's message when
          // it is sent, so their gap is how long the agent took.
          const askedAt = isUser
            ? undefined
            : activeConversation.messages
                .slice(0, index)
                .reverse()
                .find((m) => m.role === "user")?.createdAt;
          const tookMs = askedAt ? message.createdAt - askedAt : 0;
          const actions = !isUser
            ? extractTimelineActions(message.content)
            : [];
          const displayContent = !isUser
            ? stripTimelineActionBlocks(message.content)
            : message.content;

          if (isUser) {
            return (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl bg-muted/80 dark:bg-zinc-800/90 px-4 py-2.5 text-sm leading-relaxed text-foreground">
                  <div className="whitespace-pre-wrap break-words">
                    {displayContent}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              key={message.id}
              className="group relative flex flex-col gap-2.5 text-sm leading-relaxed text-foreground"
            >
              <StepTraceBlock
                thinking={message.thinking}
                steps={message.steps}
                isRunning={false}
                adapterLabel={cliLabel(activeAdapter)}
                defaultExpanded={false}
              />

              {displayContent && (
                <div className="whitespace-pre-wrap break-words">
                  {displayContent}
                </div>
              )}

              {actions.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {actions.map((act, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Film className="size-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {act.summary ||
                              t("aiEdit.message.command", { action: act.action })}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {act.action} · {selectedIntegration.toUpperCase()}
                          </div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7 rounded-lg px-2.5 text-xs gap-1 shrink-0"
                        onClick={() => onExecuteTimelineAction(act)}
                      >
                        <Play className="size-3" />
                        {t("aiEdit.message.reapply")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {message.previews && message.previews.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {message.previews.map((target) => (
                    <button
                      key={target.path}
                      type="button"
                      onClick={() => onOpenPreview(target)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5 text-left text-xs hover:bg-muted/60 transition-colors"
                      title={target.path}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <MonitorPlay className="size-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {target.name}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {target.kind === "dev" ? "Dev server" : "HTML/TS"}
                          </div>
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                        <Play className="size-3" />
                        {t("aiEdit.preview.open")}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1">
                {tookMs > 0 && (
                  <span
                    className="flex items-center gap-1 px-1.5 py-1 text-[11px] tabular-nums text-muted-foreground"
                    title={t("aiEdit.message.durationTooltip")}
                  >
                    <Clock className="size-3" />
                    {formatDuration(tookMs)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(message.content);
                    setCopiedId(message.id);
                    setTimeout(() => setCopiedId(""), 1500);
                  }}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                  title={t("aiEdit.message.copyTooltip")}
                >
                  {copiedId === message.id ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  <span>{t("aiEdit.message.copy")}</span>
                </button>
              </div>
            </div>
          );
        })}

        {activeIsRunning && (
          <div className="flex flex-col gap-3 text-sm leading-relaxed">
            <StepTraceBlock
              thinking={activeThinkingText}
              steps={activeStepList}
              isRunning={true}
              adapterLabel={cliLabel(activeAdapter)}
              defaultExpanded={true}
            />

            {activeRunText && (
              <div className="whitespace-pre-wrap break-words text-foreground">
                {stripTimelineActionBlocks(activeRunText)}
                <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-primary align-middle" />
              </div>
            )}
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}

/** 42s, 3m 12s, 1h 02m. */
function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}
