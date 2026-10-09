import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { decodeConfig, isIgnored, configuredName } from "../src/config.js"
import { hsvToWiz } from "../src/protocol/color.js"
import { parseInbound } from "../src/protocol/messages.js"
import { classify } from "../src/protocol/models.js"
import { applyPatch, brightnessFromDimming, describeChange, dimmingFromBrightness, homeKitView, toParams } from "../src/protocol/pilot.js"
import { sceneName, scenesFor } from "../src/protocol/scenes.js"

describe("parseInbound", () => {
  it("decodes a boot beacon captured from a real bulb", () => {
    const raw = `{"method":"firstBeat","env":"pro","params":{"mac":"cc4085b5f46e","homeId":17563082,"fwVersion":"1.38.0"}}`
    assert.deepStrictEqual(parseInbound(raw, "192.168.68.117"), Option.some({
      _tag: "Announce" as const,
      ip: "192.168.68.117",
      mac: "cc4085b5f46e",
      via: "firstBeat" as const
    }))
  })

  it("decodes getSystemConfig, getPilot and setPilot replies", () => {
    const config = parseInbound(`{"method":"getSystemConfig","env":"pro","result":{"mac":"CC:40:85:B5:F4:6E","moduleName":"ESP25_SHRGB_01","fwVersion":"1.38.0"}}`, "10.0.0.2")
    assert.deepStrictEqual(Option.getOrThrow(config), { _tag: "SystemConfig", ip: "10.0.0.2", mac: "cc4085b5f46e", model: "ESP25_SHRGB_01" })

    const pilot = parseInbound(`{"method":"getPilot","env":"pro","result":{"mac":"cc4085b5f46e","rssi":-60,"state":true,"sceneId":0,"temp":2700,"dimming":80}}`, "10.0.0.2")
    assert.deepStrictEqual(Option.getOrThrow(pilot), {
      _tag: "PilotReply",
      ip: "10.0.0.2",
      mac: "cc4085b5f46e",
      pilot: { state: true, sceneId: 0, temp: 2700, dimming: 80 }
    })

    assert.deepStrictEqual(Option.getOrThrow(parseInbound(`{"method":"setPilot","env":"pro","result":{"success":true}}`, "10.0.0.2")), {
      _tag: "SetPilotAck",
      ip: "10.0.0.2",
      error: undefined
    })
    const rejected = Option.getOrThrow(parseInbound(`{"method":"setPilot","env":"pro","error":{"code":-32602,"message":"Invalid params"}}`, "10.0.0.2"))
    assert.deepStrictEqual(rejected, { _tag: "SetPilotAck", ip: "10.0.0.2", error: "Invalid params (-32602)" })
  })

  it("ignores garbage, requests from other hosts and unknown methods", () => {
    assert.isTrue(Option.isNone(parseInbound("not json", "1.2.3.4")))
    assert.isTrue(Option.isNone(parseInbound(`{"method":"registration","params":{"phoneMac":"AA","register":false,"phoneIp":"1.2.3.4"}}`, "1.2.3.4")))
    assert.isTrue(Option.isNone(parseInbound(`{"method":"syncPilot","params":{"mac":"aa"}}`, "1.2.3.4")))
    assert.isTrue(Option.isNone(parseInbound(`{"method":"getPilot","result":{}}`, "1.2.3.4")))
  })
})

describe("pilot", () => {
  it("keeps color modes exclusive", () => {
    const base = { state: true, dimming: 50, r: 255, g: 0, b: 0 }
    assert.deepStrictEqual(toParams(applyPatch(base, { temp: 3000 })), { state: true, dimming: 50, temp: 3000 })
    assert.deepStrictEqual(toParams(applyPatch({ state: true, temp: 3000 }, { r: 0, g: 255, b: 0 })), { state: true, r: 0, g: 255, b: 0 })
    assert.deepStrictEqual(toParams(applyPatch(base, { sceneId: 4 })), { state: true, dimming: 50, sceneId: 4 })
    assert.deepStrictEqual(toParams(applyPatch({ state: true, sceneId: 4, speed: 100 }, { temp: 2700 })), { state: true, temp: 2700 })
  })

  it("maps HomeKit brightness onto the bulb's 10-100 range like upstream", () => {
    assert.strictEqual(dimmingFromBrightness(0), 10)
    assert.strictEqual(dimmingFromBrightness(100), 100)
    assert.strictEqual(brightnessFromDimming(10), 1)
    assert.strictEqual(brightnessFromDimming(100), 100)
    assert.strictEqual(brightnessFromDimming(0), 0)
  })

  it("treats a missing dimming value as full or minimum brightness", () => {
    assert.strictEqual(homeKitView({ state: true }).brightness, 100)
    assert.strictEqual(homeKitView({ state: false }).brightness, 1)
  })

  it("turns near-white picker colors into white temperature", () => {
    assert.isTrue("temp" in hsvToWiz(30 / 360, 0.2))
    assert.deepStrictEqual(hsvToWiz(120 / 360, 1), { r: 0, g: 255, b: 0 })
  })
})

describe("describeChange", () => {
  const light = { light: true, sceneName }
  it("summarises power, brightness and color mode changes", () => {
    assert.strictEqual(describeChange({ state: true, dimming: 50, temp: 2700 }, { state: false, dimming: 50, temp: 2700 }, light), "on → off")
    assert.strictEqual(
      describeChange({ state: true, dimming: 50, temp: 2700 }, { state: true, dimming: 100, r: 255, g: 0, b: 0 }, light),
      "brightness 45% → 100%, white 2700K → color rgb(255, 0, 0)"
    )
    assert.strictEqual(describeChange({ state: true, temp: 2700 }, { state: true, sceneId: 1 }, light), 'white 2700K → scene "Ocean"')
  })

  it("says nothing when nothing visible changed, and ignores brightness for plugs", () => {
    assert.isUndefined(describeChange({ state: true, dimming: 50, temp: 2700 }, { state: true, dimming: 50, temp: 2700 }, light))
    assert.isUndefined(describeChange({ state: true }, { state: true }, { light: false, sceneName }))
    assert.strictEqual(describeChange({ state: true }, { state: false }, { light: false, sceneName }), "on → off")
  })
})

describe("models and scenes", () => {
  it("classifies devices like upstream", () => {
    assert.deepStrictEqual(classify("ESP25_SHRGB_01"), { _tag: "Light", label: "RGB Bulb", color: true, temperature: true })
    assert.deepStrictEqual(classify("ESP06_SHDW9_01"), { _tag: "Light", label: "Dimmer Bulb", color: false, temperature: false })
    assert.deepStrictEqual(classify("ESP56_SHTW3_01"), { _tag: "Light", label: "Tunable White Bulb", color: false, temperature: true })
    assert.strictEqual(classify("ESP25_SOCKET_01")?._tag, "Socket")
    assert.isUndefined(classify("ESP99_UNKNOWN"))
  })

  it("filters scenes by family", () => {
    assert.strictEqual(scenesFor("RGB").length, 33)
    assert.isFalse(scenesFor("DW").some((s) => s.name === "Ocean"))
  })
})

describe("config", () => {
  it.effect("accepts an upstream config block and applies new defaults", () =>
    Effect.gen(function*() {
      const config = yield* decodeConfig({ platform: "WizSmarthome", name: "Wiz", _bridge: { username: "x" } })
      assert.strictEqual(config.refreshInterval, 30)
      assert.strictEqual(config.discoveryInterval, 60)
      assert.strictEqual(config.port, 38900)
    }))

  it.effect("normalizes MACs and clamps discovery to the minimum", () =>
    Effect.gen(function*() {
      const config = yield* decodeConfig({
        discoveryInterval: 2,
        refreshInterval: 0,
        devices: [{ mac: "CC:40:85:B5:F4:6E", name: "Lamp" }, { host: "192.168.68.120" }],
        ignoredDevices: [{ host: "192.168.68.99" }]
      })
      assert.strictEqual(config.discoveryInterval, 10)
      assert.strictEqual(config.refreshInterval, 0)
      assert.strictEqual(configuredName(config, "cc4085b5f46e", undefined), "Lamp")
      assert.isTrue(isIgnored(config, "anything", "192.168.68.99"))
      assert.isFalse(isIgnored(config, "anything", "192.168.68.98"))
    }))

  it.effect("rejects values of the wrong type", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(decodeConfig({ refreshInterval: "soon" }))
      assert.strictEqual(exit._tag, "Failure")
    }))
})
