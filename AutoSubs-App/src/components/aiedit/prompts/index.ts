// System prompts for AI Edit, one file per editor plus shared.ts. Each
// editor's adapter (../editors/<editor>.ts) calls its own builder.

export { buildCapCutPrompt } from "./capcut";
export { buildDavinciPrompt, type DavinciTimelineSnapshot } from "./davinci";
export { buildPremierePrompt, type PremiereTimelineSnapshot } from "./premiere";
