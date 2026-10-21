import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowRight,
  Bot,
  ChevronUp,
  FileText,
  FolderOpen,
  Layers,
  Lock,
  MessageSquarePlus,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  Square,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  CliStatusInfo,
  ContentCliAdapter,
} from "@/api/cli-chat-api";
import {
  AI_EDIT_SLASH_COMMANDS,
  cliLabel,
  editorLabel,
  formatModelParts,
  workspaceShortLabel,
} from "./ai-edit-helpers";

export interface ContextMismatchInfo {
  boundIntegration: string;
  boundProjectId: string | null;
  boundProjectName: string;
  currentIntegration: string;
  currentProjectId: string | null;
  currentProjectName: string;
}

export interface AiEditPromptBoxProps {
  draft: string;
  onDraftChange: (val: string) => void;
  onSendPrompt: (overridePrompt?: string) => void;
  onStopRunning: () => void;
  activeIsRunning: boolean;
  providerLocked: boolean;
  contextMismatch?: ContextMismatchInfo | null;
  onCreateConversation?: () => void;
  activeAdapter: ContentCliAdapter;
  onChangeAdapter: (adapter: ContentCliAdapter) => void;
  selectedModel: string;
  availableModels: string[];
  onChangeModel: (model: string) => void;
  onReloadModels: () => void;
  adapterStatus?: CliStatusInfo;
  checkingRuntime: boolean;
  onRefreshRuntime: () => void;
  workspacePath?: string | null;
  onPickWorkspace: () => void;
  onResetWorkspace: () => void;
  onAttachFile: () => void;
  onOpenAssetsDialog: () => void;
  assetCount?: number;
  onOpenMemoryDialog: () => void;
  onOpenSystemPromptDialog: () => void;
  autoApplyActions: boolean;
  onToggleAutoApply: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function AiEditPromptBox({
  draft,
  onDraftChange,
  onSendPrompt,
  onStopRunning,
  activeIsRunning,
  providerLocked,
  contextMismatch,
  onCreateConversation,
  activeAdapter,
  onChangeAdapter,
  selectedModel,
  availableModels,
  onChangeModel,
  onReloadModels,
  adapterStatus,
  checkingRuntime,
  onRefreshRuntime,
  workspacePath,
  onPickWorkspace,
  onResetWorkspace,
  onAttachFile,
  onOpenAssetsDialog,
  assetCount = 0,
  onOpenMemoryDialog,
  onOpenSystemPromptDialog,
  autoApplyActions,
  onToggleAutoApply,
  textareaRef,
}: AiEditPromptBoxProps) {
  const { t } = useTranslation();
  const slashMatch = /^\/([^\s]*)$/.exec(draft);
  const slashCommands = AI_EDIT_SLASH_COMMANDS.filter(
    (s) => !slashMatch?.[1] || s.name.includes(slashMatch[1].toLowerCase()),
  );

  const modelDisplay = formatModelParts(selectedModel, activeAdapter);
  const defaultModelDisplay = formatModelParts("", activeAdapter);
  const isLockedByMismatch = Boolean(contextMismatch);

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="mx-auto max-w-3xl space-y-2">
        {contextMismatch && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-600 dark:text-amber-300">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Lock className="size-3.5 shrink-0 text-amber-500" />
              <span className="leading-snug">
                <Trans
                  i18nKey="aiEdit.prompt.locked"
                  values={{
                    bound: `${editorLabel(contextMismatch.boundIntegration, true)} · ${contextMismatch.boundProjectName}`,
                    current: `${editorLabel(contextMismatch.currentIntegration, true)} · ${contextMismatch.currentProjectName}`,
                  }}
                  components={{ b: <strong className="font-semibold" /> }}
                />
              </span>
            </div>
            {onCreateConversation && (
              <button
                type="button"
                onClick={onCreateConversation}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 transition-colors"
              >
                <MessageSquarePlus className="size-3.5" />
                <span>{t("aiEdit.prompt.newChatForProject")}</span>
              </button>
            )}
          </div>
        )}

        {!isLockedByMismatch && slashMatch && slashCommands.length > 0 && (
          <div className="rounded-xl border border-border/70 bg-popover p-1.5 shadow-lg">
            {slashCommands.map((cmd) => (
              <button
                key={cmd.name}
                type="button"
                onClick={() => onSendPrompt(`/${cmd.name}`)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-xs hover:bg-muted"
              >
                <span className="font-mono font-medium text-foreground">
                  /{cmd.name}
                </span>
                <span className="text-muted-foreground">
                  {t(`aiEdit.slash.${cmd.name}`)}
                </span>
              </button>
            ))}
          </div>
        )}

        <div
          className={cn(
            "rounded-2xl border border-border/80 bg-muted/25 dark:bg-zinc-900/90 px-4 pt-3.5 pb-2.5 shadow-sm transition-colors focus-within:border-foreground/30",
            isLockedByMismatch && "opacity-60 pointer-events-none select-none",
          )}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            disabled={isLockedByMismatch}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSendPrompt();
              }
            }}
            placeholder={
              isLockedByMismatch
                ? t("aiEdit.prompt.lockedPlaceholder")
                : t("aiEdit.prompt.placeholder")
            }
            className="w-full resize-none border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:cursor-not-allowed"
          />

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 min-w-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={activeIsRunning}
                    className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    title={t("aiEdit.prompt.addTooltip")}
                  >
                    <Plus className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuItem onClick={onOpenAssetsDialog}>
                    <Layers className="size-3.5 mr-2 text-primary" />
                    <span className="flex-1 truncate">
                      {t("aiEdit.assets.menuItem")}
                    </span>
                    {assetCount > 0 && (
                      <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {assetCount}
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onAttachFile}>
                    <Paperclip className="size-3.5 mr-2" />
                    {t("aiEdit.prompt.attach")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={providerLocked}
                    onClick={onPickWorkspace}
                  >
                    <FolderOpen className="size-3.5 mr-2" />
                    <span className="truncate">
                      {workspacePath
                        ? workspaceShortLabel(workspacePath)
                        : t("aiEdit.prompt.pickWorkspace")}
                    </span>
                  </DropdownMenuItem>
                  {workspacePath && !providerLocked && (
                    <DropdownMenuItem onClick={onResetWorkspace}>
                      <RotateCcw className="size-3.5 mr-2" />
                      {t("aiEdit.prompt.resetWorkspace")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onOpenMemoryDialog}>
                    <FileText className="size-3.5 mr-2" />
                    {t("aiEdit.prompt.memory")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onOpenSystemPromptDialog}>
                    <Bot className="size-3.5 mr-2" />
                    {t("aiEdit.prompt.systemPrompt")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Select
                value={selectedModel || "__default"}
                disabled={activeIsRunning}
                onValueChange={(v) =>
                  onChangeModel(v === "__default" ? "" : v)
                }
                onOpenChange={(open) => {
                  if (open) onReloadModels();
                }}
              >
                <SelectTrigger className="h-7 w-auto border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted/60 rounded-lg gap-1.5 focus:ring-0 [&>svg:last-child]:hidden">
                  <span className="font-medium text-foreground/90">
                    {modelDisplay.name}
                  </span>
                  {modelDisplay.tier && (
                    <span className="text-muted-foreground font-normal">
                      {modelDisplay.tier}
                    </span>
                  )}
                  <ChevronUp className="size-3 text-muted-foreground/70" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="__default">
                    {t("aiEdit.prompt.defaultModel", {
                      name: [defaultModelDisplay.name, defaultModelDisplay.tier]
                        .filter(Boolean)
                        .join(" "),
                    })}
                  </SelectItem>
                  {availableModels.map((m) => {
                    const parts = formatModelParts(m, activeAdapter);
                    return (
                      <SelectItem key={m} value={m}>
                        <span className="font-medium">{parts.name}</span>
                        {parts.tier ? (
                          <span className="ml-1.5 text-muted-foreground">
                            {parts.tier}
                          </span>
                        ) : null}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              <Select
                value={activeAdapter}
                disabled={providerLocked || activeIsRunning}
                onValueChange={(val) =>
                  onChangeAdapter(val as ContentCliAdapter)
                }
              >
                <SelectTrigger className="h-7 w-auto border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground rounded-lg gap-1.5 focus:ring-0 [&>svg:last-child]:hidden">
                  <span
                    className={cn(
                      "size-1.5 rounded-full shrink-0",
                      adapterStatus?.available
                        ? "bg-emerald-500"
                        : "bg-amber-500",
                    )}
                  />
                  <span>{cliLabel(activeAdapter)}</span>
                  <ChevronUp className="size-3 text-muted-foreground/60" />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="agy">Antigravity CLI (agy)</SelectItem>
                  <SelectItem value="claude">Claude Code CLI</SelectItem>
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={onRefreshRuntime}
                disabled={checkingRuntime}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground transition-colors"
                title={
                  adapterStatus?.available
                    ? t("aiEdit.prompt.connected", {
                        version: adapterStatus.version || adapterStatus.path,
                      })
                    : t("aiEdit.prompt.recheck")
                }
              >
                <RefreshCw
                  className={cn("size-3", checkingRuntime && "animate-spin")}
                />
              </button>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onToggleAutoApply}
                className={cn(
                  "flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                  autoApplyActions
                    ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    : "text-amber-500 hover:bg-amber-500/10",
                )}
                title={
                  autoApplyActions
                    ? t("aiEdit.prompt.turboTooltip")
                    : t("aiEdit.prompt.manualTooltip")
                }
              >
                <Shield className="size-3.5" />
                <span className="font-medium">
                  {autoApplyActions ? "Turbo" : "Manual"}
                </span>
                <ChevronUp className="size-3 opacity-60" />
              </button>

              {activeIsRunning ? (
                <button
                  type="button"
                  onClick={onStopRunning}
                  className="flex size-8 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 transition-opacity"
                  title={t("aiEdit.prompt.stop")}
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={() => onSendPrompt()}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full transition-all",
                    draft.trim()
                      ? "bg-foreground text-background hover:opacity-90"
                      : "bg-muted text-muted-foreground/50 cursor-not-allowed",
                  )}
                  title={t("aiEdit.prompt.send")}
                >
                  <ArrowRight className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
