import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Devices, type DeviceEvent } from "../src/core/Devices.js"
import type { DeviceHandle } from "../src/core/DeviceWorker.js"
import { makeHarness, type FakeNetwork } from "./helpers.js"

const MAC = "cc4085b5f46e"
const OTHER = "cc408564ead8"

/** Let forked fibers (the inbound router, workers) process pending work. */
const settle = Effect.gen(function*() {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

/** Collect device events into a queue for assertions. */
const recordEvents = Effect.gen(function*() {
  const devices = yield* Devices
  const queue = yield* Queue.unbounded<DeviceEvent>()
  const events = yield* devices.events
  yield* events.pipe(Stream.runForEach((e) => Queue.offer(queue, e)), Effect.forkScoped)
  return queue
})

const handleFor = (mac: string) =>
  Effect.gen(function*() {
    const devices = yield* Devices
    return Option.getOrThrow(yield* devices.get(mac))
  })

/** Run the effect while advancing the test clock until it completes. */
const withTime = <A, E>(effect: Effect.Effect<A, E>, step = 100) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(effect)
    for (let i = 0; i < 200; i++) {
      yield* settle
      if (fiber.pollUnsafe() !== undefined) break
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.await(fiber)
  })

/** Power the bulb off and fail reads until the worker gives up on it. */
const makeUnreachable = (network: FakeNetwork, handle: DeviceHandle, mac: string) =>
  Effect.gen(function*() {
    network.bulb(mac).powered = false
    for (let i = 0; i < 3; i++) {
      yield* TestClock.adjust(3_000)
      yield* Effect.exit(handle.read)
      yield* withTime(Effect.void)
      yield* TestClock.adjust(1_100)
      yield* settle
    }
    assert.isFalse((yield* handle.snapshot).reachable, "device should be marked unreachable")
  })

describe("device identity and addresses", () => {
  it.effect("a device that moves to a new IP is controlled at the new IP (upstream stale-IP bug)", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        const events = yield* recordEvents
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        network.firstBeat(MAC)
        yield* settle
        const identified = yield* Queue.take(events)
        assert.deepStrictEqual(identified, { _tag: "Identified", mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })

        // Power cycle; DHCP hands out a different address.
        network.bulb(MAC).ip = "192.168.68.150"
        network.firstBeat(MAC)
        yield* settle
        assert.deepStrictEqual(yield* Queue.take(events), {
          _tag: "Moved",
          mac: MAC,
          ip: "192.168.68.150",
          from: "192.168.68.117"
        })

        const handle = yield* handleFor(MAC)
        const before = network.sent.length
        yield* withTime(handle.write({ state: false }))
        const after = network.sent.slice(before)
        assert.isTrue(after.length > 0)
        assert.isTrue(after.every((s) => s.ip === "192.168.68.150"), "all traffic goes to the new IP")
        assert.isFalse(network.bulb(MAC).pilot.state)
        assert.strictEqual(yield* Queue.size(events), 0, "no duplicate Identified event")
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a cached device is reachable at its cached IP before it is rediscovered", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        const pilot = yield* withTime(handle.read)
        assert.isTrue(pilot._tag === "Success" && pilot.value.state)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("when another device takes over an IP, the previous owner is not sent its traffic", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        const devices = yield* Devices
        network.addBulb({ mac: MAC, ip: "192.168.68.117", powered: false })
        const old = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        network.addBulb({ mac: OTHER, ip: "192.168.68.117" })
        network.firstBeat(OTHER)
        yield* settle

        assert.isUndefined(yield* devices.address(MAC))
        const before = network.sent.length
        const exit = yield* withTime(old.write({ state: true }))
        assert.strictEqual(exit._tag, "Failure")
        assert.deepStrictEqual(network.sent.slice(before), [], "nothing sent on behalf of the old owner")
        assert.isTrue(network.bulb(OTHER).pilot.state, "the new owner was not changed")
      }).pipe(Effect.provide(layer))
    }))

  it.effect("ignored devices are never identified", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness({ ignoredDevices: [{ mac: MAC, host: undefined }] })
      yield* Effect.gen(function*() {
        const events = yield* recordEvents
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        network.firstBeat(MAC)
        yield* settle
        assert.strictEqual(yield* Queue.size(events), 0)
        assert.deepStrictEqual(network.sent, [])
      }).pipe(Effect.provide(layer))
    }))
})

describe("recovery", () => {
  it.effect("a power-cycled device at the same IP recovers on its boot beacon", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)

        yield* makeUnreachable(network, handle, MAC)
        const refused = yield* Effect.exit(handle.read)
        assert.strictEqual(refused._tag, "Failure", "HomeKit sees No Response while it is off")

        network.bulb(MAC).powered = true
        network.bulb(MAC).pilot = { state: true, dimming: 100, temp: 4000 }
        network.firstBeat(MAC)
        yield* withTime(Effect.void)
        const snapshot = yield* handle.snapshot
        assert.isTrue(snapshot.reachable)
        assert.deepStrictEqual(snapshot.pilot, { state: true, dimming: 100, temp: 4000 })
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a quick power cycle that was never noticed as an outage still refreshes state on the boot beacon", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117", pilot: { state: false, dimming: 50, temp: 2700 } })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        assert.isFalse((yield* handle.snapshot).pilot?.state)

        // Wall switch off and on again: bulbs come back lit.
        network.bulb(MAC).pilot = { state: true, dimming: 100, temp: 2700 }
        network.firstBeat(MAC)
        yield* withTime(Effect.void)
        assert.isTrue((yield* handle.snapshot).pilot?.state)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a write to an unreachable device is still attempted once, and succeeds if it is back", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        yield* makeUnreachable(network, handle, MAC)

        // Back on, but its beacon was missed.
        network.bulb(MAC).powered = true
        const before = network.sentMethod("setPilot").length
        const exit = yield* withTime(handle.write({ state: false }))
        assert.strictEqual(exit._tag, "Success")
        assert.strictEqual(network.sentMethod("setPilot").length - before, 1)
        assert.isTrue((yield* handle.snapshot).reachable)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a write to an unreachable device that stays off fails after one quick attempt", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        yield* makeUnreachable(network, handle, MAC)

        const before = network.sentMethod("setPilot").length
        const exit = yield* withTime(handle.write({ state: false }))
        assert.strictEqual(exit._tag, "Failure")
        assert.strictEqual(network.sentMethod("setPilot").length - before, 1)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("background polling marks a silent device unreachable without any HomeKit activity", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness({ refreshInterval: 30 })
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        network.bulb(MAC).powered = false
        for (let i = 0; i < 5; i++) yield* withTime(Effect.sleep("31 seconds"), 1_000)
        assert.isFalse((yield* handle.snapshot).reachable)
      }).pipe(Effect.provide(layer))
    }))
})

describe("writes", () => {
  it.effect("a write with no known state reads the device first instead of failing", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117", pilot: { state: true, dimming: 40, r: 255, g: 0, b: 0 } })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        const exit = yield* withTime(handle.write({ dimming: 80 }))
        assert.strictEqual(exit._tag, "Success")
        assert.deepStrictEqual(
          network.sent.map((s) => s.method),
          ["getPilot", "setPilot"]
        )
        assert.deepStrictEqual(network.bulb(MAC).pilot, { state: true, dimming: 80, r: 255, g: 0, b: 0 })
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a lost acknowledgement is retried with the same complete state", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        network.bulb(MAC).dropReplies = 1
        const exit = yield* withTime(handle.write({ dimming: 90 }))
        assert.strictEqual(exit._tag, "Success")
        const writes = network.sentMethod("setPilot")
        assert.strictEqual(writes.length, 2)
        assert.deepStrictEqual(writes[0]!.params, writes[1]!.params)
        assert.isTrue((yield* handle.snapshot).reachable, "one lost packet is not an outage")
      }).pipe(Effect.provide(layer))
    }))

  it.effect("a state report contradicting a just-acknowledged write is checked again before it is believed", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117", pilot: { state: false, dimming: 50, temp: 2700 } })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        yield* TestClock.adjust(2_500)
        yield* withTime(handle.write({ state: true }))

        // The next report is from before the write (e.g. a late reply).
        network.bulb(MAC).staleReports.push({ state: false, dimming: 50, temp: 2700 })
        yield* handle.read
        yield* withTime(Effect.sleep("1 second"))

        assert.isTrue((yield* handle.snapshot).pilot?.state, "the stale report was not applied")
        assert.strictEqual(network.bulb(MAC).staleReports.length, 0)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("only device-confirmed states are reported as confirmed", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117", pilot: { state: false, dimming: 50, temp: 2700 } })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        assert.isFalse((yield* handle.snapshot).confirmed?.state)

        yield* withTime(handle.write({ state: true }))
        assert.isTrue((yield* handle.snapshot).confirmed?.state, "an acknowledged write is confirmed")

        network.bulb(MAC).powered = false
        const failed = yield* withTime(handle.write({ state: false }))
        assert.strictEqual(failed._tag, "Failure")
        const after = yield* handle.snapshot
        assert.isTrue(after.confirmed?.state, "a failed write never becomes confirmed")
        assert.isTrue(after.pilot?.state, "and the optimistic value is rolled back")
      }).pipe(Effect.provide(layer))
    }))

  it.effect("rapid writes are merged instead of queueing one packet each", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117" })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        const fibers = yield* Effect.forEach([20, 40, 60, 80, 100], (d) =>
          Effect.forkChild(handle.write({ dimming: d }))
        )
        for (const fiber of fibers) yield* withTime(Fiber.join(fiber))
        assert.isAtMost(network.sentMethod("setPilot").length, 2)
        assert.strictEqual(network.bulb(MAC).pilot.dimming, 100)
      }).pipe(Effect.provide(layer))
    }))

  it.effect("lastStatus sends only the on/off state for a plain toggle", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness({ lastStatus: true })
      yield* Effect.gen(function*() {
        network.addBulb({ mac: MAC, ip: "192.168.68.117", pilot: { state: false, dimming: 50, temp: 2700 } })
        const devices = yield* Devices
        const handle = yield* devices.seed({ mac: MAC, model: "ESP25_SHRGB_01", ip: "192.168.68.117" })
        yield* withTime(handle.read)
        yield* withTime(handle.write({ state: true }))
        const [first] = network.sentMethod("setPilot")
        assert.deepStrictEqual(first!.params, { mac: MAC, src: "udp", state: true })
      }).pipe(Effect.provide(layer))
    }))
})
