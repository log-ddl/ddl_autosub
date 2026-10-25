// ==============================================================================
// AI EDIT: PLACE MEDIA (build_storyboard)
// ==============================================================================
//
// Places media for AI Edit, in one of four modes, with per-item effects:
//   append  - after the last clip on the track
//   replace - overwrite the track (video and its audio) from each start
//   insert  - razor the target V/A tracks at the first start, push what is
//             after right by the new clips' length, and place them in the gap
//   overlay - video only, on the first free track above the target
// Audio-only items (sound effects, music) skip all of that: each goes in at
// its own start on the first audio track free over its span from A2 up, a
// track is added when all are taken, and they never move the video cursor.
// `spec` arrives already parsed.
//
// spec: {
//   items: [{ path, start, end?, src_in?, src_out?, effect? }],  // seconds, in play order
//   mode?: "append" | "replace" | "insert" | "overlay",       // inferred when omitted
//   audio_path?: string,
//   target_video_track?: number,   // 1-based, default 1
//   default_still_secs?: number,   // fallback clip length
// }
// Returns JSON: { success, lines, appended, requested } (or { success:false, error }).

import { applyTransform, clipId, createRazor, eachClip, findClip, secondsToTime } from "./ai-edit-util";
import { getTimeSeconds, TICKS_PER_SECOND } from "./ppro";

export function aiEditBuildStoryboard(spec: any): string {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "No project open" });
    if (!app.project.activeSequence)
      return JSON.stringify({ success: false, error: "No active sequence" });

    var sequence = app.project.activeSequence;
    var rootItem = app.project.rootItem;
    var allItems: any[] = spec && spec.items ? spec.items : [];
    var audioPath = spec && typeof spec.audio_path === "string" ? spec.audio_path : "";
    var defaultStill = spec && spec.default_still_secs > 0 ? spec.default_still_secs : 3;
    var targetTrack = spec && spec.target_video_track > 0 ? Math.floor(spec.target_video_track) : 1;
    var rawMode = spec && typeof spec.mode === "string" ? spec.mode.toLowerCase() : "";

    var lines: string[] = [];

    var IMAGE_EXTS = ",jpg,jpeg,png,gif,bmp,webp,tif,tiff,heic,avif,psd,tga,";
    var AUDIO_EXTS = ",wav,mp3,m4a,aac,flac,ogg,aif,aiff,opus,wma,";

    function isAudioPath(p: string): boolean {
      var m = String(p).match(/\.([A-Za-z0-9]+)$/);
      return !!m && AUDIO_EXTS.indexOf("," + m[1].toLowerCase() + ",") !== -1;
    }

    /** Stills get the sentence span; everything else plays at full length. */
    function isStillPath(p: string): boolean {
      var m = String(p).match(/\.([A-Za-z0-9]+)$/);
      if (!m) return false;
      return IMAGE_EXTS.indexOf("," + m[1].toLowerCase() + ",") !== -1;
    }

    function baseNameOf(p: string): string {
      var parts = String(p).split(/[\/\\]/);
      return parts[parts.length - 1] || String(p);
    }

    /** Path comparison that tolerates URI-encoding and case differences. */
    function samePath(a: string, b: string): boolean {
      if (!a || !b) return false;
      if (a === b) return true;
      var da = a;
      var db = b;
      try { da = decodeURI(a); } catch (e1) {}
      try { db = decodeURI(b); } catch (e2) {}
      return da === db || da.toLowerCase() === db.toLowerCase();
    }

    /**
     * Depth-first search of the project for the item backing `wantPath`.
     * Matching on getMediaPath() is what makes this reliable: names get
     * de-duplicated ("clip 2") and unicode filenames come back re-encoded, so a
     * name comparison alone misses. Bins are searched too, since the user's
     * project may not keep media at the root.
     */
    function findByPath(root: any, wantPath: string, wantBase: string): any {
      if (!root || !root.children) return null;
      for (var i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (!child) continue;
        var mediaPath = "";
        try {
          if (typeof child.getMediaPath === "function") {
            mediaPath = String(child.getMediaPath() || "");
          }
        } catch (e) {}
        if (mediaPath && samePath(mediaPath, wantPath)) return child;
        if (!mediaPath && wantBase && child.name && samePath(String(child.name), wantBase)) {
          return child;
        }
        if (child.children && child.children.numItems > 0) {
          var found = findByPath(child, wantPath, wantBase);
          if (found) return found;
        }
      }
      return null;
    }

    // Import one media file and return its projectItem (or null).
    function importOne(path: string): any {
      if (typeof path !== "string" || path.length === 0) return null;
      var wantBase = baseNameOf(path);

      // Already in the project (a repeat add, or the user imported it): reuse it.
      var existing = findByPath(rootItem, path, wantBase);
      if (existing) return existing;

      app.project.importFiles([path], true, rootItem, false);

      // The import is usually done by the time importFiles returns; this short
      // poll only covers the case where it isn't. It stays brief on purpose:
      // $.sleep blocks the whole ExtendScript bridge, so a long wait per file
      // would stall the panel and time the request out.
      for (var poll = 0; poll < 8; poll++) {
        $.sleep(125); // ms — ~1s total at most
        var found = findByPath(rootItem, path, wantBase);
        if (found) return found;
      }
      return null;
    }

    /**
     * Everything below works in whole SEQUENCE FRAMES rather than float seconds.
     * Premiere snaps every time it writes a clip boundary, so a cursor kept in
     * seconds drifts: the snapped clip ends a fraction earlier or later than the
     * value we remembered, the next clip starts from the unsnapped number, and
     * because overwriteClip *overwrites*, a start one frame early eats a frame
     * off the clip before it. Over a long storyboard that compounds into clips
     * "off by a few frames".
     *
     * `sequence.timebase` is ticks per frame. A sequence that won't report it
     * leaves ticksPerFrame at 0, and the helpers below degrade to plain seconds.
     */
    var ticksPerFrame = 0;
    try {
      var tb = parseFloat(sequence.timebase);
      if (!isNaN(tb) && tb > 0) ticksPerFrame = tb;
    } catch (tbErr) {}
    var seqFps = ticksPerFrame > 0 ? TICKS_PER_SECOND / ticksPerFrame : 0;

    /** Seconds -> nearest whole sequence frame. */
    function toFrames(secs: number): number {
      if (!(secs > 0)) return 0;
      return seqFps > 0 ? Math.round(secs * seqFps) : secs;
    }

    /** Whole sequence frames -> seconds. */
    function frameSecs(frames: number): number {
      return seqFps > 0 ? frames / seqFps : frames;
    }

    /**
     * A frame boundary as a Time. Built from ticks, not seconds: ticks are the
     * unit Premiere stores, so `frames * ticksPerFrame` lands exactly on the
     * frame instead of near it.
     */
    function frameToTime(frames: number): any {
      // @ts-ignore - Time is an ExtendScript global provided by the host.
      var tt = new Time();
      if (ticksPerFrame > 0) {
        tt.ticks = String(Math.round(frames * ticksPerFrame));
      } else {
        tt.seconds = frames;
      }
      return tt;
    }

    /** Read a clip boundary back as a whole sequence frame. */
    function timeToFrames(timeObj: any): number {
      return toFrames(getTimeSeconds(timeObj));
    }

    /** Live sequence handle — re-read so track collections are never stale. */
    function seq(): any {
      return app.project.activeSequence;
    }

    function videoTrackAt(idx: number): any {
      var s = seq();
      return s && s.videoTracks && idx < s.videoTracks.numTracks ? s.videoTracks[idx] : null;
    }

    /**
     * The media's own frame rate, or 0 when Premiere won't say. Used to put an
     * in-point on a real source frame: a raw "30.5s" lands between two frames
     * and Premiere resolves it in its own direction, which is how a cut ends up
     * a frame or two off the moment the user asked for.
     */
    function sourceFps(mp: any): number {
      try {
        if (mp && typeof mp.getFootageInterpretation === "function") {
          var fi = mp.getFootageInterpretation();
          var rate = fi ? parseFloat(fi.frameRate) : NaN;
          if (!isNaN(rate) && rate > 0) return rate;
        }
      } catch (e) {}
      return 0;
    }

    /** Snap seconds to the nearest whole frame of `fps` (unchanged when fps is 0). */
    function snapToSourceFrame(secs: number, fps: number): number {
      return fps > 0 ? Math.round(secs * fps) / fps : secs;
    }

    /**
     * Set a project item's in/out points so the next insert only takes that
     * section. mediaType 4 means "video and audio"; older builds want the two
     * streams set separately, so both shapes are attempted. Returns whether the
     * range stuck.
     *
     * Both ends are snapped to the source frame grid first. The out point is
     * only a hint here — Premiere disagrees across versions about whether it is
     * inclusive — so the caller trims the placed clip to the exact requested
     * length afterwards rather than trusting it.
     */
    function setItemRange(mp: any, inSec: number, outSec: number, fps: number): boolean {
      if (!mp || typeof mp.setInPoint !== "function") return false;
      var inSnapped = snapToSourceFrame(inSec, fps);
      var outSnapped = outSec > inSec ? snapToSourceFrame(outSec, fps) : 0;
      var ok = false;
      var types = [4, 1, 2]; // both, video, audio
      for (var i = 0; i < types.length; i++) {
        try {
          mp.setInPoint(inSnapped, types[i]);
          if (outSnapped > inSnapped) mp.setOutPoint(outSnapped, types[i]);
          ok = true;
          if (types[i] === 4) break; // "both" covered it — no need for the rest
        } catch (e) {}
      }
      return ok;
    }

    /** Drop any in/out we set, so the item is whole again for later re-use. */
    function clearItemRange(mp: any, durationSec: number): void {
      if (!mp || typeof mp.setInPoint !== "function") return;
      try {
        mp.setInPoint(0, 4);
        if (durationSec > 0) mp.setOutPoint(durationSec, 4);
      } catch (e) {}
    }

    /**
     * Trim any audio clip that starts alongside a video clip we just shortened.
     * Setting `end` on the video track item leaves its linked audio at full
     * length, which would run on past the picture. Matching is on the frame, so
     * the linked audio is identified exactly instead of by a seconds tolerance
     * wide enough to catch a neighbouring clip.
     */
    function trimAudioAt(startFrames: number, endFrames: number): void {
      var s = seq();
      if (!s || !s.audioTracks) return;
      for (var t = 0; t < s.audioTracks.numTracks; t++) {
        var track = s.audioTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];
          try {
            if (timeToFrames(clip.start) !== startFrames) continue;
            if (timeToFrames(clip.end) > endFrames) clip.end = frameToTime(endFrames);
          } catch (e) {}
        }
      }
    }

    /** Where the last clip on `track` ends, in frames (0 for an empty track). */
    function trackEndFrames(track: any): number {
      if (!track || !track.clips) return 0;
      var end = 0;
      for (var i = 0; i < track.clips.numItems; i++) {
        try {
          var e = timeToFrames(track.clips[i].end);
          if (e > end) end = e;
        } catch (err) {}
      }
      return end;
    }

    /** Total clips across every audio track — used to detect linked audio. */
    function audioClipCount(): number {
      var s = seq();
      if (!s || !s.audioTracks) return 0;
      var total = 0;
      for (var i = 0; i < s.audioTracks.numTracks; i++) {
        try { total += s.audioTracks[i].clips.numItems; } catch (e) {}
      }
      return total;
    }

    /** The media's own length in seconds, or 0 when Premiere won't say. */
    function mediaSeconds(mp: any): number {
      try {
        var len = getTimeSeconds(mp.getOutPoint(1)) - getTimeSeconds(mp.getInPoint(1));
        if (len > 0) return len;
      } catch (e) {}
      return 0;
    }

    /** Whether `track` has a clip overlapping [startFrames, endFrames). */
    function occupied(track: any, startFrames: number, endFrames: number): boolean {
      for (var i = 0; track && i < track.clips.numItems; i++) {
        try {
          var s = timeToFrames(track.clips[i].start);
          var e = timeToFrames(track.clips[i].end);
          if (s < endFrames && e > startFrames) return true;
        } catch (err) {}
      }
      return false;
    }

    /**
     * First video track at or above `minIndex` (0-based) free over the span,
     * adding a track through the QE DOM when every one is taken. -1 if none.
     */
    function freeVideoTrack(minIndex: number, startFrames: number, endFrames: number): number {
      var s0 = seq();
      for (var t = minIndex; t < s0.videoTracks.numTracks; t++) {
        if (!occupied(s0.videoTracks[t], startFrames, endFrames)) return t;
      }
      try {
        app.enableQE();
        // @ts-ignore - qe is the QE DOM global, enabled above.
        var qeSeq: any = qe.project.getActiveSequence();
        var before = s0.videoTracks.numTracks;
        qeSeq.addTracks(1, before, 0);
        if (seq().videoTracks.numTracks > before) return seq().videoTracks.numTracks - 1;
      } catch (e) {}
      return -1;
    }

    /**
     * First audio track at or above `minIndex` (0-based) free over the span,
     * adding a stereo track through the QE DOM when every one is taken.
     * -1 if none could be found or made.
     */
    function freeAudioTrack(minIndex: number, startFrames: number, endFrames: number): number {
      var s0 = seq();
      var n = s0.audioTracks ? s0.audioTracks.numTracks : 0;
      for (var t = minIndex; t < n; t++) {
        if (!occupied(s0.audioTracks[t], startFrames, endFrames)) return t;
      }
      try {
        app.enableQE();
        // @ts-ignore - qe is the QE DOM global, enabled above.
        var qeSeq: any = qe.project.getActiveSequence();
        var nv = s0.videoTracks.numTracks;
        // (video count, after video, audio count, audio type 1 = stereo, after audio)
        try { qeSeq.addTracks(0, nv, 1, 1, n, 0, 0); } catch (e1) {}
        if (seq().audioTracks.numTracks <= n) {
          try { qeSeq.addTracks(0, nv, 1); } catch (e2) {}
        }
        var now = seq().audioTracks.numTracks;
        if (now > n) return now - 1 < minIndex ? freeAudioTrack(minIndex, startFrames, endFrames) : now - 1;
      } catch (e) {}
      return -1;
    }

    /** An audio item's own length in seconds, or 0. */
    function audioSeconds(mp: any): number {
      var kinds = [2, 4, 1];
      for (var k = 0; k < kinds.length; k++) {
        try {
          var len = getTimeSeconds(mp.getOutPoint(kinds[k])) - getTimeSeconds(mp.getInPoint(kinds[k]));
          if (len > 0) return len;
        } catch (e) {}
      }
      return 0;
    }

    /**
     * Place the audio-only items. Returns how many landed; problems go to
     * `lines`. Each is counted on the track it went to, so a clip that landed
     * is never reported as missing.
     */
    function placeAudioItems(audioItems: any[]): number {
      var placedCount = 0;
      for (var i = 0; i < audioItems.length; i++) {
        var it = audioItems[i];
        var name = baseNameOf(it.path);
        var amp = importOne(it.path);
        if (!amp) {
          lines[lines.length] = "Skipped (import failed): " + name;
          continue;
        }
        var start = it.start > 0 ? it.start : 0;
        var aIn = it.src_in > 0 ? it.src_in : 0;
        var aOut = it.src_out > aIn ? it.src_out : 0;
        var full = audioSeconds(amp);
        var lenSec = aOut > 0 ? aOut - aIn : it.end > start ? it.end - start : full > 0 ? full - aIn : 3;
        if (full > 0 && aIn + lenSec > full) lenSec = full - aIn;
        if (lenSec <= 0) lenSec = 1 / (seqFps || 25);
        var ranged = aIn > 0 || lenSec < full - aIn;
        if (ranged) setItemRange(amp, aIn, aIn + lenSec, 0);
        var startF = toFrames(start);
        var lenF = toFrames(lenSec);
        if (seqFps > 0 && lenF < 1) lenF = 1;
        var idx = freeAudioTrack(1, startF, startF + lenF);
        if (idx < 0) {
          lines[lines.length] = "Skipped (no free audio track; add one in Premiere): " + name;
          if (ranged) clearItemRange(amp, 0);
          continue;
        }
        var clip = placeClip(seq().audioTracks[idx], amp, startF);
        if (ranged) clearItemRange(amp, 0);
        if (!clip) {
          lines[lines.length] = "Could not place: " + name + (lastPlaceErr ? " [" + lastPlaceErr + "]" : "");
          continue;
        }
        try {
          if (timeToFrames(clip.end) !== startF + lenF) clip.end = frameToTime(startF + lenF);
        } catch (trimErr) {}
        placedCount++;
      }
      return placedCount;
    }

    /** Ids of every audio clip, to spot the ones a placement adds. */
    function audioIds(): any {
      var ids: any = {};
      eachClip(seq(), function (clip, kind, t, c) {
        if (kind === "A") ids[clipId(clip, kind, t, c)] = true;
      });
      return ids;
    }

    /** Remove the audio clips that are not in `before` (overlay is video only). */
    function dropNewAudio(before: any): void {
      var added: any[] = [];
      eachClip(seq(), function (clip, kind, t, c) {
        if (kind === "A" && !before[clipId(clip, kind, t, c)]) added[added.length] = clip;
      });
      for (var i = 0; i < added.length; i++) {
        try {
          added[i].remove(false, true);
        } catch (e) {}
      }
    }

    /**
     * Open a gap of `lenFrames` at `atFrames` on V`vIdx` and the audio track
     * with the same index: razor them there, then move every clip from that
     * point right, latest first so nothing is moved onto a clip.
     */
    function openGap(vIdx: number, atFrames: number, lenFrames: number): void {
      var atSec = frameSecs(atFrames);
      var razor = createRazor(seq());
      razor("V", vIdx, atSec);
      var s0 = seq();
      var hasAudio = s0.audioTracks && vIdx < s0.audioTracks.numTracks;
      if (hasAudio) razor("A", vIdx, atSec);
      var todo: any[] = [];
      var kinds = hasAudio ? ["V", "A"] : ["V"];
      for (var k = 0; k < kinds.length; k++) {
        var track = kinds[k] === "V" ? s0.videoTracks[vIdx] : s0.audioTracks[vIdx];
        for (var c = 0; c < track.clips.numItems; c++) {
          var start = timeToFrames(track.clips[c].start);
          if (start >= atFrames) {
            todo[todo.length] = { id: clipId(track.clips[c], kinds[k], vIdx, c), want: start + lenFrames, start: start };
          }
        }
      }
      todo.sort(function (a, b) {
        return b.start - a.start;
      });
      for (var i = 0; i < todo.length; i++) {
        var clip = findClip(seq(), todo[i].id);
        if (!clip) continue;
        // A linked partner may already have moved with its clip.
        var now = timeToFrames(clip.start);
        if (now !== todo[i].want) {
          try {
            clip.move(secondsToTime(frameSecs(todo[i].want - now)));
          } catch (e) {}
        }
      }
    }

    // The last placement error, surfaced in the result so a silent failure in
    // Premiere is diagnosable instead of just "Could not place".
    var lastPlaceErr = "";

    /**
     * Place `mp` at `startFrames` on `track`. Premiere versions disagree on
     * whether overwriteClip wants a Time object, plain seconds or a tick string,
     * so each is tried in turn and the clip count decides whether anything
     * landed. Every shape is derived from the frame number, so all three ask for
     * the same instant.
     */
    function placeClip(track: any, mp: any, startFrames: number): any {
      lastPlaceErr = "";
      if (!track) {
        lastPlaceErr = "no track";
        return null;
      }
      if (typeof track.overwriteClip !== "function") {
        lastPlaceErr = "overwriteClip unavailable";
        return null;
      }
      var before = track.clips.numItems;
      var startSec = frameSecs(startFrames);
      var attempts = [
        { label: "time", value: frameToTime(startFrames) },
        { label: "secs", value: startSec },
        {
          label: "ticks",
          value: ticksPerFrame > 0
            ? String(Math.round(startFrames * ticksPerFrame))
            : String(Math.round(startSec * TICKS_PER_SECOND)),
        },
      ];
      for (var a = 0; a < attempts.length; a++) {
        try {
          track.overwriteClip(mp, attempts[a].value);
        } catch (err: any) {
          lastPlaceErr += (lastPlaceErr ? " | " : "") + attempts[a].label + ": " + err;
        }
        if (track.clips.numItems > before) {
          lastPlaceErr = "";
          return track.clips[track.clips.numItems - 1];
        }
      }
      return null;
    }

    var items: any[] = [];
    var audioItems: any[] = [];
    for (var ai = 0; ai < allItems.length; ai++) {
      if (allItems[ai] && isAudioPath(allItems[ai].path)) audioItems[audioItems.length] = allItems[ai];
      else items[items.length] = allItems[ai];
    }

    // Resolve the destination video track (1-based -> 0-based), clamped to what
    // the sequence has — ExtendScript can't reliably add tracks.
    var numVideo = sequence.videoTracks ? sequence.videoTracks.numTracks : 0;
    if (items.length > 0 && numVideo === 0) {
      return JSON.stringify({ success: false, error: "Sequence has no video track" });
    }
    var vIndex = targetTrack - 1;
    if (vIndex < 0) vIndex = 0;
    if (vIndex > numVideo - 1) vIndex = numVideo - 1;

    var requested = 0;
    var appended = 0;
    var trackEnd = trackEndFrames(videoTrackAt(vIndex));
    var firstReq = items.length > 0 && items[0] && items[0].start > 0 ? toFrames(items[0].start) : 0;

    // Infer the mode when none is given.
    var mode = rawMode === "ripple" ? "insert" : rawMode === "broll" ? "overlay" : rawMode;
    if (mode !== "replace" && mode !== "insert" && mode !== "overlay" && mode !== "append") {
      if (targetTrack >= 2) mode = "overlay";
      else if (trackEnd > 0 && firstReq > 0 && firstReq < trackEnd) mode = "replace";
      else mode = "append";
    }

    // Where the previous clip ended. Videos go in at their full length, so the
    // requested start times (which assume a still-length slot each) would
    // overlap; each clip starts at the later of its request and the cursor.
    // Append starts at the end of whatever is already on the track, so an
    // existing edit is appended to; the other modes start at the first request.
    var cursorFrames = mode === "append" ? trackEnd : firstReq;

    for (var it = 0; it < items.length; it++) {
      var item = items[it];
      var path = item ? item.path : null;
      var reqStart = item && item.start > 0 ? item.start : 0;
      var reqEnd = item && item.end > reqStart ? item.end : reqStart + defaultStill;
      var spanSec = reqEnd - reqStart;
      if (spanSec <= 0) spanSec = defaultStill;
      var reqStartFrames = toFrames(reqStart);
      var spanFrames = toFrames(spanSec);
      // A span shorter than a frame still has to occupy one.
      if (seqFps > 0 && spanFrames < 1) spanFrames = 1;

      var mp = importOne(path);
      if (!mp) {
        lines[lines.length] = "Skipped (import failed): " + baseNameOf(path);
        continue;
      }
      requested++;

      var still = isStillPath(path);
      // Optional section inside the source clip ("url start-end"). Setting the
      // project item's in/out before the insert is what makes Premiere bring in
      // just that range, audio included; trimming afterwards would leave the
      // linked audio at full length.
      var srcIn = item && item.src_in > 0 ? item.src_in : 0;
      var srcOut = item && item.src_out > srcIn ? item.src_out : 0;
      var hasRange = !still && (srcIn > 0 || srcOut > 0);
      var srcFps = hasRange ? sourceFps(mp) : 0;
      var rangeApplied = false;
      if (hasRange) rangeApplied = setItemRange(mp, srcIn, srcOut, srcFps);

      // How long the clip should end up on the timeline, in sequence frames.
      // Stills get their span. A ranged video gets exactly the section asked
      // for, whether or not the in/out stuck: Premiere's out point may or may
      // not include its own frame depending on the version, so the length is
      // enforced here instead of being left to that. 0 means "leave it whole".
      var trimFrames = 0;
      if (still) {
        trimFrames = spanFrames;
      } else if (hasRange && srcOut > 0) {
        trimFrames = toFrames(
          snapToSourceFrame(srcOut, srcFps) - snapToSourceFrame(srcIn, srcFps),
        );
        if (seqFps > 0 && trimFrames < 1) trimFrames = 1;
      }

      var startFrames = mode === "insert" || reqStartFrames < cursorFrames ? cursorFrames : reqStartFrames;

      // Insert and overlay need the clip's length before it is placed. Insert
      // also trims to it, so the clip fills exactly the gap it opened.
      var plannedFrames = trimFrames;
      if (plannedFrames <= 0) {
        if (item && item.end > reqStart) plannedFrames = spanFrames;
        else plannedFrames = toFrames(mediaSeconds(mp)) || spanFrames;
      }
      if (mode === "insert") trimFrames = plannedFrames;

      var placeIndex = vIndex;
      if (mode === "overlay") {
        placeIndex = freeVideoTrack(vIndex < 1 ? 1 : vIndex, startFrames, startFrames + plannedFrames);
        if (placeIndex < 0) {
          lines[lines.length] =
            "Skipped (no free video track above V" + (vIndex + 1) + "; add one in Premiere): " + baseNameOf(path);
          if (rangeApplied) clearItemRange(mp, 0);
          continue;
        }
      } else if (mode === "insert") {
        openGap(vIndex, startFrames, plannedFrames);
      }

      var audioBefore = audioClipCount();
      var audioBeforeIds = mode === "overlay" ? audioIds() : null;
      var placed = placeClip(videoTrackAt(placeIndex), mp, startFrames);

      if (!placed) {
        lines[lines.length] =
          "Could not place: " + baseNameOf(path) + (lastPlaceErr ? " [" + lastPlaceErr + "]" : "");
        continue;
      }
      appended++;

      var endFrames = startFrames + spanFrames;

      // Placing on a video track normally carries the linked audio across. If
      // this build of Premiere didn't, put the audio on A1 so the clip's own
      // sound is not silently dropped. Stills have none to carry.
      if (audioBeforeIds) {
        dropNewAudio(audioBeforeIds);
      } else if (!still && audioClipCount() === audioBefore) {
        var s0 = seq();
        if (s0 && s0.audioTracks && s0.audioTracks.numTracks > 0) {
          placeClip(s0.audioTracks[0], mp, startFrames);
        }
      }

      if (trimFrames > 0) {
        // Stills carry Premiere's own default duration and videos come in whole;
        // either way, cut back to the requested length.
        endFrames = startFrames + trimFrames;
        try {
          placed.end = frameToTime(endFrames);
        } catch (trimErr) {
          lines[lines.length] = "Placed but could not trim: " + baseNameOf(path);
        }
        if (!still && !audioBeforeIds) trimAudioAt(startFrames, endFrames);
      }

      if (item && item.effect) {
        var effectDone: string[] = [];
        applyTransform(
          placed,
          { zoom: item.effect.zoom, panX: item.effect.pan_x, panY: item.effect.pan_y, rotation: item.effect.rotation },
          effectDone,
          lines,
        );
      }

      // Read back where the clip REALLY ends and carry that forward. Premiere
      // snaps whatever it is given, so trusting the number we asked for is what
      // let the error compound down the timeline; the next clip now starts on
      // the frame this one actually vacates.
      try {
        var realEnd = timeToFrames(placed.end);
        if (realEnd > startFrames) endFrames = realEnd;
      } catch (endErr) {}

      // Leave the bin item as we found it — an in/out left behind would silently
      // shorten the clip the next time anyone drags it in.
      if (rangeApplied) clearItemRange(mp, 0);

      lines[lines.length] =
        baseNameOf(path) + ": " + (still ? "still" : "video") +
        (hasRange ? " src=" + srcIn + "-" + (srcOut || "end") +
          (srcFps > 0 ? "@" + srcFps : "") +
          (rangeApplied ? "" : " (in/out refused)") : "") +
        " -> " + (endFrames - startFrames) + (seqFps > 0 ? "f @" : "s @") + startFrames +
        (placeIndex !== vIndex ? " on V" + (placeIndex + 1) : "");
      cursorFrames = endFrames;
    }

    if (items.length > 0) {
      lines[lines.length] =
        "Placed " + appended + " of " + items.length + " media on V" + (vIndex + 1) + " (" + mode + ").";
    }

    var audioPlaced = audioItems.length > 0 ? placeAudioItems(audioItems) : 0;
    if (audioItems.length > 0) {
      lines[lines.length] = "Placed " + audioPlaced + " of " + audioItems.length + " audio item(s) on free audio tracks.";
    }

    // Optional voice-over on the last audio track at t=0.
    if (audioPath && audioPath.length > 0) {
      var seqA = seq();
      var numAudio = seqA && seqA.audioTracks ? seqA.audioTracks.numTracks : 0;
      if (numAudio === 0) {
        lines[lines.length] = "Skipped voice-over: no audio track.";
      } else {
        var aItem = importOne(audioPath);
        if (!aItem) {
          lines[lines.length] = "Skipped voice-over (import failed): " + baseNameOf(audioPath);
        } else {
          var placedAudio = placeClip(seqA.audioTracks[numAudio - 1], aItem, 0);
          lines[lines.length] = placedAudio
            ? "Added voice-over to A" + numAudio + "."
            : "Could not place voice-over" + (lastPlaceErr ? " [" + lastPlaceErr + "]" : "") + ".";
        }
      }
    }

    return JSON.stringify({
      success: true,
      lines: lines,
      appended: appended + audioPlaced,
      requested: requested + audioItems.length,
      audio_placed: audioPlaced,
      audio_requested: audioItems.length,
      mode: mode,
    });
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
}
