import { create } from "zustand";

// Which top-level workspace tab is active. The app opens straight into a
// tabbed shell (no separate mode-picker landing screen); AI Edit is the
// default. Not persisted — resets to the default each launch.
export type AppMode = "autosub" | "aiedit" | "download";

const DEFAULT_MODE: AppMode = "aiedit";

interface AppModeStore {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useAppModeStore = create<AppModeStore>((set) => ({
  mode: DEFAULT_MODE,
  setMode: (mode) => set({ mode }),
}));
