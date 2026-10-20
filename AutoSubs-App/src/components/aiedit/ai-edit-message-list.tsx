import * as React from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Film,
  Loader2,
  Play,
  Sparkles,
  Terminal,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContentCliAdapter } from "@/api/cli-chat-api";
import type { ContentConversation } from "@/stores/ai-edit-chat-store";
import {
  AI_EDIT_QUICK_STARTERS,
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
  onSendPrompt: (overridePrompt?: string) => void;
  onExecuteTimelineAction: (cmd: TimelineActionCommand) => void;
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
        ? "Đang suy luận..."
        : `${adapterLabel} đang suy nghĩ & xử lý...`)
    : stepList.length > 0 && thinking?.trim()
      ? `Đã suy luận & thực thi ${stepList.length} bước công cụ`
      : stepList.length > 0
        ? `Đã thực thi ${stepList.length} bước công cụ (${latestStep})`
        : "Đã suy luận";

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
  onSendPrompt,
  onExecuteTimelineAction,
  endRef,
}: AiEditMessageListProps) {
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
                  Bạn muốn dựng gì hôm nay?
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Điều khiển trực tiếp{" "}
                  <span className="font-medium text-foreground">
                    {editorTitle}
                  </span>{" "}
                  bằng {cliLabel(activeAdapter)}.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl text-left">
                {AI_EDIT_QUICK_STARTERS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => onSendPrompt(item.prompt)}
                    className="flex flex-col gap-1 rounded-xl border border-border/50 bg-card/30 p-3 text-xs hover:bg-muted/50 hover:border-border transition-all"
                  >
                    <span className="font-medium text-foreground flex items-center gap-1.5">
                      <Wand2 className="size-3.5 text-muted-foreground" />
                      {item.title}
                    </span>
                    <span className="text-[11px] text-muted-foreground/80 line-clamp-2">
                      {item.prompt}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

        {activeConversation?.messages.map((message) => {
          const isUser = message.role === "user";
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
                            {act.summary || `Lệnh: ${act.action}`}
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
                        Áp dụng lại
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(message.content);
                    setCopiedId(message.id);
                    setTimeout(() => setCopiedId(""), 1500);
                  }}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Sao chép nội dung"
                >
                  {copiedId === message.id ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  <span>Sao chép</span>
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
