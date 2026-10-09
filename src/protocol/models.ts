/**
 * What a WiZ device is and what it can do, derived from the `moduleName`
 * reported by getSystemConfig (e.g. "ESP25_SHRGB_01").
 *
 * Classification mirrors homebridge-wiz-lan so the same devices are exposed
 * with the same HomeKit services.
 */

export type DeviceKind =
  | { readonly _tag: "Light"; readonly label: string; readonly color: boolean; readonly temperature: boolean }
  | { readonly _tag: "Socket"; readonly label: string }

const LIGHT_MODELS: ReadonlyArray<readonly [id: string, label: string]> = [
  ["SHRGB", "RGB Bulb"],
  ["SHDW", "Dimmer Bulb"],
  ["SHTW", "Tunable White Bulb"],
  ["DHRGB", "Light Pole"],
  ["MHWRGB", "LED String Lights"],
  ["MHORGB", "Light Strip"]
]

const SOCKET_MODELS = ["ESP10_SOCKET_06", "ESP25_SOCKET_01"]

export const classify = (model: string): DeviceKind | undefined => {
  if (SOCKET_MODELS.some((id) => model.includes(id))) {
    return { _tag: "Socket", label: "Wiz Socket" }
  }
  const light = LIGHT_MODELS.find(([id]) => model.includes(id))
  if (light === undefined) {
    return undefined
  }
  const color = model.includes("RGB")
  return { _tag: "Light", label: light[1], color, temperature: color || model.includes("SHTW") }
}

/** Scene catalogue family used to filter scenes (see scenes.ts). */
export const sceneFamily = (model: string): "RGB" | "TW" | "DW" => {
  if (model.includes("SHTW")) return "TW"
  if (model.includes("RGB")) return "RGB"
  return "DW"
}

/** Default HomeKit name, identical to homebridge-wiz-lan's. */
export const defaultName = (kind: DeviceKind, mac: string): string => `Wiz ${kind.label} ${mac}`
