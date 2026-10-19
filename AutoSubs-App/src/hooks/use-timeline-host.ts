import { useResolve } from "@/contexts/ResolveContext"
import { useAdobe } from "@/contexts/AdobeContext"
import { useCapCut } from "@/contexts/CapCutContext"
import { useIntegration } from "@/contexts/IntegrationContext"
import {
  buildStoryboard as resolveBuildStoryboard,
  type BuildStoryboardSpec,
  type BuildStoryboardResult,
} from "@/api/resolve-api"
import {
  saveAdHocSubtitleDocument,
  type TextCueInput,
} from "@/lib/timeline-actions"
import type { TimelineLanguageMode } from "@/lib/subtitle-documents"
import type { Speaker, TimelineInfo } from "@/types"

export interface AddTextCuesOptions {
  template?: string
  outputTrack?: string
  presetSettings?: Record<string, unknown>
  languageMode?: TimelineLanguageMode
  displayName?: string
  speakers?: Speaker[]
}

/**
 * Unified host editor interface (DaVinci Resolve, Premiere Pro, After Effects, CapCut),
 * chosen automatically from the user's selected integration.
 */
export interface TimelineHost {
  /** "davinci" | "premiere" | "aftereffects" | "capcut". */
  kind: string
  /** Human label for status messages ("DaVinci Resolve", "Premiere Pro", "After Effects", "CapCut"). */
  hostName: string
  timelineInfo: TimelineInfo
  isConnected: boolean
  getSourceAudio: (
    audioInputMode: "file" | "timeline",
    fileInput: string | null,
    inputTracks: string[],
  ) => Promise<{ path: string; offset: number } | null>
  buildStoryboard: (spec: BuildStoryboardSpec) => Promise<BuildStoryboardResult>
  pushToTimeline: (
    filename?: string,
    selectedTemplate?: string,
    selectedOutputTrack?: string,
    presetSettings?: Record<string, unknown>,
    languageMode?: TimelineLanguageMode,
  ) => Promise<void>
  addTextCuesToTimeline: (
    cues: TextCueInput[],
    options?: AddTextCuesOptions,
  ) => Promise<string>
  jumpToTime: (seconds: number) => Promise<void>
}

export function useTimelineHost(): TimelineHost {
  const { selectedIntegration } = useIntegration()
  const resolve = useResolve()
  const adobe = useAdobe()
  const capcut = useCapCut()

  const isAdobe =
    selectedIntegration === "premiere" || selectedIntegration === "aftereffects"
  const isCapCut = selectedIntegration === "capcut"

  const hostName =
    selectedIntegration === "premiere"
      ? "Premiere Pro"
      : selectedIntegration === "aftereffects"
        ? "After Effects"
        : selectedIntegration === "capcut"
          ? "CapCut"
          : "DaVinci Resolve"

  const pushToTimeline = async (
    filename?: string,
    selectedTemplate?: string,
    selectedOutputTrack?: string,
    presetSettings?: Record<string, unknown>,
    languageMode?: TimelineLanguageMode,
  ) => {
    if (isCapCut) {
      await capcut.pushToTimeline(filename, selectedTemplate, languageMode)
      return
    }
    if (isAdobe) {
      await adobe.pushToTimeline(filename, languageMode)
      return
    }
    await resolve.pushToTimeline(
      filename,
      selectedTemplate,
      selectedOutputTrack,
      presetSettings,
      languageMode,
    )
  }

  const timelineInfo = isCapCut
    ? capcut.timelineInfo
    : isAdobe
      ? adobe.timelineInfo
      : resolve.timelineInfo

  const addTextCuesToTimeline = async (
    cues: TextCueInput[],
    options: AddTextCuesOptions = {},
  ): Promise<string> => {
    const filename = await saveAdHocSubtitleDocument(cues, {
      displayName: options.displayName,
      speakers: options.speakers,
      timelineId: timelineInfo.timelineId,
      timelineName: timelineInfo.name,
    })
    await pushToTimeline(
      filename,
      options.template,
      options.outputTrack,
      options.presetSettings,
      options.languageMode,
    )
    return filename
  }

  if (isCapCut) {
    return {
      kind: selectedIntegration,
      hostName,
      timelineInfo: capcut.timelineInfo,
      isConnected: capcut.isConnected,
      getSourceAudio: capcut.getSourceAudio,
      buildStoryboard: capcut.buildStoryboard,
      pushToTimeline,
      addTextCuesToTimeline,
      jumpToTime: capcut.jumpToTime,
    }
  }

  if (isAdobe) {
    return {
      kind: selectedIntegration,
      hostName,
      timelineInfo: adobe.timelineInfo,
      isConnected: adobe.isConnected,
      getSourceAudio: adobe.getSourceAudio,
      buildStoryboard: adobe.buildStoryboard,
      pushToTimeline,
      addTextCuesToTimeline,
      jumpToTime: adobe.jumpToTime,
    }
  }

  return {
    kind: selectedIntegration,
    hostName,
    timelineInfo: resolve.timelineInfo,
    isConnected: Boolean(resolve.timelineInfo.timelineId),
    getSourceAudio: resolve.getSourceAudio,
    buildStoryboard: resolveBuildStoryboard,
    pushToTimeline,
    addTextCuesToTimeline,
    jumpToTime: resolve.jumpToTime,
  }
}
