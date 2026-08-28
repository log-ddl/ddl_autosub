import type { LucideIcon } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * The app-wide way to explain a control.
 *
 * Keep the label short and put the explanation behind this icon rather than in
 * a caption underneath. A sentence under every switch and slider reads fine in
 * isolation but stacks up fast: it is what pushed the AutoCut panel past the
 * window height, hiding the button the whole workflow ends with.
 *
 * Two rules make a screenful of these readable:
 *
 * - Give every control its own icon that depicts what it does. A row of
 *   identical "i" badges carries no information, so the eye has to read every
 *   label to find anything; distinct glyphs let it jump straight there.
 * - Place it *before* the label text, matching the icon-then-label rhythm of
 *   the workspace tab bar. Labels vary in length, so a trailing icon lands in a
 *   different spot on every row and the column reads as ragged.
 *
 * Requires a `TooltipProvider` above it — `WorkspaceShell` already provides one
 * for every panel.
 */
export function InfoHint({
  icon: Icon,
  text,
  side = "top",
  className,
}: {
  /** Depicts this specific control — see the rule above. */
  icon: LucideIcon
  text: string
  side?: "top" | "right" | "bottom" | "left"
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          // These often sit inside a <label> wrapping a switch, where any click
          // would toggle the control. Reading the hint must not change it.
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          className={cn(
            "inline-flex shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs">
        <p className="text-xs leading-snug">{text}</p>
      </TooltipContent>
    </Tooltip>
  )
}
