/**
 * The device registry: the only place a device's IP is stored.
 *
 * Every message that proves "MAC X is at IP Y" (boot beacons, discovery
 * replies, state replies) goes through `observe`. Accessories hold a MAC and
 * never an address, so an IP change takes effect on the next request without
 * re-creating anything — the bug upstream has, where accessories keep the
 * device object from startup and keep talking to the old IP.
 */
import { Clock, Context, Effect, Layer, Option, PubSub, Scope, Stream } from "effect"
import { isIgnored } from "../config.js"
import { getSystemConfigRequest, type Inbound } from "../protocol/messages.js"
import { classify } from "../protocol/models.js"
import { type DeviceHandle, makeWorker, type Worker } from "./DeviceWorker.js"
import { Settings } from "./Settings.js"
import { Transport } from "./Transport.js"

export type DeviceEvent =
  /** A device with a supported model was seen for the first time. */
  | { readonly _tag: "Identified"; readonly mac: string; readonly model: string; readonly ip: string }
  /** A known device is now at a different address. */
  | { readonly _tag: "Moved"; readonly mac: string; readonly ip: string; readonly from: string | undefined }

interface Entry {
  ip: string | undefined
  model: string | undefined
  worker: Worker | undefined
  lastConfigRequestAt: number
}

/** Don't re-ask an unidentified device for its model more often than this. */
const CONFIG_REQUEST_INTERVAL_MS = 2_000

export class Devices extends Context.Service<Devices, {
  /**
   * Register a device known from a previous run (Homebridge's accessory
   * cache), so it can be controlled before it is rediscovered.
   */
  seed(device: { readonly mac: string; readonly model: string; readonly ip: string | undefined }): Effect.Effect<DeviceHandle>
  get(mac: string): Effect.Effect<Option.Option<DeviceHandle>>
  /** Current address of a device, if known. */
  address(mac: string): Effect.Effect<string | undefined>
  /** Device events from now on; live once this effect completes. */
  readonly events: Effect.Effect<Stream.Stream<DeviceEvent>, never, Scope.Scope>
}>()("wiz/core/Devices") {
  static readonly layer = Layer.effect(
    Devices,
    Effect.gen(function*() {
      const transport = yield* Transport
      const settings = yield* Settings
      const scope = yield* Effect.scope
      const context = yield* Effect.context<Transport | Settings>()
      const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<DeviceEvent>(), PubSub.shutdown)
      const entries = new Map<string, Entry>()

      const entry = (mac: string): Entry => {
        let e = entries.get(mac)
        if (e === undefined) {
          e = { ip: undefined, model: undefined, worker: undefined, lastConfigRequestAt: -Infinity }
          entries.set(mac, e)
        }
        return e
      }

      const address = (mac: string) => Effect.sync(() => entries.get(mac)?.ip)

      const startWorker = (mac: string, model: string) =>
        makeWorker({ mac, model, address: address(mac) }).pipe(
          Effect.provideContext(context),
          Scope.provide(scope)
        )

      /**
       * Record that `mac` was heard from `ip`. `via` says how: a boot beacon
       * means the device's state may have reset; a discovery reply may mean
       * an unreachable device is back; a state reply is the worker's own.
       */
      const observe = (mac: string, ip: string, via: "boot" | "discovery" | "reply") =>
        Effect.gen(function*() {
          const e = entry(mac)
          const from = e.ip
          if (from !== ip) {
            // An address belongs to one device at a time. If DHCP handed this
            // device another's old address, that device's location is now
            // unknown until it is heard from again.
            for (const [otherMac, other] of entries) {
              if (otherMac !== mac && other.ip === ip) {
                other.ip = undefined
                yield* Effect.logDebug(`${otherMac}: address ${ip} now belongs to ${mac}; waiting to hear from it again`)
              }
            }
            e.ip = ip
            if (from !== undefined || e.worker !== undefined) {
              yield* Effect.logDebug(`${mac}: now at ${ip}${from === undefined ? "" : ` (was ${from})`}`)
              yield* PubSub.publish(pubsub, { _tag: "Moved", mac, ip, from })
            }
          }
          if (e.worker !== undefined) {
            if (via !== "reply" || from !== ip) yield* e.worker.revive(via === "boot")
          } else if (e.model === undefined) {
            const now = yield* Clock.currentTimeMillis
            if (now - e.lastConfigRequestAt > CONFIG_REQUEST_INTERVAL_MS) {
              e.lastConfigRequestAt = now
              yield* transport.send(ip, getSystemConfigRequest).pipe(Effect.ignore)
            }
          }
        })

      const identify = (mac: string, ip: string, model: string) =>
        Effect.gen(function*() {
          const e = entry(mac)
          if (e.worker !== undefined) return
          e.model = model
          if (classify(model) === undefined) {
            yield* Effect.logDebug(`${mac}: unsupported model ${model}, ignoring`)
            return
          }
          e.worker = yield* startWorker(mac, model)
          yield* Effect.logDebug(`${mac}: found ${model} at ${ip}`)
          yield* PubSub.publish(pubsub, { _tag: "Identified", mac, model, ip })
        })

      const route = (message: Inbound) =>
        Effect.gen(function*() {
          if (message._tag === "SetPilotAck" || message._tag === "ErrorReply") {
            // No MAC in these replies; the address owner is the only candidate.
            for (const e of entries.values()) {
              if (e.ip === message.ip && e.worker !== undefined) yield* e.worker.deliver(message)
            }
            return
          }
          if (isIgnored(settings, message.mac, message.ip)) return
          const via = message._tag === "PilotReply"
            ? "reply"
            : message._tag === "Announce" && message.via === "firstBeat"
            ? "boot"
            : "discovery"
          yield* observe(message.mac, message.ip, via)
          if (message._tag === "SystemConfig") {
            yield* identify(message.mac, message.ip, message.model)
          } else if (message._tag === "PilotReply") {
            yield* (entries.get(message.mac)?.worker?.deliver(message) ?? Effect.void)
          }
        })

      const inbound = yield* transport.subscribe
      yield* inbound.pipe(Stream.runForEach(route), Effect.forkScoped)

      const seed = (device: { readonly mac: string; readonly model: string; readonly ip: string | undefined }) =>
        Effect.gen(function*() {
          const e = entry(device.mac)
          if (e.worker !== undefined) return e.worker
          e.model = device.model
          if (e.ip === undefined && device.ip !== undefined) {
            // A cached address is only a hint; don't take it from a device
            // that has been seen there since.
            const taken = [...entries.values()].some((other) => other !== e && other.ip === device.ip)
            if (!taken) e.ip = device.ip
          }
          e.worker = yield* startWorker(device.mac, device.model)
          return e.worker
        })

      const get = (mac: string) => Effect.sync(() => Option.fromNullishOr(entries.get(mac)?.worker))

      return Devices.of({
        seed,
        get,
        address,
        events: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription))
      })
    })
  )
}
