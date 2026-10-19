import * as React from "react";
import {
  Check,
  FolderOpen,
  Film,
  Clock,
  Layers,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useCapCut } from "@/contexts/CapCutContext";
import type { CapCutDraftSummary } from "@/api/capcut-api";

function formatDurationUs(durationUs: number): string {
  if (!durationUs || durationUs <= 0) return "00:00";
  const totalSec = Math.round(durationUs / 1_000_000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatModifiedUs(modifiedUs: number): string {
  if (!modifiedUs || modifiedUs <= 0) return "-";
  // CapCut timestamps are in microseconds; some versions add an offset or use epoch us
  let ms = Math.floor(modifiedUs / 1000);
  const nowMs = Date.now();
  if (ms > nowMs + 86400_000 * 365) {
    // Normalize if CapCut uses shifted timestamp
    return "Gần đây";
  }
  try {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

export function CapCutProjectPickerDialog() {
  const {
    drafts,
    draftsRoot,
    selectedDraftId,
    setSelectedDraftId,
    isProjectPickerOpen,
    setProjectPickerOpen,
    refresh,
  } = useCapCut();

  const [search, setSearch] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);

  const filteredDrafts = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drafts;
    return drafts.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q) ||
        d.folderPath.toLowerCase().includes(q),
    );
  }, [drafts, search]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  function handleSelectProject(draft: CapCutDraftSummary) {
    setSelectedDraftId(draft.id);
    setProjectPickerOpen(false);
  }

  return (
    <Dialog open={isProjectPickerOpen} onOpenChange={setProjectPickerOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2.5">
              <img
                src="/capcut-logo.svg"
                alt="CapCut"
                className="size-7 rounded-md"
              />
              <div>
                <DialogTitle className="text-base">
                  Chọn Project CapCut để làm việc
                </DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  Chọn một dự án từ danh sách bên dưới. Mọi thao tác cắt ghép, import và phụ đề sẽ ghi trực tiếp vào project này.
                </DialogDescription>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="gap-1.5 h-8 text-xs shrink-0"
            >
              <RotateCcw
                className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Làm mới
            </Button>
          </div>
        </DialogHeader>

        {/* Thanh tìm kiếm & đường dẫn thư mục */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm theo tên project CapCut..."
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Badge variant="secondary" className="text-[11px] font-normal shrink-0">
            {drafts.length} project
          </Badge>
        </div>

        {/* Bảng danh sách các Project CapCut */}
        <div className="border rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/50 border-b text-[11px] font-medium text-muted-foreground">
            <div className="col-span-5">Tên Project</div>
            <div className="col-span-3">Thông số Canvas</div>
            <div className="col-span-2">Timeline</div>
            <div className="col-span-2 text-right">Trạng thái</div>
          </div>

          <div className="overflow-y-auto max-h-[360px] divide-y">
            {filteredDrafts.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">
                  Không tìm thấy project CapCut nào
                </p>
                <p>
                  Hãy mở CapCut Desktop và tạo ít nhất 1 project mới, sau đó bấm{" "}
                  <span className="font-medium">Làm mới</span>.
                </p>
              </div>
            ) : (
              filteredDrafts.map((draft) => {
                const isSelected = selectedDraftId === draft.id;
                const width = draft.width || 1920;
                const height = draft.height || 1080;
                const fps = draft.fps || 30;
                const tracks = draft.trackCount ?? 0;
                const clips = draft.clipCount ?? 0;

                return (
                  <div
                    key={draft.id}
                    onClick={() => handleSelectProject(draft)}
                    className={`grid grid-cols-12 gap-2 px-3 py-2.5 items-center text-xs cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-green-500/10 hover:bg-green-500/15"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    {/* Cột 1: Tên Project & đường dẫn */}
                    <div className="col-span-5 min-w-0 flex items-center gap-2.5">
                      <div
                        className={`size-8 rounded-md flex items-center justify-center shrink-0 ${
                          isSelected
                            ? "bg-green-500/20 text-green-600 dark:text-green-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <FolderOpen className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm truncate flex items-center gap-1.5">
                          <span className="truncate">{draft.name}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          Cập nhật: {formatModifiedUs(draft.modifiedUs)}
                        </div>
                      </div>
                    </div>

                    {/* Cột 2: Độ phân giải & FPS */}
                    <div className="col-span-3 text-xs text-muted-foreground space-y-0.5">
                      <div className="flex items-center gap-1 text-foreground font-medium">
                        <Film className="size-3 text-muted-foreground shrink-0" />
                        <span>
                          {width}×{height}
                        </span>
                      </div>
                      <div className="text-[11px]">{fps} FPS</div>
                    </div>

                    {/* Cột 3: Thời lượng & Số Track/Clip */}
                    <div className="col-span-2 text-xs text-muted-foreground space-y-0.5">
                      <div className="flex items-center gap-1 text-foreground font-medium">
                        <Clock className="size-3 text-muted-foreground shrink-0" />
                        <span>{formatDurationUs(draft.durationUs)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[11px]">
                        <Layers className="size-3 shrink-0" />
                        <span>
                          {tracks} tr · {clips} clip
                        </span>
                      </div>
                    </div>

                    {/* Cột 4: Nút chọn */}
                    <div className="col-span-2 flex justify-end">
                      {isSelected ? (
                        <Badge
                          variant="outline"
                          className="gap-1 border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300 font-medium"
                        >
                          <Check className="size-3" />
                          Đang chọn
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectProject(draft);
                          }}
                        >
                          Chọn
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer hiển thị thư mục gốc */}
        {draftsRoot && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
            <span className="truncate">Thư mục Drafts: {draftsRoot}</span>
            <span className="shrink-0 ml-2">
              Mẹo: Thoát về màn hình Home CapCut trước khi bấm dựng
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
