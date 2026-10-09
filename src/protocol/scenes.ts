/**
 * WiZ built-in scenes, indexed by sceneId, with the device families that
 * support each one.
 *
 * The scene table is derived from homebridge-wiz-lan, Copyright Kevin Pei and
 * the homebridge-wiz-lan contributors, licensed under the Apache License 2.0
 * (see THIRD_PARTY_NOTICES.md). Modified: lookup helpers are new.
 */
type Family = "RGB" | "TW" | "DW"

const SCENES: ReadonlyArray<readonly [name: string, families: ReadonlyArray<Family>]> = [
  ["No Scene", ["RGB", "DW", "TW"]],
  ["Ocean", ["RGB"]],
  ["Romance", ["RGB"]],
  ["Sunset", ["RGB"]],
  ["Party", ["RGB"]],
  ["Fireplace", ["RGB"]],
  ["Cozy", ["RGB", "TW"]],
  ["Forest", ["RGB"]],
  ["Pastel Colors", ["RGB"]],
  ["Wake up", ["RGB", "DW", "TW"]],
  ["Bedtime", ["RGB", "DW", "TW"]],
  ["Warm White", ["RGB", "TW"]],
  ["Daylight", ["RGB", "TW"]],
  ["Cool white", ["RGB", "DW", "TW"]],
  ["Night light", ["RGB", "DW", "TW"]],
  ["Focus", ["RGB", "TW"]],
  ["Relax", ["RGB", "TW"]],
  ["True colors", ["RGB"]],
  ["TV time", ["RGB", "TW"]],
  ["Plantgrowth", ["RGB"]],
  ["Spring", ["RGB"]],
  ["Summer", ["RGB"]],
  ["Fall", ["RGB"]],
  ["Deepdive", ["RGB"]],
  ["Jungle", ["RGB"]],
  ["Mojito", ["RGB"]],
  ["Club", ["RGB"]],
  ["Christmas", ["RGB"]],
  ["Halloween", ["RGB"]],
  ["Candlelight", ["RGB", "DW", "TW"]],
  ["Golden white", ["RGB", "DW", "TW"]],
  ["Pulse", ["RGB", "DW", "TW"]],
  ["Steampunk", ["RGB", "DW", "TW"]]
]

export const scenesFor = (family: Family): ReadonlyArray<{ readonly id: number; readonly name: string }> =>
  SCENES.flatMap(([name, families], id) => (families.includes(family) ? [{ id, name }] : []))

/** Selecting "No Scene" switches the light to this white instead. */
export const NO_SCENE_KELVIN = 3000

export const sceneName = (id: number): string => SCENES[id]?.[0] ?? `scene ${id}`
