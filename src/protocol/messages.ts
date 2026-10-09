/**
 * The WiZ local protocol: JSON over UDP. Requests go to port 38899 on the
 * device; replies come back to the sender's port, and boot announcements
 * (`firstBeat`) are broadcast to port 38900.
 *
 * Replies carry no request id. Most identify the device by MAC; setPilot
 * acks do not, so they can only be attributed by source IP.
 */
import { Option, Schema } from "effect"
import type { Pilot } from "./pilot.js"

export const DEVICE_PORT = 38899
export const DEFAULT_LISTEN_PORT = 38900

/** Canonical MAC form used everywhere: lowercase hex without separators. */
export const normalizeMac = (mac: string): string => mac.toLowerCase().replace(/[^0-9a-f]/g, "")

export type Inbound =
  | { readonly _tag: "Announce"; readonly ip: string; readonly mac: string; readonly via: "firstBeat" | "registration" }
  | { readonly _tag: "SystemConfig"; readonly ip: string; readonly mac: string; readonly model: string }
  | { readonly _tag: "PilotReply"; readonly ip: string; readonly mac: string; readonly pilot: Pilot }
  | { readonly _tag: "SetPilotAck"; readonly ip: string; readonly error: string | undefined }
  | { readonly _tag: "ErrorReply"; readonly ip: string; readonly method: string; readonly message: string }

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    params: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Unknown)
  })
)

const WithMac = Schema.Struct({ mac: Schema.String })

const SystemConfigResult = Schema.Struct({ mac: Schema.String, moduleName: Schema.String })

const num = Schema.optionalKey(Schema.Number)
const PilotResult = Schema.Struct({
  mac: Schema.String,
  state: Schema.optionalKey(Schema.Boolean),
  dimming: num,
  temp: num,
  r: num,
  g: num,
  b: num,
  sceneId: num,
  speed: num
})

const ErrorBody = Schema.Struct({ code: Schema.optionalKey(Schema.Number), message: Schema.optionalKey(Schema.String) })

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeWithMac = Schema.decodeUnknownOption(WithMac)
const decodeSystemConfig = Schema.decodeUnknownOption(SystemConfigResult)
const decodePilot = Schema.decodeUnknownOption(PilotResult)
const decodeError = Schema.decodeUnknownOption(ErrorBody)

const describeError = (error: unknown): string =>
  Option.match(decodeError(error), {
    onNone: () => JSON.stringify(error),
    onSome: (e) => `${e.message ?? "error"}${e.code === undefined ? "" : ` (${e.code})`}`
  })

/** Decode one datagram. Anything unrecognised or malformed yields `None`. */
export const parseInbound = (payload: string, ip: string): Option.Option<Inbound> =>
  Option.flatMap(decodeEnvelope(payload), (msg): Option.Option<Inbound> => {
    if (msg.error !== undefined) {
      if (msg.method === "setPilot") {
        return Option.some({ _tag: "SetPilotAck", ip, error: describeError(msg.error) })
      }
      return Option.some({ _tag: "ErrorReply", ip, method: msg.method, message: describeError(msg.error) })
    }
    switch (msg.method) {
      case "firstBeat":
        return Option.map(decodeWithMac(msg.params), ({ mac }) => ({
          _tag: "Announce",
          ip,
          mac: normalizeMac(mac),
          via: "firstBeat"
        }))
      case "registration":
        return Option.map(decodeWithMac(msg.result), ({ mac }) => ({
          _tag: "Announce",
          ip,
          mac: normalizeMac(mac),
          via: "registration"
        }))
      case "getSystemConfig":
        return Option.map(decodeSystemConfig(msg.result), ({ mac, moduleName }) => ({
          _tag: "SystemConfig",
          ip,
          mac: normalizeMac(mac),
          model: moduleName
        }))
      case "getPilot":
        return Option.map(decodePilot(msg.result), ({ mac, state, ...rest }) => ({
          _tag: "PilotReply",
          ip,
          mac: normalizeMac(mac),
          pilot: { ...rest, state: state ?? false }
        }))
      case "setPilot":
        return Option.some({ _tag: "SetPilotAck", ip, error: undefined })
      default:
        return Option.none()
    }
  })

// ---------------------------------------------------------------------------
// Outbound

export const getPilotRequest = { method: "getPilot", params: {} } as const
export const getSystemConfigRequest = { method: "getSystemConfig", params: {} } as const

export const setPilotRequest = (mac: string, params: Record<string, number | boolean>) => ({
  method: "setPilot",
  env: "pro",
  params: { mac, src: "udp", ...params }
})

export const registrationRequest = (phoneMac: string, phoneIp: string) => ({
  method: "registration",
  params: { phoneMac, register: false, phoneIp }
})
