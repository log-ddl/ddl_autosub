// ==============================================================================
// AI EDIT: SHARED HELPERS
// ==============================================================================
//
// Clip lookup, transforms and razor cuts used by both ai-edit.ts and
// ai-edit-storyboard.ts. Times are seconds from the start of the sequence;
// clip ids are TrackItem nodeIds.

import { getSequenceStartSeconds, getTimeSeconds, TICKS_PER_SECOND } from "./ppro";

export function num(v: any): boolean {
  return typeof v === "number" && !isNaN(v);
}

export function secondsToTime(secs: number): any {
  // @ts-ignore - Time is an ExtendScript global provided by the host.
  var t = new Time();
  t.ticks = String(Math.round(secs * TICKS_PER_SECOND));
  return t;
}

export function clipId(clip: any, kind: string, t: number, c: number): string {
  try {
    if (clip.nodeId) return String(clip.nodeId);
  } catch (e) {}
  return kind + (t + 1) + "_" + c;
}

/** Every clip on the sequence, with the track it sits on. */
export function eachClip(
  seq: any,
  fn: (clip: any, kind: string, t: number, c: number, track: any) => void,
): void {
  var kinds = [
    { kind: "V", tracks: seq.videoTracks },
    { kind: "A", tracks: seq.audioTracks },
  ];
  for (var k = 0; k < kinds.length; k++) {
    var tracks = kinds[k].tracks;
    if (!tracks) continue;
    for (var t = 0; t < tracks.numTracks; t++) {
      var track = tracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        fn(track.clips[c], kinds[k].kind, t, c, track);
      }
    }
  }
}

export function findClip(seq: any, id: string): any {
  var found: any = null;
  eachClip(seq, function (clip, kind, t, c) {
    if (!found && clipId(clip, kind, t, c) === id) found = clip;
  });
  return found;
}

/** The Motion / Opacity component of a clip, by its locale-independent matchName. */
export function component(clip: any, matchName: string): any {
  if (!clip || !clip.components) return null;
  for (var i = 0; i < clip.components.numItems; i++) {
    var comp = clip.components[i];
    if (comp && comp.matchName === matchName) return comp;
  }
  return null;
}

export function property(comp: any, displayName: string): any {
  if (!comp || !comp.properties) return null;
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i];
    if (p && p.displayName === displayName) return p;
  }
  return null;
}

/** Set a property now, or animate it from `from` to `to` across the clip. */
export function setAnimated(prop: any, clip: any, from: any, to: any): void {
  if (to === undefined || to === null) {
    if (prop.isTimeVarying && prop.isTimeVarying()) prop.setTimeVarying(false);
    prop.setValue(from, true);
    return;
  }
  // Keyframe times are in the clip's source time, so they run from its in-point.
  var inSec = getTimeSeconds(clip.inPoint);
  var outSec = inSec + (getTimeSeconds(clip.end) - getTimeSeconds(clip.start));
  prop.setTimeVarying(true);
  var t0 = secondsToTime(inSec);
  var t1 = secondsToTime(outSec);
  prop.addKey(t0);
  prop.addKey(t1);
  prop.setValueAtKey(t0, from, true);
  prop.setValueAtKey(t1, to, true);
  // Ease in and out rather than Premiere's default linear. Set after the
  // values: setting it first has been reported to leave the curve flat.
  try {
    prop.setInterpolationTypeAtKey(t0, KF_INTERP_BEZIER, true);
    prop.setInterpolationTypeAtKey(t1, KF_INTERP_BEZIER, true);
  } catch (e) {}
}

/** Keyframe interpolation value for Bezier (the PProPanel sample's KF_Interp_Mode_Bezier). */
var KF_INTERP_BEZIER = 5;

/**
 * Apply zoom / pan / rotation (and their *End keyframes) to a video clip.
 * `args` uses the tool's field names. Pushes what changed onto `updated` and
 * what could not be done onto `lines`.
 */
export function applyTransform(clip: any, args: any, updated: string[], lines: string[]): void {
  var wantsMotion = num(args.zoom) || num(args.panX) || num(args.panY) || num(args.rotation);
  if (!wantsMotion) return;
  var motion = component(clip, "AE.ADBE Motion");
  if (!motion) {
    lines[lines.length] = "This clip has no Motion effect (audio clip?).";
    return;
  }
  var scale = property(motion, "Scale");
  if (scale && num(args.zoom)) {
    setAnimated(scale, clip, args.zoom * 100, num(args.zoomEnd) ? args.zoomEnd * 100 : null);
    updated[updated.length] = num(args.zoomEnd) ? "zoom keyframes" : "zoom";
  }
  var pos = property(motion, "Position");
  if (pos && (num(args.panX) || num(args.panY))) {
    // Position is normalised (0.5, 0.5 = centre). panX/panY are offsets in
    // a -1..1 range, where +1 moves half a frame right/up.
    var px = num(args.panX) ? args.panX : 0;
    var py = num(args.panY) ? args.panY : 0;
    var from = [0.5 + px / 2, 0.5 - py / 2];
    var hasEnd = num(args.panXEnd) || num(args.panYEnd);
    var to = hasEnd
      ? [0.5 + (num(args.panXEnd) ? args.panXEnd : px) / 2, 0.5 - (num(args.panYEnd) ? args.panYEnd : py) / 2]
      : null;
    setAnimated(pos, clip, from, to);
    updated[updated.length] = hasEnd ? "pan keyframes" : "pan";
  }
  var rot = property(motion, "Rotation");
  if (rot && num(args.rotation)) {
    setAnimated(rot, clip, args.rotation, null);
    updated[updated.length] = "rotation";
  }
}

/**
 * Premiere stores clip volume as Level = gain * 10^(-15/20): 0 dB reads
 * 0.1778. `gain` is linear (1.0 = unchanged, 0.5 = about -6 dB).
 */
var LEVEL_AT_0DB = 0.17782794100389;

/** The Volume > Level property of an audio clip, found by property name. */
function levelProperty(clip: any): any {
  if (!clip || !clip.components) return null;
  for (var i = 0; i < clip.components.numItems; i++) {
    var level = property(clip.components[i], "Level");
    if (level) return level;
  }
  return null;
}

/** Set the volume of an audio clip, or of the audio linked to a video clip. */
export function setVolume(clip: any, gain: number, lines: string[]): boolean {
  var targets: any[] = [];
  if (levelProperty(clip)) targets[targets.length] = clip;
  try {
    var linked = clip.getLinkedItems ? clip.getLinkedItems() : null;
    for (var i = 0; linked && i < linked.numItems; i++) {
      if (levelProperty(linked[i])) targets[targets.length] = linked[i];
    }
  } catch (e) {}
  if (targets.length === 0) {
    lines[lines.length] = "This clip has no audio volume to change.";
    return false;
  }
  for (var t = 0; t < targets.length; t++) {
    var level = levelProperty(targets[t]);
    if (level.isTimeVarying && level.isTimeVarying()) level.setTimeVarying(false);
    level.setValue(Math.max(0, gain) * LEVEL_AT_0DB, true);
  }
  return true;
}

// ------------------------------------------------------------------------------
// Razor cuts (QE DOM)
// ------------------------------------------------------------------------------

/** Seconds of one frame of the sequence, or 0 when it will not say. */
export function frameSeconds(seq: any): number {
  try {
    var tb = parseFloat(seq.timebase);
    if (tb > 0) return tb / TICKS_PER_SECOND;
  } catch (e) {}
  return 0;
}

/** Snap seconds to the sequence's frame grid. */
export function snapToFrame(seq: any, secs: number): number {
  var f = frameSeconds(seq);
  return f > 0 ? Math.round(secs / f) * f : secs;
}

export function timecodeAt(seq: any, secs: number): string {
  var t = secondsToTime(secs);
  var settings = seq.getSettings();
  return t.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
}

/** A track by kind and 0-based index, re-read so it is never stale. */
export function trackAt(kind: string, index: number): any {
  var seq = app.project.activeSequence;
  var list = kind === "V" ? seq.videoTracks : seq.audioTracks;
  return list && index < list.numTracks ? list[index] : null;
}

/** The clip on `track` that spans `secs` strictly inside it, or null. */
export function clipSpanning(track: any, secs: number, tolerance: number): any {
  if (!track || !track.clips) return null;
  for (var c = 0; c < track.clips.numItems; c++) {
    var clip = track.clips[c];
    var s = getTimeSeconds(clip.start);
    var e = getTimeSeconds(clip.end);
    if (s + tolerance < secs && secs < e - tolerance) return clip;
  }
  return null;
}

function hasEdgeAt(track: any, secs: number, tolerance: number): boolean {
  for (var c = 0; track && c < track.clips.numItems; c++) {
    if (Math.abs(getTimeSeconds(track.clips[c].start) - secs) <= tolerance) return true;
  }
  return false;
}

/**
 * Razor cuts on the QE DOM. Whether QE's timecodes count the sequence's
 * zero point is not documented, so the first cut tries without it, then
 * with it, and checks that a clip edge appeared where it was asked for; the
 * answer is kept for the rest of the request. A cut in the wrong place is
 * only a through-edit: playback does not change.
 */
export function createRazor(seq: any): (kind: string, index: number, secs: number) => boolean {
  app.enableQE();
  // @ts-ignore - qe is the QE DOM global, enabled above.
  var qeSeq: any = qe.project.getActiveSequence();
  var zero = getSequenceStartSeconds(seq);
  var tolerance = Math.max(frameSeconds(seq) / 2, 0.001);
  var mode = zero > 0 ? -1 : 0;
  return function (kind: string, index: number, secs: number): boolean {
    if (!qeSeq) return false;
    if (!clipSpanning(trackAt(kind, index), secs, tolerance)) return false;
    var qeTrack = kind === "V" ? qeSeq.getVideoTrackAt(index) : qeSeq.getAudioTrackAt(index);
    if (!qeTrack) return false;
    var tries = mode >= 0 ? [mode] : [0, 1];
    for (var i = 0; i < tries.length; i++) {
      try {
        qeTrack.razor(timecodeAt(seq, secs + (tries[i] === 1 ? zero : 0)));
      } catch (e) {}
      if (hasEdgeAt(trackAt(kind, index), secs, tolerance)) {
        mode = tries[i];
        return true;
      }
    }
    return false;
  };
}

// ------------------------------------------------------------------------------
// Clip lookup with its track, QE items and effect names
// ------------------------------------------------------------------------------

/** The clip with this id, its track kind ("V"/"A") and 0-based track index, or null. */
export function locate(seq: any, id: string): any {
  var found: any = null;
  eachClip(seq, function (clip, kind, t, c, track) {
    if (!found && clipId(clip, kind, t, c) === id) found = { clip: clip, kind: kind, index: t, track: track };
  });
  return found;
}

/**
 * The QE item of a DOM clip. QE tracks also list gaps and transitions, so
 * the DOM clip index points at the wrong item once anything precedes it;
 * match on the start time instead.
 */
export function qeClipFor(kind: string, index: number, clip: any): any {
  app.enableQE();
  // @ts-ignore - qe is the QE DOM global, enabled above.
  var qeSeq: any = qe.project.getActiveSequence();
  if (!qeSeq) return null;
  var qeTrack = kind === "V" ? qeSeq.getVideoTrackAt(index) : qeSeq.getAudioTrackAt(index);
  if (!qeTrack) return null;
  var want = String(clip.start.ticks);
  var best: any = null;
  var bestDelta = -1;
  for (var i = 0; i < qeTrack.numItems; i++) {
    var item = qeTrack.getItemAt(i);
    if (!item) continue;
    try {
      if (String(item.type) !== "Clip") continue;
    } catch (e) {
      continue;
    }
    var ticks = "";
    try {
      ticks = String(item.start.ticks);
    } catch (e) {}
    if (ticks === want) return item;
    var delta = Math.abs(parseFloat(ticks) - parseFloat(want));
    if (!isNaN(delta) && (bestDelta < 0 || delta < bestDelta)) {
      best = item;
      bestDelta = delta;
    }
  }
  return best;
}

/** Lower case without spaces, dashes or underscores, for forgiving name matches. */
export function foldName(s: any): string {
  var text = String(s || "").toLowerCase();
  var out = "";
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (ch !== " " && ch !== "-" && ch !== "_" && ch !== "/" && ch !== ".") out += ch;
  }
  return out;
}

var QE_GETTERS: any = {
  videoEffect: ["getVideoEffectByName", "getVideoEffectList"],
  audioEffect: ["getAudioEffectByName", "getAudioEffectList"],
  videoTransition: ["getVideoTransitionByName", "getVideoTransitionList"],
  audioTransition: ["getAudioTransitionByName", "getAudioTransitionList"],
};

/** Every name Premiere lists for a kind ("videoEffect", "audioTransition", ...). */
export function qeNames(kind: string): string[] {
  app.enableQE();
  var out: string[] = [];
  try {
    // @ts-ignore - qe is the QE DOM global, enabled above.
    var list = qe.project[QE_GETTERS[kind][1]]();
    for (var i = 0; list && i < list.length; i++) out[out.length] = String(list[i]);
  } catch (e) {}
  return out;
}

/** A QE effect or transition by name, matched loosely when the exact name misses. */
export function qeNamed(kind: string, name: string): any {
  app.enableQE();
  var getter = QE_GETTERS[kind][0];
  try {
    // @ts-ignore - qe is the QE DOM global, enabled above.
    var direct = qe.project[getter](name);
    if (direct) return direct;
  } catch (e) {}
  var names = qeNames(kind);
  for (var i = 0; i < names.length; i++) {
    if (foldName(names[i]) === foldName(name)) {
      try {
        // @ts-ignore
        return qe.project[getter](names[i]);
      } catch (e) {}
    }
  }
  return null;
}

/** Up to `max` of `names` that contain `wanted` or one of its words, for "did you mean". */
export function closeNames(names: string[], wanted: string, max: number): string[] {
  var w = foldName(wanted);
  var words = String(wanted || "").toLowerCase().split(" ");
  var out: string[] = [];
  for (var i = 0; i < names.length && out.length < max; i++) {
    var n = foldName(names[i]);
    var hit = n.indexOf(w) >= 0 || (n.length > 2 && w.indexOf(n) >= 0);
    for (var k = 0; !hit && k < words.length; k++) {
      if (words[k].length > 2 && names[i].toLowerCase().indexOf(words[k]) >= 0) hit = true;
    }
    if (hit) out[out.length] = names[i];
  }
  return out;
}

/** First video track at or above `minIndex` free over [start, end), adding one when all are taken. -1 if none. */
export function freeVideoTrack(minIndex: number, start: number, end: number): number {
  var seq = app.project.activeSequence;
  for (var t = minIndex; t < seq.videoTracks.numTracks; t++) {
    var busy = false;
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems && !busy; c++) {
      var s = getTimeSeconds(track.clips[c].start);
      var e = getTimeSeconds(track.clips[c].end);
      if (s < end - 0.001 && e > start + 0.001) busy = true;
    }
    if (!busy) return t;
  }
  // Every track from minIndex up is busy (or missing): add tracks on top
  // until there is one at minIndex or above.
  try {
    app.enableQE();
    // @ts-ignore - qe is the QE DOM global, enabled above.
    var qeSeq: any = qe.project.getActiveSequence();
    for (var guard = 0; guard < 8; guard++) {
      var n = app.project.activeSequence.videoTracks.numTracks;
      qeSeq.addTracks(1, n, 0);
      var now = app.project.activeSequence.videoTracks.numTracks;
      if (now === n) return -1;
      if (now - 1 >= minIndex) return now - 1;
    }
  } catch (e) {}
  return -1;
}
