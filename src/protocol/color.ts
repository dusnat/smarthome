/**
 * Color conversions between HomeKit (hue/saturation, mireds) and WiZ
 * (r/g/b, kelvin).
 *
 * Derived from homebridge-wiz-lan's src/util/color.ts, Copyright Kevin Pei and
 * the homebridge-wiz-lan contributors, licensed under the Apache License 2.0
 * (see THIRD_PARTY_NOTICES.md). Modified: rewritten as pure functions, logging
 * dependency removed. The original credits neilbartlett/color-temperature and
 * mjackson's HSV gist.
 */

export type RGB = { readonly r: number; readonly g: number; readonly b: number }

/** Range of white temperatures WiZ bulbs accept. */
export const KELVIN_RANGE = { min: 2200, max: 6500 } as const

export const miredToKelvin = (mired: number): number => Math.round(1_000_000 / mired)
export const kelvinToMired = (kelvin: number): number => Math.round(1_000_000 / kelvin)

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const clampRgb = ({ r, g, b }: RGB): RGB => ({
  r: clamp(r, 0, 255),
  g: clamp(g, 0, 255),
  b: clamp(b, 0, 255)
})

export const colorTemperatureToRgb = (kelvin: number): RGB => {
  const temperature = kelvin / 100
  let red: number
  let green: number
  let blue: number

  if (temperature < 66) {
    red = 255
  } else {
    const x = temperature - 55
    red = clamp(351.97690566805693 + 0.114206453784165 * x - 40.25366309332127 * Math.log(x), 0, 255)
  }

  if (temperature < 66) {
    const x = temperature - 2
    green = clamp(-155.25485562709179 - 0.44596950469579133 * x + 104.49216199393888 * Math.log(x), 0, 255)
  } else {
    const x = temperature - 50
    green = clamp(325.4494125711974 + 0.07943456536662342 * x - 28.0852963507957 * Math.log(x), 0, 255)
  }

  if (temperature >= 66) {
    blue = 255
  } else if (temperature <= 20) {
    blue = 0
  } else {
    const x = temperature - 10
    blue = clamp(-254.76935184120902 + 0.8274096064007395 * x + 115.67994401066147 * Math.log(x), 0, 255)
  }

  return { r: Math.round(red), g: Math.round(green), b: Math.round(blue) }
}

/** Closest white temperature for an RGB color, clamped to what bulbs accept. */
export const rgbToColorTemperature = (rgb: RGB): number => {
  const epsilon = 0.4
  let temperature = 0
  let min = 1000
  let max = 40000
  while (max - min > epsilon) {
    temperature = (max + min) / 2
    const test = colorTemperatureToRgb(temperature)
    if (test.b / test.r >= rgb.b / rgb.r) {
      max = temperature
    } else {
      min = temperature
    }
  }
  return clamp(Math.round(temperature), KELVIN_RANGE.min, KELVIN_RANGE.max)
}

/** RGB (0-255) to HomeKit hue (0-360) and saturation (0-100). */
export const rgbToHsv = ({ r, g, b }: RGB): { hue: number; saturation: number } => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  const s = max === 0 ? 0 : d / max
  let h = 0
  if (max !== min) {
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h /= 6
  }
  return { hue: Math.round(h * 360), saturation: Math.round(s * 100) }
}

/**
 * HomeKit hue/saturation (both 0-1) to what the bulb should be sent.
 *
 * HomeKit's temperature picker produces near-white hues; those map to a
 * kelvin value instead, because WiZ white mode is much brighter than RGB.
 */
export const hsvToWiz = (h: number, s: number): { readonly temp: number } | RGB => {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = 1 - s
  const q = 1 - f * s
  const t = 1 - (1 - f) * s
  const [r, g, b] = [
    [1, t, p],
    [q, 1, p],
    [p, 1, t],
    [p, q, 1],
    [t, p, 1],
    [1, p, q]
  ][((i % 6) + 6) % 6]!
  const rgb = { r: Math.round(r! * 255), g: Math.round(g! * 255), b: Math.round(b! * 255) }

  const h360 = h * 360
  const s100 = s * 100
  if ((h360 >= 0 && h360 <= 30 && s100 <= 76) || (h360 >= 220 && h360 <= 360 && s100 <= 25)) {
    const kelvin = rgbToColorTemperature(rgb)
    if (kelvin >= KELVIN_RANGE.min && kelvin <= KELVIN_RANGE.max) {
      return { temp: kelvin }
    }
  }
  return rgb
}
