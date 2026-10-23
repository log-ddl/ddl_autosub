// ==============================================================================
// AI EDIT: EFFECTS, TRANSITIONS, SPEED, KEYFRAMES AND GRAPHICS
// ==============================================================================
//
// The app picks the clips and edit points (actions.rs), so everything here
// works on clip ids it is handed. Effects, transitions and speed go through
// the QE DOM, which has no other way in; parameters and keyframes through the
// regular DOM. Each edit reports what it could not do, in `lines`.

import {
  closeNames,
  foldName,
  freeVideoTrack,
  locate,
  num,
  qeClipFor,
  qeNamed,
  qeNames,
  secondsToTime,
} from "./ai-edit-util";
import { getTimeSeconds, TICKS_PER_SECOND } from "./ppro";

/** Components every clip has; they are not effects someone added. */
var BUILT_IN: any = {
  motion: true,
  opacity: true,
  timeremapping: true,
  volume: true,
  channelvolume: true,
  panner: true,
  vectormotion: true,
};

/** Names of the effects added to a clip, for the snapshot. */
export function addedEffects(clip: any): string[] {
  var out: string[] = [];
  try {
    for (var i = 0; i < clip.components.numItems; i++) {
      var name = String(clip.components[i].displayName || "");
      if (name && !BUILT_IN[foldName(name)]) out[out.length] = name;
    }
  } catch (e) {}
  return out;
}

/** Push `line` once. */
function note(lines: string[], line: string): void {
  for (var i = 0; i < lines.length; i++) if (lines[i] === line) return;
  lines[lines.length] = line;
}

function names(props: any): string[] {
  var out: string[] = [];
  for (var i = 0; props && i < props.numItems; i++) out[out.length] = String(props[i].displayName);
  return out;
}

/** A property of `comp` by its display name, matched loosely. */
function findProperty(comp: any, name: string): any {
  if (!comp || !comp.properties) return null;
  for (var i = 0; i < comp.properties.numItems; i++) {
    if (foldName(comp.properties[i].displayName) === foldName(name)) return comp.properties[i];
  }
  return null;
}

/** The last component of `clip` named `name`: the one just added when it has several. */
function lastComponent(clip: any, name: string): any {
  var found: any = null;
  for (var i = 0; clip && clip.components && i < clip.components.numItems; i++) {
    var c = clip.components[i];
    if (foldName(c.displayName) === foldName(name) || foldName(c.matchName) === foldName(name)) found = c;
  }
  return found;
}

/** ExtendScript's setValue wants numbers for sliders and booleans for checkboxes. */
function coerce(value: any): any {
  if (typeof value === "string" && value !== "" && !isNaN(Number(value))) return Number(value);
  return value;
}

// args: { ids, effects: [{ name, params }] }
export function addEffects(seq: any, args: any): string {
  var ids: string[] = args.ids || [];
  var effects: any[] = args.effects || [];
  var lines: string[] = [];
  var done = 0;
  // Look each effect up once per kind.
  var cache: any = {};
  var lookup = function (kind: string, name: string): any {
    var key = kind + "|" + name;
    if (cache[key] === undefined) cache[key] = qeNamed(kind === "V" ? "videoEffect" : "audioEffect", name) || null;
    return cache[key];
  };

  for (var i = 0; i < ids.length; i++) {
    var hit = locate(seq, String(ids[i]));
    if (!hit) {
      note(lines, "No clip with id " + ids[i] + ".");
      continue;
    }
    var applied = 0;
    for (var e = 0; e < effects.length; e++) {
      var name = String(effects[e].name);
      var fx = lookup(hit.kind, name);
      if (!fx) {
        var other = lookup(hit.kind === "V" ? "A" : "V", name);
        if (other) {
          note(lines, name + " is " + (hit.kind === "V" ? "an audio" : "a video") + " effect; skipped the " +
            (hit.kind === "V" ? "video" : "audio") + " clips.");
        } else {
          var close = closeNames(qeNames("videoEffect").concat(qeNames("audioEffect")), name, 8);
          note(lines, "No effect named \"" + name + "\"." + (close.length ? " Close: " + close.join(", ") + "." : ""));
        }
        continue;
      }
      var qeClip = qeClipFor(hit.kind, hit.index, hit.clip);
      if (!qeClip) {
        note(lines, "Premiere did not find clip " + ids[i] + " through the QE DOM.");
        continue;
      }
      try {
        if (hit.kind === "V") qeClip.addVideoEffect(fx);
        else qeClip.addAudioEffect(fx);
      } catch (err: any) {
        note(lines, "Could not add " + name + " to " + ids[i] + ": " + err);
        continue;
      }
      applied++;
      setParams(locate(seq, String(ids[i])), name, effects[e].params, lines);
    }
    if (applied > 0) done++;
  }
  return JSON.stringify({ success: true, clips: done, lines: lines });
}

function setParams(hit: any, effect: string, params: any, lines: string[]): void {
  if (!hit || !params) return;
  var comp = lastComponent(hit.clip, effect);
  if (!comp) {
    // Added, but under a name other than the one asked for.
    var comps = hit.clip.components;
    if (comps && comps.numItems > 0) comp = comps[comps.numItems - 1];
  }
  for (var key in params) {
    if (!params.hasOwnProperty(key)) continue;
    var prop = findProperty(comp, key);
    if (!prop) {
      note(lines, effect + " has no \"" + key + "\". It has: " + names(comp && comp.properties).join(", ") + ".");
      continue;
    }
    try {
      if (prop.isTimeVarying && prop.isTimeVarying()) prop.setTimeVarying(false);
      prop.setValue(coerce(params[key]), true);
    } catch (err: any) {
      note(lines, "Could not set " + effect + " " + key + ": " + err);
    }
  }
}

// ------------------------------------------------------------------------------
// Transitions
// ------------------------------------------------------------------------------

function transitionCount(track: any): number {
  try {
    return track.transitions ? track.transitions.numItems : -1;
  } catch (e) {
    return -1;
  }
}

// args: { points: [{ id, atEnd, atSec, track }], transition, audioTransition, durationSec }
export function addTransitions(seq: any, args: any): string {
  var points: any[] = args.points || [];
  var lines: string[] = [];
  var fps = 0;
  try {
    var tb = parseFloat(seq.timebase);
    if (tb > 0) fps = TICKS_PER_SECOND / tb;
  } catch (e) {}
  var frames = Math.max(1, Math.round(Number(args.durationSec) * (fps || 30)));
  var video = qeNamed("videoTransition", String(args.transition));
  var audio = qeNamed("audioTransition", String(args.audioTransition));
  var added = 0;
  var unconfirmed = 0;

  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var hit = locate(seq, String(p.id));
    if (!hit) {
      note(lines, "No clip with id " + p.id + ".");
      continue;
    }
    var tr = hit.kind === "V" ? video : audio;
    if (!tr) {
      var kind = hit.kind === "V" ? "videoTransition" : "audioTransition";
      var wanted = String(hit.kind === "V" ? args.transition : args.audioTransition);
      var close = closeNames(qeNames(kind), wanted, 8);
      note(lines, "No " + (hit.kind === "V" ? "video" : "audio") + " transition named \"" + wanted + "\"." +
        (close.length ? " Close: " + close.join(", ") + "." : ""));
      continue;
    }
    var qeClip = qeClipFor(hit.kind, hit.index, hit.clip);
    if (!qeClip) {
      note(lines, "Premiere did not find clip " + p.id + " through the QE DOM.");
      continue;
    }
    var before = transitionCount(hit.track);
    try {
      // (transition, at the clip's end, duration in frames, offset, alignment
      // 0.5 = centred on the cut, single-sided, align to video)
      qeClip.addTransition(tr, Boolean(p.atEnd), String(frames), "0", 0.5, true, true);
    } catch (err: any) {
      note(lines, p.track + " " + Number(p.atSec).toFixed(2) + "s: " + err);
      continue;
    }
    var again = locate(seq, String(p.id));
    var after = transitionCount(again ? again.track : hit.track);
    if (before >= 0 && after >= 0 && after <= before) unconfirmed++;
    added++;
  }
  if (unconfirmed > 0) {
    lines[lines.length] = unconfirmed + " transition(s) were accepted but did not show up on the track; " +
      "the clips may have no unused media past the cut.";
  }
  return JSON.stringify({ success: true, added: added - unconfirmed, lines: lines });
}

// ------------------------------------------------------------------------------
// Speed and keyframes (update_clip)
// ------------------------------------------------------------------------------

/** Set a clip's speed (2 = twice as fast) and direction through QE setSpeed. */
export function applySpeed(hit: any, args: any, updated: string[], lines: string[]): void {
  if (!num(args.speed) && !args.reverse) return;
  var qeClip = qeClipFor(hit.kind, hit.index, hit.clip);
  if (!qeClip || typeof qeClip.setSpeed !== "function") {
    note(lines, "Premiere did not let the script change this clip's speed.");
    return;
  }
  var oldSpeed = 1;
  try {
    oldSpeed = Math.abs(Number(hit.clip.getSpeed())) || 1;
  } catch (e) {}
  var ratio = num(args.speed) ? args.speed : oldSpeed;
  // QE setSpeed is (multiplier, new duration in ticks, reverse, keep pitch,
  // ripple). The clip keeps the same stretch of source media.
  var oldTicks = 0;
  try {
    oldTicks = parseFloat(hit.clip.duration.ticks);
  } catch (e) {}
  var ticks = oldTicks > 0 ? String(Math.round((oldTicks * oldSpeed) / ratio)) : "";
  try {
    qeClip.setSpeed(ratio, ticks, Boolean(args.reverse), true, false);
  } catch (e1) {
    try {
      qeClip.setSpeed(ratio, "", Boolean(args.reverse), true, false);
    } catch (e2: any) {
      note(lines, "Could not change the speed: " + e2);
      return;
    }
  }
  if (num(args.speed)) updated[updated.length] = "speed";
  if (args.reverse) updated[updated.length] = "reverse";
}

var INTERPOLATION: any = { linear: 0, hold: 4, ease: 5 };

/**
 * A property for keyframes: "Scale" (searched in every component, Motion
 * first) or "Effect/Parameter". Looks in linked clips too, so "Level" on a
 * video clip reaches its sound.
 */
function keyframeProperty(clip: any, path: string): any {
  var slash = path.indexOf("/");
  var compName = slash >= 0 ? path.substring(0, slash) : "";
  var propName = slash >= 0 ? path.substring(slash + 1) : path;
  var clips = [clip];
  try {
    var linked = clip.getLinkedItems ? clip.getLinkedItems() : null;
    for (var l = 0; linked && l < linked.numItems; l++) clips[clips.length] = linked[l];
  } catch (e) {}
  for (var c = 0; c < clips.length; c++) {
    var comps = clips[c].components;
    for (var i = 0; comps && i < comps.numItems; i++) {
      if (compName && foldName(comps[i].displayName) !== foldName(compName)) continue;
      var prop = findProperty(comps[i], propName);
      if (prop) return { prop: prop, clip: clips[c] };
    }
  }
  return null;
}

/**
 * "Scale Width" / "Scale Height": turns the clip's Uniform Scale off first,
 * after which Motion's "Scale" is the height. Null for any other property.
 */
function scaleAxis(clip: any, path: string, lines: string[]): any {
  var axis = foldName(path);
  if (axis !== "scalewidth" && axis !== "scaleheight") return null;
  var motion = lastComponent(clip, "AE.ADBE Motion") || lastComponent(clip, "Motion");
  if (!motion) return null;
  var uniform = findProperty(motion, "Uniform Scale");
  // The checkbox reads back as true/1; some versions only take 0 to clear it.
  var on = function (): boolean {
    var v = uniform.getValue();
    return v === true || v === 1 || String(v) === "true";
  };
  if (!uniform) {
    note(lines, "No Uniform Scale checkbox found, so width and height may still move together.");
  } else {
    try {
      if (on()) uniform.setValue(false, true);
      if (on()) uniform.setValue(0, true);
      if (on()) note(lines, "Premiere kept Uniform Scale on: untick it in Effect Controls > Motion for width and height to move apart.");
    } catch (e) {
      note(lines, "Could not turn off Uniform Scale: " + e);
    }
  }
  var prop =
    axis === "scalewidth"
      ? findProperty(motion, "Scale Width")
      : findProperty(motion, "Scale Height") || findProperty(motion, "Scale");
  return prop ? { prop: prop, clip: clip } : null;
}

// ------------------------------------------------------------------------------
// Anchor point (update_clip)
// ------------------------------------------------------------------------------

/** Pixel size of a clip's media, from the project's "Video Info" column ("1024 x 1024 (1.0)"). */
function mediaSize(clip: any): number[] | null {
  try {
    var md = String(clip.projectItem.getProjectMetadata());
    var m = md.match(/VideoInfo>\s*(\d+)\s*x\s*(\d+)/);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch (e) {}
  return null;
}

function sequenceSize(seq: any): number[] {
  var w = Number(seq.frameWidth) || 0;
  var h = Number(seq.frameHeight) || 0;
  try {
    if (!w || !h) {
      var settings = seq.getSettings();
      w = Number(settings.videoFrameWidth) || w;
      h = Number(settings.videoFrameHeight) || h;
    }
  } catch (e) {}
  return [w || 1920, h || 1080];
}

/** A point property's value now, as [x, y]. */
function pointValue(prop: any): number[] {
  var v = prop.getValue();
  return [Number(v[0]), Number(v[1])];
}

/**
 * Move a clip's Anchor Point to `args.anchor` ([0.5, 0.5] centre of its own
 * picture, [0.5, 1] bottom middle) and move Position (every key of it) by the
 * same amount on screen, so the picture stays put. Scale and Rotation are read
 * at the playhead, so a clip already animating them can drift a little.
 */
export function applyAnchor(seq: any, clip: any, args: any, updated: string[], lines: string[]): void {
  var a = args.anchor;
  if (!a || a.length !== 2 || !num(a[0]) || !num(a[1])) return;
  var motion = lastComponent(clip, "AE.ADBE Motion") || lastComponent(clip, "Motion");
  var anchor = motion ? findProperty(motion, "Anchor Point") : null;
  var position = motion ? findProperty(motion, "Position") : null;
  if (!anchor || !position) {
    note(lines, "This clip has no Anchor Point (audio clip?).");
    return;
  }
  var media = mediaSize(clip);
  var frame = sequenceSize(seq);
  try {
    var old = pointValue(anchor);
    // Premiere reports the anchor as a fraction of the picture; older builds
    // in pixels. Pixels need the media size to convert.
    var pixels = Math.abs(old[0]) > 2 || Math.abs(old[1]) > 2;
    if (pixels && !media) {
      note(lines, "Could not read the picture size, so the anchor was not moved.");
      return;
    }
    var size = media || frame;
    var oldFrac = pixels ? [old[0] / size[0], old[1] / size[1]] : old;
    var dx = (Number(a[0]) - oldFrac[0]) * size[0];
    var dy = (Number(a[1]) - oldFrac[1]) * size[1];

    var scale = findProperty(motion, "Scale");
    var width = findProperty(motion, "Scale Width");
    var uniform = findProperty(motion, "Uniform Scale");
    var sy = scale ? Number(scale.getValue()) / 100 : 1;
    var sx = sy;
    try {
      var u = uniform ? uniform.getValue() : true;
      if (!(u === true || u === 1 || String(u) === "true") && width) sx = Number(width.getValue()) / 100;
    } catch (e) {}
    var rotation = findProperty(motion, "Rotation");
    var r = rotation ? (Number(rotation.getValue()) * Math.PI) / 180 : 0;
    // The anchor's move on screen, in pixels (y down, rotation clockwise).
    var px = dx * sx * Math.cos(r) - dy * sy * Math.sin(r);
    var py = dx * sx * Math.sin(r) + dy * sy * Math.cos(r);
    var shift = [px / frame[0], py / frame[1]];

    anchor.setValue(pixels ? [Number(a[0]) * size[0], Number(a[1]) * size[1]] : [Number(a[0]), Number(a[1])], true);
    if (position.isTimeVarying && position.isTimeVarying()) {
      var keys = position.getKeys() || [];
      for (var k = 0; k < keys.length; k++) {
        var v = position.getValueAtKey(keys[k]);
        position.setValueAtKey(keys[k], [Number(v[0]) + shift[0], Number(v[1]) + shift[1]], true);
      }
    } else {
      var p = pointValue(position);
      position.setValue([p[0] + shift[0], p[1] + shift[1]], true);
    }
    if (!media) note(lines, "Could not read the picture size; the anchor assumed it fills the frame.");
    updated[updated.length] = "anchor";
  } catch (err: any) {
    note(lines, "Could not move the anchor: " + err);
  }
}

/** Keyframes from `args.keyframes`, each point placed relative to the clip's start or end. */
export function applyKeyframes(hit: any, args: any, updated: string[], lines: string[]): void {
  var specs: any[] = args.keyframes || [];
  for (var k = 0; k < specs.length; k++) {
    var spec = specs[k];
    var found = scaleAxis(hit.clip, String(spec.property), lines) || keyframeProperty(hit.clip, String(spec.property));
    if (!found) {
      note(lines, "No property \"" + spec.property + "\" on this clip (use \"Effect/Parameter\" for an effect's).");
      continue;
    }
    var clip = found.clip;
    var prop = found.prop;
    var inSec = getTimeSeconds(clip.inPoint);
    var length = getTimeSeconds(clip.end) - getTimeSeconds(clip.start);
    var speed = 1;
    try {
      speed = Math.abs(Number(clip.getSpeed())) || 1;
    } catch (e) {}
    var mode = INTERPOLATION[String(spec.interpolation || "ease").toLowerCase()];
    if (mode === undefined) mode = 5;
    try {
      if (!prop.isTimeVarying()) prop.setTimeVarying(true);
      for (var p = 0; p < spec.points.length; p++) {
        var pt = spec.points[p];
        var offset = pt.fromEnd ? length - Number(pt.sec) : Number(pt.sec);
        offset = Math.max(0, Math.min(length, offset));
        // Keyframes live in the clip's source time, which runs `speed` times
        // faster than the timeline.
        var t = secondsToTime(inSec + offset * speed);
        prop.addKey(t);
        prop.setValueAtKey(t, coerce(pt.value), true);
        try {
          prop.setInterpolationTypeAtKey(t, mode, true);
        } catch (e) {}
      }
      updated[updated.length] = String(spec.property) + " keyframes";
    } catch (err: any) {
      note(lines, "Could not keyframe " + spec.property + ": " + err);
    }
  }
}

// ------------------------------------------------------------------------------
// Graphics (add_text)
// ------------------------------------------------------------------------------

/** Text-ish property of a template: Source Text, or a value holding a text document. */
function looksLikeText(prop: any): boolean {
  var dn = String(prop.displayName || "").toLowerCase();
  if (dn.indexOf("source text") >= 0 || dn === "text" || dn === "title") return true;
  var v = "";
  try {
    v = String(prop.getValue());
  } catch (e) {}
  return v.indexOf("mTextParam") >= 0 || v.indexOf("textEditValue") >= 0 || v.indexOf("mTextString") >= 0;
}

/**
 * Type `text` into the first text field of an imported template. Template
 * text is a JSON document, sometimes behind a few binary bytes; writing a
 * plain string stores it but the graphic does not change, so the JSON is
 * patched and written back.
 */
function setTemplateText(item: any, text: string): boolean {
  var props: any[] = [];
  try {
    var mgt = item.getMGTComponent ? item.getMGTComponent() : null;
    for (var i = 0; mgt && mgt.properties && i < mgt.properties.numItems; i++) {
      if (looksLikeText(mgt.properties[i])) props[props.length] = mgt.properties[i];
    }
  } catch (e) {}
  if (props.length === 0) {
    for (var c = 0; item.components && c < item.components.numItems; c++) {
      var comp = item.components[c];
      for (var p = 0; comp.properties && p < comp.properties.numItems; p++) {
        if (looksLikeText(comp.properties[p])) props[props.length] = comp.properties[p];
      }
    }
  }
  if (props.length === 0) return false;
  var prop = props[0];
  var raw = "";
  try {
    raw = String(prop.getValue());
  } catch (e) {}
  var brace = raw.indexOf("{");
  var doc: any = null;
  if (brace >= 0) {
    try {
      doc = JSON.parse(raw.substring(brace));
    } catch (e) {}
  }
  if (!doc) {
    prop.setValue(text, true);
    return String(prop.getValue()).indexOf(text) >= 0;
  }
  if (doc.mTextParam && doc.mTextParam.mStyleSheet) doc.mTextParam.mStyleSheet.mText = text;
  if (doc.textEditValue !== undefined) {
    doc.textEditValue = text;
    doc.fontTextRunLength = [text.length];
  }
  if (doc.mTextString !== undefined) doc.mTextString = text;
  prop.setValue(raw.substring(0, brace) + JSON.stringify(doc), true);
  return true;
}

// args: { mogrt, track (1-based lowest), texts: [{ text, start, end }] }
export function addGraphics(seq: any, args: any): string {
  var texts: any[] = args.texts || [];
  var lines: string[] = [];
  var added = 0;
  var minIndex = Math.max(0, Number(args.track || 2) - 1);
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i];
    var track = freeVideoTrack(minIndex, t.start, t.end);
    if (track < 0) {
      note(lines, "No free video track for \"" + t.text + "\" at " + t.start + "s.");
      continue;
    }
    var item: any = null;
    try {
      item = app.project.activeSequence.importMGT(
        String(args.mogrt),
        String(Math.round(Number(t.start) * TICKS_PER_SECOND)),
        track,
        0,
      );
    } catch (err: any) {
      note(lines, "Premiere could not import the template: " + err);
      continue;
    }
    if (!item) {
      note(lines, "Premiere could not import the template " + args.mogrt + ".");
      continue;
    }
    try {
      item.end = secondsToTime(Number(t.end));
    } catch (e) {}
    try {
      if (!setTemplateText(item, String(t.text))) {
        note(lines, "The template has no text field the script can fill; it kept its own text.");
      }
    } catch (err: any) {
      note(lines, "Could not type the text into \"" + t.text + "\": " + err);
    }
    added++;
  }
  return JSON.stringify({ success: true, added: added, lines: lines });
}
