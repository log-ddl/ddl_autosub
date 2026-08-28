// Effect presets for the "Slideshow from voice" built-in.
//
// This is the single source of truth for what per-clip looks the slideshow can
// apply. Adding a new preset is one entry in EFFECT_PRESETS — nothing in the UI
// or the Lua handler needs to change, because every preset just resolves to the
// same small `ClipEffect` (a set of static transform values Resolve scripting
// can actually set: zoom, pan, tilt, rotation).
//
// What this deliberately does NOT do: transitions, keyframed/animated moves,
// ResolveFX or Fusion effects. Resolve's scripting API cannot add any of those.
// A future preset that wants a real animated look would carry a `fusionMacro`
// name here and the Lua side would import that pre-authored macro — the seam is
// left open (see `fusionMacro`) but no such preset ships yet.

/** Static transform applied to one clip. All fields optional; omit = untouched. */
export interface ClipEffect {
  /** Zoom multiplier. 1 = no zoom, 1.1 = 110%. */
  zoom?: number
  /** Horizontal offset in pixels (needs headroom from zoom to avoid edges). */
  panX?: number
  /** Vertical offset in pixels. */
  panY?: number
  /** Rotation in degrees. */
  rotation?: number
  /** Reserved: name of a pre-authored Fusion macro to import onto the clip. */
  fusionMacro?: string
}

export interface EffectPresetOptions {
  /** User-facing intensity, 0..50. Drives zoom depth and pan distance. */
  intensity: number
}

export interface EffectPreset {
  id: string
  nameKey: string
  /**
   * Resolve the transform for the clip at `index` (0-based). `index` lets a
   * preset alternate direction between clips for variety without any extra
   * state. Return {} for "leave the clip alone".
   */
  build: (index: number, opts: EffectPresetOptions) => ClipEffect
}

// Pan distance in px for a given intensity. Pans only look right when there is
// zoom headroom, so presets that pan also zoom.
const panFor = (intensity: number) => intensity * 6

export const EFFECT_PRESETS: EffectPreset[] = [
  {
    id: "none",
    nameKey: "slideshow.effects.none",
    build: () => ({}),
  },
  {
    id: "punchIn",
    nameKey: "slideshow.effects.punchIn",
    build: (_index, { intensity }) => ({ zoom: 1 + intensity / 100 }),
  },
  {
    id: "punchPan",
    nameKey: "slideshow.effects.punchPan",
    build: (index, { intensity }) => ({
      zoom: 1 + intensity / 100,
      // Alternate the framing left/right so consecutive stills don't look flat.
      panX: (index % 2 === 0 ? -1 : 1) * panFor(intensity),
    }),
  },
  {
    id: "diagonal",
    nameKey: "slideshow.effects.diagonal",
    build: (index, { intensity }) => {
      const dir = index % 2 === 0 ? 1 : -1
      return {
        zoom: 1 + intensity / 100,
        panX: dir * panFor(intensity),
        panY: dir * panFor(intensity) * 0.5,
      }
    },
  },
]

export const DEFAULT_EFFECT_ID = "punchIn"

export function getEffectPreset(id: string): EffectPreset {
  return EFFECT_PRESETS.find((p) => p.id === id) ?? EFFECT_PRESETS[0]
}
