import { useTranslation } from "react-i18next";
import {
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ContentConversation } from "@/stores/ai-edit-chat-store";
import { editorLabel } from "./ai-edit-helpers";
import { OpenAgentAppButtons } from "@/components/external-agent/external-agent-badge";

/** Short editor tag in front of each chat title. */
const EDITOR_TAGS: Record<string, { label: string; name: string; className: string }> = {
  premiere: {
    label: "PR",
    name: "Premiere Pro",
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  },
};

export interface AiEditSidebarProps {
  conversations: ContentConversation[];
  activeConversationId: string | null;
  runningTexts: Record<string, string>;
  /** The project open in the editor; a chat without one yet shows this. */
  openProjectName: string | null;
  /** The editor selected in the app; a chat not bound yet is tagged with it. */
  openEditor: string;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onCreateConversation: () => void;
  onSelectConversation: (id: string) => void;
  onTogglePin: (id: string) => void;
  onStartRename: (conv: { id: string; title: string }) => void;
  onDeleteConversation: (id: string) => void;
  onCollapse: () => void;
}

export function AiEditSidebar({
  conversations,
  activeConversationId,
  runningTexts,
  openProjectName,
  openEditor,
  searchQuery,
  onSearchQueryChange,
  onCreateConversation,
  onSelectConversation,
  onTogglePin,
  onStartRename,
  onDeleteConversation,
  onCollapse,
}: AiEditSidebarProps) {
  const { t } = useTranslation();
  return (
    <aside className="flex w-64 min-w-[16rem] max-w-[16rem] shrink-0 flex-col border-r border-border/60 bg-card/20 select-none overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <span className="text-xs font-semibold tracking-tight text-foreground/90">
          {t("aiEdit.sidebar.title")}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            onClick={onCreateConversation}
            title={t("aiEdit.newChat")}
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            onClick={onCollapse}
            title={t("aiEdit.sidebar.collapse")}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="px-2.5 pb-2 shrink-0">
        <div className="relative">
          <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder={t("aiEdit.sidebar.search")}
            className="h-8 rounded-xl border-0 bg-muted/50 pl-8 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring/40"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-1 space-y-0.5">
        {conversations.map((conv) => {
          const tag =
            EDITOR_TAGS[
              conv.boundWorkspace?.editor ?? conv.boundIntegration ?? openEditor
            ];
          const isActive = conv.id === activeConversationId;
          const isRunning = runningTexts[conv.id] !== undefined;
          return (
            <div
              key={conv.id}
              onClick={() => onSelectConversation(conv.id)}
              className={cn(
                "group relative flex w-full max-w-full items-center justify-between gap-1.5 rounded-xl px-2.5 py-2 text-xs cursor-pointer transition-colors overflow-hidden",
                isActive
                  ? "bg-muted/90 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                  {tag && (
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-px text-[9.5px] font-semibold leading-none tracking-wide",
                        tag.className,
                      )}
                      title={tag.name}
                    >
                      {tag.label}
                    </span>
                  )}
                  {conv.pinned && (
                    <Pin className="size-3 shrink-0 text-amber-500" />
                  )}
                  {isRunning && (
                    <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
                  )}
                  <span
                    className={cn(
                      "block truncate text-[12.5px] leading-snug",
                      isActive ? "font-medium" : "font-normal",
                    )}
                  >
                    {conv.title || t("aiEdit.newChat")}
                  </span>
                </div>
                <div className="text-[10.5px] text-muted-foreground/70 mt-0.5 truncate">
                  {(() => {
                    // Project name only: a new chat shows the open project,
                    // which it binds to on its first message.
                    const project =
                      conv.boundWorkspace?.name ??
                      (conv.boundIntegration
                        ? editorLabel(conv.boundIntegration, true)
                        : openProjectName);
                    return project ? `${project} · ` : "";
                  })()}
                  {t("aiEdit.sidebar.messages", { count: conv.messages.length })}
                </div>
              </div>

              <div
                className={cn(
                  "shrink-0 items-center gap-0.5",
                  isActive ? "flex" : "hidden group-hover:flex",
                )}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(conv.id);
                  }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={conv.pinned ? t("aiEdit.sidebar.unpin") : t("aiEdit.sidebar.pin")}
                >
                  {conv.pinned ? (
                    <PinOff className="size-3" />
                  ) : (
                    <Pin className="size-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartRename({
                      id: conv.id,
                      title: conv.title,
                    });
                  }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t("aiEdit.sidebar.rename")}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(conv.id);
                  }}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t("aiEdit.sidebar.delete")}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Open Claude / Antigravity in the agent folder */}
      <OpenAgentAppButtons />
    </aside>
  );
}
