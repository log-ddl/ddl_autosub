import { invoke } from "@tauri-apps/api/core";

/** Something the preview panel can open: a folder under motion-graphics/, or a code video project. */
export interface PreviewTarget {
  name: string;
  path: string;
  /**
   * "static": served by the app (HTML, TS transpiled). "dev": runs the project's dev script.
   * "studio": a project in the working folder's projects/, shown in its Remotion Studio.
   */
  kind: "static" | "dev" | "studio";
  /** The project id, for "studio". */
  id?: string;
  modifiedSec?: number;
}

export interface PreviewInfo {
  url: string;
  kind: "static" | "dev" | "studio";
  root: string;
}

export async function startPreview(path: string): Promise<PreviewInfo> {
  return invoke<PreviewInfo>("preview_start", { path });
}

export async function stopPreview(): Promise<void> {
  return invoke<void>("preview_stop");
}

export async function getPreviewLogs(): Promise<string> {
  return invoke<string>("preview_logs");
}

/** Previewable folders / .html files in `dir` changed at or after `sinceSec`. */
export async function listPreviewCandidates(
  dir: string,
  sinceSec = 0,
): Promise<PreviewTarget[]> {
  return invoke<PreviewTarget[]>("preview_candidates", { dir, sinceSec });
}
