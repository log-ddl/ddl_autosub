import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The working folder and whether the Remotion environment is installed into it. */
export interface StudioStatus {
  /** The working folder (also the external agents' home). */
  root: string;
  busy: boolean;
  /** "files" | "node" | "python" | "docs" | "links" while busy. */
  stage: string | null;
  error: string | null;
  node: boolean;
  python: boolean;
  docs: boolean;
  ready: boolean;
}

/** A code video project in the working folder's `projects/`. */
export interface StudioProject {
  id: string;
  title: string;
  path: string;
  modifiedSec: number;
}

/** A skill in the working folder's `skills/`. */
export interface StudioSkill {
  folder: string;
  name: string;
  description: string;
  path: string;
}

export interface StudioInfo {
  id: string;
  url: string;
}

export function getStudioStatus(): Promise<StudioStatus> {
  return invoke<StudioStatus>("studio_status");
}

/** Installs or updates the environment and links it into the working folder. */
export function setupStudio(): Promise<StudioStatus> {
  return invoke<StudioStatus>("studio_setup");
}

export function setStudioRoot(path: string): Promise<StudioStatus> {
  return invoke<StudioStatus>("studio_set_root", { path });
}

export function onStudioStatus(cb: (s: StudioStatus) => void): Promise<UnlistenFn> {
  return listen<StudioStatus>("studio-status", (e) => cb(e.payload));
}

export function listStudioProjects(): Promise<StudioProject[]> {
  return invoke<StudioProject[]>("studio_projects");
}

/** Builds the project and starts its Remotion Studio (stopping any other). */
export function openStudio(id: string): Promise<StudioInfo> {
  return invoke<StudioInfo>("studio_open", { id });
}

export function stopStudio(id?: string): Promise<void> {
  return invoke<void>("studio_stop", { id });
}

export function getStudioLogs(): Promise<string> {
  return invoke<string>("studio_logs");
}

export function listStudioSkills(): Promise<StudioSkill[]> {
  return invoke<StudioSkill[]>("studio_skills");
}

/** Copies skill folders into the working folder's `skills/`. Rejects with "EXISTS:<folder>" when one is there and `replace` is false. */
export function importStudioSkills(source: string, replace = false): Promise<string[]> {
  return invoke<string[]>("studio_import_skills", { source, replace });
}

export function removeStudioSkill(folder: string): Promise<void> {
  return invoke<void>("studio_remove_skill", { folder });
}
