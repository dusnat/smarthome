/**
 * Finds devices by asking the network. Replies are handled by Devices like
 * any other message; this module only sends.
 *
 * Boot beacons (`firstBeat`) need nothing from here: Devices handles them as
 * soon as they arrive. Discovery covers devices that were already on when
 * Homebridge started, beacons that were missed, and configured hosts that
 * broadcast does not reach.
 */
import os from "node:os"
import { Duration, Effect, Layer, Schedule } from "effect"
import { normalizeMac, registrationRequest } from "../protocol/messages.js"
import { Settings } from "./Settings.js"
import { Transport } from "./Transport.js"

/**
 * Broadcast replies get lost (on the reference network a single broadcast
 * reached 4-6 of 10 bulbs), so startup sends a few rounds: at 0, 2, 5 and 15
 * seconds. These are the gaps between rounds.
 */
const STARTUP_GAPS = [Duration.zero, Duration.seconds(2), Duration.seconds(3), Duration.seconds(10)]

/** The IPv4 address and MAC this host advertises in discovery requests. */
const localIdentity = (preferredAddress: string | undefined) => {
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => i !== undefined && i.family === "IPv4" && !i.internal)
  const chosen = candidates.find((i) => i.address === preferredAddress) ?? candidates[0]
  return { ip: preferredAddress ?? chosen?.address ?? "0.0.0.0", mac: chosen?.mac ?? "00:00:00:00:00:00" }
}

export const DiscoveryLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const transport = yield* Transport
    const settings = yield* Settings
    const local = localIdentity(settings.address)
    const request = registrationRequest(normalizeMac(settings.mac ?? local.mac).toUpperCase(), local.ip)
    const hosts = settings.devices.flatMap((d) => (d.host === undefined ? [] : [d.host]))

    const round = Effect.gen(function*() {
      yield* Effect.logDebug(`Discovery: broadcasting to ${settings.broadcast}${hosts.length ? ` and ${hosts.length} configured host(s)` : ""}`)
      for (const ip of [settings.broadcast, ...hosts]) {
        yield* transport.send(ip, request).pipe(
          Effect.catch((e) => Effect.logDebug(`Discovery: could not send to ${ip}: ${e.message}`))
        )
      }
    })

    const startup = Effect.forEach(STARTUP_GAPS, (delay) => Effect.delay(round, delay), { discard: true })
    const periodic =
      settings.discoveryInterval > 0
        ? Effect.repeat(Effect.delay(round, Duration.seconds(settings.discoveryInterval)), Schedule.forever)
        : Effect.void

    yield* Effect.logDebug(
      settings.discoveryInterval > 0
        ? `Discovery: every ${settings.discoveryInterval}s, plus device boot announcements`
        : "Discovery: at startup only, plus device boot announcements"
    )
    yield* Effect.andThen(startup, periodic).pipe(Effect.forkScoped)
  })
)
