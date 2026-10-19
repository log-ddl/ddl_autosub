import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { TimelineInfo } from "@/types";
import type { BuildStoryboardSpec, BuildStoryboardResult } from "@/api/resolve-api";
import {
  getCapCutStatus,
  buildCapCutStoryboard,
  addSubtitlesToCapCut,
  getCapCutTimelineAudio,
  type CapCutDraftSummary,
} from "@/api/capcut-api";
import { useIntegration } from "@/contexts/IntegrationContext";
import {
  writeSingleLanguageDocument,
  type TimelineLanguageMode,
} from "@/lib/subtitle-documents";

interface CapCutContextType {
  timelineInfo: TimelineInfo;
  isConnected: boolean;
  draftsRoot: string;
  drafts: CapCutDraftSummary[];
  selectedDraftId: string | null;
  setSelectedDraftId: (id: string) => void;
  isProjectPickerOpen: boolean;
  setProjectPickerOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  pushToTimeline: (
    filename?: string,
    selectedTemplate?: string,
    languageMode?: TimelineLanguageMode,
  ) => Promise<void>;
  getSourceAudio: (
    audioInputMode: "file" | "timeline",
    fileInput: string | null,
    inputTracks: string[],
  ) => Promise<{ path: string; offset: number } | null>;
  buildStoryboard: (spec: BuildStoryboardSpec) => Promise<BuildStoryboardResult>;
  jumpToTime: (seconds: number) => Promise<void>;
}

const emptyTimelineInfo: TimelineInfo = {
  name: "",
  timelineId: "",
  templates: [],
  inputTracks: [],
  outputTracks: [],
  projectName: "",
};

const CapCutContext = createContext<CapCutContextType | null>(null);

export function CapCutProvider({ children }: { children: React.ReactNode }) {
  const { selectedIntegration } = useIntegration();
  const [timelineInfo, setTimelineInfo] = useState<TimelineInfo>(emptyTimelineInfo);
  const [isConnected, setIsConnected] = useState(false);
  const [draftsRoot, setDraftsRoot] = useState("");
  const [drafts, setDrafts] = useState<CapCutDraftSummary[]>([]);
  const [selectedDraftId, setSelectedDraftIdState] = useState<string | null>(null);
  const [isProjectPickerOpen, setProjectPickerOpen] = useState(false);

  const refresh = useCallback(async (overrideDraftId?: string | null) => {
    try {
      const targetId = overrideDraftId !== undefined ? overrideDraftId : selectedDraftId;
      const status = await getCapCutStatus(targetId || undefined);
      setDraftsRoot(status.draftsRoot || "");
      setDrafts(status.drafts || []);
      setIsConnected(status.connected);
      if (status.connected && status.activeDraft) {
        setSelectedDraftIdState(status.activeDraft.id);
        setTimelineInfo({
          name: status.name,
          timelineId: status.timelineId,
          projectName: status.projectName,
          inputTracks: status.inputTracks,
          outputTracks: status.outputTracks,
          templates: status.templates,
        });
      } else {
        setTimelineInfo(emptyTimelineInfo);
      }
    } catch (err) {
      console.error("[CapCutContext] Failed to get CapCut status:", err);
      setIsConnected(false);
      setTimelineInfo(emptyTimelineInfo);
    }
  }, [selectedDraftId]);

  const setSelectedDraftId = useCallback(
    (id: string) => {
      setSelectedDraftIdState(id);
      void refresh(id);
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [selectedIntegration, refresh]);

  const pushToTimeline = useCallback(
    async (
      filename?: string,
      selectedTemplate?: string,
      languageMode: TimelineLanguageMode = "translated",
    ) => {
      const finalFilename = filename || "";
      if (!finalFilename) return;

      const passes: Array<"translated" | "source"> =
        languageMode === "source"
          ? ["source"]
          : languageMode === "both"
            ? ["translated", "source"]
            : ["translated"];

      let totalAdded = 0;
      let targetDraft = "";
      for (const which of passes) {
        const docName = await writeSingleLanguageDocument(finalFilename, which);
        const res = await addSubtitlesToCapCut(
          docName,
          selectedTemplate,
          selectedDraftId || undefined,
        );
        totalAdded += res.added;
        targetDraft = res.draftName;
      }

      toast.success(`Added ${totalAdded} subtitles to CapCut project "${targetDraft}"`, {
        description: "Re-open the project from CapCut Home to view the updated timeline.",
      });
      await refresh();
    },
    [selectedDraftId, refresh],
  );

  const getSourceAudio = useCallback(
    async (
      audioInputMode: "file" | "timeline",
      fileInput: string | null,
      _inputTracks: string[],
    ): Promise<{ path: string; offset: number } | null> => {
      if (audioInputMode === "file") {
        return { path: fileInput || "", offset: 0 };
      }
      return getCapCutTimelineAudio(selectedDraftId || undefined);
    },
    [selectedDraftId],
  );

  const buildStoryboard = useCallback(
    async (spec: BuildStoryboardSpec): Promise<BuildStoryboardResult> => {
      const res = await buildCapCutStoryboard(spec, selectedDraftId || undefined);
      await refresh();
      return res;
    },
    [selectedDraftId, refresh],
  );

  const jumpToTime = useCallback(async (_seconds: number) => {
    // CapCut draft JSON does not have a live playhead IPC
  }, []);

  return (
    <CapCutContext.Provider
      value={{
        timelineInfo,
        isConnected,
        draftsRoot,
        drafts,
        selectedDraftId,
        setSelectedDraftId,
        isProjectPickerOpen,
        setProjectPickerOpen,
        refresh: () => refresh(),
        pushToTimeline,
        getSourceAudio,
        buildStoryboard,
        jumpToTime,
      }}
    >
      {children}
    </CapCutContext.Provider>
  );
}

export function useCapCut() {
  const ctx = useContext(CapCutContext);
  if (!ctx) {
    throw new Error("useCapCut must be used within a CapCutProvider");
  }
  return ctx;
}
