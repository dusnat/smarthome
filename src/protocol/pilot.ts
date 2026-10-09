/**
 * Device state ("pilot" in WiZ terms) and its mapping to and from HomeKit.
 */
import {
  clampRgb,
  colorTemperatureToRgb,
  kelvinToMired,
  rgbToColorTemperature,
  rgbToHsv
} from "./color.js"

/** Last known device state. Lights use every field; sockets only `state`. */
export interface Pilot {
  readonly state: boolean
  readonly dimming?: number | undefined
  readonly temp?: number | undefined
  readonly r?: number | undefined
  readonly g?: number | undefined
  readonly b?: number | undefined
  readonly sceneId?: number | undefined
  readonly speed?: number | undefined
}

/** A requested change. Fields set to `undefined` are left as they are. */
export type PilotPatch = Partial<Pilot>

/**
 * Apply a patch on top of the current state.
 *
 * Color modes are exclusive: choosing a scene clears color and white settings,
 * and choosing a color clears the scene and the other color mode. Writes always
 * send the complete result, which is what makes retrying a write safe.
 */
export const applyPatch = (current: Pilot, patch: PilotPatch): Pilot => {
  const next: { -readonly [K in keyof Pilot]: Pilot[K] } = { ...current }
  for (const [key, value] of Object.entries(patch) as Array<[keyof Pilot, never]>) {
    if (value !== undefined) next[key] = value
  }
  if (patch.sceneId !== undefined && patch.sceneId !== 0) {
    next.temp = next.r = next.g = next.b = undefined
  } else if (patch.temp !== undefined) {
    next.r = next.g = next.b = next.sceneId = next.speed = undefined
  } else if (patch.r !== undefined || patch.g !== undefined || patch.b !== undefined) {
    next.temp = next.sceneId = next.speed = undefined
  }
  if (next.sceneId === 0) next.sceneId = undefined
  return next
}

/** The setPilot params for a full state, omitting unset fields. */
export const toParams = (pilot: Pilot): Record<string, number | boolean> => {
  const params: Record<string, number | boolean> = { state: pilot.state }
  for (const key of ["dimming", "temp", "r", "g", "b", "sceneId", "speed"] as const) {
    const value = pilot[key]
    if (value !== undefined) params[key] = value
  }
  return params
}

/** True if `reported` disagrees with any field we just wrote. */
export const contradicts = (written: PilotPatch, reported: Pilot): boolean =>
  (Object.keys(written) as Array<keyof Pilot>).some(
    (key) => written[key] !== undefined && reported[key] !== written[key]
  )

/** True if color, white temperature or scene differ (used by Adaptive Lighting). */
export const colorDiffers = (a: Pilot, b: Pilot): boolean =>
  a.r !== b.r || a.g !== b.g || a.b !== b.b || a.temp !== b.temp || (a.sceneId ?? 0) !== (b.sceneId ?? 0)

// ---------------------------------------------------------------------------
// HomeKit views. Behaviour matches homebridge-wiz-lan.

/** WiZ dimming is 10-100; HomeKit brightness is 0-100. */
export const brightnessFromDimming = (dimming: number): number => Math.max(0, Math.floor(dimming * 1.1) - 10)
export const dimmingFromBrightness = (brightness: number): number => Math.floor(brightness * 0.9) + 10

/** Brightness to show when a bulb omits `dimming` (some firmware does). */
const effectiveDimming = (pilot: Pilot): number => pilot.dimming ?? (pilot.state ? 100 : 10)

export const homeKitColor = (pilot: Pilot): { hue: number; saturation: number; kelvin: number } => {
  if (pilot.temp !== undefined) {
    return { ...rgbToHsv(colorTemperatureToRgb(pilot.temp)), kelvin: pilot.temp }
  }
  const rgb = clampRgb({ r: pilot.r ?? 0, g: pilot.g ?? 0, b: pilot.b ?? 0 })
  return { ...rgbToHsv(rgb), kelvin: rgbToColorTemperature(rgb) }
}

export interface HomeKitLightView {
  readonly on: boolean
  readonly brightness: number
  readonly hue: number
  readonly saturation: number
  readonly colorTemperature: number
  readonly sceneId: number
}

export const homeKitView = (pilot: Pilot): HomeKitLightView => {
  const color = homeKitColor(pilot)
  return {
    on: pilot.state,
    brightness: brightnessFromDimming(effectiveDimming(pilot)),
    hue: color.hue,
    saturation: color.saturation,
    colorTemperature: kelvinToMired(color.kelvin),
    sceneId: pilot.sceneId ?? 0
  }
}

// ---------------------------------------------------------------------------
// Log descriptions

const mode = (pilot: Pilot, sceneName: (id: number) => string): string => {
  if (pilot.sceneId !== undefined && pilot.sceneId !== 0) return `scene "${sceneName(pilot.sceneId)}"`
  if (pilot.temp !== undefined) return `white ${pilot.temp}K`
  if (pilot.r !== undefined || pilot.g !== undefined || pilot.b !== undefined) {
    return `color rgb(${pilot.r ?? 0}, ${pilot.g ?? 0}, ${pilot.b ?? 0})`
  }
  return "unknown mode"
}

/**
 * A short human description of what changed between two confirmed states,
 * e.g. "off → on, brightness 50% → 80%". Undefined when nothing visible
 * changed. Sockets only have power.
 */
export const describeChange = (
  previous: Pilot,
  next: Pilot,
  options: { readonly light: boolean; readonly sceneName: (id: number) => string }
): string | undefined => {
  const parts: Array<string> = []
  if (previous.state !== next.state) {
    parts.push(`${previous.state ? "on" : "off"} → ${next.state ? "on" : "off"}`)
  }
  if (options.light) {
    const before = homeKitView(previous).brightness
    const after = homeKitView(next).brightness
    if (before !== after) parts.push(`brightness ${before}% → ${after}%`)
    const modeBefore = mode(previous, options.sceneName)
    const modeAfter = mode(next, options.sceneName)
    if (modeBefore !== modeAfter) parts.push(`${modeBefore} → ${modeAfter}`)
  }
  return parts.length === 0 ? undefined : parts.join(", ")
}
