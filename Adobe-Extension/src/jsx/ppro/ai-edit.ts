// ==============================================================================
// AI EDIT
// ==============================================================================
//
// Timeline edits for the app's AI Edit tab. Everything arrives through one
// entry point, `aiEdit(requestJson)`, so the panel's allowlist stays at a
// single function: { func: "<Name>", args: {...} } in, a JSON string out
// ({ success: true, ... } or { success: false, error }).
//
// Times are seconds from the start of the sequence. Clip ids are TrackItem
// nodeIds, which stay stable while the project is open.

import { aiEditBuildStoryboard } from "./ai-edit-storyboard";
import {
  getSequenceStartSeconds,
  getTimeSeconds,
  importSRTFile,
  TICKS_PER_SECOND,
} from "./ppro";

// Premiere's marker colour indices (Marker.setColorByIndex).
var MARKER_COLORS = ["Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan"];

function fail(error: string): string {
  return JSON.stringify({ success: false, error: error });
}

function secondsToTime(secs: number): any {
  // @ts-ignore - Time is an ExtendScript global provided by the host.
  var t = new Time();
  t.ticks = String(Math.round(secs * TICKS_PER_SECOND));
  return t;
}

function clipId(clip: any, kind: string, t: number, c: number): string {
  try {
    if (clip.nodeId) return String(clip.nodeId);
  } catch (e) {}
  return kind + (t + 1) + "_" + c;
}

function mediaPathOf(clip: any): string {
  try {
    if (clip.projectItem && typeof clip.projectItem.getMediaPath === "function") {
      return String(clip.projectItem.getMediaPath() || "");
    }
  } catch (e) {}
  return "";
}

/** The Motion / Opacity component of a clip, by its locale-independent matchName. */
function component(clip: any, matchName: string): any {
  if (!clip || !clip.components) return null;
  for (var i = 0; i < clip.components.numItems; i++) {
    var comp = clip.components[i];
    if (comp && comp.matchName === matchName) return comp;
  }
  return null;
}

function property(comp: any, displayName: string): any {
  if (!comp || !comp.properties) return null;
  for (var i = 0; i < comp.properties.numItems; i++) {
    var p = comp.properties[i];
    if (p && p.displayName === displayName) return p;
  }
  return null;
}

function scaleOf(clip: any): number | null {
  try {
    var scale = property(component(clip, "AE.ADBE Motion"), "Scale");
    if (scale) {
      var v = parseFloat(scale.getValue());
      if (!isNaN(v)) return v / 100;
    }
  } catch (e) {}
  return null;
}

/** Every clip on the sequence, with the track it sits on. */
function eachClip(seq: any, fn: (clip: any, kind: string, t: number, c: number, track: any) => void): void {
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

function findClip(seq: any, id: string): any {
  var found: any = null;
  eachClip(seq, function (clip, kind, t, c) {
    if (!found && clipId(clip, kind, t, c) === id) found = clip;
  });
  return found;
}

function getTimelineSnapshot(seq: any): string {
  var tracks: any[] = [];
  var kinds = [
    { kind: "V", type: "video", list: seq.videoTracks },
    { kind: "A", type: "audio", list: seq.audioTracks },
  ];
  for (var k = 0; k < kinds.length; k++) {
    var list = kinds[k].list;
    if (!list) continue;
    for (var t = 0; t < list.numTracks; t++) {
      var track = list[t];
      var clips: any[] = [];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var start = getTimeSeconds(clip.start);
        var entry: any = {
          id: clipId(clip, kinds[k].kind, t, c),
          name: String(clip.name || ""),
          startSec: start,
          durationSec: getTimeSeconds(clip.end) - start,
          path: mediaPathOf(clip),
        };
        if (kinds[k].kind === "V") {
          var zoom = scaleOf(clip);
          if (zoom !== null) entry.zoom = zoom;
        }
        clips[clips.length] = entry;
      }
      tracks[tracks.length] = {
        trackType: kinds[k].type,
        index: t + 1,
        name: String(track.name || ""),
        clips: clips,
      };
    }
  }

  var markers: any[] = [];
  try {
    var m = seq.markers.getFirstMarker();
    while (m) {
      var at = getTimeSeconds(m.start);
      var color = "";
      try {
        color = MARKER_COLORS[m.getColorByIndex()] || "";
      } catch (e) {}
      markers[markers.length] = {
        atSec: at,
        color: color,
        name: String(m.name || ""),
        durationSec: Math.max(0, getTimeSeconds(m.end) - at),
      };
      m = seq.markers.getNextMarker(m);
    }
  } catch (e) {}

  var fps = 0;
  try {
    var tb = parseFloat(seq.timebase);
    if (tb > 0) fps = TICKS_PER_SECOND / tb;
  } catch (e) {}

  return JSON.stringify({
    success: true,
    name: String(seq.name || ""),
    fps: Math.round(fps * 1000) / 1000,
    durationSec: Math.max(0, getTimeSeconds(seq.end) - getSequenceStartSeconds(seq)),
    tracks: tracks,
    markers: markers,
  });
}

function addMarkers(seq: any, args: any): string {
  var list: any[] = args && args.markers ? args.markers : [];
  var lines: string[] = [];
  var added = 0;
  for (var i = 0; i < list.length; i++) {
    var spec = list[i];
    if (!spec || !(spec.atSec >= 0)) {
      lines[lines.length] = "Skipped marker " + (i + 1) + ": invalid time.";
      continue;
    }
    try {
      var marker = seq.markers.createMarker(spec.atSec);
      if (spec.name) marker.name = String(spec.name);
      if (spec.note) marker.comments = String(spec.note);
      if (spec.durationSec > 0) marker.end = secondsToTime(spec.atSec + spec.durationSec);
      var colorIndex = -1;
      for (var c = 0; c < MARKER_COLORS.length; c++) {
        if (spec.color && MARKER_COLORS[c].toLowerCase() === String(spec.color).toLowerCase()) colorIndex = c;
      }
      if (colorIndex >= 0) marker.setColorByIndex(colorIndex);
      else if (spec.color) lines[lines.length] = "Unknown color '" + spec.color + "', kept the default.";
      added++;
    } catch (e: any) {
      lines[lines.length] = "Marker at " + spec.atSec + "s failed: " + e;
    }
  }
  return JSON.stringify({ success: true, added: added, lines: lines });
}

/** Set a property now, or animate it from `from` to `to` across the clip. */
function setAnimated(prop: any, clip: any, from: any, to: any): void {
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
}

function num(v: any): boolean {
  return typeof v === "number" && !isNaN(v);
}

function updateClip(seq: any, args: any): string {
  var clip = findClip(seq, String(args.segmentId || ""));
  if (!clip) return fail("No clip with id " + args.segmentId + " on the active sequence.");
  var updated: string[] = [];
  var lines: string[] = [];

  if (num(args.startSec)) {
    try {
      var shift = args.startSec - getTimeSeconds(clip.start);
      clip.move(secondsToTime(shift));
      updated[updated.length] = "start";
    } catch (e: any) {
      lines[lines.length] = "Could not move the clip: " + e;
    }
  }
  if (num(args.durationSec) && args.durationSec > 0) {
    try {
      clip.end = secondsToTime(getTimeSeconds(clip.start) + args.durationSec);
      updated[updated.length] = "duration";
    } catch (e: any) {
      lines[lines.length] = "Could not change the duration: " + e;
    }
  }

  var motion = component(clip, "AE.ADBE Motion");
  var wantsMotion = num(args.zoom) || num(args.panX) || num(args.panY) || num(args.rotation);
  if (wantsMotion && !motion) lines[lines.length] = "This clip has no Motion effect (audio clip?).";
  if (motion) {
    var scale = property(motion, "Scale");
    if (scale && num(args.zoom)) {
      setAnimated(scale, clip, args.zoom * 100, num(args.zoomEnd) ? args.zoomEnd * 100 : null);
      updated[updated.length] = num(args.zoomEnd) ? "zoom keyframes" : "zoom";
    }
    var pos = property(motion, "Position");
    if (pos && (num(args.panX) || num(args.panY))) {
      // Position is normalised (0.5, 0.5 = centre). panX/panY are offsets in
      // the same -1..1 range CapCut uses, where +1 moves half a frame right/up.
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

  if (num(args.opacity)) {
    var opacity = property(component(clip, "AE.ADBE Opacity"), "Opacity");
    if (opacity) {
      opacity.setValue(args.opacity, true);
      updated[updated.length] = "opacity";
    } else {
      lines[lines.length] = "This clip has no Opacity effect.";
    }
  }
  if (num(args.volume)) lines[lines.length] = "Premiere: volume is not supported and was ignored.";
  if (typeof args.text === "string") lines[lines.length] = "Premiere: clip text cannot be edited by script; ignored.";

  return JSON.stringify({ success: true, updated: updated, lines: lines });
}

function deleteClips(seq: any, args: any): string {
  var ids: string[] = args && args.ids ? args.ids : [];
  var ripple = Boolean(args && args.ripple);
  var deleted = 0;
  var missing = 0;
  for (var i = 0; i < ids.length; i++) {
    var clip = findClip(seq, String(ids[i]));
    if (!clip) {
      missing++;
      continue;
    }
    clip.remove(ripple, true);
    deleted++;
  }
  return JSON.stringify({ success: true, deleted: deleted, missing: missing });
}

/**
 * Single entry point for the AI Edit tab. `requestJson` is
 * { func, args }; non-ASCII must arrive \u-escaped (see useWebSocket.ts).
 */
export function aiEdit(requestJson: string): string {
  try {
    var req: any;
    try {
      req = JSON.parse(requestJson);
    } catch (parseErr: any) {
      return fail("Bad request: " + parseErr);
    }
    if (!app.project) return fail("No project open in Premiere Pro.");
    var seq = app.project.activeSequence;
    if (!seq) return fail("No active sequence in Premiere Pro.");
    var args = req && req.args ? req.args : {};

    switch (req && req.func) {
      case "GetTimelineSnapshot":
        return getTimelineSnapshot(seq);
      case "BuildStoryboard":
        return aiEditBuildStoryboard(args);
      case "AddMarkers":
        return addMarkers(seq, args);
      case "ImportCaptions":
        return importSRTFile(String(args.filePath || ""));
      case "UpdateClip":
        return updateClip(seq, args);
      case "DeleteClips":
        return deleteClips(seq, args);
      default:
        return fail("Invalid function name");
    }
  } catch (e: any) {
    return fail(String(e));
  }
}
