import { useResolve } from "@/contexts/ResolveContext"
import { useAdobe } from "@/contexts/AdobeContext"
import { useIntegration } from "@/contexts/IntegrationContext"
import {
  buildStoryboard as resolveBuildStoryboard,
  type BuildStoryboardSpec,
  type BuildStoryboardResult,
} from "@/api/resolve-api"
import type { TimelineInfo } from "@/types"

/**
 * The bits of a host editor the slideshow needs, with the host chosen from the
 * user's selected integration. Resolve talks over its local HTTP bridge; the
 * Adobe hosts ride the websocket bridge. Both providers are always mounted (see
 * EditorWorkspaceProviders), so we can read both and pick at call time — the
 * Slideshow panel stays host-agnostic.
 */
export interface TimelineHost {
  /** "davinci" | "premiere" | "aftereffects". */
  kind: string
  /** Human label for status messages ("DaVinci Resolve", "Premiere Pro"). */
  hostName: string
  timelineInfo: TimelineInfo
  isConnected: boolean
  getSourceAudio: (
    audioInputMode: "file" | "timeline",
    fileInput: string | null,
    inputTracks: string[],
  ) => Promise<{ path: string; offset: number } | null>
  buildStoryboard: (spec: BuildStoryboardSpec) => Promise<BuildStoryboardResult>
}

export function useTimelineHost(): TimelineHost {
  const { selectedIntegration } = useIntegration()
  const resolve = useResolve()
  const adobe = useAdobe()

  const isAdobe =
    selectedIntegration === "premiere" || selectedIntegration === "aftereffects"

  const hostName =
    selectedIntegration === "premiere"
      ? "Premiere Pro"
      : selectedIntegration === "aftereffects"
        ? "After Effects"
        : "DaVinci Resolve"

  if (isAdobe) {
    return {
      kind: selectedIntegration,
      hostName,
      timelineInfo: adobe.timelineInfo,
      isConnected: adobe.isConnected,
      getSourceAudio: adobe.getSourceAudio,
      buildStoryboard: adobe.buildStoryboard,
    }
  }

  return {
    kind: selectedIntegration,
    hostName,
    timelineInfo: resolve.timelineInfo,
    isConnected: Boolean(resolve.timelineInfo.timelineId),
    getSourceAudio: resolve.getSourceAudio,
    buildStoryboard: resolveBuildStoryboard,
  }
}
