import * as React from "react";
import {
  Film,
  Folder,
  Layers,
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
import type { ProjectAssetItem, WorkspaceInfo } from "@/api/cli-chat-api";

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
  renameTarget,
  onClearRenameTarget,
  renameDraft,
  onRenameDraftChange,
  onConfirmRename,
}: AiEditDialogsProps) {
  const [memoryTab, setMemoryTab] = React.useState<"project" | "global">(
    "project",
  );
  const [assetCategory, setAssetCategory] = React.useState<string>("all");

  const assets = workspaceInfo?.assets || [];
  const filteredAssets =
    assetCategory === "all"
      ? assets
      : assets.filter((a) => a.category === assetCategory);

  return (
    <>
      {/* ── Dialog: System Prompt ─────────────────────────────────────────── */}
      <Dialog open={systemPromptOpen} onOpenChange={onSystemPromptOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">
              Chỉ dẫn hệ thống (System Prompt)
            </DialogTitle>
            <DialogDescription className="text-xs">
              Chỉ dẫn riêng cho cuộc trò chuyện này (phong cách dựng, quy tắc
              cắt, tỷ lệ khung hình...). Ngữ cảnh Timeline và Project Workspace
              đã được tự động đính kèm.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={systemPromptDraft}
            onChange={(e) => onSystemPromptDraftChange(e.target.value)}
            placeholder="Ví dụ: Luôn dựng theo nhịp nhanh 2.5s/cảnh, ưu tiên zoom 1.15x vào các câu nhấn mạnh..."
            className="min-h-36 text-xs"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onSystemPromptOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="button" size="sm" onClick={onSaveSystemPrompt}>
              Lưu chỉ dẫn
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: 2-Tier Memory (Project memory.md + Global global-memory.md) */}
      <Dialog open={memoryOpen} onOpenChange={onMemoryOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base">
              Bộ nhớ AI 2 Tầng (Project & Global Memory)
            </DialogTitle>
            <DialogDescription className="text-xs">
              Tách biệt ngữ cảnh riêng của Project đang mở (
              <span className="font-mono font-medium text-foreground">
                {workspaceInfo?.projectSlug || "default-project"}
              </span>
              ) và phong cách dựng phim dùng chung cho mọi dự án.
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
              Theo Project ({workspaceInfo?.projectSlug || "memory.md"})
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
              Toàn cục (global-memory.md)
            </button>
          </div>

          {memoryTab === "project" ? (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {workspaceInfo?.path
                  ? `${workspaceInfo.path}/memory.md`
                  : "memory.md"}
              </div>
              <Textarea
                value={memoryDraft}
                onChange={(e) => onMemoryDraftChange(e.target.value)}
                placeholder="Ghi chú riêng cho video này: chủ đề, kịch bản, tone màu, nhân vật, yêu cầu đặc biệt..."
                className="min-h-44 font-mono text-xs"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="text-[11px] text-muted-foreground font-mono truncate">
                {workspaceInfo?.globalPath
                  ? `${workspaceInfo.globalPath}/global-memory.md`
                  : "global-memory.md"}
              </div>
              <Textarea
                value={globalMemoryDraft}
                onChange={(e) => onGlobalMemoryDraftChange(e.target.value)}
                placeholder="Phong cách dựng mặc định cho MỌI dự án: font chữ thương hiệu, bảng màu, nhịp cắt, thư mục nhạc nền..."
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
              Hủy
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={savingMemory}
              onClick={onSaveMemory}
            >
              {savingMemory ? "Đang lưu..." : "Lưu Bộ nhớ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: 2-Tier Project Assets (Motion Graphics, AI B-Roll, Exports) */}
      <Dialog open={assetsOpen} onOpenChange={onAssetsOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              Quản lý Project Assets ({workspaceInfo?.projectSlug || "Project"})
            </DialogTitle>
            <DialogDescription className="text-xs">
              Mỗi Project CapCut / DaVinci có không gian lưu trữ riêng cho{" "}
              <span className="font-medium text-foreground">
                Motion Graphics
              </span>
              , <span className="font-medium text-foreground">B-Roll AI</span>{" "}
              và <span className="font-medium text-foreground">Exports</span>{" "}
              cùng kho Template toàn cục.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-muted/20 p-2.5 text-[11px]">
            <div className="min-w-0">
              <span className="text-muted-foreground">Motion Graphics: </span>
              <span className="font-mono text-foreground truncate block">
                {workspaceInfo?.motionGraphicsDir || "..."}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted-foreground">B-Roll AI: </span>
              <span className="font-mono text-foreground truncate block">
                {workspaceInfo?.aiBrollDir || "..."}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted-foreground">Exports (.mp4): </span>
              <span className="font-mono text-foreground truncate block">
                {workspaceInfo?.exportsDir || "..."}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-muted-foreground">Global Templates: </span>
              <span className="font-mono text-foreground truncate block">
                {workspaceInfo?.templatesDir || "..."}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1 text-xs">
            {[
              { id: "all", label: `Tất cả (${assets.length})` },
              { id: "motion-graphics", label: "Motion Graphics" },
              { id: "ai-broll", label: "B-Roll AI" },
              { id: "exports", label: "Exports (.mp4)" },
              { id: "templates", label: "Global Templates" },
            ].map((tab) => (
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

          <div className="max-h-64 min-h-40 overflow-y-auto space-y-1.5 pr-1">
            {filteredAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-center text-xs text-muted-foreground gap-1.5">
                <Sparkles className="size-5 opacity-50" />
                <span>
                  Chưa có asset nào trong mục này. Hãy yêu cầu AI tạo Motion
                  Graphic hoặc B-Roll!
                </span>
              </div>
            ) : (
              filteredAssets.map((item) => {
                const isPlayableMedia = /\.(mp4|mov|webm|mkv|png|jpg|jpeg|webp)$/i.test(
                  item.name,
                );
                return (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/50 bg-card/40 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.isDir ? (
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
                        title="Đính kèm đường dẫn vào khung chat (@)"
                      >
                        <Paperclip className="size-3" />
                        @Chat
                      </Button>
                      {isPlayableMedia && !item.isDir && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-[11px] gap-1"
                          onClick={() => onQuickPlaceOnTimeline(item)}
                          title="Đặt trực tiếp file này lên Timeline"
                        >
                          <Play className="size-3" />
                          Lên Timeline
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
              Đóng
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
              Đổi tên cuộc trò chuyện
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
              Hủy
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!renameDraft.trim()}
              onClick={onConfirmRename}
            >
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
