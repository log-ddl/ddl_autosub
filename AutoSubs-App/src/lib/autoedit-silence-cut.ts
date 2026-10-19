// Orchestrator for the "Auto-cut silences on timeline" AutoEdit action.
//
// End-to-end flow (matches AutoCut's default behaviour on Resolve):
//   1. Read the current timeline via the AutoSubs Lua bridge (clips + In/Out).
//   2. Export the selected audio track via Resolve's ExportAudio (existing).
//   3. Run Silero VAD in Rust on the exported WAV → get silence/keep spans.
//   4. Map audio-relative spans onto each source clip's frame domain.
//   5. Create a fresh empty timeline so the original stays untouched.
//   6. Rebuild the keep-segments compacted onto it — the "cut" effect.

import {
  applyKeepSegments,
  cancelExport,
  clearTracks,
  createCutTimeline,
  exportAudio,
  getExportProgress,
  getTimelineSelection,
  KeepSegment,
  ResolveApiError,
  TimelineClipInfo,
} from '@/api/resolve-api';
import { detectFillerSpans, type TranscriptLike } from '@/lib/filler-words';
import { ensureModels, transcribeAudio } from '@/api/transcription-api';
import { analyzeWavSilences, type AnalyzeSilenceResult } from '@/api/autoedit-api';

/** Which tracks a cut is applied to. */
export type CutTarget = 'both' | 'video' | 'audio';

export interface SilenceCutOptions {
  /** 1-based indexes of the video tracks to cut. Empty leaves picture alone. */
  videoTrackIndexes: number[];
  /** 1-based indexes of the audio tracks to analyse and cut. They are exported
   *  as one mix, so a silence has to be silent on all of them to count. */
  audioTrackIndexes: number[];
  /** Restrict to timeline In/Out marks when true (default: true). */
  useInOut?: boolean;
  /** Minimum silence duration to remove, in seconds. */
  minSilenceSecs?: number;
  /** Extra padding kept around every kept span, in seconds. */
  paddingSecs?: number;
  /** Reject kept spans shorter than this, in seconds. */
  minKeepSecs?: number;
  /** Suffix appended to the duplicated timeline's name. */
  timelineNameSuffix?: string;
}

export interface SilenceCutProgress {
  step: 'reading' | 'exporting' | 'analyzing' | 'duplicating' | 'clearing' | 'applying' | 'done';
  message: string;
  ratio?: number; // 0..1, only meaningful during 'exporting'
}

export interface SilenceCutResult {
  totalDurationSecs: number;
  speechDurationSecs: number;
  cutDurationSecs: number;
  timelineName: string;
  appended: number;
  requested: number;
  lines: string[];
}

export type { AnalyzeSilenceResult };

// One audio track's own export and detection pass. Tracks are measured and cut
// independently, so each carries its own spans and its own timing.
export interface TrackSilenceAnalysis {
  trackIndex: number;
  audioPath: string;
  audioOffsetSecs: number;
  analysis: AnalyzeSilenceResult;
  // Filler-word spans (audio-relative seconds) when the caller asked for filler
  // detection; empty otherwise. Same time domain as this track's VAD spans.
  fillerSpans: Array<{ start_secs: number; end_secs: number }>;
}

// Everything the AutoCut tab needs after the VAD passes. The tab holds on to
// this so slider changes recompute cuts client-side (silence-math.ts) and only
// `applySilenceCut` touches Resolve again.
export interface TimelineSilenceAnalysis {
  selection: TimelineSelectionResult;
  fps: number;
  startFrame: number;
  // Whether the analysis window was limited to the timeline's In/Out marks.
  // An in-place cut needs this to know that material outside the marks was
  // never analysed and must be preserved verbatim.
  limitedToInOut: boolean;
  // In selection order. The first entry is the one video tracks follow, since
  // picture has no sound of its own to be measured against.
  tracks: TrackSilenceAnalysis[];
}

// Re-exported so callers don't need to import the raw Resolve type name.
type TimelineSelectionResult = Awaited<ReturnType<typeof getTimelineSelection>>;

// A keep range measured in timeline record-frames, plus the position it maps
// to on the compacted timeline. Built once and shared by the video and audio
// tracks so both compact to the *same* record positions — this is what keeps
// picture and sound in sync (independent per-track compaction drifts apart).
interface KeepRangeFrames {
  inF: number;      // original record-frame start (0-based from timeline start)
  outF: number;     // original record-frame end (exclusive)
  compactedInF: number; // where this range starts on the compacted timeline
}

// Order the ranges and lay them end to end. Removing the space between them is
// the whole cut: every kept range slides left onto the end of the previous one.
// Exported for the frame-math checks in autoedit-silence-cut.check.ts.
export function compactRanges(
  ranges: Array<{ inF: number; outF: number }>,
): KeepRangeFrames[] {
  const sorted = ranges
    .filter((r) => r.outF > r.inF)
    .sort((a, b) => a.inF - b.inF);
  let acc = 0;
  return sorted.map((r) => {
    const compactedInF = acc;
    acc += r.outF - r.inF;
    return { inF: r.inF, outF: r.outF, compactedInF };
  });
}

function toFrameRanges(
  spans: Array<{ start_secs: number; end_secs: number }>,
  fps: number,
): Array<{ inF: number; outF: number }> {
  return spans.map((s) => ({
    inF: Math.round(s.start_secs * fps),
    outF: Math.round(s.end_secs * fps),
  }));
}

// Slice one clip against the shared keep ranges (all in record frames) and
// place each kept piece at its compacted record position. Source in/out are
// derived from the clip's own source-to-record ratio, so retimed clips and
// media whose fps differs from the timeline map correctly. Placement duration
// is a RECORD-frame span, which is what actually decides where the next clip
// sits — using source frames here is what left gaps on the video track.
export function sliceClipToKeepSegments(
  clip: TimelineClipInfo,
  keepRanges: KeepRangeFrames[],
): KeepSegment[] {
  if (!clip.media_pool_ref) return [];
  const clipRecIn = clip.record_in_frame;
  const clipRecOut = clip.record_out_frame;
  const recSpan = clipRecOut - clipRecIn;
  if (recSpan <= 0) return [];
  // Source frames per record frame (≈1 for un-retimed, timeline-conformed media).
  const ratio = (clip.source_end_frame - clip.source_start_frame) / recSpan;

  const out: KeepSegment[] = [];
  for (const kr of keepRanges) {
    const lo = Math.max(kr.inF, clipRecIn);
    const hi = Math.min(kr.outF, clipRecOut);
    if (hi <= lo) continue;
    const srcIn = Math.round(clip.source_start_frame + (lo - clipRecIn) * ratio);
    const srcOut = Math.round(clip.source_start_frame + (hi - clipRecIn) * ratio);
    if (srcOut <= srcIn) continue;
    out.push({
      track_type: clip.track_type,
      track_index: clip.track,
      media_pool_ref: clip.media_pool_ref,
      source_in_frame: srcIn,
      source_out_frame: srcOut,
      // Compacted position = where this keep range starts on the new timeline,
      // plus how far into the range this piece begins.
      record_in_frame: kr.compactedInF + (lo - kr.inF),
    });
  }
  return out;
}

// Stage 1: read timeline, export the audio track, run VAD once. The returned
// bundle carries `raw_speech_spans`, so the caller can recompute keep/cut spans
// with different slider values without touching Resolve or the VAD again.
export async function analyzeTimelineForSilence(
  opts: Pick<SilenceCutOptions, 'videoTrackIndexes' | 'audioTrackIndexes' | 'useInOut' | 'minSilenceSecs' | 'paddingSecs' | 'minKeepSecs'> & {
    /** Also run transcription and detect filler words (um/uh/à/ừm...). */
    detectFillers?: boolean;
    /** Transcription model id to use for filler detection. */
    fillerModel?: string;
    /** Source language for transcription (undefined = auto-detect). */
    fillerLang?: string;
    /** GPU acceleration for the filler transcription pass. */
    fillerGpu?: boolean;
  },
  onProgress?: (p: SilenceCutProgress) => void,
): Promise<TimelineSilenceAnalysis> {
  const {
    videoTrackIndexes,
    audioTrackIndexes,
    useInOut = true,
    minSilenceSecs = 0.6,
    paddingSecs = 0.05,
    minKeepSecs = 0.2,
    detectFillers = false,
    fillerModel = 'small',
    fillerLang,
    fillerGpu,
  } = opts;
  const emit = (p: SilenceCutProgress) => onProgress?.(p);

  emit({ step: 'reading', message: 'Reading timeline selection...' });
  // Always fetch every clip on the target tracks, not just the ones inside
  // In/Out. An in-place cut rebuilds the whole track, so it needs the material
  // outside the marks too — otherwise clearing the track would destroy it.
  // The marks still come back and still bound what gets analysed.
  const selection = await getTimelineSelection({
    video_tracks: videoTrackIndexes,
    audio_tracks: audioTrackIndexes,
    use_in_out: false,
  });
  if (selection.audio_clips.length === 0 && selection.video_clips.length === 0) {
    throw new ResolveApiError(
      'No clips found on the selected tracks.',
      undefined,
      'GetTimelineSelection',
    );
  }

  const limitedToInOut = Boolean(useInOut && selection.has_in_out);
  if (limitedToInOut) {
    const markIn = selection.mark_in_frame ?? 0;
    const markOut = selection.mark_out_frame ?? 0;
    const insideMarks = [...selection.video_clips, ...selection.audio_clips].some(
      (c) => c.record_out_frame > markIn && c.record_in_frame < markOut,
    );
    if (!insideMarks) {
      throw new ResolveApiError(
        'No clips fall inside the In/Out range on the selected tracks.',
        undefined,
        'GetTimelineSelection',
      );
    }
  }

  if (audioTrackIndexes.length === 0) {
    throw new Error('Select at least one audio track to analyse.');
  }

  // Each track is exported and measured on its own — one render and one VAD
  // pass per track. That is why selecting several is slower: the work is per
  // track, not shared.
  const tracks: TrackSilenceAnalysis[] = [];

  for (const [position, trackIndex] of audioTrackIndexes.entries()) {
    const label = `track ${trackIndex} (${position + 1}/${audioTrackIndexes.length})`;

    emit({ step: 'exporting', message: `Exporting audio from ${label}...` });
    await exportAudio([String(trackIndex)], limitedToInOut ? 'inout' : 'entire');

    let audioPath = '';
    let audioOffsetSecs = 0;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let progressResult: any;
      try {
        progressResult = await getExportProgress();
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          await cancelExport().catch(() => undefined);
          throw err;
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      if (typeof progressResult.progress === 'number') {
        emit({
          step: 'exporting',
          message: `Exporting audio from ${label}...`,
          ratio: Math.max(0, Math.min(1, progressResult.progress / 100)),
        });
      }

      if (progressResult.completed) {
        audioPath = progressResult.audioInfo?.path ?? '';
        audioOffsetSecs = progressResult.audioInfo?.offset ?? 0;
        break;
      }
      if (progressResult.cancelled) {
        throw new Error('Audio export was cancelled.');
      }
      if (progressResult.error) {
        throw new ResolveApiError(
          progressResult.message || 'Export failed',
          progressResult.detail,
          'GetExportProgress',
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!audioPath) {
      throw new Error(`Export of ${label} finished but no audio path was returned.`);
    }

    emit({ step: 'analyzing', message: `Detecting silences on ${label}...` });
    const analysis = await analyzeWavSilences({
      wav_path: audioPath,
      min_silence_secs: minSilenceSecs,
      padding_secs: paddingSecs,
      min_keep_secs: minKeepSecs,
    });

    // Optional filler-word pass: transcribe this track's WAV and pull out the
    // um/uh/à/ừm word spans. Word timestamps are relative to the WAV, matching
    // the VAD span domain, so no extra offset conversion is needed here.
    let fillerSpans: Array<{ start_secs: number; end_secs: number }> = [];
    if (detectFillers) {
      emit({ step: 'analyzing', message: `Transcribing ${label} to find filler words...` });
      const modelPaths = await ensureModels({
        model: fillerModel,
        enable_vad: true,
        enable_diarize: false,
        enable_forced_alignment: false,
      });
      const transcript = await transcribeAudio<TranscriptLike>({
        audioPath,
        offset: 0,
        model: fillerModel,
        lang: fillerLang,
        enableDtw: true,
        enableGpu: fillerGpu,
        enableDiarize: false,
        asrModelPath: modelPaths.asr_model_path,
        vadModelPath: modelPaths.vad_model_path,
      });
      fillerSpans = detectFillerSpans(transcript);
    }

    tracks.push({ trackIndex, audioPath, audioOffsetSecs, analysis, fillerSpans });
  }

  return {
    selection,
    fps: selection.fps,
    startFrame: selection.timeline_start_frame,
    limitedToInOut,
    tracks,
  };
}

// Stage 2: given a pre-fetched analysis + the (audio-relative) keep spans the
// user settled on, slice every clip, compact, duplicate the timeline and
// rebuild it. Kept separate from analysis so the AutoCut tab can apply after a
// live preview without re-exporting.
export async function applySilenceCut(
  bundle: TimelineSilenceAnalysis,
  /** Keep spans per audio track, keyed by track index, in that track's own
   *  audio-relative seconds. Tracks are cut independently, so each needs its
   *  own set. */
  keepSpansByTrack: Map<number, Array<{ start_secs: number; end_secs: number }>>,
  opts: {
    videoTrackIndexes: number[];
    audioTrackIndexes: number[];
    /** When true, cut onto a fresh timeline and leave the current one alone.
     *  When false (default), ripple the current timeline in place (undoable). */
    keepOriginalCopy?: boolean;
    timelineNameSuffix?: string;
  },
  onProgress?: (p: SilenceCutProgress) => void,
): Promise<SilenceCutResult> {
  const emit = (p: SilenceCutProgress) => onProgress?.(p);
  const { selection, fps } = bundle;
  const {
    videoTrackIndexes,
    audioTrackIndexes,
    keepOriginalCopy = false,
    timelineNameSuffix = ' (silence removed)',
  } = opts;
  const cutVideo = videoTrackIndexes.length > 0;
  const cutAudio = audioTrackIndexes.length > 0;

  const markInF = selection.mark_in_frame ?? 0;
  const markOutF = selection.mark_out_frame ?? 0;

  // Build one track's keep ranges from its own spans. Cutting in place rebuilds
  // the whole track, so material the analysis never looked at — before In and
  // after Out — is carried over as ordinary ranges. That also gives the ripple
  // for free: compaction slides the tail left by exactly what was removed.
  const rangesForTrack = (
    trackAnalysis: TrackSilenceAnalysis,
    clips: TimelineClipInfo[],
  ) => {
    const spans = (keepSpansByTrack.get(trackAnalysis.trackIndex) ?? []).map((span) => ({
      start_secs: span.start_secs + trackAnalysis.audioOffsetSecs,
      end_secs: span.end_secs + trackAnalysis.audioOffsetSecs,
    }));
    const ranges = toFrameRanges(spans, fps);
    if (!keepOriginalCopy && bundle.limitedToInOut) {
      const trackEndF = clips.reduce((max, c) => Math.max(max, c.record_out_frame), 0);
      if (markInF > 0) ranges.push({ inF: 0, outF: markInF });
      if (trackEndF > markOutF) ranges.push({ inF: markOutF, outF: trackEndF });
    }
    return compactRanges(ranges);
  };

  const primary = bundle.tracks[0];
  if (!primary) {
    throw new Error('Nothing was analysed, so there is nothing to cut.');
  }

  // Picture has no sound of its own, so it follows the first selected audio
  // track. Every other audio track is measured and cut entirely on its own.
  const videoClips = cutVideo ? selection.video_clips : [];
  const videoCompacted = videoClips.flatMap((clip) =>
    sliceClipToKeepSegments(clip, rangesForTrack(primary, videoClips)),
  );

  const audioCompacted: KeepSegment[] = [];
  if (cutAudio) {
    for (const trackAnalysis of bundle.tracks) {
      const clips = selection.audio_clips.filter(
        (c) => c.track === trackAnalysis.trackIndex,
      );
      if (clips.length === 0) continue;
      const trackRanges = rangesForTrack(trackAnalysis, clips);
      for (const clip of clips) {
        audioCompacted.push(...sliceClipToKeepSegments(clip, trackRanges));
      }
    }
  }

  if (videoCompacted.length === 0 && audioCompacted.length === 0) {
    throw new Error('No keep-segments intersect the selected clips.');
  }

  // Resolve's scripting API has no razor/split, so we rebuild rather than
  // ripple-delete mid-clip. Two destinations:
  //   in place  → clear the chosen tracks on the CURRENT timeline, then
  //               re-append the compacted media. Looks like AutoCut's in-place
  //               ripple and is undoable with Cmd/Ctrl+Z.
  //   on a copy → build onto a fresh empty timeline, current one untouched.
  let timelineName: string;
  let targetVideo: number;
  let targetAudio: number;

  if (keepOriginalCopy) {
    emit({ step: 'duplicating', message: 'Creating cut timeline...' });
    const created = await createCutTimeline(timelineNameSuffix);
    timelineName = created.name;
    targetVideo = 1;
    targetAudio = 1;
    // A fresh timeline has no V2/A2 to receive them, and the segments' own
    // indexes would otherwise send them to tracks that don't exist yet.
    for (const segment of [...videoCompacted, ...audioCompacted]) {
      delete segment.track_index;
    }
  } else {
    emit({ step: 'clearing', message: 'Clearing tracks to rebuild...' });
    // Clear only what we are going to rebuild — a track left out of the cut
    // must survive untouched.
    await clearTracks(
      cutVideo ? videoTrackIndexes : [],
      cutAudio ? audioTrackIndexes : [],
    );
    timelineName = selection.timeline_name ?? 'current timeline';
    // Each segment carries its own track_index; these are only the fallback.
    targetVideo = videoTrackIndexes[0] ?? 0;
    targetAudio = audioTrackIndexes[0] ?? 0;
  }

  const compacted = [...videoCompacted, ...audioCompacted];
  emit({ step: 'applying', message: 'Rebuilding cut timeline...' });
  const applied = await applyKeepSegments({
    // 0 tells the Lua side to skip that media type entirely.
    target_video_track: cutVideo ? targetVideo : 0,
    target_audio_track: cutAudio ? targetAudio : 0,
    segments: compacted,
  });

  // Totals are reported per track, since the tracks no longer share a length.
  const lines: string[] = [];
  let totalDurationSecs = 0;
  let speechDurationSecs = 0;
  let cutDurationSecs = 0;
  for (const trackAnalysis of bundle.tracks) {
    const kept = (keepSpansByTrack.get(trackAnalysis.trackIndex) ?? []).reduce(
      (acc, span) => acc + (span.end_secs - span.start_secs),
      0,
    );
    const total = trackAnalysis.analysis.total_duration_secs;
    const removed = Math.max(0, total - kept);
    totalDurationSecs = Math.max(totalDurationSecs, total);
    speechDurationSecs += trackAnalysis.analysis.speech_duration_secs;
    cutDurationSecs = Math.max(cutDurationSecs, removed);
    lines.push(
      `Audio ${trackAnalysis.trackIndex}: ${total.toFixed(1)}s → cut ${removed.toFixed(1)}s, kept ${kept.toFixed(1)}s.`,
    );
  }
  if (bundle.tracks.length > 1) {
    lines.push(
      'Each audio track was measured and cut on its own, so their lengths now differ.',
    );
  }
  lines.push(`Rebuilt ${applied.appended} of ${applied.requested} segments on "${timelineName}".`);
  lines.push(...applied.lines);

  emit({ step: 'done', message: 'Done.' });
  return {
    totalDurationSecs,
    speechDurationSecs,
    cutDurationSecs,
    timelineName,
    appended: applied.appended,
    requested: applied.requested,
    lines,
  };
}

// One-shot convenience used by the built-in "Auto-cut silences" list action:
// analyze then immediately apply with the request's default thresholds.
export async function runSilenceCutOnTimeline(
  opts: SilenceCutOptions,
  onProgress?: (p: SilenceCutProgress) => void,
): Promise<SilenceCutResult> {
  const bundle = await analyzeTimelineForSilence(opts, onProgress);
  const keepSpansByTrack = new Map(
    bundle.tracks.map((track) => [track.trackIndex, track.analysis.keep_spans]),
  );
  return applySilenceCut(
    bundle,
    keepSpansByTrack,
    {
      videoTrackIndexes: opts.videoTrackIndexes,
      audioTrackIndexes: opts.audioTrackIndexes,
      timelineNameSuffix: opts.timelineNameSuffix,
    },
    onProgress,
  );
}
