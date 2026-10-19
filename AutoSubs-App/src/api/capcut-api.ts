import { invoke } from "@tauri-apps/api/core";
import { getSubtitleDocumentPath } from "@/lib/subtitle-documents";
import type { BuildStoryboardSpec, BuildStoryboardResult } from "@/api/resolve-api";
import type { Template, Track } from "@/types";

export interface CapCutDraftSummary {
  id: string;
  name: string;
  folderPath: string;
  jsonPath: string;
  modifiedUs: number;
  durationUs: number;
  fps?: number;
  width?: number;
  height?: number;
  trackCount?: number;
  clipCount?: number;
}

export interface CapCutStatusResponse {
  connected: boolean;
  draftsRoot: string;
  drafts: CapCutDraftSummary[];
  activeDraft: CapCutDraftSummary | null;
  name: string;
  timelineId: string;
  projectName: string;
  fps: number;
  duration: number;
  inputTracks: Track[];
  outputTracks: Track[];
  templates: Template[];
}

export async function getCapCutStatus(
  preferredDraftId?: string,
): Promise<CapCutStatusResponse> {
  return invoke<CapCutStatusResponse>("capcut_get_status", {
    preferredDraftId: preferredDraftId || null,
  });
}

export async function buildCapCutStoryboard(
  spec: BuildStoryboardSpec,
  preferredDraftId?: string,
): Promise<BuildStoryboardResult> {
  return invoke<BuildStoryboardResult>("capcut_build_storyboard", {
    spec: {
      preferred_draft_id: preferredDraftId || null,
      target_video_track: spec.targetVideoTrack,
      mode: spec.mode || null,
      default_still_secs: spec.defaultStillSecs,
      audio_path: spec.audioPath,
      items: spec.items.map((it) => ({
        path: it.path,
        start: it.start,
        end: it.end,
        src_in: it.srcIn,
        src_out: it.srcOut,
        effect: it.effect
          ? {
              zoom: it.effect.zoom,
              pan_x: it.effect.panX,
              pan_y: it.effect.panY,
              rotation: it.effect.rotation,
            }
          : undefined,
      })),
    },
  });
}

export async function addSubtitlesToCapCut(
  filename: string,
  templateName?: string,
  preferredDraftId?: string,
): Promise<{ added: number; draftName: string }> {
  const filePath = await getSubtitleDocumentPath(filename);
  return invoke<{ added: number; draftName: string }>("capcut_add_subtitles", {
    args: {
      filePath,
      templateName: templateName || null,
      preferredDraftId: preferredDraftId || null,
    },
  });
}

export async function getCapCutTimelineAudio(
  preferredDraftId?: string,
): Promise<{ path: string; offset: number }> {
  return invoke<{ path: string; offset: number }>("capcut_get_timeline_audio", {
    preferredDraftId: preferredDraftId || null,
  });
}

export interface CapCutTimelineSegment {
  id: string;
  materialId: string;
  kind: "video" | "photo" | "audio" | "text" | string;
  name: string;
  mediaPath: string;
  text: string;
  startSec: number;
  durationSec: number;
  srcInSec: number;
  srcOutSec: number;
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
  volume: number;
}

export interface CapCutTimelineTrack {
  id: string;
  name: string;
  trackType: "video" | "audio" | "text" | string;
  segments: CapCutTimelineSegment[];
}

export interface CapCutTimelineSnapshot {
  draftId: string;
  draftName: string;
  folderPath: string;
  jsonPath: string;
  canvasWidth: number;
  canvasHeight: number;
  fps: number;
  durationSec: number;
  tracks: CapCutTimelineTrack[];
}

export async function getCapCutTimelineSnapshot(
  preferredDraftId?: string,
): Promise<CapCutTimelineSnapshot> {
  return invoke<CapCutTimelineSnapshot>("capcut_get_timeline_snapshot", {
    preferredDraftId: preferredDraftId || null,
  });
}

export async function deleteCapCutSegment(
  segmentId: string,
  preferredDraftId?: string,
): Promise<CapCutTimelineSnapshot> {
  return invoke<CapCutTimelineSnapshot>("capcut_delete_segment", {
    preferredDraftId: preferredDraftId || null,
    segmentId,
  });
}

export async function updateCapCutSegment(args: {
  segmentId: string;
  preferredDraftId?: string;
  startSec?: number;
  durationSec?: number;
  text?: string;
  zoom?: number;
  zoomEnd?: number;
  panX?: number;
  panXEnd?: number;
  panY?: number;
  panYEnd?: number;
  rotation?: number;
  volume?: number;
}): Promise<CapCutTimelineSnapshot> {
  return invoke<CapCutTimelineSnapshot>("capcut_update_segment", { args });
}
