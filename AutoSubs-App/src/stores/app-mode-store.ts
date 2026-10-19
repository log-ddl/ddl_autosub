import { create } from "zustand";

// Which top-level workspace tab is active. The app opens straight into a
// tabbed shell (no separate mode-picker landing screen); AutoCut is the
// default. Not persisted — resets to the default each launch.
export type AppMode = "autocut" | "autosub" | "aiedit" | "scripts" | "download";

const DEFAULT_MODE: AppMode = "autocut";

interface AppModeStore {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  // Back to the default tab (used to leave a setup screen).
  resetMode: () => void;
}

export const useAppModeStore = create<AppModeStore>((set) => ({
  mode: DEFAULT_MODE,
  setMode: (mode) => set({ mode }),
  resetMode: () => set({ mode: DEFAULT_MODE }),
}));
