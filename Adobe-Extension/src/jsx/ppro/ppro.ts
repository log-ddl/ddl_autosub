import { logMessage as _log } from "../lib/log";

// ==============================================================================
// UTILS & POLYFILLS
// ==============================================================================

/**
 * Log a message to the ExtendScript console with the PPRO prefix.
 */
const log = (message: string): void => {
  _log("PPRO", message);
};

/**
 * Array.indexOf polyfill for older ExtendScript engines (ES3).
 */
function AK_indexOf(arr: any[], item: any): number {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === item) return i;
  }
  return -1;
}

// Premiere Pro's internal tick rate — all Time values from the API are in this unit.
const TICKS_PER_SECOND = 254016000000;

/** Extracts seconds from a Premiere Pro Time object, a raw tick string, or a seconds string. */
function getTimeSeconds(timeObj: any): number {
  if (!timeObj) return 0;

  // Time objects expose ticks (string) and seconds (number/string). ticks is the
  // authoritative raw value and avoids rounding/floating-point issues in .seconds.
  if (timeObj.ticks !== undefined && timeObj.ticks !== null && timeObj.ticks !== "") {
    var ticks = parseFloat(timeObj.ticks);
    if (!isNaN(ticks)) return ticks / TICKS_PER_SECOND;
  }

  if (typeof timeObj.seconds !== "undefined" && timeObj.seconds !== null && timeObj.seconds !== "") {
    var secs = parseFloat(timeObj.seconds);
    if (!isNaN(secs)) return secs;
  }

  // Fallback: raw string/number. Premiere sometimes returns raw tick strings for
  // legacy getters. A value whose magnitude exceeds 1e9 seconds (~31 years) is
  // almost certainly a tick count and must be converted to seconds.
  var raw = parseFloat(String(timeObj));
  if (isNaN(raw)) return 0;
  if (Math.abs(raw) > 1e9) return raw / TICKS_PER_SECOND;
  return raw;
}

/** Returns the sequence's displayed starting time (zeroPoint) in seconds. */
function getSequenceStartSeconds(sequence: any): number {
  if (sequence.zeroPoint) {
    var zeroTicks = parseFloat(sequence.zeroPoint);
    if (!isNaN(zeroTicks)) return zeroTicks / TICKS_PER_SECOND;
  }
  return 0;
}

/** Returns the sequence In point in seconds relative to the first frame of the sequence. */
function getSequenceInPointSeconds(sequence: any): number {
  var inPointTime: any;
  if (typeof sequence.getInPointAsTime === "function") {
    inPointTime = sequence.getInPointAsTime();
  } else {
    inPointTime = sequence.getInPoint();
  }
  // getInPointAsTime/getInPoint return absolute timeline time (including the
  // sequence zeroPoint), so subtract the start time to get the offset from the
  // first exported sample back to the sequence start.
  return getTimeSeconds(inPointTime) - getSequenceStartSeconds(sequence);
}

// ==============================================================================
// PRESET MANAGEMENT
// ==============================================================================

/**
 * Resolves the path to the bundled WAV audio preset.
 * Search order:
 *   1. <extension-root>/presets/
 *   2. <script-dir>/presets/
 *   3. Same directory as the script
 */
function getPresetFilePath(outputFolder: string) {
  var separator = outputFolder.indexOf("/") !== -1 ? "/" : "\\";
  var presetName = "WAV_48_kHz_16_bits.epr";
  var scriptFile = new File($.fileName);

  // Strategy 1: Check in the extension root presets folder (dist/cep/presets)
  var rootPresetsFolder = new Folder(scriptFile.parent.parent.fsName + separator + "presets");
  var rootPresetFile = new File(rootPresetsFolder.fsName + separator + presetName);
  if (rootPresetFile.exists) {
    return { success: true, path: rootPresetFile.fsName };
  }

  // Strategy 2: Check in the script directory's presets sub-folder
  var presetsFolder = new Folder(scriptFile.parent.fsName + separator + "presets");
  var presetFile = new File(presetsFolder.fsName + separator + presetName);
  if (presetFile.exists) {
    return { success: true, path: presetFile.fsName };
  }

  // Strategy 3: Check in the same directory as the script
  presetFile = new File(scriptFile.parent.fsName + separator + presetName);
  if (presetFile.exists) {
    return { success: true, path: presetFile.fsName };
  }

  return { success: false, path: null };
}

// ==============================================================================
// SEQUENCE MODULE
// ==============================================================================

/**
 * Gets detailed information about the active sequence.
 */
export function getActiveSequenceInfo(): string {
  try {
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({
        success: false,
        error: "No active sequence found",
        hasActiveSequence: false,
      });
    }

    const sequence = app.project.activeSequence;
    const timebase = parseFloat(sequence.timebase);
    let frameWidth = sequence.frameWidth;
    let frameHeight = sequence.frameHeight;

    // Fallback for resolution via getSettings()
    if (!frameWidth || !frameHeight) {
      try {
        const settings = (sequence as any).getSettings();
        if (settings) {
          frameWidth = settings.videoFrameWidth;
          frameHeight = settings.videoFrameHeight;
        }
      } catch (e) {
        log("getSettings() failed: " + e);
      }
    }

    let durationSeconds = 0;
    try {
      // sequence.end is the absolute end time in ticks; duration is end minus start.
      durationSeconds = getTimeSeconds(sequence.end) - getSequenceStartSeconds(sequence);
      if (durationSeconds < 0) durationSeconds = 0;
    } catch (e) {
      log("Error reading sequence duration: " + e);
    }

    const audioTrackInfo: any[] = [];
    if (sequence.audioTracks) {
      for (let i = 0; i < sequence.audioTracks.numTracks; i++) {
        const track = sequence.audioTracks[i];
        audioTrackInfo.push({
          index: i + 1,
          name: track.name || "Audio " + (i + 1),
          enabled: true,
        });
      }
    }

    return JSON.stringify({
      success: true,
      hasActiveSequence: true,
      name: sequence.name,
      id: sequence.sequenceID,
      durationSeconds: durationSeconds,
      timebase: timebase,
      width: frameWidth || 1920,
      height: frameHeight || 1080,
      numAudioTracks: sequence.audioTracks ? sequence.audioTracks.numTracks : 0,
      numVideoTracks: sequence.videoTracks ? sequence.videoTracks.numTracks : 0,
      audioTrackInfo: audioTrackInfo,
    });
  } catch (e: any) {
    return JSON.stringify({
      success: false,
      error: "Error getting sequence info: " + e.toString(),
      hasActiveSequence: false,
    });
  }
}

/**
 * Gets the combined time range of all selected clips across video and audio tracks.
 * Returns start/end in seconds relative to the sequence start.
 */
export function getSelectedClipsTimeRange(sequence: any) {
  try {
    var earliestStart = Infinity;
    var latestEnd = 0;
    var selectedClipsFound = 0;
    // Use a set-like object (keyed by clip start+end) to deduplicate linked clips
    // that appear on both a video and audio track.
    var seenKeys: any = {};
    var selectedItems: any[] = [];

    log("Analyzing selected clips...");

    // Method 1: sequence.getSelection()
    try {
      var sel = sequence.getSelection();
      if (sel && sel.length > 0) {
        for (var si = 0; si < sel.length; si++) {
          selectedItems.push(sel[si]);
        }
        log("Got " + selectedItems.length + " clips via getSelection()");
      }
    } catch (selErr: any) {
      log("getSelection() failed: " + selErr.toString());
    }

    // Method 2: Fallback — iterate tracks and check isSelected()
    if (selectedItems.length === 0) {
      log("Falling back to per-clip isSelected() check...");
      // Video tracks
      for (var vi = 0; vi < sequence.videoTracks.numTracks; vi++) {
        var vTrack = sequence.videoTracks[vi];
        for (var vj = 0; vj < vTrack.clips.numItems; vj++) {
          var vClip = vTrack.clips[vj];
          if (vClip) {
            try {
              if (typeof vClip.isSelected === "function" && vClip.isSelected()) {
                selectedItems.push(vClip);
              }
            } catch (e2) {
              log("Error checking video clip selection: " + e2);
            }
          }
        }
      }
      // Audio tracks
      for (var ai = 0; ai < sequence.audioTracks.numTracks; ai++) {
        var aTrack = sequence.audioTracks[ai];
        for (var aj = 0; aj < aTrack.clips.numItems; aj++) {
          var aClip = aTrack.clips[aj];
          if (aClip) {
            try {
              if (typeof aClip.isSelected === "function" && aClip.isSelected()) {
                selectedItems.push(aClip);
              }
            } catch (e3) {
              log("Error checking audio clip selection: " + e3);
            }
          }
        }
      }
      if (selectedItems.length > 0) {
        log("Found " + selectedItems.length + " clips via isSelected() fallback");
      }
    }

    if (selectedItems.length === 0) {
      log("No clips selected by any method");
      return { success: false, error: "No clips are currently selected" };
    }

    for (var i = 0; i < selectedItems.length; i++) {
      var clip = selectedItems[i];
      if (clip) {
        try {
          var startTime = getTimeSeconds(clip.start);
          var endTime = getTimeSeconds(clip.end);

          // Deduplicate linked clips (same start+end appear on both video and audio track)
          var key = startTime + "_" + endTime;
          if (seenKeys[key]) continue;
          seenKeys[key] = true;

          selectedClipsFound++;
          if (startTime < earliestStart) earliestStart = startTime;
          if (endTime > latestEnd) latestEnd = endTime;

          log("Selected clip: " + clip.name + " (" + startTime + "s to " + endTime + "s)");
        } catch (clipErr: any) {
          log("Error reading clip time: " + clipErr.toString());
        }
      }
    }

    if (selectedClipsFound === 0) {
      return { success: false, error: "No valid clips in selection" };
    }

    log("Found " + selectedClipsFound + " unique selected clips");
    log("Combined range: " + earliestStart + "s to " + latestEnd + "s");

    return {
      success: true,
      startTime: earliestStart,
      endTime: latestEnd,
      clipCount: selectedClipsFound,
    };
  } catch (e: any) {
    return { success: false, error: e.toString() };
  }
}

// ==============================================================================
// AUDIO EXPORT MODULE
// ==============================================================================

/**
 * Exports the active sequence's audio as a WAV file.
 * @param outputFolder       - Folder path where the WAV will be written
 * @param selectedTracksJson - JSON string encoding an array of 1-based track indices to export
 * @param selectedRange      - "entire" | "inout" | "selected"
 * @param externalPresetPath - Optional path to a custom .epr preset file
 */
export function exportSequenceAudio(
  outputFolder: string,
  selectedTracksJson: string,
  selectedRange: string,
  externalPresetPath: string
): string {
  var debugInfo: any = {
    method: "QE_DOM",
    outputFolder: outputFolder,
    selectedRange: selectedRange || "entire",
    externalPresetPath: externalPresetPath,
  };

  try {
    log("=== EXPORT SEQUENCE AUDIO VIA QE DOM ===");
    if (!app.project || !app.project.activeSequence) {
      return JSON.stringify({ success: false, error: "No active sequence", debug: debugInfo });
    }

    var sequence = app.project.activeSequence;

    // Parse selected tracks — the parameter is always a JSON string but guard defensively
    var selectedTracks: number[] = [];
    if (selectedTracksJson && selectedTracksJson.length > 0) {
      try {
        selectedTracks = JSON.parse(String(selectedTracksJson));
      } catch (e: any) {
        log("Error parsing selectedTracksJson: " + e.toString());
      }
    }

    // Ensure every element is numeric
    for (var v = 0; v < selectedTracks.length; v++) {
      if (typeof selectedTracks[v] !== "number") {
        selectedTracks[v] = Number(selectedTracks[v]);
      }
    }

    // Build output path
    var timestamp = new Date().getTime();
    var sequenceName = sequence.name.replace(/[^a-zA-Z0-9]/g, "_");
    var filename = sequenceName + "_audio_" + timestamp + ".wav";
    var separator = outputFolder.indexOf("/") !== -1 ? "/" : "\\";
    var lastChar = outputFolder.charAt(outputFolder.length - 1);
    var outputPath = outputFolder + (lastChar === separator ? "" : separator) + filename;
    debugInfo.outputPath = outputPath;

    // Resolve preset
    var audioPresetPath = "";
    if (externalPresetPath) {
      var eprFile = new File(externalPresetPath);
      if (eprFile.exists) {
        audioPresetPath = eprFile.fsName;
      } else {
        log("External preset not found: " + externalPresetPath);
      }
    }
    if (!audioPresetPath) {
      var presetResult = getPresetFilePath(outputFolder);
      audioPresetPath = presetResult.path || "";
    }
    if (!audioPresetPath) {
      return JSON.stringify({ success: false, error: "Audio preset not found", debug: debugInfo });
    }
    debugInfo.presetPath = audioPresetPath;

    // Verify preset still exists immediately before export
    var preExportCheck = new File(audioPresetPath);
    if (!preExportCheck.exists) {
      log("CRITICAL: Preset file missing at export time: " + audioPresetPath);
      return JSON.stringify({
        success: false,
        error: "Preset file missing at export time: " + audioPresetPath,
        debug: debugInfo,
      });
    }

    // Access QE DOM for per-track mute/solo control
    app.enableQE();
    var qeSequence = (qe.project as any).getActiveSequence();
    if (!qeSequence) {
      return JSON.stringify({ success: false, error: "QE sequence not available", debug: debugInfo });
    }

    // Snapshot original track states so we can restore them unconditionally
    var originalStates: any[] = [];
    for (var i = 0; i < qeSequence.numAudioTracks; i++) {
      var qeTrack = qeSequence.getAudioTrackAt(i);
      if (qeTrack) {
        var originalState = { index: i, muted: false, solo: false };
        if (typeof qeTrack.isMuted === "function") originalState.muted = qeTrack.isMuted();
        if (typeof qeTrack.isSolo === "function") originalState.solo = qeTrack.isSolo();
        originalStates.push(originalState);
      }
    }

    // Track state changes and range changes are restored in the finally block
    var tempInOutSet = false;
    var originalInPoint: any = null;
    var originalOutPoint: any = null;

    try {
      // Apply selective track control when a subset is requested
      if (selectedTracks.length > 0) {
        // Determine which API is available by checking the first track
        var firstQeTrack = qeSequence.getAudioTrackAt(0);
        var hasSolo = firstQeTrack && typeof firstQeTrack.setSolo === "function";
        var hasMute = firstQeTrack && typeof firstQeTrack.setMute === "function";

        for (var j = 0; j < qeSequence.numAudioTracks; j++) {
          var qeTrack2 = qeSequence.getAudioTrackAt(j);
          if (!qeTrack2) continue;
          var shouldExport = AK_indexOf(selectedTracks, j + 1) !== -1;
          if (hasSolo) {
            qeTrack2.setSolo(shouldExport);
          } else if (hasMute) {
            qeTrack2.setMute(!shouldExport);
          }
        }
      }

      // Determine export range
      var workAreaType = 0; // 0 = entire sequence
      var timeOffsetSeconds = 0;
      var rangeType = (selectedRange || "entire").toLowerCase();

      if (rangeType === "inout") {
        workAreaType = 1;
        log("Using In/Out range for export");
        timeOffsetSeconds = getSequenceInPointSeconds(sequence);
      } else if (rangeType === "selected" || rangeType === "selection") {
        log("Getting selected clips range...");
        originalInPoint = sequence.getInPoint();
        originalOutPoint = sequence.getOutPoint();

        var selectionRange = getSelectedClipsTimeRange(sequence);
        if (selectionRange.success) {
          timeOffsetSeconds = selectionRange.startTime || 0;
          if (
            typeof selectionRange.startTime === "number" &&
            typeof selectionRange.endTime === "number"
          ) {
            sequence.setInPoint(
              Math.round(selectionRange.startTime * TICKS_PER_SECOND).toString()
            );
            sequence.setOutPoint(
              Math.round(selectionRange.endTime * TICKS_PER_SECOND).toString()
            );
          }
          tempInOutSet = true;
          workAreaType = 1;
          log("Temporary In/Out set for selection export. Offset: " + timeOffsetSeconds);
        } else {
          log("No valid selection — falling back to entire timeline");
          workAreaType = 0;
          timeOffsetSeconds = 0;
        }
      }

      var exportResult = sequence.exportAsMediaDirect(outputPath, audioPresetPath, workAreaType);

      if (exportResult === "No Error" || exportResult === true || exportResult === 0) {
        log("Audio exported successfully: " + outputPath);
        return JSON.stringify({
          success: true,
          outputPath: outputPath,
          filename: filename,
          timeOffsetSeconds: timeOffsetSeconds,
          debug: debugInfo,
        });
      } else {
        log("Export failed with result: " + exportResult);
        return JSON.stringify({
          success: false,
          error: "Export failed: " + exportResult,
          debug: debugInfo,
        });
      }
    } finally {
      // Always restore In/Out points if we temporarily changed them
      if (tempInOutSet) {
        log("Restoring original sequence In/Out points");
        try {
          if (originalInPoint !== null) sequence.setInPoint(originalInPoint);
          if (originalOutPoint !== null) sequence.setOutPoint(originalOutPoint);
        } catch (e) {
          log("Error restoring In/Out points: " + e);
        }
      }

      // Always restore track mute/solo states
      for (var k = 0; k < originalStates.length; k++) {
        var state = originalStates[k];
        var qeTrackRestore = qeSequence.getAudioTrackAt(state.index);
        if (qeTrackRestore) {
          try {
            if (typeof qeTrackRestore.setSolo === "function") qeTrackRestore.setSolo(state.solo);
            if (typeof qeTrackRestore.setMute === "function") qeTrackRestore.setMute(state.muted);
          } catch (e) {
            log("Error restoring track state at index " + state.index + ": " + e);
          }
        }
      }
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.toString(), debug: debugInfo });
  }
}

// ==============================================================================
// SUBTITLES / CAPTIONS MODULE
// ==============================================================================

/**
 * Imports an SRT file into the project and creates a caption track on the active sequence.
 */
export function importSRTFile(filePath: string): string {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "No project open" });
    if (!app.project.activeSequence)
      return JSON.stringify({ success: false, error: "No active sequence" });

    var sequence = app.project.activeSequence;
    var rootItem = app.project.rootItem;
    var childCountBefore = rootItem.children.numItems;

    // 1. Import the SRT file into the project bin
    app.project.importFiles([filePath], true, rootItem, false);

    // 2. Find the newly imported project item
    var srtItem = null;
    var childCountAfter = rootItem.children.numItems;

    if (childCountAfter > childCountBefore) {
      // A new item was added — it is the last child
      srtItem = rootItem.children[childCountAfter - 1];
    } else {
      // File may already have been in the project — search by name
      var srtFile = new File(filePath);
      var srtName = srtFile.name.replace(/\.[^.]+$/, ""); // strip extension
      for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
        var child = rootItem.children[i];
        if (child.name && child.name.indexOf(srtName) !== -1) {
          srtItem = child;
          break;
        }
      }
    }

    if (!srtItem) {
      return JSON.stringify({
        success: false,
        error: "Could not find imported SRT in project bin",
      });
    }

    // 3. Create a caption track on the active sequence
    try {
      var captionResult = (sequence as any).createCaptionTrack(srtItem, 0);
      return JSON.stringify({
        success: true,
        method: "createCaptionTrack",
        captionResult: captionResult !== undefined ? String(captionResult) : "ok",
        itemName: srtItem.name,
      });
    } catch (captionErr: any) {
      // createCaptionTrack is not available in all Premiere versions; fall back to import-only
      log("createCaptionTrack failed: " + captionErr.toString());
      return JSON.stringify({
        success: true,
        method: "importOnly",
        warning: "createCaptionTrack failed: " + captionErr.toString(),
        itemName: srtItem.name,
      });
    }
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
}

/**
 * Moves the playhead of the active sequence to the specified time.
 */
export function jumpToTime(seconds: number): string {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "No project open" });
    if (!app.project.activeSequence)
      return JSON.stringify({ success: false, error: "No active sequence" });

    var sequence = app.project.activeSequence;
    var ticks = Math.round(seconds * TICKS_PER_SECOND).toString();
    sequence.setPlayerPosition(ticks);

    return JSON.stringify({ success: true });
  } catch (e: any) {
    return JSON.stringify({ success: false, error: e.toString() });
  }
}

/**
 * Build a slideshow on the active sequence: import each media file and lay the
 * clips end-to-end on a video track, then drop an optional voice-over onto an
 * audio track. Placement only — no transforms, no keyframes.
 *
 * `specJson` is a JSON string:
 *   {
 *     items: [{ path: string, start: number, end: number }],  // seconds, in play order
 *     audio_path?: string,
 *     target_video_track?: number,   // 1-based, default 1
 *     default_still_secs?: number,   // fallback clip length
 *   }
 *
 * Returns JSON: { success, lines, appended, requested } (or { success:false, error }).
 */
export function buildStoryboard(specJson: string): string {
  try {
    if (!app.project) return JSON.stringify({ success: false, error: "No project open" });
    if (!app.project.activeSequence)
      return JSON.stringify({ success: false, error: "No active sequence" });

    var spec: any;
    try {
      spec = JSON.parse(specJson);
    } catch (parseErr: any) {
      return JSON.stringify({ success: false, error: "Bad spec: " + parseErr.toString() });
    }

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

    function secondsToTime(secs: number): any {
      // @ts-ignore - Time is an ExtendScript global provided by the host.
      var tt = new Time();
      tt.seconds = secs;
      return tt;
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
     * Set a project item's in/out points so the next insert only takes that
     * section. mediaType 4 means "video and audio"; older builds want the two
     * streams set separately, so both shapes are attempted. Returns whether the
     * range stuck.
     */
    function setItemRange(mp: any, inSec: number, outSec: number): boolean {
      if (!mp || typeof mp.setInPoint !== "function") return false;
      var ok = false;
      var types = [4, 1, 2]; // both, video, audio
      for (var i = 0; i < types.length; i++) {
        try {
          mp.setInPoint(inSec, types[i]);
          if (outSec > inSec) mp.setOutPoint(outSec, types[i]);
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
     * length, which would run on past the picture.
     */
    function trimAudioAt(startSec: number, endSec: number): void {
      var s = seq();
      if (!s || !s.audioTracks) return;
      for (var t = 0; t < s.audioTracks.numTracks; t++) {
        var track = s.audioTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];
          try {
            if (Math.abs(getTimeSeconds(clip.start) - startSec) > 0.05) continue;
            if (getTimeSeconds(clip.end) > endSec) clip.end = secondsToTime(endSec);
          } catch (e) {}
        }
      }
    }

    /** Where the last clip on `track` ends, in seconds (0 for an empty track). */
    function trackEndSeconds(track: any): number {
      if (!track || !track.clips) return 0;
      var end = 0;
      for (var i = 0; i < track.clips.numItems; i++) {
        try {
          var e = getTimeSeconds(track.clips[i].end);
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
     * Place `mp` at `startSec` on `track`. Premiere versions disagree on whether
     * overwriteClip wants a Time object, plain seconds or a tick string, so each
     * is tried in turn and the clip count decides whether anything landed.
     */
    function placeClip(track: any, mp: any, startSec: number): any {
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
      var attempts = [
        { label: "time", value: secondsToTime(startSec) },
        { label: "secs", value: startSec },
        { label: "ticks", value: String(Math.round(startSec * TICKS_PER_SECOND)) },
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
    var cursor = trackEndSeconds(videoTrackAt(vIndex));

    for (var it = 0; it < items.length; it++) {
      var item = items[it];
      var path = item ? item.path : null;
      var reqStart = item && item.start > 0 ? item.start : 0;
      var reqEnd = item && item.end > reqStart ? item.end : reqStart + defaultStill;
      var spanSec = reqEnd - reqStart;
      if (spanSec <= 0) spanSec = defaultStill;

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
      var rangeApplied = false;
      if (hasRange) rangeApplied = setItemRange(mp, srcIn, srcOut);

      var trimTo = still ? spanSec : 0;
      // If Premiere wouldn't take the in/out, fall back to cutting the placed
      // clip to the right length (the start offset is lost, but the duration is
      // still honoured instead of dropping a whole long video onto the timeline).
      if (hasRange && !rangeApplied && srcOut > 0) trimTo = srcOut - srcIn;

      var startSec = reqStart > cursor ? reqStart : cursor;
      var audioBefore = audioClipCount();
      var placed = placeClip(videoTrackAt(vIndex), mp, startSec);

      if (!placed) {
        lines[lines.length] =
          "Could not place: " + baseNameOf(path) + (lastPlaceErr ? " [" + lastPlaceErr + "]" : "");
        continue;
      }
      appended++;

      var endedAt = startSec + spanSec;

      // Placing on a video track normally carries the linked audio across. If
      // this build of Premiere didn't, put the audio on A1 so the clip's own
      // sound is not silently dropped. Stills have none to carry.
      if (!still && audioClipCount() === audioBefore) {
        var s0 = seq();
        if (s0 && s0.audioTracks && s0.audioTracks.numTracks > 0) {
          placeClip(s0.audioTracks[0], mp, startSec);
        }
      }

      if (trimTo > 0) {
        // Stills carry Premiere's own default duration and videos come in whole;
        // either way, cut back to the requested length.
        endedAt = startSec + trimTo;
        try {
          placed.end = secondsToTime(endedAt);
        } catch (trimErr) {
          lines[lines.length] = "Placed but could not trim: " + baseNameOf(path);
        }
        if (!still) trimAudioAt(startSec, endedAt);
      } else {
        // Video keeps its full length — read back where it actually ended.
        try {
          var realEnd = getTimeSeconds(placed.end);
          if (realEnd > startSec) endedAt = realEnd;
        } catch (endErr) {}
      }

      // Leave the bin item as we found it — an in/out left behind would silently
      // shorten the clip the next time anyone drags it in.
      if (rangeApplied) clearItemRange(mp, 0);

      lines[lines.length] =
        baseNameOf(path) + ": " + (still ? "still" : "video") +
        (hasRange ? " src=" + srcIn + "-" + (srcOut || "end") +
          (rangeApplied ? "" : " (in/out refused)") : "") +
        " -> " + (Math.round((endedAt - startSec) * 10) / 10) + "s";
      cursor = endedAt;
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