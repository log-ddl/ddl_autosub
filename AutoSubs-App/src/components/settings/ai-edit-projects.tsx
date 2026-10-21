import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  conversationUsesProject,
  deleteWorkspaceProject,
  listWorkspaceProjects,
  type WorkspaceProjectEntry,
} from "@/api/cli-chat-api";
import { useAiEditChatStore } from "@/stores/ai-edit-chat-store";

const EDITOR_NAMES: Record<string, string> = {
  davinci: "DaVinci Resolve",
  premiere: "Premiere Pro",
  capcut: "CapCut",
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Settings section listing the folders AI Edit keeps per editor project.
 * Deleting one removes it from AutoSubs only: its folder goes to the Trash
 * and the chats bound to it are deleted; the editor's project is untouched.
 */
export function AiEditProjects({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const conversations = useAiEditChatStore((s) => s.conversations);
  const deleteConversations = useAiEditChatStore((s) => s.deleteConversations);
  const [projects, setProjects] = React.useState<WorkspaceProjectEntry[] | null>(null);
  const [busyPath, setBusyPath] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<WorkspaceProjectEntry | null>(null);

  const load = React.useCallback(() => {
    listWorkspaceProjects()
      .then(setProjects)
      .catch((err) => {
        console.error("[AiEditProjects] could not list projects:", err);
        setProjects([]);
      });
  }, []);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const chatsFor = React.useCallback(
    (entry: WorkspaceProjectEntry) =>
      conversations.filter((c) => conversationUsesProject(c.boundWorkspace, entry)),
    [conversations],
  );

  async function handleDelete(entry: WorkspaceProjectEntry) {
    const chats = chatsFor(entry);
    setBusyPath(entry.path);
    try {
      await deleteWorkspaceProject(entry.path);
      deleteConversations(chats.map((c) => c.id));
      setProjects((list) => list?.filter((p) => p.path !== entry.path) ?? null);
    } catch (err) {
      toast.error(t("settings.aiProjects.errorTitle"), { description: String(err) });
    } finally {
      setBusyPath(null);
    }
  }

  const pendingChats = pendingDelete ? chatsFor(pendingDelete).length : 0;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("settings.sections.aiProjects")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("settings.aiProjects.description")}
        </p>
      </div>

      {projects === null ? (
        <p className="text-xs text-muted-foreground">{t("settings.aiProjects.loading")}</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.aiProjects.empty")}</p>
      ) : (
        <FieldGroup className="gap-2">
          {projects.map((entry) => {
            const editor = EDITOR_NAMES[entry.editor] ?? t("settings.aiProjects.noEditor");
            const chatCount = chatsFor(entry).length;
            return (
              <Field key={entry.path}>
                <Item variant="outline" size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="truncate" title={entry.name}>
                      {entry.name}
                    </ItemTitle>
                    <ItemDescription className="text-xs leading-tight line-clamp-1">
                      {editor} · {formatSize(entry.sizeBytes)} ·{" "}
                      {t("settings.aiProjects.chatCount", { count: chatCount })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      title={t("settings.aiProjects.openFolder")}
                      aria-label={t("settings.aiProjects.openFolder")}
                      onClick={() => void revealItemInDir(entry.path)}
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive"
                      title={t("settings.aiProjects.delete")}
                      aria-label={t("settings.aiProjects.delete")}
                      disabled={busyPath === entry.path}
                      onClick={() => setPendingDelete(entry)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </ItemActions>
                </Item>
              </Field>
            );
          })}
        </FieldGroup>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.aiProjects.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete &&
                t("settings.aiProjects.confirm", {
                  name: pendingDelete.name,
                  editor: EDITOR_NAMES[pendingDelete.editor] ?? pendingDelete.editor,
                  count: pendingChats,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (pendingDelete) void handleDelete(pendingDelete);
                setPendingDelete(null);
              }}
            >
              {t("settings.aiProjects.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
