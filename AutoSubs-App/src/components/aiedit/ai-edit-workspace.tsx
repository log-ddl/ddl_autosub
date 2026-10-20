import * as React from "react";
import { Layers, MonitorPlay, PanelLeftOpen, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { TimelineActionCommand } from "./ai-edit-helpers";
import { AiEditSidebar } from "./ai-edit-sidebar";
import { AiEditMessageList } from "./ai-edit-message-list";
import { AiEditPromptBox } from "./ai-edit-prompt-box";
import { AiEditDialogs } from "./ai-edit-dialogs";
import { AiEditPreviewPanel } from "./ai-edit-preview-panel";
import { useAiEditController } from "./use-ai-edit-controller";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PreviewTarget } from "@/api/preview-api";

export type { TimelineActionCommand };

export function AiEditWorkspace() {
  const { t } = useTranslation();
  const c = useAiEditController();
  const assetCount =
    c.workspaceInfo?.assets?.filter((a) => a.category !== "templates").length ??
    0;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {!c.sidebarCollapsed && (
        <AiEditSidebar
          conversations={c.visibleConversations}
          activeConversationId={c.activeConversation?.id ?? null}
          runningTexts={c.runningTexts}
          defaultAdapter={c.adapter}
          searchQuery={c.searchQuery}
          onSearchQueryChange={c.setSearchQuery}
          onCreateConversation={() => c.createConversation()}
          onSelectConversation={(id) => c.selectConversation(id)}
          onTogglePin={(id) => c.toggleConversationPinned(id)}
          onStartRename={(target) => {
            c.setRenameTarget(target);
            c.setRenameDraft(target.title);
          }}
          onDeleteConversation={(id) => c.deleteConversation(id)}
          onCollapse={() => c.setSidebarCollapsed(true)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Minimal Top Sub-header */}
        <div className="flex h-11 shrink-0 items-center justify-between px-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {c.sidebarCollapsed && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={() => c.setSidebarCollapsed(false)}
                title="Mở danh sách hội thoại"
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            )}

            <span className="text-xs font-medium text-muted-foreground truncate max-w-md">
              {c.activeConversation?.title || "Cuộc trò chuyện mới"}
            </span>
            {c.workspaceProject?.name && (
              <span
                className="shrink-0 truncate max-w-48 rounded-full bg-muted px-2 py-0.5 text-[10.5px] text-muted-foreground"
                title="Project chứa asset của cuộc trò chuyện này"
              >
                {c.workspaceProject.name}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PreviewMenu
              open={Boolean(c.preview.target)}
              activePath={c.preview.target?.path}
              loadTargets={c.listPreviewTargets}
              onOpen={c.preview.open}
              onClose={c.preview.close}
            />
            <button
              type="button"
              onClick={() => {
                void c.refreshWorkspace();
                c.setAssetsOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title={t("aiEdit.assets.tooltip")}
            >
              <Layers className="size-3 text-primary" />
              <span>{t("aiEdit.assets.button")}</span>
              {assetCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-semibold text-primary">
                  {assetCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <AiEditMessageList
          activeConversation={c.activeConversation}
          activeAdapter={c.activeAdapter}
          selectedIntegration={c.selectedIntegration}
          editorTitle={c.editorTitle}
          activeIsRunning={c.activeIsRunning}
          activeRunText={c.activeRunText}
          activeThinkingText={c.activeThinkingText}
          activeStepList={c.activeStepList}
          onSendPrompt={(prompt) => void c.handleSendPrompt(prompt)}
          onExecuteTimelineAction={(cmd) => void c.executeTimelineAction(cmd)}
          onOpenPreview={c.preview.open}
          endRef={c.endRef}
        />

        <AiEditPromptBox
          draft={c.draft}
          onDraftChange={c.setDraft}
          onSendPrompt={(prompt) => void c.handleSendPrompt(prompt)}
          onStopRunning={c.handleStopRunning}
          activeIsRunning={c.activeIsRunning}
          providerLocked={c.providerLocked}
          contextMismatch={c.contextMismatch}
          onCreateConversation={() => c.createConversation()}
          activeAdapter={c.activeAdapter}
          onChangeAdapter={c.setAdapter}
          selectedModel={c.selectedModel}
          availableModels={c.availableModels}
          onChangeModel={(m) => c.setModel(c.activeAdapter, m)}
          onReloadModels={() => void c.loadModels()}
          adapterStatus={c.adapterStatus}
          checkingRuntime={c.checkingRuntime}
          onRefreshRuntime={() => void c.refreshRuntime()}
          workspacePath={c.activeConversation?.workspacePath}
          onPickWorkspace={() => void c.handlePickWorkspace()}
          onResetWorkspace={() => {
            if (c.activeConversation) {
              c.setConversationWorkspace(c.activeConversation.id, null);
            }
          }}
          onAttachFile={() => void c.handleAttachFile()}
          onOpenAssetsDialog={() => {
            void c.refreshWorkspace();
            c.setAssetsOpen(true);
          }}
          assetCount={assetCount}
          onOpenMemoryDialog={() => {
            c.setMemoryDraft(c.workspaceInfo?.memory || "");
            c.setGlobalMemoryDraft(c.workspaceInfo?.globalMemory || "");
            c.setMemoryOpen(true);
          }}
          onOpenSystemPromptDialog={() => {
            c.setSystemPromptDraft(c.activeConversation?.systemPrompt || "");
            c.setSystemPromptOpen(true);
          }}
          autoApplyActions={c.autoApplyActions}
          onToggleAutoApply={() => c.setAutoApplyActions((v) => !v)}
          textareaRef={c.textareaRef}
        />
      </div>

      <AiEditPreviewPanel preview={c.preview} />

      <AiEditDialogs
        systemPromptOpen={c.systemPromptOpen}
        onSystemPromptOpenChange={c.setSystemPromptOpen}
        systemPromptDraft={c.systemPromptDraft}
        onSystemPromptDraftChange={c.setSystemPromptDraft}
        onSaveSystemPrompt={() => {
          if (c.activeConversation) {
            c.setConversationSystemPrompt(
              c.activeConversation.id,
              c.systemPromptDraft,
            );
          }
          c.setSystemPromptOpen(false);
          toast.success("Đã lưu System Prompt");
        }}
        memoryOpen={c.memoryOpen}
        onMemoryOpenChange={c.setMemoryOpen}
        memoryDraft={c.memoryDraft}
        onMemoryDraftChange={c.setMemoryDraft}
        globalMemoryDraft={c.globalMemoryDraft}
        onGlobalMemoryDraftChange={c.setGlobalMemoryDraft}
        savingMemory={c.savingMemory}
        onSaveMemory={() => void c.handleSaveMemory()}
        assetsOpen={c.assetsOpen}
        onAssetsOpenChange={c.setAssetsOpen}
        workspaceInfo={c.workspaceInfo}
        onInsertAssetPath={c.handleInsertAssetPath}
        onQuickPlaceOnTimeline={(filePath) =>
          void c.handleQuickPlaceAssetOnTimeline(filePath)
        }
        onPreviewAsset={(asset) => void c.handlePreviewAsset(asset)}
        onSaveAsTemplate={(asset) => void c.handleSaveAsTemplate(asset)}
        onUseTemplate={(asset) => void c.handleUseTemplate(asset)}
        renameTarget={c.renameTarget}
        onClearRenameTarget={() => c.setRenameTarget(null)}
        renameDraft={c.renameDraft}
        onRenameDraftChange={c.setRenameDraft}
        onConfirmRename={() => {
          if (c.renameTarget && c.renameDraft.trim()) {
            c.renameConversation(c.renameTarget.id, c.renameDraft.trim());
            c.setRenameTarget(null);
          }
        }}
      />
    </div>
  );
}

function PreviewMenu({
  open,
  activePath,
  loadTargets,
  onOpen,
  onClose,
}: {
  open: boolean;
  activePath?: string;
  loadTargets: () => Promise<PreviewTarget[]>;
  onOpen: (target: PreviewTarget) => void;
  onClose: () => void;
}) {
  const [targets, setTargets] = React.useState<PreviewTarget[] | null>(null);

  return (
    <DropdownMenu
      onOpenChange={(isOpen) => {
        if (!isOpen) return;
        setTargets(null);
        void loadTargets().then(setTargets);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={
            open
              ? "flex items-center gap-1.5 rounded-full border border-primary/50 bg-primary/10 px-2.5 py-1 text-[11px] text-foreground transition-colors"
              : "flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          }
          title="Xem preview code AI đã viết"
        >
          <MonitorPlay className="size-3 text-primary" />
          <span>Preview</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs">
          Motion Graphics của project
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {targets === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Đang tải...
          </div>
        ) : targets.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Chưa có gì để preview. Hãy yêu cầu AI tạo motion trong
            motion-graphics.
          </div>
        ) : (
          targets.map((t) => (
            <DropdownMenuItem
              key={t.path}
              onSelect={() => onOpen(t)}
              className="flex items-center justify-between gap-2 text-xs"
              title={t.path}
            >
              <span
                className={
                  t.path === activePath ? "truncate font-medium" : "truncate"
                }
              >
                {t.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t.kind === "dev" ? "Dev server" : "HTML/TS"}
              </span>
            </DropdownMenuItem>
          ))
        )}
        {open && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClose} className="gap-2 text-xs">
              <X className="size-3" />
              Đóng preview
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
