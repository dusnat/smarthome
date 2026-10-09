import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Devices, type DeviceEvent } from "../src/core/Devices.js"
import { DiscoveryLive } from "../src/core/Discovery.js"
import { makeHarness } from "./helpers.js"

const settle = Effect.gen(function*() {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

describe("discovery", () => {
  it.effect("sends several startup rounds, then repeats on the interval, to broadcast and configured hosts", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness({
        discoveryInterval: 60,
        devices: [{ host: "192.168.68.200", mac: undefined, name: undefined }]
      })
      yield* Effect.gen(function*() {
        yield* settle
        const rounds = () => network.sentTo("255.255.255.255", "registration").length
        assert.strictEqual(rounds(), 1)
        yield* TestClock.adjust("15 seconds")
        yield* settle
        assert.strictEqual(rounds(), 4)
        assert.strictEqual(network.sentTo("192.168.68.200", "registration").length, 4)
        yield* TestClock.adjust("60 seconds")
        yield* settle
        assert.strictEqual(rounds(), 5)
      }).pipe(Effect.provide(DiscoveryLive.pipe(Layer.provideMerge(layer))))
    }))

  it.effect("a bulb that answers discovery is identified with its model", () =>
    Effect.gen(function*() {
      const { network, layer } = yield* makeHarness()
      network.addBulb({ mac: "cc4085b5f46e", ip: "192.168.68.117" })
      network.addBulb({ mac: "cc408564ead8", ip: "192.168.68.103", model: "ESP25_SOCKET_01" })
      yield* Effect.gen(function*() {
        const devices = yield* Devices
        const queue = yield* Queue.unbounded<DeviceEvent>()
        const events = yield* devices.events
        yield* events.pipe(Stream.runForEach((e) => Queue.offer(queue, e)), Effect.forkScoped)
        yield* Effect.gen(function*() {
          yield* settle
          const found = yield* Queue.takeAll(queue)
          assert.deepStrictEqual(
            found.map((e) => e._tag === "Identified" && `${e.mac}/${e.model}`).sort(),
            ["cc408564ead8/ESP25_SOCKET_01", "cc4085b5f46e/ESP25_SHRGB_01"]
          )
          // Later rounds find nothing new.
          yield* TestClock.adjust("15 seconds")
          yield* settle
          assert.strictEqual(yield* Queue.size(queue), 0)
        }).pipe(Effect.provide(DiscoveryLive.pipe(Layer.provide(layer))))
      }).pipe(Effect.provide(layer))
    }))
})
