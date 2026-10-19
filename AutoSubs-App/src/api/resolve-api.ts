import { invoke } from '@tauri-apps/api/core';
import { getSubtitleDocumentPath, getAudioExportDir } from '@/utils/file-utils';
import { Speaker, Template } from '@/types';

/**
 * Error thrown when the AutoSubs Lua server (inside Resolve) reports a failure
 * in its response body. Carries both the short user-facing message and the
 * underlying Resolve error so the frontend error dialog can surface both.
 */
export class ResolveApiError extends Error {
  public detail?: string;
  public func?: string;

  constructor(message: string, detail?: string, func?: string) {
    super(message);
    this.name = "ResolveApiError";
    this.detail = detail;
    this.func = func;
  }
}

/**
 * Inspect a Lua-server JSON response and throw if it indicates failure. The
 * Lua server returns `{ error: "<short>", detail: "<raw>" }` (or
 * `{ error: true, message, detail }` for legacy handlers) on failure; on
 * success it returns handler-specific shapes that never have a non-empty
 * `error` field.
 */
function throwIfError(data: any, fallbackFunc?: string): void {
  if (data == null || typeof data !== "object") return;
  const err = (data as { error?: unknown }).error;
  if (!err) return;

  // Two supported shapes:
  //   { error: "short reason", detail?: "..." }
  //   { error: true, message: "short reason", detail?: "..." }
  const shortMessage =
    typeof err === "string"
      ? err
      : typeof (data as any).message === "string"
      ? (data as any).message
      : "Resolve reported an error";
  const detail =
    typeof (data as any).detail === "string"
      ? (data as any).detail
      : undefined;
  const func =
    typeof (data as any).func === "string"
      ? (data as any).func
      : fallbackFunc;

  throw new ResolveApiError(shortMessage, detail, func);
}

/**
 * Posts `payload` to the AutoSubs Lua server via a small Rust shim
 * (`resolve_bridge`) and returns the parsed JSON body.
 *
 * We used to call `@tauri-apps/plugin-http` directly, but its response-body
 * stream was observed to hang indefinitely against this specific server's
 * short `Connection: close` responses (headers would arrive with `200 OK`
 * but neither `.json()` nor `.text()` would ever resolve). Routing through
 * Rust/reqwest bypasses that plugin entirely.
 */
async function callResolve(
  payload: Record<string, unknown>,
  timeoutSecs?: number,
): Promise<any> {
  const invokePromise = invoke<string>('resolve_bridge', {
    args: { payload, timeoutSecs },
  });

  let text: string;
  if (timeoutSecs && timeoutSecs > 0) {
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Resolve did not respond within ${timeoutSecs} seconds`)),
        timeoutSecs * 1000,
      ),
    );
    text = await Promise.race([invokePromise, timeoutPromise]);
  } else {
    text = await invokePromise;
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('[resolve-api] Failed to parse JSON response:', err, text);
    throw new Error(
      `Invalid JSON response from AutoSubs server: ${text.slice(0, 200)}`,
    );
  }
}

export async function exportAudio(inputTracks: Array<string>, exportRange: 'entire' | 'inout' = 'entire') {
  const outputDir = await getAudioExportDir();
  const data = await callResolve({
    func: 'ExportAudio',
    outputDir,
    inputTracks,
    exportRange,
  });

  // Surface any Resolve-side error with underlying detail so the frontend
  // error dialog can show it to the user.
  throwIfError(data, 'ExportAudio');

  // New non-blocking API returns started: true instead of timeline data.
  if (!data.started) {
    throw new ResolveApiError(
      'Export did not start successfully',
      typeof data.detail === 'string' ? data.detail : undefined,
      'ExportAudio',
    );
  }

  return data;
}

export async function jumpToTime(seconds: number) {
  return callResolve({ func: 'JumpToTime', seconds });
}

export async function getTimelineInfo() {
  const data = await callResolve({ func: 'GetTimelineInfo' });
  if (!data.timelineId) {
    throw new Error('No timeline detected in Resolve.');
  }
  return {
    ...data,
    templates: [],
  };
}

export async function getTemplates(): Promise<Template[]> {
  const data = await callResolve({ func: 'GetTemplates' }, 15);
  throwIfError(data, 'GetTemplates');
  return Array.isArray(data) ? data : [];
}

export interface ConflictInfo {
  hasConflicts: boolean;
  conflictingClips?: Array<{ start: number; end: number; name: string }>;
  trackName?: string;
  subtitleRange?: { start: number; end: number };
  totalConflicts?: number;
  trackExists?: boolean;
  message?: string;
  error?: string;
}

export type ConflictMode = 'replace' | 'skip' | 'new_track' | null;

// Emitted by the Resolve Lua server when the AutoSubs Caption macro's default
// font was auto-swapped to something that supports the transcript's script
// (e.g. Japanese). `to` is null when the script is known but no candidate font
// is installed on the host (`missing: true`) so the UI can warn the user.
export interface FontSwapInfo {
  from: string;
  to: string | null;
  language: string;
  script: string;
  missing: boolean;
}

export interface AddSubtitlesResult {
  message?: string;
  result?: {
    ok?: boolean;
    fontSwap?: FontSwapInfo | null;
  } | false;
}

export interface GeneratePreviewResult {
  path: string;
  fontSwap?: FontSwapInfo | null;
}

export async function checkTrackConflicts(
  filename: string,
  outputTrack: string,
): Promise<ConflictInfo> {
  const filePath = await getSubtitleDocumentPath(filename);
  return callResolve({
    func: 'CheckTrackConflicts',
    filePath,
    trackIndex: outputTrack,
  });
}

export async function addSubtitlesToTimeline(
  filename: string,
  currentTemplate: string,
  outputTrack: string,
  conflictMode: ConflictMode = null,
  presetSettings?: Record<string, unknown>,
): Promise<AddSubtitlesResult> {
  const filePath = await getSubtitleDocumentPath(filename);
  const data = await callResolve({
    func: 'AddSubtitles',
    filePath,
    templateName: currentTemplate,
    trackIndex: outputTrack,
    conflictMode,
    presetSettings,
  });
  // Top-level failure (e.g. the server-side handler's pcall caught an error).
  throwIfError(data, 'AddSubtitles');
  // Nested failure: `AddSubtitles()` returns `{ error, detail }` inside `result`.
  if (data && typeof data === 'object' && data.result) {
    throwIfError(data.result, 'AddSubtitles');
  }
  return data;
}

export async function closeResolveLink() {
  return callResolve({ func: 'Exit' });
}

export async function getExportProgress() {
  return callResolve({ func: 'GetExportProgress' });
}

export async function cancelExport() {
  return callResolve({ func: 'CancelExport' });
}

export async function getRenderJobStatus() {
  return callResolve({ func: 'GetRenderJobStatus' });
}

export async function generatePreview(
  speaker: Speaker,
  templateName: string,
  exportPath: string,
  presetSettings?: Record<string, unknown>,
  language?: string,
): Promise<GeneratePreviewResult> {
  const data = await callResolve({
    func: 'GeneratePreview',
    speaker,
    templateName,
    exportPath,
    presetSettings,
    language,
  });
  throwIfError(data, 'GeneratePreview');
  return data;
}

// Starts an interactive caption-preset edit session in Resolve. Adds a new
// video track, drops an AutoSubs Caption clip, opens the Fusion page and
// (optionally) applies existing preset settings to the tool so the user can
// tweak them in the Fusion inspector.
export async function startPresetEdit(
  initialSettings?: Record<string, unknown>,
): Promise<{ ok?: true; error?: string }> {
  return callResolve({ func: 'StartPresetEdit', initialSettings });
}

// Reads the AutoSubs tool's current input values via the macro's GetInputValues
// helper, then tears down the preset-edit clip/track.
export async function capturePresetSettings(): Promise<{
  settings?: Record<string, unknown>;
  error?: string;
}> {
  return callResolve({ func: 'CapturePresetSettings' });
}

// Tears down the preset-edit clip/track without capturing. Safe to call with
// no active session.
export async function cancelPresetEdit(): Promise<{ ok?: true; error?: string }> {
  return callResolve({ func: 'CancelPresetEdit' });
}

// ===================== AutoEdit =====================
// AutoEdit actions execute inside Resolve through the Lua server because the
// free edition of Resolve rejects external scripting connections entirely.

// Read-only project/timeline snapshot, returned as printable log lines.
export async function getResolveInfo(): Promise<string[]> {
  const data = await callResolve({ func: 'GetResolveInfo' });
  throwIfError(data, 'GetResolveInfo');
  return Array.isArray(data.lines) ? data.lines : [];
}

export async function addMarkerAtPlayhead(): Promise<string[]> {
  const data = await callResolve({ func: 'AddMarkerAtPlayhead' });
  throwIfError(data, 'AddMarkerAtPlayhead');
  return Array.isArray(data.lines) ? data.lines : [];
}

// Timeline markers rendered as a YouTube chapter list, ready to paste into a
// video description.
export async function getYoutubeChapters(): Promise<string[]> {
  const data = await callResolve({ func: 'GetYoutubeChapters' });
  throwIfError(data, 'GetYoutubeChapters');
  return Array.isArray(data.lines) ? data.lines : [];
}

// Drops a marker on every clip boundary of a video track (default V1).
export async function markClipCuts(trackIndex = 1): Promise<string[]> {
  const data = await callResolve({ func: 'MarkClipCuts', trackIndex }, 120);
  throwIfError(data, 'MarkClipCuts');
  return Array.isArray(data.lines) ? data.lines : [];
}

// Removes markers from the timeline; omit `color` to clear every colour.
export async function clearTimelineMarkers(color?: string): Promise<string[]> {
  const data = await callResolve({ func: 'ClearTimelineMarkers', color });
  throwIfError(data, 'ClearTimelineMarkers');
  return Array.isArray(data.lines) ? data.lines : [];
}

// One marker per subtitle, carrying its text — turns the marker list into a
// clickable transcript index. Long timelines mean many markers, hence the
// generous timeout.
export async function markersFromSubtitles(trackIndex = 1): Promise<string[]> {
  const data = await callResolve(
    { func: 'MarkersFromSubtitles', trackIndex },
    300,
  );
  throwIfError(data, 'MarkersFromSubtitles');
  return Array.isArray(data.lines) ? data.lines : [];
}

// Marks silences between subtitles longer than `minSeconds` — the pauses worth
// tightening, and natural section breaks.
export async function markSpeechGaps(
  minSeconds = 2,
  trackIndex = 1,
): Promise<string[]> {
  const data = await callResolve(
    { func: 'MarkSpeechGaps', minSeconds, trackIndex },
    300,
  );
  throwIfError(data, 'MarkSpeechGaps');
  return Array.isArray(data.lines) ? data.lines : [];
}

// Reports (and marks) holes in a video track, which would play as black.
export async function findTimelineGaps(trackIndex = 1): Promise<string[]> {
  const data = await callResolve({ func: 'FindTimelineGaps', trackIndex }, 120);
  throwIfError(data, 'FindTimelineGaps');
  return Array.isArray(data.lines) ? data.lines : [];
}

// ===================== AutoEdit: timeline selection =====================
// Opaque handle for a Resolve API object held server-side. The Lua bridge
// registers each MediaPoolItem it hands out and expects the same handle back
// when we later reference it (see ApplyKeepSegments).
export interface ResolveObjectRef {
  __resolve_obj: number;
}

export interface TimelineClipInfo {
  track: number;
  track_type: 'video' | 'audio';
  name: string;
  record_in_frame: number;   // frames from timeline start
  record_out_frame: number;  // exclusive
  source_start_frame: number;
  source_end_frame: number;
  left_offset: number;
  media_pool_ref?: ResolveObjectRef;
  media_path?: string;
  media_pool_unique_id?: string;
}

export interface TimelineSelection {
  fps: number;
  timeline_name?: string;
  timeline_start_frame: number;
  mark_in_frame: number | null;
  mark_out_frame: number | null;
  has_in_out: boolean;
  video_clips: TimelineClipInfo[];
  audio_clips: TimelineClipInfo[];
}

export interface TimelineSelectionSpec {
  video_tracks?: number[];
  audio_tracks?: number[];
  use_in_out?: boolean;
}

// Snapshot of the timeline clips the user is about to operate on. Every clip
// carries a `media_pool_ref` handle so a follow-up ApplyKeepSegments call can
// rebuild sub-ranges of the same media on a new track.
export async function getTimelineSelection(
  spec: TimelineSelectionSpec = {},
): Promise<TimelineSelection> {
  const data = await callResolve({ func: 'GetTimelineSelection', spec }, 60);
  throwIfError(data, 'GetTimelineSelection');
  return data as TimelineSelection;
}

export interface KeepSegment {
  track_type: 'video' | 'audio';
  media_pool_ref: ResolveObjectRef;
  source_in_frame: number;
  source_out_frame: number;   // exclusive
  record_in_frame: number;    // frames from timeline start
  /** Track this segment belongs on. Required when cutting several tracks at
   *  once; without it everything of one media type lands on a single track.
   *  Falls back to the spec's target_* index when omitted. */
  track_index?: number;
}

export interface ApplyKeepSegmentsSpec {
  target_video_track?: number;   // >=1 to insert; 0 or omit to skip video
  target_audio_track?: number;   // >=1 to insert; 0 or omit to skip audio
  segments: KeepSegment[];
}

export interface ApplyKeepSegmentsResult {
  lines: string[];
  appended: number;
  requested: number;
}

// Non-destructive: rebuilds `segments` on the requested target tracks (created
// if they don't exist yet) using MediaPool:AppendToTimeline. Original tracks
// are left untouched.
export async function applyKeepSegments(
  spec: ApplyKeepSegmentsSpec,
): Promise<ApplyKeepSegmentsResult> {
  const data = await callResolve({ func: 'ApplyKeepSegments', spec }, 300);
  throwIfError(data, 'ApplyKeepSegments');
  return {
    lines: Array.isArray(data.lines) ? data.lines.filter((l: unknown) => typeof l === 'string') : [],
    appended: typeof data.appended === 'number' ? data.appended : 0,
    requested: typeof data.requested === 'number' ? data.requested : 0,
  };
}

export interface DuplicateTimelineResult {
  name: string;
  timeline_ref: ResolveObjectRef;
  lines: string[];
}

// Duplicates the current timeline and (by default) makes the copy the current
// timeline. Returns the new timeline's name + object handle.
export async function duplicateCurrentTimeline(
  nameSuffix = ' (silence removed)',
  switchTo = true,
): Promise<DuplicateTimelineResult> {
  const data = await callResolve(
    { func: 'DuplicateCurrentTimeline', spec: { name_suffix: nameSuffix, switch_to: switchTo } },
    60,
  );
  throwIfError(data, 'DuplicateCurrentTimeline');
  return data as DuplicateTimelineResult;
}

// Creates a fresh empty timeline (and switches to it), returning its name +
// object handle. Preferred over duplicateCurrentTimeline for the silence-cut
// workflow — CreateEmptyTimeline is supported on more Resolve builds than
// MediaPool:DuplicateTimeline.
export async function createCutTimeline(
  nameSuffix = ' (silence removed)',
): Promise<DuplicateTimelineResult> {
  const data = await callResolve(
    { func: 'CreateCutTimeline', spec: { name_suffix: nameSuffix } },
    60,
  );
  throwIfError(data, 'CreateCutTimeline');
  return data as DuplicateTimelineResult;
}

// ===================== Slideshow (media synced to voice) =====================

// Static transform applied to one placed clip (see slideshow-effects.ts). All
// fields optional; omitted ones leave the clip's default framing untouched.
export interface StoryboardEffect {
  zoom?: number;
  panX?: number;
  panY?: number;
  rotation?: number;
}

// One media file placed at the record time of the sentence it illustrates.
// `start`/`end` are seconds on the timeline; `end` omitted/<= start falls back
// to the spec's default still duration.
export interface StoryboardItem {
  path: string;
  start: number;
  end?: number;
  effect?: StoryboardEffect;
  /**
   * Optional in/out point *within the source clip*, in seconds. Videos are
   * otherwise placed whole; giving a range makes the host cut that section out
   * instead (the "url start-end" import). Both omitted = use the whole clip.
   */
  srcIn?: number;
  srcOut?: number;
}

export interface BuildStoryboardSpec {
  targetVideoTrack: number;   // >=1; created if it doesn't exist yet
  mode?: "replace" | "insert" | "overlay" | "append";
  defaultStillSecs: number;   // fallback duration for a 0/absent span
  items: StoryboardItem[];    // in play order (may be empty for audio-only)
  /** Optional voice-over file dropped onto a fresh audio track at t=0. */
  audioPath?: string;
}

export interface BuildStoryboardResult {
  lines: string[];
  appended: number;
  requested: number;
}

// Imports the media and drops each clip at its sentence's record time so the
// visuals follow the voice-over. Non-destructive: appends onto the target track
// of the current timeline (created if missing). Transitions and animated moves
// are out of scope — Resolve scripting cannot add either.
export async function buildStoryboard(
  spec: BuildStoryboardSpec,
): Promise<BuildStoryboardResult> {
  const data = await callResolve(
    {
      func: 'BuildStoryboard',
      spec: {
        target_video_track: spec.targetVideoTrack,
        mode: spec.mode,
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
    },
    300,
  );
  throwIfError(data, 'BuildStoryboard');
  return {
    lines: Array.isArray(data.lines)
      ? data.lines.filter((l: unknown) => typeof l === 'string')
      : [],
    appended: typeof data.appended === 'number' ? data.appended : 0,
    requested: typeof data.requested === 'number' ? data.requested : 0,
  };
}

// Deletes every clip on the given track indices of the current timeline (does
// NOT ripple). Used to empty tracks on the duplicated timeline before
// ApplyKeepSegments rebuilds them from keep-segments.
export async function clearTracks(
  videoTracks: number[] = [],
  audioTracks: number[] = [],
): Promise<{ removed: number; lines: string[] }> {
  const data = await callResolve(
    { func: 'ClearTracks', spec: { video_tracks: videoTracks, audio_tracks: audioTracks } },
    120,
  );
  throwIfError(data, 'ClearTracks');
  return {
    removed: typeof data.removed === 'number' ? data.removed : 0,
    lines: Array.isArray(data.lines) ? data.lines.filter((l: unknown) => typeof l === 'string') : [],
  };
}
