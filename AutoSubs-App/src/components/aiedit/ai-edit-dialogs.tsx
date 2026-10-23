import * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  BookmarkPlus,
  BookOpen,
  CopyPlus,
  FolderInput,
  Film,
  Folder,
  Layers,
  MonitorPlay,
  Paperclip,
  Play,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  isLibraryAsset,
  type ProjectAssetItem,
  type WorkspaceInfo,
} from "@/api/cli-chat-api";

export interface AiEditDialogsProps {
  systemPromptOpen: boolean;
  onSystemPromptOpenChange: (open: boolean) => void;
  systemPromptDraft: string;
  onSystemPromptDraftChange: (val: string) => void;
  onSaveSystemPrompt: () => void;

  memoryOpen: boolean;
  onMemoryOpenChange: (open: boolean) => void;
  memoryDraft: string;
  onMemoryDraftChange: (val: string) => void;
  globalMemoryDraft: string;
  onGlobalMemoryDraftChange: (val: string) => void;
  workspaceInfo: WorkspaceInfo | null;
  savingMemory: boolean;
  onSaveMemory: () => void;

  assetsOpen: boolean;
  onAssetsOpenChange: (open: boolean) => void;
  onInsertAssetPath: (path: string) => void;
  onQuickPlaceOnTimeline: (asset: ProjectAssetItem) => void;
  onPreviewAsset: (asset: ProjectAssetItem) => void;
  /** Copy a project motion graphic into the shared templates. */
  onSaveAsTemplate: (asset: ProjectAssetItem) => void;
  /** Copy a template into this project's motion-graphics. */
  onUseTemplate: (asset: ProjectAssetItem) => void;
  /** Pick a folder of skills and copy it into the project, or the library. */
  onImportSkills: (toLibrary: boolean) => void;

  renameTarget: { id: string; title: string } | null;
  onClearRenameTarget: () => void;
  renameDraft: string;
  onRenameDraftChange: (val: string) => void;
  onConfirmRename: () => void;
}

export function AiEditDialogs({
  systemPromptOpen,
  onSystemPromptOpenChange,
  systemPromptDraft,
  onSystemPromptDraftChange,
  onSaveSystemPrompt,
  memoryOpen,
  onMemoryOpenChange,
  memoryDraft,
  onMemoryDraftChange,
  globalMemoryDraft,
  onGlobalMemoryDraftChange,
  workspaceInfo,
  savingMemory,
  onSaveMemory,
  assetsOpen,
  onAssetsOpenChange,
  onInsertAssetPath,
  onQuickPlaceOnTimeline,
  onPreviewAsset,
  onSaveAsTemplate,
  onUseTemplate,
  onImportSkills,
  renameTarget,
  onClearRenameTarget,
  renameDraft,
  onRenameDraftChange,
  onConfirmRename,
}: AiEditDialogsProps) {
  const { t } = useTranslation();
  const [memoryTab, setMemoryTab] = React.useState<"project" | "global">(
    "project",
  );
  const [assetCategory, setAssetCategory] = React.useState<string>("all");

  const assets = workspaceInfo?.assets || [];
  // "All" is this project's media only: the library is shared by every
  // project, and skills have their own tab.
  const projectAssets = assets.filter(
    (a) => !isLibraryAsset(a) && a.category !== "skills",
  );
  const skillsTab =
    assetCategory === "skills" || assetCategory === "library-skills";
  const filteredAssets =
    assetCategory === "all"
      ? projectAssets
      : assets.filter((a) => a.category === assetCategory);

  return (
    <>
      {/* ── Dialog: System Prompt ─────────────────────────────────────────── */}
      <Dialog open={systemPromptOpen} onOpenChange={onSystemPromptOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t("aiEdit.systemPrompt.title")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("aiEdit.systemPrompt.description")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={systemPromptDraft}
            onChange={(e) => onSystemPromptDraftChange(e.target.value)}
            placeholder={t("aiEdit.systemPrompt.placeholder")}
            className="min-h-36 text-xs"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onSystemPromptOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="button" size="sm" onClick={onSaveSystemPrompt}>
              {t("aiEdit.systemPrompt.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: 2-Tier Memory (Project memory.md + Global global-memory.md) */}
      <Dialog open={memoryOpen} onOpenChange={onMemoryOpenChange}>
        <DialogContent className="sm:max-w-xl grid-cols-[minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t("aiEdit.memory.title")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              <Trans
                i18nKey="aiEdit.memory.description"
                values={{
                  project: workspaceInfo?.projectSlug || "default-project",
                }}
                components={{
                  b: <span className="font-mono font-medium text-foreground" />,
                }}
              />
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1 text-xs">
            <button
              type="button"
              onClick={() => setMemoryTab("project")}
              className={cn(
                "flex-1 rounded-md py-1.5 font-medium transition-colors",
                memoryTab === "project"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("aiEdit.memory.projectTab", {
                project: workspaceInfo?.projectSlug || "memory.md",
              })}
            </button>
            <button
              type="button"
              onClick={() => setMemoryTab("global")}
              className={cn(
                "flex-1 rounded-md py-1.5 font-medium transition-colors",
                memoryTab === "global"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("aiEdit.memory.globalTab")}
            </button>
          </div>

          {memoryTab === "project" ? (
            <div className="min-w-0 space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {workspaceInfo?.path
                  ? `${workspaceInfo.path}/memory.md`
                  : "memory.md"}
              </div>
              <Textarea
                value={memoryDraft}
                onChange={(e) => onMemoryDraftChange(e.target.value)}
                placeholder={t("aiEdit.memory.projectPlaceholder")}
                className="min-h-44 font-mono text-xs"
              />
            </div>
          ) : (
            <div className="min-w-0 space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {workspaceInfo?.globalPath
                  ? `${workspaceInfo.globalPath}/global-memory.md`
                  : "global-memory.md"}
              </div>
              <Textarea
                value={globalMemoryDraft}
                onChange={(e) => onGlobalMemoryDraftChange(e.target.value)}
                placeholder={t("aiEdit.memory.globalPlaceholder")}
                className="min-h-44 font-mono text-xs"
              />
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onMemoryOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={savingMemory}
              onClick={onSaveMemory}
            >
              {savingMemory ? t("aiEdit.memory.saving") : t("aiEdit.memory.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Project assets + shared library ─────────────────────────── */}
      <Dialog open={assetsOpen} onOpenChange={onAssetsOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              {t("aiEdit.assets.title", {
                project: workspaceInfo?.projectSlug || "Project",
              })}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("aiEdit.assets.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-muted/20 p-2.5 text-[11px]">
            <div className="min-w-0">
              <span className="text-muted-foreground">
                {t("aiEdit.assets.projectPath")}
              </span>
              <span
                className="font-mono text-foreground truncate block"
                title={workspaceInfo?.path}
              >
                {workspaceInfo?.path || "..."}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted-foreground">
                {t("aiEdit.assets.libraryPath")}
              </span>
              <span
                className="font-mono text-foreground truncate block"
                title={workspaceInfo ? `${workspaceInfo.globalPath}/library` : ""}
              >
                {workspaceInfo ? `${workspaceInfo.globalPath}/library` : "..."}
              </span>
            </div>
          </div>

          {[
            [
              {
                id: "all",
                label: t("aiEdit.assets.tabs.all", {
                  count: projectAssets.length,
                }),
              },
              { id: "video", label: t("aiEdit.assets.tabs.video") },
              { id: "images", label: t("aiEdit.assets.tabs.images") },
              { id: "voice", label: t("aiEdit.assets.tabs.voice") },
              { id: "music", label: t("aiEdit.assets.tabs.music") },
              { id: "sfx", label: t("aiEdit.assets.tabs.sfx") },
              { id: "motion-graphics", label: t("aiEdit.assets.tabs.motion") },
              { id: "exports", label: t("aiEdit.assets.tabs.exports") },
              { id: "skills", label: t("aiEdit.assets.tabs.skills") },
            ],
            [
              { id: "templates", label: t("aiEdit.assets.tabs.templates") },
              { id: "library-music", label: t("aiEdit.assets.tabs.libraryMusic") },
              { id: "library-sfx", label: t("aiEdit.assets.tabs.librarySfx") },
              { id: "library-skills", label: t("aiEdit.assets.tabs.librarySkills") },
            ],
          ].map((row, rowIndex) => (
            <div
              key={rowIndex}
              className="flex items-center gap-1 rounded-lg bg-muted/50 p-1 text-xs"
            >
              {rowIndex === 1 && (
                <span className="shrink-0 px-1.5 text-[10.5px] text-muted-foreground">
                  {t("aiEdit.assets.library")}
                </span>
              )}
              {row.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setAssetCategory(tab.id)}
                  className={cn(
                    "flex-1 rounded-md py-1.5 font-medium transition-colors truncate px-1.5",
                    assetCategory === tab.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ))}

          {skillsTab && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              <span className="min-w-0">{t("aiEdit.assets.skillsHint")}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 px-2.5 text-[11px] gap-1 shrink-0"
                onClick={() => onImportSkills(assetCategory === "library-skills")}
                title={t("aiEdit.assets.importSkillTooltip")}
              >
                <FolderInput className="size-3" />
                {t("aiEdit.assets.importSkill")}
              </Button>
            </div>
          )}

          <div className="max-h-64 min-h-40 overflow-y-auto space-y-1.5 pr-1">
            {filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-center text-xs text-muted-foreground gap-1.5">
                <Sparkles className="size-5 opacity-50" />
                <span>
                  {t(skillsTab ? "aiEdit.assets.emptySkills" : "aiEdit.assets.empty")}
                </span>
              </div>
            ) : (
              filteredAssets.map((item) => {
                const isPlayableMedia = /\.(mp4|mov|webm|mkv|png|jpg|jpeg|webp)$/i.test(
                  item.name,
                );
                const isPreviewable =
                  (item.category === "motion-graphics" ||
                    item.category === "templates") &&
                  (item.isDir || /\.html?$/i.test(item.name));
                return (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/50 bg-card/40 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.category === "skills" ||
                      item.category === "library-skills" ? (
                        <BookOpen className="size-4 text-emerald-500 shrink-0" />
                      ) : item.isDir ? (
                        <Folder className="size-4 text-amber-500 shrink-0" />
                      ) : (
                        <Film className="size-4 text-primary shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {item.name}
                        </div>
                        <div className="text-[10.5px] text-muted-foreground font-mono truncate">
                          [{item.category}] {item.path}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px] gap-1"
                        onClick={() => {
                          onInsertAssetPath(item.path);
                          onAssetsOpenChange(false);
                        }}
                        title={t("aiEdit.assets.attachTooltip")}
                      >
                        <Paperclip className="size-3" />
                        {t("aiEdit.assets.attach")}
                      </Button>
                      {(item.category === "motion-graphics" ||
                        item.category === "skills") && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] gap-1"
                          onClick={() => onSaveAsTemplate(item)}
                          title={t("aiEdit.assets.saveTemplateTooltip")}
                        >
                          <BookmarkPlus className="size-3" />
                          {t("aiEdit.assets.saveTemplate")}
                        </Button>
                      )}
                      {isLibraryAsset(item) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] gap-1"
                          onClick={() => onUseTemplate(item)}
                          title={t("aiEdit.assets.useTooltip")}
                        >
                          <CopyPlus className="size-3" />
                          {t("aiEdit.assets.use")}
                        </Button>
                      )}
                      {isPreviewable && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-[11px] gap-1"
                          onClick={() => {
                            onPreviewAsset(item);
                            onAssetsOpenChange(false);
                          }}
                          title={t("aiEdit.preview.tooltip")}
                        >
                          <MonitorPlay className="size-3" />
                          {t("aiEdit.preview.button")}
                        </Button>
                      )}
                      {isPlayableMedia && !item.isDir && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-[11px] gap-1"
                          onClick={() => onQuickPlaceOnTimeline(item)}
                          title={t("aiEdit.assets.placeTooltip")}
                        >
                          <Play className="size-3" />
                          {t("aiEdit.assets.place")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onAssetsOpenChange(false)}
            >
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Rename Conversation ───────────────────────────────────── */}
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) onClearRenameTarget();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t("aiEdit.rename.title")}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameTarget && renameDraft.trim()) {
                onConfirmRename();
              }
            }}
            className="text-xs"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClearRenameTarget}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!renameDraft.trim()}
              onClick={onConfirmRename}
            >
              {t("aiEdit.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
