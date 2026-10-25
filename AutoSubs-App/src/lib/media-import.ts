import { open as openDialog } from "@tauri-apps/plugin-dialog"

// The folder the Download workspace last saved into.
export const DOWNLOAD_DIR_KEY = "autosubs.download.lastDir"

export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** Open folder picker for downloads and persist in localStorage. */
export async function pickDownloadFolder(): Promise<string> {
  const picked = await openDialog({ directory: true, multiple: false })
  if (typeof picked !== "string") return ""
  localStorage.setItem(DOWNLOAD_DIR_KEY, picked)
  return picked
}
