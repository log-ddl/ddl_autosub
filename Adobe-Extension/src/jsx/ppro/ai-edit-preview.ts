// ==============================================================================
// AI EDIT: FRAME PREVIEW
// ==============================================================================
//
// ExportFrames writes the sequence's picture at some times as PNG files, so
// the agent can look at what it placed. The app lays them out as a contact
// sheet. QE's exportFramePNG takes a display timecode (with the sequence's
// zero point) and a path; some versions add ".png" themselves, so the path is
// given without it and the reply names the file that appeared.

import { timecodeAt } from "./ai-edit-util";
import { getSequenceStartSeconds } from "./ppro";

function fileAt(base: string): string {
  var candidates = [base + ".png", base];
  for (var i = 0; i < candidates.length; i++) {
    // @ts-ignore - File is an ExtendScript global.
    if (new File(candidates[i]).exists) return candidates[i];
  }
  return "";
}

/**
 * args: { dir: string, times: number[] } (seconds from the sequence start).
 * Returns { success, frames: [{ sec, path }], lines } where path is "" when
 * Premiere wrote nothing (yet: the app waits a moment for late files).
 */
export function exportFrames(seq: any, args: any): string {
  var dir = String(args.dir || "");
  var times: number[] = args.times || [];
  if (!dir || !times.length) return JSON.stringify({ success: false, error: "dir and times are required" });
  // @ts-ignore - Folder is an ExtendScript global.
  var folder = new Folder(dir);
  if (!folder.exists) folder.create();
  app.enableQE();
  // @ts-ignore - qe is the QE DOM global, enabled above.
  var qeSeq: any = qe.project.getActiveSequence();
  if (!qeSeq) return JSON.stringify({ success: false, error: "QE has no active sequence" });

  var zero = getSequenceStartSeconds(seq);
  var sep = dir.indexOf("\\") !== -1 && dir.indexOf("/") === -1 ? "\\" : "/";
  var frames: any[] = [];
  var lines: string[] = [];
  for (var i = 0; i < times.length; i++) {
    var secs = Number(times[i]);
    var base = dir + sep + "frame-" + (i + 1);
    var tc = timecodeAt(seq, secs + zero);
    var ok = false;
    try {
      ok = qeSeq.exportFramePNG(tc, base);
    } catch (e) {
      try {
        ok = qeSeq.exportFramePNG(tc, base, "");
      } catch (e2) {
        lines[lines.length] = "Frame at " + secs + "s failed: " + e2;
      }
    }
    var path = fileAt(base);
    frames[frames.length] = { sec: secs, path: path, base: base, ok: !!ok };
  }
  return JSON.stringify({ success: true, frames: frames, lines: lines });
}
