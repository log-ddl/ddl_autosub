import * as React from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  ensureCliWorkspace,
  copyCliAsset,
  importCliSkills,
  getCliModels,
  getCliRuntimeStatus,
  runCliTextTask,
  saveCliMemory,
  type CliRuntimeStatus,
  type ContentCliAdapter,
  type WorkspaceInfo,
} from "@/api/cli-chat-api";
import { executeTimelineAction as runTimelineAction } from "@/api/ai-edit-api";
import {
  useAiEditChatStore,
  type ContentMessage,
} from "@/stores/ai-edit-chat-store";
import { useIntegration } from "@/contexts/IntegrationContext";
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext";
import {
  cliLabel,
  extractTimelineActions,
  mergeStepEvent,
  type TimelineActionCommand,
} from "./ai-edit-helpers";
import { useEditorAdapter } from "./editors";
import { useAiEditPreview } from "./ai-edit-preview-panel";
import { listPreviewCandidates } from "@/api/preview-api";

export function useAiEditController() {
  const { t } = useTranslation();
  const { selectedIntegration } = useIntegration();
  // Everything editor-specific (target, project, snapshot, prompt, refresh)
  // lives in ./editors/<editor>.ts.
  const editor = useEditorAdapter(selectedIntegration);
  // The transcript open in the app is the one get_transcript reads by default.
  const { currentSubtitleDocumentFilename } = useSubtitleDocument();

  // Store selectors
  const conversations = useAiEditChatStore((s) => s.conversations);
  const activeConversationId = useAiEditChatStore(
    (s) => s.activeConversationId,
  );
  const adapter = useAiEditChatStore((s) => s.adapter);
  const selectedModels = useAiEditChatStore((s) => s.models);
  const selectedEfforts = useAiEditChatStore((s) => s.efforts);
  const createConversation = useAiEditChatStore((s) => s.createConversation);
  const selectConversation = useAiEditChatStore((s) => s.selectConversation);
  const deleteConversation = useAiEditChatStore((s) => s.deleteConversation);
  const clearConversationMessages = useAiEditChatStore(
    (s) => s.clearConversationMessages,
  );
  const addMessage = useAiEditChatStore((s) => s.addMessage);
  const setAdapter = useAiEditChatStore((s) => s.setAdapter);
  const setModel = useAiEditChatStore((s) => s.setModel);
  const setConversationWorkspace = useAiEditChatStore(
    (s) => s.setConversationWorkspace,
  );
  const bindConversationAdapter = useAiEditChatStore(
    (s) => s.bindConversationAdapter,
  );
  const bindConversationTarget = useAiEditChatStore(
    (s) => s.bindConversationTarget,
  );
  const setConversationSystemPrompt = useAiEditChatStore(
    (s) => s.setConversationSystemPrompt,
  );
  const renameConversation = useAiEditChatStore((s) => s.renameConversation);
  const toggleConversationPinned = useAiEditChatStore(
    (s) => s.toggleConversationPinned,
  );

  // Local UI state
  const [draft, setDraft] = React.useState("");
  const [status, setStatus] = React.useState<CliRuntimeStatus | null>(null);
  const [checkingRuntime, setCheckingRuntime] = React.useState(false);
  const [availableModels, setAvailableModels] = React.useState<string[]>([]);
  const [runningTexts, setRunningTexts] = React.useState<
    Record<string, string>
  >({});
  const [runningThinking, setRunningThinking] = React.useState<
    Record<string, string>
  >({});
  const [runningSteps, setRunningSteps] = React.useState<
    Record<string, string[]>
  >({});
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [autoApplyActions, setAutoApplyActions] = React.useState(true);

  // Workspace & Dialogs
  const [workspaceInfo, setWorkspaceInfo] =
    React.useState<WorkspaceInfo | null>(null);
  const [assetsOpen, setAssetsOpen] = React.useState(false);
  const [memoryOpen, setMemoryOpen] = React.useState(false);
  const [memoryDraft, setMemoryDraft] = React.useState("");
  const [globalMemoryDraft, setGlobalMemoryDraft] = React.useState("");
  const [savingMemory, setSavingMemory] = React.useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");
  const [renameTarget, setRenameTarget] = React.useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const preview = useAiEditPreview();

  const abortControllersRef = React.useRef(new Map<string, AbortController>());
  const endRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Ensure at least one conversation exists
  React.useEffect(() => {
    if (conversations.length === 0) {
      createConversation();
    } else if (
      !activeConversationId ||
      !conversations.some((c) => c.id === activeConversationId)
    ) {
      selectConversation(conversations[0].id);
    }
  }, [
    conversations,
    activeConversationId,
    createConversation,
    selectConversation,
  ]);

  const activeConversation = React.useMemo(
    () =>
      conversations.find((item) => item.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );
  const rawAdapter = activeConversation?.adapter ?? adapter;
  const activeAdapter: ContentCliAdapter =
    rawAdapter === "claude" ? "claude" : "agy";
  const activeRunText = activeConversation
    ? runningTexts[activeConversation.id]
    : undefined;
  const activeThinkingText = activeConversation
    ? runningThinking[activeConversation.id]
    : undefined;
  const activeStepList = activeConversation
    ? runningSteps[activeConversation.id] || []
    : [];
  const activeIsRunning = activeRunText !== undefined;
  const providerLocked = Boolean(
    activeConversation?.messages.some((m) => m.role === "user"),
  );
  const selectedModel = selectedModels[activeAdapter];
  const adapterStatus = status?.[activeAdapter];

  const activeProjectId = editor.projectId;
  const activeProjectName = editor.projectName;
  // A conversation keeps the project it started in, so switching to an old
  // conversation shows that project's assets, not the open project's.
  const workspaceProject =
    activeConversation?.boundWorkspace ?? editor.workspaceProject;
  // An editor is connected but hasn't told us its project yet.
  const projectUnknown = Boolean(editor.target) && !workspaceProject;

  const contextMismatch = React.useMemo(() => {
    if (
      !activeConversation ||
      !providerLocked ||
      !activeConversation.boundIntegration
    ) {
      return null;
    }
    const isDiffIntegration =
      activeConversation.boundIntegration !== selectedIntegration;
    const bound = activeConversation.boundWorkspace;
    const open = editor.workspaceProject;
    const isDiffProject =
      (Boolean(activeConversation.boundProjectId) &&
        Boolean(activeProjectId) &&
        activeConversation.boundProjectId !== activeProjectId) ||
      (Boolean(bound) &&
        Boolean(open) &&
        (bound!.editor !== open!.editor ||
          (bound!.id || bound!.name) !== (open!.id || open!.name)));
    if (!isDiffIntegration && !isDiffProject) return null;
    return {
      boundIntegration: activeConversation.boundIntegration,
      boundProjectId: activeConversation.boundProjectId ?? null,
      boundProjectName:
        [activeConversation.boundWorkspace?.name, activeConversation.boundProjectName]
          .filter(Boolean)
          .join(" · ") ||
        activeConversation.boundProjectId ||
        t("aiEdit.defaultProject"),
      currentIntegration: selectedIntegration,
      currentProjectId: activeProjectId,
      currentProjectName:
        [editor.workspaceProject?.name, activeProjectName]
          .filter(Boolean)
          .join(" · ") || t("aiEdit.notSelected"),
    };
  }, [
    activeConversation,
    providerLocked,
    selectedIntegration,
    activeProjectId,
    activeProjectName,
    editor.workspaceProject,
  ]);

  // Auto-resize textarea height cleanly
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(28, el.scrollHeight))}px`;
  }, [draft]);

  const refreshRuntime = React.useCallback(async () => {
    setCheckingRuntime(true);
    try {
      setStatus(await getCliRuntimeStatus());
    } catch (err) {
      console.warn("Failed to check CLI runtime:", err);
    } finally {
      setCheckingRuntime(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const loadModels = React.useCallback(async () => {
    try {
      const res = await getCliModels(activeAdapter);
      const list = res.models || [];
      setAvailableModels(list);
      const current = selectedModels[activeAdapter];
      if (current && list.length > 0 && !list.includes(current)) {
        setModel(activeAdapter, "");
      }
    } catch {
      // ignore
    }
  }, [activeAdapter, selectedModels, setModel]);

  React.useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const refreshWorkspace = React.useCallback(async () => {
    if (projectUnknown) {
      setWorkspaceInfo(null);
      return;
    }
    try {
      const info = await ensureCliWorkspace(
        activeConversation?.workspacePath ?? null,
        workspaceProject,
      );
      setWorkspaceInfo(info);
    } catch {
      // ignore
    }
  }, [activeConversation?.workspacePath, workspaceProject, projectUnknown]);

  React.useEffect(() => {
    void refreshWorkspace();
  }, [activeConversation?.id, refreshWorkspace]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    activeConversation?.messages.length,
    activeRunText,
    activeThinkingText,
    activeStepList.length,
  ]);

  const executeTimelineAction = React.useCallback(
    async (cmd: TimelineActionCommand) => {
      const target = editor.target;
      if (!target) {
        toast.error(t("aiEdit.errors.unsupported"));
        return;
      }
      try {
        const outcome = await runTimelineAction(
          target,
          cmd as unknown as Record<string, unknown>,
          workspaceInfo?.path,
        );
        if (outcome.partial) {
          toast.warning(outcome.message, { description: outcome.lines.join("\n") || undefined });
        } else {
          toast.success(cmd.summary || outcome.message);
        }
        await editor.refreshAfterEdit();
      } catch (err: any) {
        toast.error(err?.message || String(err));
      }
    },
    [editor],
  );

  // The agent edits through the MCP tools in the backend; refresh after each
  // edit so the timeline view stays current. No toast: the tool result already
  // shows in the chat, and one popup per edit was too noisy.
  const refreshAfterEdit = editor.refreshAfterEdit;
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("ai-edit-timeline-changed", () => {
      void refreshAfterEdit();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshAfterEdit]);

  async function handlePickWorkspace() {
    if (!activeConversation || providerLocked) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("aiEdit.pickWorkspaceTitle"),
    });
    if (typeof picked === "string" && picked.trim()) {
      setConversationWorkspace(activeConversation.id, picked.trim());
    }
  }

  async function handleAttachFile() {
    const picked = await openDialog({
      directory: false,
      multiple: true,
      title: t("aiEdit.attachTitle"),
    });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    if (list.length === 0) return;
    const refs = list.map((p) => `@"${p}"`).join(" ");
    setDraft((prev) => (prev ? `${prev} ${refs} ` : `${refs} `));
    textareaRef.current?.focus();
  }

  function handleInsertAssetPath(filePath: string) {
    const ref = `@"${filePath}"`;
    setDraft((prev) => (prev ? `${prev} ${ref} ` : `${ref} `));
    textareaRef.current?.focus();
  }

  async function handleQuickPlaceAssetOnTimeline(
    asset: import("@/api/cli-chat-api").ProjectAssetItem,
  ) {
    await executeTimelineAction({
      action: "build_storyboard",
      summary: t("aiEdit.assets.placeSummary", { name: asset.name }),
      items: [{ path: asset.path, start: 0, end: 4 }],
    });
  }

  /** This project's motion graphics; templates open from the asset library. */
  async function listPreviewTargets() {
    const dir = workspaceInfo?.motionGraphicsDir;
    return dir ? listPreviewCandidates(dir).catch(() => []) : [];
  }

  async function copyAsset(
    asset: import("@/api/cli-chat-api").ProjectAssetItem,
    destinationDir: string | undefined,
    done: string,
  ) {
    if (!destinationDir) return;
    try {
      await copyCliAsset(asset.path, destinationDir);
      await refreshWorkspace();
      toast.success(done);
    } catch (err: any) {
      toast.error(err?.message || String(err));
    }
  }

  function handleSaveAsTemplate(
    asset: import("@/api/cli-chat-api").ProjectAssetItem,
  ) {
    const skill = asset.category === "skills";
    return copyAsset(
      asset,
      skill ? workspaceInfo?.librarySkillsDir : workspaceInfo?.templatesDir,
      t(skill ? "aiEdit.assets.savedSkill" : "aiEdit.assets.savedTemplate", {
        name: asset.name,
      }),
    );
  }

  function handleUseTemplate(
    asset: import("@/api/cli-chat-api").ProjectAssetItem,
  ) {
    // Library files are copied in, never linked: the project keeps working
    // if the library changes.
    const destination =
      asset.category === "library-music"
        ? workspaceInfo?.musicDir
        : asset.category === "library-sfx"
          ? workspaceInfo?.sfxDir
          : asset.category === "library-skills"
            ? workspaceInfo?.skillsDir
            : workspaceInfo?.motionGraphicsDir;
    return copyAsset(asset, destination, t("aiEdit.assets.copied", { name: asset.name }));
  }

  /** Picks a folder holding one skill (or several) and copies it into the project or the library. */
  async function handleImportSkills(toLibrary: boolean) {
    const destination = toLibrary
      ? workspaceInfo?.librarySkillsDir
      : workspaceInfo?.skillsDir;
    if (!destination) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("aiEdit.assets.importSkillTitle"),
    });
    if (typeof picked !== "string" || !picked.trim()) return;
    try {
      const names = await importCliSkills(picked, destination);
      await refreshWorkspace();
      toast.success(
        t("aiEdit.assets.importedSkills", { names: names.join(", ") }),
      );
    } catch (err: any) {
      toast.error(err?.message || String(err));
    }
  }

  async function handlePreviewAsset(
    asset: import("@/api/cli-chat-api").ProjectAssetItem,
  ) {
    // The asset list doesn't know whether a folder runs a dev server; ask.
    const dir =
      asset.category === "templates"
        ? workspaceInfo?.templatesDir
        : workspaceInfo?.motionGraphicsDir;
    const known = dir
      ? (await listPreviewCandidates(dir).catch(() => [])).find(
          (t) => t.path === asset.path,
        )
      : undefined;
    preview.open(
      known ?? { name: asset.name, path: asset.path, kind: "static" },
    );
  }

  async function handleSaveMemory() {
    setSavingMemory(true);
    try {
      const info = await saveCliMemory(
        activeConversation?.workspacePath ?? null,
        memoryDraft,
        workspaceProject,
        globalMemoryDraft,
      );
      setWorkspaceInfo(info);
      setMemoryOpen(false);
      toast.success(t("aiEdit.memory.saved"));
    } catch (err: any) {
      toast.error(err?.message || String(err));
    } finally {
      setSavingMemory(false);
    }
  }

  async function handleSendPrompt(overridePrompt?: string) {
    const text = (overridePrompt ?? draft).trim();
    if (!text || !activeConversation || activeIsRunning) return;

    // Handle quick slash commands
    if (text === "/new") {
      setDraft("");
      createConversation();
      return;
    }
    if (text === "/clear") {
      setDraft("");
      clearConversationMessages(activeConversation.id);
      return;
    }
    if (text === "/memory") {
      setDraft("");
      setMemoryDraft(workspaceInfo?.memory || "");
      setGlobalMemoryDraft(workspaceInfo?.globalMemory || "");
      setMemoryOpen(true);
      return;
    }
    if (text === "/folder") {
      setDraft("");
      await handlePickWorkspace();
      return;
    }

    if (contextMismatch) {
      toast.error(
        t("aiEdit.errors.mismatch"),
      );
      return;
    }

    if (projectUnknown) {
      toast.error(
        t("aiEdit.errors.projectUnknown", { editor: editor.title }),
      );
      return;
    }

    if (!overridePrompt) setDraft("");

    const convId = activeConversation.id;
    const targetAdapter: ContentCliAdapter =
      (activeConversation.adapter ?? adapter) === "claude" ? "claude" : "agy";
    bindConversationAdapter(convId, targetAdapter);
    bindConversationTarget(
      convId,
      selectedIntegration,
      activeProjectId,
      activeProjectName,
      editor.workspaceProject,
    );

    const userMsg: ContentMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    addMessage(convId, userMsg);

    const controller = new AbortController();
    abortControllersRef.current.set(convId, controller);
    setRunningTexts((prev) => ({ ...prev, [convId]: "" }));
    setRunningThinking((prev) => ({ ...prev, [convId]: "" }));
    setRunningSteps((prev) => ({ ...prev, [convId]: [] }));

    const fullSystemPrompt = await editor.buildPrompt(
      activeConversation.systemPrompt,
      workspaceInfo,
      autoApplyActions,
    );

    let streamed = "";
    let streamedThinking = "";
    let finalSteps: string[] = [];
    // A little slack for filesystems with coarse mtimes.
    const runStartSec = Math.floor(Date.now() / 1000) - 2;
    try {
      const output = await runCliTextTask({
        adapter: targetAdapter,
        prompt: text,
        systemPrompt: fullSystemPrompt,
        model: selectedModels[targetAdapter] || undefined,
        effort: selectedEfforts[targetAdapter] || undefined,
        sessionKey: `${convId}:${targetAdapter}`,
        workingDirectory: workspaceInfo?.path,
        project: workspaceProject,
        editTarget: editor.target
          ? { ...editor.target, transcriptFile: currentSubtitleDocumentFilename }
          : undefined,
        // Turbo lets the agent edit through the MCP tools; Manual keeps them
        // read-only and the user applies timeline-action blocks.
        allowEdits: autoApplyActions,
        signal: controller.signal,
        onChunk: (chunk) => {
          streamed += chunk;
          setRunningTexts((prev) => ({ ...prev, [convId]: streamed }));
        },
        onThinking: (tChunk) => {
          streamedThinking += tChunk;
          setRunningThinking((prev) => ({
            ...prev,
            [convId]: streamedThinking,
          }));
        },
        onStep: (stepInfo) => {
          setRunningSteps((prev) => {
            const existing = prev[convId] || [];
            const merged = mergeStepEvent(existing, stepInfo);
            finalSteps = merged;
            return { ...prev, [convId]: merged };
          });
        },
      });

      const previews = workspaceInfo?.motionGraphicsDir
        ? await listPreviewCandidates(
            workspaceInfo.motionGraphicsDir,
            runStartSec,
          ).catch(() => [])
        : [];
      const assistantMsg: ContentMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: output,
        thinking: streamedThinking.trim() || undefined,
        steps: finalSteps.length > 0 ? finalSteps : undefined,
        previews: previews.length > 0 ? previews : undefined,
        createdAt: Date.now(),
      };
      addMessage(convId, assistantMsg);

      // Show the agent's latest edit in the open preview. A dev server
      // hot-reloads on its own; the built-in server needs a reload.
      if (
        preview.target &&
        preview.info?.kind === "static" &&
        previews.some((p) => p.path === preview.target?.path)
      ) {
        preview.reload();
      }

      // Refresh workspace assets in case AI created new motion graphics / B-roll files
      void refreshWorkspace();

      if (autoApplyActions) {
        const actions = extractTimelineActions(output);
        for (const act of actions) {
          await executeTimelineAction(act);
        }
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg !== "Cancelled by user") {
        toast.error(msg);
        addMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: t("aiEdit.message.runError", {
            cli: cliLabel(targetAdapter),
            error: msg,
          }),
          thinking: streamedThinking.trim() || undefined,
          steps: finalSteps.length > 0 ? finalSteps : undefined,
          createdAt: Date.now(),
        });
      } else if (streamed.trim() || finalSteps.length > 0) {
        addMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `${streamed}\n\n${t("aiEdit.message.stopped")}`,
          thinking: streamedThinking.trim() || undefined,
          steps: finalSteps.length > 0 ? finalSteps : undefined,
          createdAt: Date.now(),
        });
      }
    } finally {
      abortControllersRef.current.delete(convId);
      setRunningTexts((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      setRunningThinking((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      setRunningSteps((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    }
  }

  function handleStopRunning() {
    if (!activeConversation) return;
    abortControllersRef.current.get(activeConversation.id)?.abort();
  }

  const visibleConversations = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [conversations, searchQuery]);

  return {
    selectedIntegration,
    editorTitle: editor.title,
    adapter,
    setAdapter,
    setModel,
    createConversation,
    selectConversation,
    deleteConversation,
    setConversationWorkspace,
    setConversationSystemPrompt,
    renameConversation,
    toggleConversationPinned,
    activeConversation,
    visibleConversations,
    activeAdapter,
    activeRunText,
    activeThinkingText,
    activeStepList,
    activeIsRunning,
    providerLocked,
    contextMismatch,
    selectedModel,
    adapterStatus,
    availableModels,
    checkingRuntime,
    runningTexts,
    draft,
    setDraft,
    sidebarCollapsed,
    setSidebarCollapsed,
    searchQuery,
    setSearchQuery,
    autoApplyActions,
    setAutoApplyActions,
    workspaceInfo,
    refreshWorkspace,
    assetsOpen,
    setAssetsOpen,
    memoryOpen,
    setMemoryOpen,
    memoryDraft,
    setMemoryDraft,
    globalMemoryDraft,
    setGlobalMemoryDraft,
    savingMemory,
    systemPromptOpen,
    setSystemPromptOpen,
    systemPromptDraft,
    setSystemPromptDraft,
    renameTarget,
    setRenameTarget,
    renameDraft,
    setRenameDraft,
    endRef,
    textareaRef,
    refreshRuntime,
    loadModels,
    executeTimelineAction,
    handlePickWorkspace,
    handleAttachFile,
    handleInsertAssetPath,
    handleQuickPlaceAssetOnTimeline,
    handlePreviewAsset,
    listPreviewTargets,
    handleSaveAsTemplate,
    handleUseTemplate,
    handleImportSkills,
    handleSaveMemory,
    handleSendPrompt,
    handleStopRunning,
    preview,
    workspaceProject,
    openProjectName: editor.workspaceProject?.name ?? null,
  };
}
