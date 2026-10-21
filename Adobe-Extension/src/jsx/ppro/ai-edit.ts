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

import { addEffects, addedEffects, addGraphics, addTransitions, applyKeyframes, applySpeed } from "./ai-edit-fx";
import { aiEditBuildStoryboard } from "./ai-edit-storyboard";
import {
  applyTransform,
  clipId,
  createRazor,
  eachClip,
  findClip,
  component,
  frameSeconds,
  locate,
  num,
  property,
  secondsToTime,
  setVolume,
  snapToFrame,
  trackAt,
} from "./ai-edit-util";
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

function mediaPathOf(clip: any): string {
  try {
    if (clip.projectItem && typeof clip.projectItem.getMediaPath === "function") {
      return String(clip.projectItem.getMediaPath() || "");
    }
  } catch (e) {}
  return "";
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
        try {
          var speed = Number(clip.getSpeed());
          if (speed > 0 && Math.abs(speed - 1) > 0.001) entry.speed = speed;
        } catch (e) {}
        var fx = addedEffects(clip);
        if (fx.length > 0) entry.effects = fx;
        try {
          if (clip.isSelected()) entry.selected = true;
        } catch (e) {}
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

  var width = 0;
  var height = 0;
  try {
    width = Number(seq.frameSizeHorizontal) || 0;
    height = Number(seq.frameSizeVertical) || 0;
  } catch (e) {}

  return JSON.stringify({
    success: true,
    name: String(seq.name || ""),
    fps: Math.round(fps * 1000) / 1000,
    width: width,
    height: height,
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

// args: { atSec: number[] }  Delete the markers at these times. The app
// picks them from the snapshot, so each sits exactly on a marker's start.
function deleteMarkers(seq: any, args: any): string {
  var wanted: number[] = args && args.atSec ? args.atSec : [];
  var tolerance = Math.max(frameSeconds(seq) / 2, 0.001);
  var doomed: any[] = [];
  var m = seq.markers.getFirstMarker();
  while (m) {
    var at = getTimeSeconds(m.start);
    for (var i = 0; i < wanted.length; i++) {
      if (Math.abs(Number(wanted[i]) - at) <= tolerance) {
        doomed[doomed.length] = m;
        break;
      }
    }
    m = seq.markers.getNextMarker(m);
  }
  // Delete after the walk: removing while iterating loses the next marker.
  var deleted = 0;
  var lines: string[] = [];
  for (var d = 0; d < doomed.length; d++) {
    try {
      seq.markers.deleteMarker(doomed[d]);
      deleted++;
    } catch (e: any) {
      lines[lines.length] = "Could not delete a marker: " + e;
    }
  }
  return JSON.stringify({ success: true, deleted: deleted, lines: lines });
}

// args: { ids, ...the update_clip fields }  The same change on every clip.
function updateClip(seq: any, args: any): string {
  var ids: string[] = args.ids || [];
  var updated: string[] = [];
  var lines: string[] = [];
  var done = 0;
  for (var i = 0; i < ids.length; i++) {
    var hit = locate(seq, String(ids[i]));
    if (!hit) {
      lines[lines.length] = "No clip with id " + ids[i] + " on the active sequence.";
      continue;
    }
    var mine: string[] = [];
    updateOne(seq, String(ids[i]), hit, args, mine, lines);
    for (var m = 0; m < mine.length; m++) {
      var seen = false;
      for (var u = 0; u < updated.length; u++) if (updated[u] === mine[m]) seen = true;
      if (!seen) updated[updated.length] = mine[m];
    }
    if (mine.length > 0) done++;
  }
  if (done === 0 && ids.length === 1 && lines.length > 0 && updated.length === 0) return fail(lines.join(" "));
  return JSON.stringify({ success: true, clips: done, updated: updated, lines: lines });
}

function updateOne(seq: any, id: string, hit: any, args: any, updated: string[], lines: string[]): void {
  var clip = hit.clip;
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

  // Speed changes the clip's length, so it goes before anything timed
  // against the clip (zoom keyframes, keyframes).
  applySpeed(hit, args, updated, lines);
  if (num(args.speed) || args.reverse) {
    var again = locate(seq, id);
    if (again) {
      hit = again;
      clip = again.clip;
    }
  }

  applyTransform(clip, args, updated, lines);

  if (num(args.opacity)) {
    var opacity = property(component(clip, "AE.ADBE Opacity"), "Opacity");
    if (opacity) {
      opacity.setValue(args.opacity, true);
      updated[updated.length] = "opacity";
    } else {
      lines[lines.length] = "This clip has no Opacity effect.";
    }
  }
  if (num(args.volume) && setVolume(clip, args.volume, lines)) updated[updated.length] = "volume";
  applyKeyframes(hit, args, updated, lines);
  if (typeof args.text === "string") lines[lines.length] = "Premiere: clip text cannot be edited by script; ignored.";
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

function trackName(kind: string, index: number): string {
  return kind + (index + 1);
}

/** Every track as { kind, index }. */
function allTracks(seq: any): any[] {
  var out: any[] = [];
  for (var v = 0; seq.videoTracks && v < seq.videoTracks.numTracks; v++) out[out.length] = { kind: "V", index: v };
  for (var a = 0; seq.audioTracks && a < seq.audioTracks.numTracks; a++) out[out.length] = { kind: "A", index: a };
  return out;
}

// args: { atSec, ids? }  Razor the tracks holding the listed clips (and the
// clips linked to them), or every track with a clip under atSec.
function splitClips(seq: any, args: any): string {
  var at = snapToFrame(seq, Number(args.atSec));
  var tolerance = Math.max(frameSeconds(seq) / 2, 0.001);
  var ids: string[] = args && args.ids ? args.ids : [];
  var tracks: any[] = [];
  var lines: string[] = [];
  if (ids.length > 0) {
    var seen: any = {};
    var add = function (kind: string, index: number) {
      var key = kind + index;
      if (!seen[key]) {
        seen[key] = true;
        tracks[tracks.length] = { kind: kind, index: index };
      }
    };
    for (var i = 0; i < ids.length; i++) {
      var hit = locate(seq, String(ids[i]));
      if (!hit) {
        lines[lines.length] = "No clip with id " + ids[i] + ".";
        continue;
      }
      add(hit.kind, hit.index);
      try {
        var linked = hit.clip.getLinkedItems ? hit.clip.getLinkedItems() : null;
        for (var l = 0; linked && l < linked.numItems; l++) {
          var other = locate(seq, String(linked[l].nodeId));
          if (other) add(other.kind, other.index);
        }
      } catch (e) {}
    }
  } else {
    tracks = allTracks(seq);
  }

  var razor = createRazor(seq);
  var split = 0;
  for (var t = 0; t < tracks.length; t++) {
    var track = trackAt(tracks[t].kind, tracks[t].index);
    var spanning = false;
    for (var c = 0; track && c < track.clips.numItems; c++) {
      var s = getTimeSeconds(track.clips[c].start);
      var e = getTimeSeconds(track.clips[c].end);
      if (s + tolerance < at && at < e - tolerance) spanning = true;
    }
    if (!spanning) continue;
    if (razor(tracks[t].kind, tracks[t].index, at)) split++;
    else lines[lines.length] = "Premiere did not cut " + trackName(tracks[t].kind, tracks[t].index) + ".";
  }
  if (split === 0 && lines.length === 0) return fail("No clip spans " + at + "s, so nothing was split.");
  return JSON.stringify({ success: true, split: split, lines: lines });
}

/**
 * Move every clip starting at or after `from` left by `dur`, earliest first,
 * so each lands in the gap the previous move (or the cut) left. A linked
 * partner may already have moved with its clip, so each one's position is
 * read again before moving it. Returns how many did not end up in place.
 */
function shiftLeft(seq: any, from: number, dur: number, tolerance: number, only?: any): number {
  var todo: any[] = [];
  eachClip(seq, function (clip, kind, t, c) {
    if (only && !only[kind + (t + 1)]) return;
    var s = getTimeSeconds(clip.start);
    if (s >= from - tolerance) todo[todo.length] = { id: clipId(clip, kind, t, c), want: s - dur, start: s };
  });
  todo.sort(function (a, b) {
    return a.start - b.start;
  });
  var stuck = 0;
  for (var i = 0; i < todo.length; i++) {
    var clip = findClip(app.project.activeSequence, todo[i].id);
    if (!clip) continue;
    var now = getTimeSeconds(clip.start);
    if (Math.abs(now - todo[i].want) > tolerance) {
      try {
        clip.move(secondsToTime(todo[i].want - now));
      } catch (e) {}
    }
  }
  for (var j = 0; j < todo.length; j++) {
    var moved = findClip(app.project.activeSequence, todo[j].id);
    if (moved && Math.abs(getTimeSeconds(moved.start) - todo[j].want) > tolerance) stuck++;
  }
  return stuck;
}

/** Drop markers inside [a, b) and move later ones left by b - a. */
function rippleMarkers(seq: any, a: number, b: number, tolerance: number): number {
  var removed = 0;
  try {
    var all: any[] = [];
    var m = seq.markers.getFirstMarker();
    while (m) {
      all[all.length] = m;
      m = seq.markers.getNextMarker(m);
    }
    for (var i = 0; i < all.length; i++) {
      var at = getTimeSeconds(all[i].start);
      if (at >= a - tolerance && at < b - tolerance) {
        seq.markers.deleteMarker(all[i]);
        removed++;
      } else if (at >= b - tolerance) {
        var end = getTimeSeconds(all[i].end);
        all[i].start = secondsToTime(at - (b - a));
        if (end > at) all[i].end = secondsToTime(end - (b - a));
      }
    }
  } catch (e) {}
  return removed;
}

// args: { ranges: [{ start, end }] (sorted, disjoint), ripple?, tracks? }
// Cut the spans out of every track (or only `tracks`, labelled "V1", "A2"
// like get_timeline), last span first so earlier times stay valid.
function removeRanges(seq: any, args: any): string {
  var ranges: any[] = args && args.ranges ? args.ranges : [];
  var ripple = Boolean(args && args.ripple);
  var only: any = null;
  if (args && args.tracks && args.tracks.length > 0) {
    only = {};
    for (var o = 0; o < args.tracks.length; o++) only[String(args.tracks[o]).toUpperCase()] = true;
  }
  var wanted = function (kind: string, t: number): boolean {
    return !only || only[kind + (t + 1)] === true;
  };
  var tolerance = Math.max(frameSeconds(seq) / 2, 0.001);
  var razor = createRazor(seq);
  var lines: string[] = [];
  var cut = 0;
  var deleted = 0;
  var markersRemoved = 0;
  var stuck = 0;

  for (var r = ranges.length - 1; r >= 0; r--) {
    var a = snapToFrame(seq, Number(ranges[r].start));
    var b = snapToFrame(seq, Number(ranges[r].end));
    if (!(b - a > tolerance)) continue;
    var tracks = allTracks(app.project.activeSequence);
    for (var t = 0; t < tracks.length; t++) {
      if (!wanted(tracks[t].kind, tracks[t].index)) continue;
      if (razor(tracks[t].kind, tracks[t].index, a)) cut++;
      if (razor(tracks[t].kind, tracks[t].index, b)) cut++;
    }
    var inside: any[] = [];
    eachClip(app.project.activeSequence, function (clip, kind, ti) {
      if (!wanted(kind, ti)) return;
      var s = getTimeSeconds(clip.start);
      var e = getTimeSeconds(clip.end);
      if (s >= a - tolerance && e <= b + tolerance) inside[inside.length] = clip;
    });
    for (var i = 0; i < inside.length; i++) {
      try {
        inside[i].remove(false, true);
        deleted++;
      } catch (e) {}
    }
    var straddling = 0;
    eachClip(app.project.activeSequence, function (clip, kind, ti) {
      if (!wanted(kind, ti)) return;
      var s = getTimeSeconds(clip.start);
      var e = getTimeSeconds(clip.end);
      if (s < b - tolerance && e > a + tolerance) straddling++;
    });
    if (straddling > 0) {
      lines[lines.length] = straddling + " clip(s) could not be cut at " + a + "-" + b + "s and were left in place.";
      continue;
    }
    if (ripple) {
      stuck += shiftLeft(app.project.activeSequence, b, b - a, tolerance, only);
      // Markers belong to the whole sequence: they follow only a cut on
      // every track.
      if (!only) markersRemoved += rippleMarkers(app.project.activeSequence, a, b, tolerance);
    }
  }
  if (stuck > 0) lines[lines.length] = stuck + " clip move(s) did not land where expected; check the sequence.";
  return JSON.stringify({
    success: true,
    cut: cut,
    deleted: deleted,
    markersRemoved: markersRemoved,
    lines: lines,
  });
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
      case "DeleteMarkers":
        return deleteMarkers(seq, args);
      case "ImportCaptions":
        return importSRTFile(String(args.filePath || ""));
      case "UpdateClip":
        return updateClip(seq, args);
      case "DeleteClips":
        return deleteClips(seq, args);
      case "SplitClips":
        return splitClips(seq, args);
      case "RemoveRanges":
        return removeRanges(seq, args);
      case "AddEffects":
        return addEffects(seq, args);
      case "AddTransitions":
        return addTransitions(seq, args);
      case "AddGraphics":
        return addGraphics(seq, args);
      default:
        return fail("Invalid function name");
    }
  } catch (e: any) {
    return fail(String(e));
  }
}
