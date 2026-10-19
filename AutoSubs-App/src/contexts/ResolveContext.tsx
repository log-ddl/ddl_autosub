import React, { createContext, useContext, useState, useRef, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Template, TimelineInfo } from '@/types';
import { getTimelineInfo, getTemplates, cancelExport, addSubtitlesToTimeline, ResolveApiError } from '@/api/resolve-api';
import { useIntegration } from '@/contexts/IntegrationContext';
import { useSettingsStore } from '@/stores/settings-store';
import { validateExportedAudioFile, writeSingleLanguageDocument, type TimelineLanguageMode } from '@/lib/subtitle-documents';

interface ResolveContextType {
  timelineInfo: TimelineInfo;
  templates: Template[];
  templatesLoading: boolean;
  templatesLoaded: boolean;
  markIn: number;
  isExporting: boolean;
  exportProgress: number;
  cancelRequestedRef: React.MutableRefObject<boolean>;
  refresh: () => Promise<void>;
  refreshTemplates: () => Promise<Template[]>;
  pushToTimeline: (filename?: string, selectedTemplate?: string, selectedOutputTrack?: string, presetSettings?: Record<string, unknown>, languageMode?: TimelineLanguageMode) => Promise<void>;
  getSourceAudio: (audioInputMode: "file" | "timeline", fileInput: string | null, inputTracks: string[]) => Promise<{ path: string, offset: number } | null>;
  setIsExporting: (isExporting: boolean) => void;
  setExportProgress: (progress: number) => void;
  cancelExport: () => Promise<any>;
  jumpToTime: (seconds: number) => Promise<void>;
}


const ResolveContext = createContext<ResolveContextType | null>(null);

export function ResolveProvider({ children }: { children: React.ReactNode }) {
  const { selectedIntegration } = useIntegration();
  const exportRange = useSettingsStore((s) => s.exportRange);
  const [timelineInfo, setTimelineInfo] = useState<TimelineInfo>({ name: "", timelineId: "", templates: [], inputTracks: [], outputTracks: [], projectName: "" });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [markIn] = useState(0);
  
  // Export state
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const cancelRequestedRef = useRef<boolean>(false);
  const emptyTimelineInfo: TimelineInfo = { name: "", timelineId: "", templates: [], inputTracks: [], outputTracks: [], projectName: "" };

  const refresh = useCallback(async () => {
    try {
      let newTimelineInfo = await getTimelineInfo();
      setTimelineInfo({ ...newTimelineInfo, templates });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Resolve offline — fail silently during background polling. Matches both
      // raw reqwest strings and the friendly message from resolve_bridge.
      if (
        errorMessage.includes('Connection refused') ||
        errorMessage.includes('tcp connect error') ||
        errorMessage.includes('DaVinci Resolve is not running') ||
        errorMessage.includes('AutoSubs bridge is unavailable')
      ) {
        return;
      }
      throw error;
    }
  }, [templates]);

  const refreshTemplates = useCallback(async () => {
    if (templatesLoaded) {
      return templates;
    }

    setTemplatesLoading(true);
    try {
      const nextTemplates = await getTemplates();
      setTemplates(nextTemplates);
      setTemplatesLoaded(true);
      setTimelineInfo((info) => ({ ...info, templates: nextTemplates }));
      return nextTemplates;
    } finally {
      setTemplatesLoading(false);
    }
  }, [templates, templatesLoaded]);

  // Mirror of connection state for the poll scheduler below, so the effect
  // doesn't re-subscribe every time timelineInfo changes.
  const connectedRef = useRef(false);
  useEffect(() => {
    connectedRef.current = timelineInfo.timelineId !== "";
  }, [timelineInfo]);

  useEffect(() => {
    let cancelled = false;

    if (selectedIntegration !== "davinci") {
      setTimelineInfo(emptyTimelineInfo);
      setTemplates([]);
      setTemplatesLoading(false);
      setTemplatesLoaded(false);
      return;
    }

    let inFlight = false;
    let pollTimer: number | null = null;
    let offlineStrikes = 0;

    const scheduleNext = (delayOverride?: number) => {
      if (cancelled) return;
      const delay = delayOverride ?? (connectedRef.current ? 60000 : 5000);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        void pollTimeline();
      }, delay);
    };

    const pollTimeline = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const info = await getTimelineInfo();
        if (!cancelled) {
          offlineStrikes = 0;
          setTimelineInfo({ ...info, templates });
        }
      } catch (error) {
        if (cancelled) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('No timeline detected')) {
          offlineStrikes = 0;
          setTimelineInfo(emptyTimelineInfo);
        } else if (
          errorMessage.includes('DaVinci Resolve is not running') ||
          errorMessage.includes('AutoSubs bridge is unavailable') ||
          errorMessage.includes('Connection refused') ||
          errorMessage.includes('tcp connect error')
        ) {
          offlineStrikes++;
          if (!connectedRef.current || offlineStrikes >= 2) {
            setTimelineInfo(emptyTimelineInfo);
          }
        }
      } finally {
        inFlight = false;
        const delay = offlineStrikes >= 2
          ? 5000
          : connectedRef.current && offlineStrikes === 1
            ? 3000
            : undefined;
        scheduleNext(delay);
      }
    };

    const startupTimers = [0, 1000, 3000].map((delay) =>
      window.setTimeout(() => {
        void pollTimeline();
      }, delay),
    );

    return () => {
      cancelled = true;
      startupTimers.forEach((timer) => window.clearTimeout(timer));
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [selectedIntegration, templates]);

  async function pushToTimeline(
    filename?: string,
    selectedTemplate?: string,
    selectedOutputTrack?: string,
    presetSettings?: Record<string, unknown>,
    languageMode: TimelineLanguageMode = 'translated',
  ) {
    // If parameters are not provided, use defaults
    const finalFilename = filename || '';
    const finalTemplate = selectedTemplate || 'Subtitle';
    const finalTrack = selectedOutputTrack || '1';

    // One send per language, mirroring the Adobe path. Resolve creates a track
    // per send, so "both" is two calls: the translation onto the chosen track,
    // then the source onto a fresh one ("0" means "new track").
    const passes: Array<{ which: "translated" | "source"; track: string }> =
      languageMode === "source"
        ? [{ which: "source", track: finalTrack }]
        : languageMode === "both"
          ? [
              { which: "translated", track: finalTrack },
              { which: "source", track: "0" },
            ]
          : [{ which: "translated", track: finalTrack }];

    let response: Awaited<ReturnType<typeof addSubtitlesToTimeline>> | undefined;
    for (const pass of passes) {
      const documentFilename = await writeSingleLanguageDocument(finalFilename, pass.which);
      response = await addSubtitlesToTimeline(documentFilename, finalTemplate, pass.track, null, presetSettings);
    }

    // Surface a language-aware font swap (done server-side in the Lua macro
    // server) so the user knows why their caption font changed.
    const result = response && typeof response === 'object' ? response.result : undefined;
    const fontSwap = result && typeof result === 'object' ? result.fontSwap : null;
    if (fontSwap) {
      if (fontSwap.to) {
        toast.info(
          `Using '${fontSwap.to}' for ${fontSwap.language} captions`,
          { description: `The default caption font doesn't support this language. Change the Font in your preset to override.` },
        );
      } else if (fontSwap.missing) {
        toast.warning(
          `No installed font found for ${fontSwap.language} captions`,
          { description: `Install a font that supports ${fontSwap.script} (e.g. a Noto ${fontSwap.script} family) to render captions correctly.` },
        );
      }
    }
  }

  // Function to get source audio based on current mode
  const getSourceAudio = async (
    audioInputMode: "file" | "timeline",
    fileInput: string | null,
    inputTracks: string[]
  ): Promise<{ path: string, offset: number } | null> => {
    if (timelineInfo && audioInputMode === "timeline") {
      // Reset cancellation flag at the start of export
      cancelRequestedRef.current = false;
      setIsExporting(true);
      setExportProgress(0);

      try {
        // Import the required functions directly
        const { exportAudio, getExportProgress } = await import('@/api/resolve-api');

        // Start the export (non-blocking)
        const exportResult = await exportAudio(inputTracks, exportRange || "entire");
        console.log("Export started:", exportResult);

        // Poll for export progress until completion.
        // Resolve can stall its own Lua scripting engine during rendering, so
        // individual GetExportProgress requests may time out even while the
        // export is still running normally. We tolerate up to
        // MAX_CONSECUTIVE_ERRORS consecutive network/timeout errors before
        // giving up, so a long-running export doesn't kill the UI prematurely.
        let exportCompleted = false;
        let audioInfo = null;
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 10;

        while (!exportCompleted && !cancelRequestedRef.current) {
          // Check if cancellation was requested before making the next API call
          if (cancelRequestedRef.current) {
            console.log("Export polling interrupted by cancellation request");
            await cancelExport();
            break;
          }

          let progressResult;
          try {
            progressResult = await getExportProgress();
            consecutiveErrors = 0;
          } catch (pollErr) {
            consecutiveErrors++;
            console.warn(
              `Export progress poll failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`,
              pollErr,
            );
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              throw pollErr;
            }
            // Back off before retrying — Resolve may be busy rendering
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Cancellation may have been requested during the backoff; send
            // the cancel to Resolve before exiting so the render doesn't keep
            // running after the UI has stopped.
            if (cancelRequestedRef.current) {
              await cancelExport();
              break;
            }
            continue;
          }

          console.log("Export progress:", progressResult);

          // Update progress
          setExportProgress(progressResult.progress || 0);

          if (progressResult.completed) {
            exportCompleted = true;
            audioInfo = progressResult.audioInfo;
            console.log("Export completed:", audioInfo);
          } else if (progressResult.cancelled) {
            console.log("Export was cancelled");
            setIsExporting(false);
            setExportProgress(0);
            return null;
          } else if (progressResult.error) {
            console.error("Export error:", progressResult.message, progressResult.detail);
            setIsExporting(false);
            setExportProgress(0);
            throw new ResolveApiError(
              progressResult.message || "Export failed",
              progressResult.detail,
              "GetExportProgress",
            );
          }

          // Wait before next poll (avoid overwhelming the server)
          if (!exportCompleted && !cancelRequestedRef.current) {
            await new Promise(resolve => setTimeout(resolve, 500));

            // Check again after timeout in case cancellation happened during the wait
            if (cancelRequestedRef.current) {
              console.log("Export polling interrupted during wait interval");
              await cancelExport();
              break;
            }
          }
        }

        setIsExporting(false);
        setExportProgress(0);

        // If audioInfo is null, the export was cancelled or failed
        if (!audioInfo) {
          console.log("Export cancelled or failed - no audio info available");
          return null;
        }

        let audioPath = audioInfo["path"];
        await validateExportedAudioFile(audioPath);

        let audioOffset = audioInfo["offset"];
        return { path: audioPath, offset: audioOffset };

      } catch (error) {
        setIsExporting(false);
        setExportProgress(0);
        throw error;
      }
    } else {
      return { path: fileInput || "", offset: 0 };
    }
  };

  return (
    <ResolveContext.Provider value={{
      timelineInfo,
      templates,
      templatesLoading,
      templatesLoaded,
      markIn,
      isExporting,
      exportProgress,
      cancelRequestedRef,
      refresh,
      refreshTemplates,
      pushToTimeline,
      getSourceAudio,
      setIsExporting,
      setExportProgress,
      cancelExport,
      jumpToTime: async (seconds: number) => {
        const { jumpToTime: resolveJump } = await import("@/api/resolve-api");
        await resolveJump(seconds);
      },
    }}>

      {children}
    </ResolveContext.Provider>
  );
}

export const useResolve = () => {
  const context = useContext(ResolveContext);
  if (!context) {
    throw new Error('useResolve must be used within a ResolveProvider');
  }
  return context;
};
