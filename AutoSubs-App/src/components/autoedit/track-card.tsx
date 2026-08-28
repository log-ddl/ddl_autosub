import { AudioLines, Captions, Check, MonitorIcon } from "lucide-react"
import { InfoHint } from "@/components/ui/info-hint"
import { cn } from "@/lib/utils"
import type { Track } from "@/types"

/**
 * The app's standard timeline-track picker card: a titled panel of track rows,
 * each with a circular check, a video/audio icon, the track name and its index
 * badge. Shared so AutoCut and the slideshow (and anything later) present track
 * selection identically.
 *
 * `mode` switches selection semantics without changing the look:
 *   - "multi"  (default): rows toggle independently; `value` may hold several.
 *   - "single": rows behave like radios; picking one replaces the selection.
 */
export function TrackCard({
  title,
  kind,
  tracks,
  value,
  onChange,
  emptyLabel,
  noneLabel,
  disabled,
  hint,
  mode = "multi",
}: {
  title: string
  kind: "video" | "audio" | "subtitle"
  tracks: Track[]
  /** Selected track values. In single mode this holds 0 or 1 entry. */
  value: string[]
  onChange: (value: string[]) => void
  /** Shown when the timeline has no tracks of this kind at all. */
  emptyLabel: string
  /** Shown in place of the title when nothing is selected (multi mode). */
  noneLabel?: string
  disabled?: boolean
  /** Optional tooltip on the header icon. */
  hint?: string
  mode?: "single" | "multi"
}) {
  const Icon =
    kind === "video" ? MonitorIcon : kind === "subtitle" ? Captions : AudioLines

  const pick = (trackValue: string) => {
    if (mode === "single") {
      onChange([trackValue])
      return
    }
    onChange(
      value.includes(trackValue)
        ? value.filter((v) => v !== trackValue)
        : [...value, trackValue],
    )
  }

  const headerLabel =
    value.length === 0 && noneLabel
      ? noneLabel
      : value.length > 1
        ? `${title} (${value.length})`
        : title

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border transition-colors",
        value.length > 0 ? "bg-background" : "bg-muted/20",
      )}
    >
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground">
        {hint ? (
          <InfoHint icon={Icon} text={hint} />
        ) : (
          <Icon className="size-4" />
        )}
        <span className="truncate">{headerLabel}</span>
      </div>
      {tracks.length === 0 ? (
        <div className="px-3 pb-3 text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-1.5 p-2 pt-0">
          {tracks.map((track, index) => {
            const selected = value.includes(track.value)
            return (
              <button
                key={track.value}
                type="button"
                role={mode === "single" ? "radio" : "checkbox"}
                aria-checked={selected}
                disabled={disabled}
                onClick={() => pick(track.value)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-all disabled:opacity-60",
                  selected
                    ? "bg-card shadow-sm"
                    : "border-transparent bg-transparent hover:bg-muted/50",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "border-muted-foreground/40",
                  )}
                >
                  {selected ? <Check className="size-2.5" /> : null}
                </span>
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    selected ? "text-foreground" : "text-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm font-medium transition-colors",
                    selected ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {track.label}
                </span>
                <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-muted/30 px-2 text-xs font-semibold text-muted-foreground/70">
                  {index + 1}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
