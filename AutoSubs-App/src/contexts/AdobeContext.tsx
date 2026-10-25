import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TimelineInfo } from '@/types';
import { requestSequenceInfo, requestAudioExport, requestImportSRT, requestJumpToTime } from '@/api/adobe-api';
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

interface AdobeContextType {
  timelineInfo: TimelineInfo;
  isConnected: boolean;
  isExporting: boolean;
  exportProgress: number;
  refresh: () => Promise<void>;
  pushToTimeline: (filename?: string, languageMode?: TimelineLanguageMode) => Promise<void>;
  getSourceAudio: (audioInputMode: "file" | "timeline", fileInput: string | null, inputTracks: string[]) => Promise<{ path: string, offset: number } | null>;
  jumpToTime: (seconds: number) => Promise<void>;
}

const AdobeContext = createContext<AdobeContextType | null>(null);

const emptyTimeline: TimelineInfo = {
  name: "",
  timelineId: "",
  inputTracks: [],
  outputTracks: [],
  projectName: ""
};

/** Maps raw sequence info from Premiere into a normalised TimelineInfo shape. */
function toTimelineInfo(data: any): TimelineInfo {
  return {
    name: data.name || data.sequenceName || "Sequence",
    timelineId: data.id || "adobe_seq",
    inputTracks: data.audioTrackInfo?.map((t: any) => ({
      value: t.index.toString(),
      label: t.name || `Audio ${t.index}`
    })) ?? [],
    // Premiere reports a video-track count (not per-track names); expose them as
    // V1..Vn. ExtendScript can't add tracks, so there is no synthetic "new
    // track" here.
    outputTracks: typeof data.numVideoTracks === 'number'
      ? Array.from({ length: data.numVideoTracks }, (_, i) => ({
          value: String(i + 1),
          label: `V${i + 1}`,
        }))
      : [],
    projectName: data.projectName || "",
    projectId: data.projectPath || ""
  };
}

export function AdobeProvider({ children }: { children: React.ReactNode }) {
  const exportRange = useSettingsStore((s) => s.exportRange);
  const [isConnected, setIsConnected] = useState(false);
  const [timelineInfo, setTimelineInfo] = useState<TimelineInfo>(emptyTimeline);

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const pendingRequests = useRef<Map<string, (value: any) => void>>(new Map());

  const refreshApp = useCallback(async (connected: boolean) => {
    if (!connected) return;

    try {
      const result = await sendRequestAndWait((sid) => requestSequenceInfo(sid, 'premiere'));
      const data = typeof result === 'string' ? JSON.parse(result) : result;

      if (data && data.success) setTimelineInfo(toTimelineInfo(data));
    } catch (error) {
      console.error('Failed to refresh Premiere sequence info:', error);
    }
    // sendRequestAndWait is a stable function (defined outside useCallback and only reads a ref);
    // it does not need to be in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    await refreshApp(isConnected);
  }, [isConnected, refreshApp]);

  useEffect(() => {
    const unlistenStatus = listen<{ status: string, app: string }>('adobe-status', (event) => {
      const { status, app } = event.payload;
      if (app !== 'premiere') return;
      const isAppConnected = status === 'connected';
      setIsConnected(isAppConnected);

      if (isAppConnected) {
        // Pass the status explicitly instead of relying on the async state update.
        refreshApp(true);
      } else {
        setTimelineInfo(emptyTimeline);
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
        if (data && data.success && originApp === 'premiere') setTimelineInfo(toTimelineInfo(data));
      }
    });

    return () => {
      unlistenStatus.then(f => f());
      unlistenMessage.then(f => f());
    };
  }, [refreshApp]);

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
    if (!filename) return;
    try {
      const filePath = await getSubtitleDocumentPath(filename);

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

      toast.info('Importing subtitles to Premiere Pro...');

      for (const pass of passes) {
        const srtPath = filePath.replace(/\.json$/, `${pass.suffix}.srt`);
        await writeTextFile(srtPath, generateSrt(pass.subtitles));

        const result = await sendRequestAndWait((sid) => requestImportSRT(srtPath, sid, 'premiere'));
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
    if (audioInputMode === "file" || !isConnected) return { path: fileInput || "", offset: 0 };

    setIsExporting(true);
    setExportProgress(10);
    try {
      const exportDir = await getAudioExportDir();
      const tracks = inputTracks.map(Number).filter(n => !isNaN(n));
      const result = await sendRequestAndWait((sid) => requestAudioExport(exportDir, tracks, exportRange || 'entire', '', sid, 'premiere'));
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

  async function jumpToTime(seconds: number) {
    if (!isConnected) return;
    try {
      // Fire and forget pattern. No need to wait for a WebSocket response.
      await requestJumpToTime(seconds, undefined, 'premiere');
    } catch (error) {
      console.error('Failed to dispatch jump_to_time command:', error);
    }
  }

  return (
    <AdobeContext.Provider value={{
      timelineInfo,
      isConnected,
      isExporting,
      exportProgress,
      refresh,
      pushToTimeline,
      getSourceAudio,
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
