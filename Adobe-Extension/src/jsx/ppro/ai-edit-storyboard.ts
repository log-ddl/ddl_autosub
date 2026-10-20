// ==============================================================================
// AI EDIT: PLACE MEDIA (build_storyboard)
// ==============================================================================
//
// AI Edit's own copy of the Slideshow placement (buildStoryboard in ppro.ts),
// so the two features change independently: this is where replace / insert /
// overlay modes and per-item effects for Premiere go, without touching the
// Slideshow tab. It started as an exact copy; `spec` arrives already parsed.
//
// spec: {
//   items: [{ path, start, end?, src_in?, src_out? }],  // seconds, in play order
//   audio_path?: string,
//   target_video_track?: number,   // 1-based, default 1
//   default_still_secs?: number,   // fallback clip length
// }
// Returns JSON: { success, lines, appended, requested } (or { success:false, error }).

import { getTimeSeconds, TICKS_PER_SECOND } from "./ppro";

export function aiEditBuildStoryboard(spec: any): string {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "No project open" });
    if (!app.project.activeSequence)
      return JSON.stringify({ success: false, error: "No active sequence" });

    var sequence = app.project.activeSequence;
    var rootItem = app.project.rootItem;
    var items: any[] = spec && spec.items ? spec.items : [];
    var audioPath = spec && typeof spec.audio_path === "string" ? spec.audio_path : "";
    var defaultStill = spec && spec.default_still_secs > 0 ? spec.default_still_secs : 3;
    var targetTrack = spec && spec.target_video_track > 0 ? Math.floor(spec.target_video_track) : 1;

    var lines: string[] = [];

    var IMAGE_EXTS = ",jpg,jpeg,png,gif,bmp,webp,tif,tiff,heic,avif,psd,tga,";

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
     * off the clip before it. Over a slideshow that compounds into the "off by a
     * few frames" the Resolve side never shows — its whole layout is integer
     * frames already.
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
    // Where the previous clip ended. Videos go in at their full length, so the
    // requested start times (which assume a still-length slot each) would
    // overlap; each clip starts at the later of its request and the cursor.
    // It starts at the end of whatever is already on the track, so an existing
    // edit is appended to rather than overwritten.
    var cursorFrames = trackEndFrames(videoTrackAt(vIndex));

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

      var startFrames = reqStartFrames > cursorFrames ? reqStartFrames : cursorFrames;
      var audioBefore = audioClipCount();
      var placed = placeClip(videoTrackAt(vIndex), mp, startFrames);

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
      if (!still && audioClipCount() === audioBefore) {
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
        if (!still) trimAudioAt(startFrames, endFrames);
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
        " -> " + (endFrames - startFrames) + (seqFps > 0 ? "f @" : "s @") + startFrames;
      cursorFrames = endFrames;
    }

    if (items.length > 0) {
      lines[lines.length] =
        "Placed " + appended + " of " + items.length + " media on V" + (vIndex + 1) + ".";
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
      appended: appended,
      requested: requested,
    });
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
}
