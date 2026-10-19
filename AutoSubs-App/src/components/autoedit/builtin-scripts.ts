import {
  Captions,
  ClipboardList,
  Eraser,
  ListOrdered,
  MapPin,
  Pause,
  ScanSearch,
  Scissors,
  type LucideIcon,
} from "lucide-react"
import {
  addMarkerAtPlayhead,
  clearTimelineMarkers,
  findTimelineGaps,
  getResolveInfo,
  getYoutubeChapters,
  markClipCuts,
  markersFromSubtitles,
  markSpeechGaps,
} from "@/api/resolve-api"

// A value the user picks before a script runs. Track pickers are filled from
// the live timeline; `seconds` is a free number with sane bounds.
export type OptionSpec =
  | {
      key: string
      kind: "videoTrack" | "audioTrack" | "subtitleTrack"
      labelKey: string
      fallback: number
    }
  | {
      key: string
      kind: "seconds"
      labelKey: string
      hintKey: string
      fallback: number
      min: number
      max: number
      step: number
    }

export type OptionValues = Record<string, number>

// Groups the built-in scripts by purpose so the list reads as a small toolbox
// rather than a flat pile. Order here is the order the sections render in.
export type BuiltinCategory = "cut" | "markers" | "cleanup" | "info"

export const BUILTIN_CATEGORY_ORDER: BuiltinCategory[] = [
  "cut",
  "markers",
  "cleanup",
  "info",
]

export interface BuiltinScript {
  id: string
  category: BuiltinCategory
  action: (values: OptionValues) => Promise<string[]>
  nameKey: string
  descriptionKey: string
  // Depicts what this script does; the description sits behind it on hover.
  icon: LucideIcon
  // Omitted for scripts that take no parameters; those run on the first click.
  options?: OptionSpec[]
}

// Built-in actions are implemented as endpoints on the AutoSubs Lua server
// (which runs inside Resolve), so they work on the free edition of Resolve
// and need no local Python at all.
export const BUILTIN_SCRIPTS: BuiltinScript[] = [
  {
    id: "resolve-info",
    category: "info",
    icon: ClipboardList,
    action: getResolveInfo,
    nameKey: "modePicker.autoedit.builtin.resolveInfo.name",
    descriptionKey: "modePicker.autoedit.builtin.resolveInfo.description",
  },
  {
    id: "add-marker",
    category: "markers",
    icon: MapPin,
    action: addMarkerAtPlayhead,
    nameKey: "modePicker.autoedit.builtin.addMarker.name",
    descriptionKey: "modePicker.autoedit.builtin.addMarker.description",
  },
  {
    id: "youtube-chapters",
    category: "markers",
    icon: ListOrdered,
    action: getYoutubeChapters,
    nameKey: "modePicker.autoedit.builtin.chapters.name",
    descriptionKey: "modePicker.autoedit.builtin.chapters.description",
  },
  {
    id: "mark-cuts",
    category: "cut",
    icon: Scissors,
    action: (v) => markClipCuts(v.track),
    nameKey: "modePicker.autoedit.builtin.markCuts.name",
    descriptionKey: "modePicker.autoedit.builtin.markCuts.description",
    options: [
      {
        key: "track",
        kind: "videoTrack",
        labelKey: "modePicker.autoedit.options.videoTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "subtitle-markers",
    category: "markers",
    icon: Captions,
    action: (v) => markersFromSubtitles(v.track),
    nameKey: "modePicker.autoedit.builtin.subtitleMarkers.name",
    descriptionKey: "modePicker.autoedit.builtin.subtitleMarkers.description",
    options: [
      {
        key: "track",
        kind: "subtitleTrack",
        labelKey: "modePicker.autoedit.options.subtitleTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "speech-gaps",
    category: "cut",
    icon: Pause,
    action: (v) => markSpeechGaps(v.minSeconds, v.track),
    nameKey: "modePicker.autoedit.builtin.speechGaps.name",
    descriptionKey: "modePicker.autoedit.builtin.speechGaps.description",
    options: [
      {
        key: "track",
        kind: "subtitleTrack",
        labelKey: "modePicker.autoedit.options.subtitleTrack",
        fallback: 1,
      },
      {
        key: "minSeconds",
        kind: "seconds",
        labelKey: "modePicker.autoedit.options.minPause",
        hintKey: "modePicker.autoedit.options.minPauseHint",
        fallback: 2,
        min: 0.2,
        max: 60,
        step: 0.1,
      },
    ],
  },
  {
    id: "timeline-gaps",
    category: "cut",
    icon: ScanSearch,
    action: (v) => findTimelineGaps(v.track),
    nameKey: "modePicker.autoedit.builtin.timelineGaps.name",
    descriptionKey: "modePicker.autoedit.builtin.timelineGaps.description",
    options: [
      {
        key: "track",
        kind: "videoTrack",
        labelKey: "modePicker.autoedit.options.videoTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "clear-markers",
    category: "cleanup",
    icon: Eraser,
    action: () => clearTimelineMarkers(),
    nameKey: "modePicker.autoedit.builtin.clearMarkers.name",
    descriptionKey: "modePicker.autoedit.builtin.clearMarkers.description",
  },
]

export function defaultValues(script: BuiltinScript): OptionValues {
  const values: OptionValues = {}
  for (const option of script.options ?? []) values[option.key] = option.fallback
  return values
}
