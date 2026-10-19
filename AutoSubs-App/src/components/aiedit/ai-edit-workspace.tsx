import { Layers, PanelLeftOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { TimelineActionCommand } from "./ai-edit-helpers";
import { AiEditSidebar } from "./ai-edit-sidebar";
import { AiEditMessageList } from "./ai-edit-message-list";
import { AiEditPromptBox } from "./ai-edit-prompt-box";
import { AiEditDialogs } from "./ai-edit-dialogs";
import { useAiEditController } from "./use-ai-edit-controller";

export type { TimelineActionCommand };

export function AiEditWorkspace() {
  const c = useAiEditController();
  const assetCount = c.workspaceInfo?.assets?.length ?? 0;

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
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                void c.refreshWorkspace();
                c.setAssetsOpen(true);
              }}
              className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="Mở Kho Asset AI của Project (Motion Graphics, AI B-Roll, Exports, Templates)"
            >
              <Layers className="size-3 text-primary" />
              <span>Kho Asset AI</span>
              {assetCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-semibold text-primary">
                  {assetCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (c.selectedIntegration === "capcut") {
                  c.setProjectPickerOpen(true);
                }
              }}
              className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title={
                c.selectedIntegration === "capcut"
                  ? "Bấm để đổi Project CapCut"
                  : "Timeline DaVinci Resolve đang kết nối"
              }
            >
              <Sparkles className="size-3 text-primary" />
              <span>
                {c.selectedIntegration === "capcut"
                  ? `CapCut: ${c.timelineSnapshot?.draftName || "Chọn Project"}`
                  : `DaVinci: ${c.resolveTimeline?.name || "Timeline"}`}
              </span>
            </button>
          </div>
        </div>

        <AiEditMessageList
          activeConversation={c.activeConversation}
          activeAdapter={c.activeAdapter}
          selectedIntegration={c.selectedIntegration}
          draftName={c.timelineSnapshot?.draftName}
          activeIsRunning={c.activeIsRunning}
          activeRunText={c.activeRunText}
          activeThinkingText={c.activeThinkingText}
          activeStepList={c.activeStepList}
          onSendPrompt={(prompt) => void c.handleSendPrompt(prompt)}
          onExecuteTimelineAction={(cmd) => void c.executeTimelineAction(cmd)}
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
