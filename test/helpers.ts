/**
 * A simulated WiZ network for tests: bulbs that answer like real ones, can be
 * powered off, moved to another IP, or made to drop or falsify replies.
 */
import { Effect, Layer, PubSub, Stream } from "effect"
import { defaults, type WizConfig } from "../src/config.js"
import { Devices } from "../src/core/Devices.js"
import { Settings } from "../src/core/Settings.js"
import { Transport } from "../src/core/Transport.js"
import type { Inbound } from "../src/protocol/messages.js"
import type { Pilot } from "../src/protocol/pilot.js"

export interface FakeBulb {
  mac: string
  model: string
  ip: string
  powered: boolean
  pilot: Pilot
  /** Replies to swallow before answering again (lost packets). */
  dropReplies: number
  /** Pilots to report instead of the real one, consumed one per getPilot. */
  staleReports: Array<Pilot>
}

export interface Sent {
  readonly ip: string
  readonly method: string
  readonly params: Record<string, unknown>
}

export class FakeNetwork {
  readonly bulbs: Array<FakeBulb> = []
  readonly sent: Array<Sent> = []
  constructor(readonly pubsub: PubSub.PubSub<Inbound>, readonly broadcast = "255.255.255.255") {}

  addBulb(bulb: Partial<FakeBulb> & Pick<FakeBulb, "mac" | "ip">): FakeBulb {
    const full: FakeBulb = {
      model: "ESP25_SHRGB_01",
      powered: true,
      pilot: { state: true, dimming: 50, temp: 2700 },
      dropReplies: 0,
      staleReports: [],
      ...bulb
    }
    this.bulbs.push(full)
    return full
  }

  bulb(mac: string): FakeBulb {
    return this.bulbs.find((b) => b.mac === mac)!
  }

  /** Deliver a message as if it had arrived on the socket. */
  inject(message: Inbound) {
    PubSub.publishUnsafe(this.pubsub, message)
  }

  firstBeat(mac: string) {
    const bulb = this.bulb(mac)
    this.inject({ _tag: "Announce", ip: bulb.ip, mac, via: "firstBeat" })
  }

  sentTo(ip: string, method?: string): Array<Sent> {
    return this.sent.filter((s) => s.ip === ip && (method === undefined || s.method === method))
  }

  sentMethod(method: string): Array<Sent> {
    return this.sent.filter((s) => s.method === method)
  }

  private reply(bulb: FakeBulb, message: Inbound) {
    if (bulb.dropReplies > 0) {
      bulb.dropReplies -= 1
      return
    }
    this.inject(message)
  }

  handle(ip: string, payload: { method: string; params?: Record<string, unknown> }) {
    this.sent.push({ ip, method: payload.method, params: payload.params ?? {} })
    const targets = ip === this.broadcast ? this.bulbs : this.bulbs.filter((b) => b.ip === ip)
    for (const bulb of targets.filter((b) => b.powered)) {
      switch (payload.method) {
        case "registration":
          this.reply(bulb, { _tag: "Announce", ip: bulb.ip, mac: bulb.mac, via: "registration" })
          break
        case "getSystemConfig":
          this.reply(bulb, { _tag: "SystemConfig", ip: bulb.ip, mac: bulb.mac, model: bulb.model })
          break
        case "getPilot": {
          const pilot = bulb.staleReports.shift() ?? bulb.pilot
          this.reply(bulb, { _tag: "PilotReply", ip: bulb.ip, mac: bulb.mac, pilot })
          break
        }
        case "setPilot": {
          const { mac: _mac, src: _src, ...params } = payload.params ?? {}
          bulb.pilot = params as unknown as Pilot
          this.reply(bulb, { _tag: "SetPilotAck", ip: bulb.ip, error: undefined })
          break
        }
      }
    }
  }
}

export const testConfig = (overrides: Partial<WizConfig> = {}): WizConfig => ({
  ...defaults,
  refreshInterval: 0,
  discoveryInterval: 0,
  ...overrides
})

/** Transport + Settings + Devices on top of a fake network. */
export const makeHarness = (overrides: Partial<WizConfig> = {}) =>
  Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<Inbound>()
    const network = new FakeNetwork(pubsub)
    const transport = Layer.succeed(Transport)(
      Transport.of({
        send: (ip, payload) => Effect.sync(() => network.handle(ip, payload as { method: string })),
        subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription))
      })
    )
    const layer = Devices.layer.pipe(
      Layer.provideMerge(transport),
      Layer.provideMerge(Settings.layer(testConfig(overrides)))
    )
    return { network, layer }
  })
