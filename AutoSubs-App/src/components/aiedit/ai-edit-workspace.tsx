import * as React from "react";
import { MonitorPlay, PanelLeftOpen, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LayersIcon,
  type LayersIconHandle,
} from "@/components/ui/icons/layers";
import type { TimelineActionCommand } from "./ai-edit-helpers";
import { AiEditSidebar } from "./ai-edit-sidebar";
import { AiEditMessageList } from "./ai-edit-message-list";
import { AiEditPromptBox } from "./ai-edit-prompt-box";
import { AiEditDialogs } from "./ai-edit-dialogs";
import { AiEditPreviewPanel, kindLabel } from "./ai-edit-preview-panel";
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
import { isLibraryAsset } from "@/api/cli-chat-api";

export type { TimelineActionCommand };

export function AiEditWorkspace() {
  const { t } = useTranslation();
  const c = useAiEditController();
  const layersIconRef = React.useRef<LayersIconHandle>(null);
  const assetCount =
    c.workspaceInfo?.assets?.filter((a) => !isLibraryAsset(a)).length ?? 0;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {!c.sidebarCollapsed && (
        <AiEditSidebar
          conversations={c.visibleConversations}
          activeConversationId={c.activeConversation?.id ?? null}
          runningTexts={c.runningTexts}
          openProjectName={c.openProjectName}
          openEditor={c.selectedIntegration}
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
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 bg-card/30 px-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {c.sidebarCollapsed && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={() => c.setSidebarCollapsed(false)}
                title={t("aiEdit.sidebar.expand")}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            )}

            <span className="text-xs font-semibold text-foreground/90 truncate max-w-md">
              {c.activeConversation?.title || t("aiEdit.newChat")}
            </span>
            {c.workspaceProject?.name && (
              <span
                className="shrink-0 truncate max-w-48 rounded-full border border-border/60 bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                title={t("aiEdit.header.projectTooltip")}
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
              studioRoot={c.studioRoot}
              onOpen={c.preview.open}
              onClose={c.preview.close}
            />
            <button
              type="button"
              onClick={() => {
                void c.refreshWorkspace();
                c.setAssetsOpen(true);
              }}
              onMouseEnter={() => layersIconRef.current?.startAnimation()}
              onMouseLeave={() => layersIconRef.current?.stopAnimation()}
              className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-2xs hover:text-foreground hover:bg-accent/70 active:scale-[0.97] transition-all"
              title={t("aiEdit.assets.tooltip")}
            >
              <LayersIcon
                ref={layersIconRef}
                size={13}
                className="text-primary"
              />
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
          toast.success(t("aiEdit.systemPrompt.saved"));
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
        skills={c.studioSkills}
        studioRoot={c.studioRoot}
        onChangeStudioRoot={() => void c.handleChangeStudioRoot()}
        onInsertAssetPath={c.handleInsertAssetPath}
        onQuickPlaceOnTimeline={(filePath) =>
          void c.handleQuickPlaceAssetOnTimeline(filePath)
        }
        onPreviewAsset={(asset) => void c.handlePreviewAsset(asset)}
        onSaveAsTemplate={(asset) => void c.handleSaveAsTemplate(asset)}
        onUseTemplate={(asset) => void c.handleUseTemplate(asset)}
        onImportSkills={() => void c.handleImportSkills()}
        onRemoveSkill={(asset) => void c.handleRemoveSkill(asset)}
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
  studioRoot,
  onOpen,
  onClose,
}: {
  open: boolean;
  activePath?: string;
  loadTargets: () => Promise<PreviewTarget[]>;
  /** The working folder; code videos are its projects/. */
  studioRoot: string;
  onOpen: (target: PreviewTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [targets, setTargets] = React.useState<PreviewTarget[] | null>(null);
  const item = (target: PreviewTarget) => (
    <DropdownMenuItem
      key={target.path}
      onSelect={() => onOpen(target)}
      className="flex items-center justify-between gap-2 text-xs"
      title={target.path}
    >
      <span className="min-w-0">
        <span className={cn("block truncate", target.path === activePath && "font-medium")}>{target.name}</span>
        {target.kind === "studio" && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground">projects/{target.id}</span>
        )}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{kindLabel(target.kind)}</span>
    </DropdownMenuItem>
  );

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
          title={t("aiEdit.preview.tooltip")}
        >
          <MonitorPlay className="size-3 text-primary" />
          <span>{t("aiEdit.preview.button")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs">
          {t("aiEdit.preview.menuTitle")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {targets === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("aiEdit.preview.loading")}
          </div>
        ) : (
          <>
            <div className="px-2 pb-1 pt-0.5 text-[10.5px] text-muted-foreground">
              {t("aiEdit.preview.codeVideos")}
              <div className="truncate font-mono text-foreground/80" title={`${studioRoot}/projects`}>
                {studioRoot ? `${studioRoot}/projects` : "…"}
              </div>
            </div>
            {targets.filter((x) => x.kind === "studio").length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">{t("aiEdit.preview.noCodeVideos")}</div>
            )}
            {targets.filter((x) => x.kind === "studio").map(item)}
            <DropdownMenuSeparator />
            <div className="px-2 pb-1 pt-0.5 text-[10.5px] text-muted-foreground">{t("aiEdit.preview.motionGraphics")}</div>
            {targets.filter((x) => x.kind !== "studio").length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">{t("aiEdit.preview.empty")}</div>
            )}
            {targets.filter((x) => x.kind !== "studio").map(item)}
          </>
        )}
        {open && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClose} className="gap-2 text-xs">
              <X className="size-3" />
              {t("aiEdit.preview.close")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
