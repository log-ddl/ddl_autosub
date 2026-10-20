import * as React from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ensureCliWorkspace,
  getCliModels,
  getCliRuntimeStatus,
  runCliTextTask,
  saveCliMemory,
  type CliRuntimeStatus,
  type ContentCliAdapter,
  type WorkspaceInfo,
} from "@/api/cli-chat-api";
import {
  buildCapCutStoryboard,
  addCapCutMarkers,
  deleteCapCutSegment,
  getCapCutTimelineSnapshot,
  updateCapCutSegment,
  type CapCutTimelineSnapshot,
} from "@/api/capcut-api";
import { addTimelineMarkers, buildStoryboard } from "@/api/resolve-api";
import {
  useAiEditChatStore,
  type ContentMessage,
} from "@/stores/ai-edit-chat-store";
import { useIntegration } from "@/contexts/IntegrationContext";
import { useCapCut } from "@/contexts/CapCutContext";
import { useResolve } from "@/contexts/ResolveContext";
import {
  cliLabel,
  extractTimelineActions,
  mergeStepEvent,
  type TimelineActionCommand,
} from "./ai-edit-helpers";
import { buildEditorContextPrompt } from "./ai-edit-prompts";

export function useAiEditController() {
  const { selectedIntegration } = useIntegration();
  const {
    selectedDraftId,
    setProjectPickerOpen,
    refresh: refreshCapCut,
  } = useCapCut();
  const { timelineInfo: resolveTimeline, refresh: refreshResolve } =
    useResolve();

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

  // Timeline Snapshot state (for AI context)
  const [timelineSnapshot, setTimelineSnapshot] =
    React.useState<CapCutTimelineSnapshot | null>(null);

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

  const activeProjectId = React.useMemo(() => {
    if (selectedIntegration === "capcut") {
      return timelineSnapshot?.draftId || selectedDraftId || null;
    }
    return resolveTimeline?.name || null;
  }, [
    selectedIntegration,
    timelineSnapshot?.draftId,
    selectedDraftId,
    resolveTimeline?.name,
  ]);

  const activeProjectName = React.useMemo(() => {
    if (selectedIntegration === "capcut") {
      return timelineSnapshot?.draftName || null;
    }
    return resolveTimeline?.name || null;
  }, [selectedIntegration, timelineSnapshot?.draftName, resolveTimeline?.name]);

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
    const isDiffProject =
      Boolean(activeConversation.boundProjectId) &&
      Boolean(activeProjectId) &&
      activeConversation.boundProjectId !== activeProjectId;
    if (!isDiffIntegration && !isDiffProject) return null;
    return {
      boundIntegration: activeConversation.boundIntegration,
      boundProjectId: activeConversation.boundProjectId ?? null,
      boundProjectName:
        activeConversation.boundProjectName ||
        activeConversation.boundProjectId ||
        "Mặc định",
      currentIntegration: selectedIntegration,
      currentProjectId: activeProjectId,
      currentProjectName: activeProjectName || "Chưa chọn",
    };
  }, [
    activeConversation,
    providerLocked,
    selectedIntegration,
    activeProjectId,
    activeProjectName,
  ]);

  // Auto-resize textarea height cleanly
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(28, el.scrollHeight))}px`;
  }, [draft]);

  const loadTimelineSnapshot = React.useCallback(async () => {
    if (selectedIntegration !== "capcut") return;
    try {
      const snap = await getCapCutTimelineSnapshot(
        selectedDraftId || undefined,
      );
      setTimelineSnapshot(snap);
    } catch (err) {
      console.warn("[AiEditWorkspace] Could not load CapCut snapshot:", err);
      setTimelineSnapshot(null);
    }
  }, [selectedIntegration, selectedDraftId]);

  React.useEffect(() => {
    void loadTimelineSnapshot();
  }, [loadTimelineSnapshot]);

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
    try {
      const info = await ensureCliWorkspace(
        activeConversation?.workspacePath ?? null,
        activeProjectName,
      );
      setWorkspaceInfo(info);
    } catch {
      // ignore
    }
  }, [activeConversation?.workspacePath, activeProjectName]);

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
      try {
        if (cmd.action === "build_storyboard" && cmd.items?.length) {
          const trackIdx = cmd.targetVideoTrack || 1;
          if (selectedIntegration === "capcut") {
            const res = await buildCapCutStoryboard(
              {
                targetVideoTrack: trackIdx,
                mode: cmd.mode,
                defaultStillSecs: 3,
                items: cmd.items,
                audioPath: cmd.audioPath,
              },
              selectedDraftId || undefined,
            );
            toast.success(
              `Đã đặt ${res.appended} clip vào Track V${trackIdx} CapCut`,
            );
            await refreshCapCut();
            await loadTimelineSnapshot();
          } else {
            const res = await buildStoryboard({
              targetVideoTrack: trackIdx,
              mode: cmd.mode,
              defaultStillSecs: 3,
              items: cmd.items,
              audioPath: cmd.audioPath,
            });
            toast.success(
              `Đã đặt ${res.appended} clip vào Track V${trackIdx} DaVinci`,
            );
            await refreshResolve();
          }
        } else if (cmd.action === "add_marker" && cmd.markers?.length) {
          if (selectedIntegration === "capcut") {
            const res = await addCapCutMarkers(
              cmd.markers,
              selectedDraftId || undefined,
            );
            setTimelineSnapshot(res.snapshot);
            if (res.skipped === 0) {
              toast.success(cmd.summary || `Đã đặt ${res.added} marker trên CapCut`);
            } else {
              toast.warning(
                `Đã đặt ${res.added}/${cmd.markers.length} marker trên CapCut`,
                { description: "Bỏ qua marker có thời gian sai hoặc trùng frame đã có marker." },
              );
            }
          } else {
            const lines = await addTimelineMarkers(cmd.markers);
            const placed = lines.filter((l) => l.startsWith("Added")).length;
            if (placed === cmd.markers.length) {
              toast.success(cmd.summary || `Đã đặt ${placed} marker trên DaVinci`);
            } else {
              toast.warning(`Đã đặt ${placed}/${cmd.markers.length} marker trên DaVinci`, {
                description: lines.filter((l) => !l.startsWith("Added")).join("\n"),
              });
            }
            await refreshResolve();
          }
        } else if (
          cmd.action === "update_segment" &&
          cmd.segmentId &&
          selectedIntegration === "capcut"
        ) {
          const snap = await updateCapCutSegment({
            segmentId: cmd.segmentId,
            preferredDraftId: selectedDraftId || undefined,
            startSec: cmd.startSec,
            durationSec: cmd.durationSec,
            zoom: cmd.zoom,
            zoomEnd: cmd.zoomEnd,
            panX: cmd.panX,
            panXEnd: cmd.panXEnd,
            panY: cmd.panY,
            panYEnd: cmd.panYEnd,
            rotation: cmd.rotation,
            volume: cmd.volume,
            text: cmd.text,
          });
          setTimelineSnapshot(snap);
          toast.success(cmd.summary || "Đã cập nhật clip trên Timeline CapCut");
        } else if (
          cmd.action === "delete_segment" &&
          cmd.segmentId &&
          selectedIntegration === "capcut"
        ) {
          const snap = await deleteCapCutSegment(
            cmd.segmentId,
            selectedDraftId || undefined,
          );
          setTimelineSnapshot(snap);
          toast.success(cmd.summary || "Đã xóa clip khỏi Timeline CapCut");
        }
      } catch (err: any) {
        toast.error(err?.message || String(err));
      }
    },
    [
      selectedIntegration,
      selectedDraftId,
      refreshCapCut,
      loadTimelineSnapshot,
      refreshResolve,
    ],
  );

  async function handlePickWorkspace() {
    if (!activeConversation || providerLocked) return;
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Chọn thư mục Workspace cho AI",
    });
    if (typeof picked === "string" && picked.trim()) {
      setConversationWorkspace(activeConversation.id, picked.trim());
    }
  }

  async function handleAttachFile() {
    const picked = await openDialog({
      directory: false,
      multiple: true,
      title: "Chọn file hoặc media đính kèm cho AI",
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
      summary: `Đặt ${asset.name} lên Timeline`,
      items: [{ path: asset.path, start: 0, end: 4 }],
    });
  }

  async function handleSaveMemory() {
    setSavingMemory(true);
    try {
      const info = await saveCliMemory(
        activeConversation?.workspacePath ?? null,
        memoryDraft,
        activeProjectName,
        globalMemoryDraft,
      );
      setWorkspaceInfo(info);
      setMemoryOpen(false);
      toast.success("Đã lưu Bộ nhớ 2-Tier (Project & Global)");
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
        "Cuộc trò chuyện này đã gắn với một Dự án / Đầu nối khác. Hãy tạo cuộc trò chuyện mới để tránh lẫn lộn context!",
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

    const fullSystemPrompt = buildEditorContextPrompt(
      selectedIntegration,
      timelineSnapshot,
      resolveTimeline?.name,
      activeConversation.systemPrompt,
      workspaceInfo,
    );

    let streamed = "";
    let streamedThinking = "";
    let finalSteps: string[] = [];
    try {
      const output = await runCliTextTask({
        adapter: targetAdapter,
        prompt: text,
        systemPrompt: fullSystemPrompt,
        model: selectedModels[targetAdapter] || undefined,
        effort: selectedEfforts[targetAdapter] || undefined,
        sessionKey: `${convId}:${targetAdapter}`,
        workingDirectory: workspaceInfo?.path,
        projectName: activeProjectName || undefined,
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

      const assistantMsg: ContentMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: output,
        thinking: streamedThinking.trim() || undefined,
        steps: finalSteps.length > 0 ? finalSteps : undefined,
        createdAt: Date.now(),
      };
      addMessage(convId, assistantMsg);

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
          content: `⚠️ **Lỗi thực thi (${cliLabel(targetAdapter)})**: ${msg}`,
          thinking: streamedThinking.trim() || undefined,
          steps: finalSteps.length > 0 ? finalSteps : undefined,
          createdAt: Date.now(),
        });
      } else if (streamed.trim() || finalSteps.length > 0) {
        addMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `${streamed}\n\n*(Đã dừng bởi người dùng)*`,
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
    setProjectPickerOpen,
    resolveTimeline,
    timelineSnapshot,
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
    handleSaveMemory,
    handleSendPrompt,
    handleStopRunning,
  };
}
