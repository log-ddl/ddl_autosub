import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TimelineInfo } from '@/types';
import { requestSequenceInfo, requestAudioExport, requestImportSRT, requestJumpToTime, requestBuildStoryboard } from '@/api/adobe-api';
import type { BuildStoryboardSpec, BuildStoryboardResult } from '@/api/resolve-api';
import {
  getAudioExportDir,
  getSubtitleDocumentPath,
  loadSubtitleDocumentSubtitles,
  loadSubtitleDocumentSourceSubtitles,
  type TimelineLanguageMode,
} from '@/lib/subtitle-documents';
import { generateSrt } from '@/lib/srt-utils';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useSettingsStore } from '@/stores/settings-store';
import { useIntegration } from '@/contexts/IntegrationContext';

interface AdobeContextType {
  timelineInfo: TimelineInfo;
  premiereTimeline: TimelineInfo;
  afterEffectsTimeline: TimelineInfo;
  isConnected: boolean;
  isPremiereConnected: boolean;
  isAfterEffectsConnected: boolean;
  isExporting: boolean;
  exportProgress: number;
  refresh: () => Promise<void>;
  pushToTimeline: (filename?: string, languageMode?: TimelineLanguageMode) => Promise<void>;
  getSourceAudio: (audioInputMode: "file" | "timeline", fileInput: string | null, inputTracks: string[]) => Promise<{ path: string, offset: number } | null>;
  buildStoryboard: (spec: BuildStoryboardSpec) => Promise<BuildStoryboardResult>;

  jumpToTime: (seconds: number) => Promise<void>;
}

const AdobeContext = createContext<AdobeContextType | null>(null);

const emptyTimeline: TimelineInfo = {
  name: "",
  timelineId: "",
  templates: [],
  inputTracks: [],
  outputTracks: [],
  projectName: ""
};

/** Maps raw API data from either Adobe host into a normalised TimelineInfo shape. */
function toTimelineInfo(data: any): TimelineInfo {
  return {
    name: data.name || data.sequenceName || "Sequence",
    timelineId: data.id || "adobe_seq",
    templates: [],
    inputTracks: data.audioTrackInfo?.map((t: any) => ({
      value: t.index.toString(),
      label: t.name || `Audio ${t.index}`
    })) ?? [],
    // Premiere reports a video-track count (not per-track names); expose them as
    // V1..Vn so the slideshow's track picker has real options. ExtendScript
    // can't add tracks, so there is no synthetic "new track" here.
    outputTracks: typeof data.numVideoTracks === 'number'
      ? Array.from({ length: data.numVideoTracks }, (_, i) => ({
          value: String(i + 1),
          label: `V${i + 1}`,
        }))
      : [],
    projectName: data.projectName || ""
  };
}

export function AdobeProvider({ children }: { children: React.ReactNode }) {
  const exportRange = useSettingsStore((s) => s.exportRange);
  const { selectedIntegration } = useIntegration();

  const [appConnections, setAppConnections] = useState<Record<string, boolean>>({
    premiere: false,
    aftereffects: false
  });

  const [premiereTimeline, setPremiereTimeline] = useState<TimelineInfo>(emptyTimeline);
  const [aeTimeline, setAeTimeline] = useState<TimelineInfo>(emptyTimeline);

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const pendingRequests = useRef<Map<string, (value: any) => void>>(new Map());

  const isPremiereConnected = appConnections.premiere;
  const isAfterEffectsConnected = appConnections.aftereffects;
  const isConnected = selectedIntegration === 'aftereffects' ? isAfterEffectsConnected : isPremiereConnected;
  const timelineInfo = selectedIntegration === 'aftereffects' ? aeTimeline : premiereTimeline;

  const refreshApp = useCallback(async (app: 'premiere' | 'aftereffects', connected: boolean) => {
    if (!connected) return;

    try {
      const result = await sendRequestAndWait((sid) => requestSequenceInfo(sid, app));
      const data = typeof result === 'string' ? JSON.parse(result) : result;

      if (data && data.success) {
        if (app === 'premiere') setPremiereTimeline(toTimelineInfo(data));
        else if (app === 'aftereffects') setAeTimeline(toTimelineInfo(data));
      }
    } catch (error) {
      console.error(`Failed to refresh info for ${app}:`, error);
    }
    // sendRequestAndWait is a stable function (defined outside useCallback and only reads a ref);
    // it does not need to be in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    if (selectedIntegration === 'premiere' || selectedIntegration === 'aftereffects') {
      await refreshApp(selectedIntegration, isConnected);
    }
  }, [selectedIntegration, isConnected, refreshApp]);

  useEffect(() => {
    const unlistenStatus = listen<{ status: string, app: string }>('adobe-status', (event) => {
      const { status, app } = event.payload;
      const isAppConnected = status === 'connected';
      const targetApp = app as 'premiere' | 'aftereffects';

      setAppConnections(prev => ({
        ...prev,
        [targetApp]: isAppConnected
      }));

      const hostName = targetApp === 'aftereffects' ? 'After Effects' : 'Premiere Pro';
      if (isAppConnected) {
        toast.success(`Connected to ${hostName}`);
        // Senior pattern: pass status explicitly instead of relying on async state update
        refreshApp(targetApp, true);
      } else {
        toast.error(`Disconnected from ${hostName}`);
        if (targetApp === 'premiere') setPremiereTimeline(emptyTimeline);
        else if (targetApp === 'aftereffects') setAeTimeline(emptyTimeline);
      }
    });

    const unlistenMessage = listen<any>('adobe-message', (event) => {
      const msg = event.payload;
      const originApp = msg.integration;
      const sessionId = msg.sessionId || (msg.payload && typeof msg.payload === 'object' ? msg.payload.sessionId : undefined);

      if (sessionId && pendingRequests.current.has(sessionId)) {
        const resolve = pendingRequests.current.get(sessionId);
        if (resolve) {
          resolve(msg.payload);
          pendingRequests.current.delete(sessionId);
        }
      } else if (msg.type === 'sequence_info_response') {
        const result = msg.payload;
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        if (data && data.success) {
          if (originApp === 'premiere') setPremiereTimeline(toTimelineInfo(data));
          else if (originApp === 'aftereffects') setAeTimeline(toTimelineInfo(data));
        }
      }
    });

    return () => {
      unlistenStatus.then(f => f());
      unlistenMessage.then(f => f());
    };
  }, [refreshApp]);

  // Refresh when the user actively switches integration. `isConnected` is intentionally
  // excluded from the dep array: we pass it explicitly as an argument to avoid a stale
  // closure while still preventing a double-fire on every connection event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isConnected) {
      refreshApp(selectedIntegration as 'premiere' | 'aftereffects', isConnected);
    }
  }, [selectedIntegration]); // isConnected excluded intentionally — see comment above

  // Switching editors must not keep the previous editor's project info cached —
  // the refresh effect above re-fetches the now-active host. (Resolve's context
  // already clears its timeline on its side; mirror that here for the Adobe hosts
  // so no stale Premiere/AE project leaks into a DaVinci session.)
  useEffect(() => {
    setPremiereTimeline(emptyTimeline);
    setAeTimeline(emptyTimeline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIntegration]);

  const sendRequestAndWait = (fn: (sessionId: string) => Promise<string>, timeoutMs = 30000): Promise<any> => {
    return new Promise((resolve, reject) => {
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(sessionId);
        reject(new Error('Request timed out'));
      }, timeoutMs);
      pendingRequests.current.set(sessionId, (val) => {
        clearTimeout(timeout);
        resolve(val);
      });
      fn(sessionId).catch((err) => {
        pendingRequests.current.delete(sessionId);
        clearTimeout(timeout);
        reject(err);
      });
    });
  };

  async function pushToTimeline(
    filename?: string,
    languageMode: TimelineLanguageMode = 'translated',
  ) {
    if (!filename || !selectedIntegration) return;
    try {
      const filePath = await getSubtitleDocumentPath(filename);
      const hostName = selectedIntegration === 'aftereffects' ? 'After Effects' : 'Premiere Pro';

      // Adobe has no per-cue track concept - the extension imports one SRT and
      // the host creates one caption track from it. So "both" is two imports,
      // which lands the two languages on two tracks.
      const translated = await loadSubtitleDocumentSubtitles(filename);
      const source = await loadSubtitleDocumentSourceSubtitles(filename);

      const passes: Array<{ subtitles: typeof translated; suffix: string }> = [];
      if (languageMode === 'source' && source.length > 0) {
        passes.push({ subtitles: source, suffix: '.source' });
      } else if (languageMode === 'both' && source.length > 0) {
        passes.push({ subtitles: translated, suffix: '' });
        passes.push({ subtitles: source, suffix: '.source' });
      } else {
        passes.push({ subtitles: translated, suffix: '' });
      }

      toast.info(`Importing subtitles to ${hostName}...`);

      for (const pass of passes) {
        const srtPath = filePath.replace(/\.json$/, `${pass.suffix}.srt`);
        await writeTextFile(srtPath, generateSrt(pass.subtitles));

        const result = await sendRequestAndWait((sid) => requestImportSRT(srtPath, sid, selectedIntegration));
        const data = typeof result === 'string' ? JSON.parse(result) : result;

        if (!data || !data.success) {
          toast.error(`Failed to import SRT: ${data?.error || 'Unknown error'}`);
          return;
        }
      }

      toast.success(
        passes.length > 1
          ? 'Both languages imported'
          : 'SRT imported successfully!',
      );
    } catch (error: any) {
      toast.error(`Error: ${error.message}`);
    }
  }

  async function getSourceAudio(audioInputMode: "file" | "timeline", fileInput: string | null, inputTracks: string[]): Promise<{ path: string, offset: number } | null> {
    if (audioInputMode === "file" || !isConnected || !selectedIntegration) return { path: fileInput || "", offset: 0 };

    setIsExporting(true);
    setExportProgress(10);
    try {
      const exportDir = await getAudioExportDir();
      const tracks = inputTracks.map(Number).filter(n => !isNaN(n));
      const result = await sendRequestAndWait((sid) => requestAudioExport(exportDir, tracks, exportRange || 'entire', '', sid, selectedIntegration));
      const data = typeof result === 'string' ? JSON.parse(result) : result;
      if (data && data.success) {
        setExportProgress(100);
        setIsExporting(false);
        return { path: data.outputPath, offset: data.timeOffsetSeconds || 0 };
      }
      throw new Error(data?.error || 'Export failed');
    } catch (error: any) {
      setIsExporting(false);
      setExportProgress(0);
      toast.error(`Audio export failed: ${error.message}`);
      throw error;
    }
  }

  // Place a voice-synced (or sequential) slideshow onto the active Premiere
  // sequence. Mirrors Resolve's buildStoryboard but rides the websocket bridge:
  // the spec is snake_cased here so the ExtendScript side can read it directly.
  async function buildStoryboard(spec: BuildStoryboardSpec): Promise<BuildStoryboardResult> {
    if (!isConnected || !selectedIntegration) throw new Error('Not connected to an editor');
    const payload = {
      target_video_track: spec.targetVideoTrack,
      default_still_secs: spec.defaultStillSecs,
      audio_path: spec.audioPath,
      items: spec.items.map((it) => ({
        path: it.path,
        start: it.start,
        end: it.end,
        src_in: it.srcIn,
        src_out: it.srcOut,
      })),
    };
    // Importing media into Premiere is slow and runs once per item, so this
    // needs far longer than the default request timeout.
    const result = await sendRequestAndWait(
      (sid) => requestBuildStoryboard(payload, sid, selectedIntegration),
      300000,
    );
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    if (!data || !data.success) throw new Error(data?.error || 'Could not build the slideshow');
    return {
      lines: Array.isArray(data.lines) ? data.lines.filter((l: unknown) => typeof l === 'string') : [],
      appended: typeof data.appended === 'number' ? data.appended : 0,
      requested: typeof data.requested === 'number' ? data.requested : 0,
    };
  }

  async function jumpToTime(seconds: number) {
    if (!isConnected || !selectedIntegration) return;
    try {
      // Fire and forget pattern. No need to wait for a WebSocket response.
      await requestJumpToTime(seconds, undefined, selectedIntegration);
    } catch (error) {
      console.error('Failed to dispatch jump_to_time command:', error);
    }
  }

  return (
    <AdobeContext.Provider value={{
      timelineInfo,
      premiereTimeline,
      afterEffectsTimeline: aeTimeline,
      isConnected,
      isPremiereConnected,
      isAfterEffectsConnected,
      isExporting,
      exportProgress,
      refresh,
      pushToTimeline,
      getSourceAudio,
      buildStoryboard,
      jumpToTime
    }}>
      {children}
    </AdobeContext.Provider>
  );
}

export const useAdobe = () => {
  const context = useContext(AdobeContext);
  if (!context) throw new Error('useAdobe must be used within an AdobeProvider');
  return context;
};
