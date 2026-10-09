/**
 * Platform configuration. Accepts every key homebridge-wiz-lan accepts so an
 * existing "WizSmarthome" platform block works unchanged. Only the defaults
 * for refreshInterval and discoveryInterval differ (upstream: both off).
 */
import { Effect, Schema } from "effect"
import { DEFAULT_LISTEN_PORT, normalizeMac } from "./protocol/messages.js"

const optional = <S extends Schema.Constraint>(schema: S) => Schema.optionalKey(schema)

const DeviceEntry = Schema.Struct({
  host: optional(Schema.String),
  mac: optional(Schema.String),
  name: optional(Schema.String)
})

const RawConfig = Schema.Struct({
  name: optional(Schema.String),
  port: optional(Schema.Number),
  enableScenes: optional(Schema.Boolean),
  lastStatus: optional(Schema.Boolean),
  broadcast: optional(Schema.String),
  address: optional(Schema.String),
  mac: optional(Schema.String),
  devices: optional(Schema.Array(DeviceEntry)),
  ignoredDevices: optional(Schema.Array(DeviceEntry)),
  refreshInterval: optional(Schema.Number),
  discoveryInterval: optional(Schema.Number),
  pingFailuresBeforeOffline: optional(Schema.Number)
})

export interface DeviceMatcher {
  readonly host: string | undefined
  readonly mac: string | undefined
}

export interface WizConfig {
  readonly port: number
  readonly enableScenes: boolean
  readonly lastStatus: boolean
  readonly broadcast: string
  /** IP to advertise in discovery requests; autodetected when unset. */
  readonly address: string | undefined
  /** MAC to advertise in discovery requests; autodetected when unset. */
  readonly mac: string | undefined
  readonly devices: ReadonlyArray<DeviceMatcher & { readonly name: string | undefined }>
  readonly ignoredDevices: ReadonlyArray<DeviceMatcher>
  /** Seconds between background state polls; 0 disables polling. */
  readonly refreshInterval: number
  /** Seconds between discovery broadcasts; 0 disables periodic discovery. */
  readonly discoveryInterval: number
  readonly pingFailuresBeforeOffline: number
}

export const MIN_DISCOVERY_INTERVAL = 10

export const defaults: WizConfig = {
  port: DEFAULT_LISTEN_PORT,
  enableScenes: false,
  lastStatus: false,
  broadcast: "255.255.255.255",
  address: undefined,
  mac: undefined,
  devices: [],
  ignoredDevices: [],
  refreshInterval: 30,
  discoveryInterval: 60,
  pingFailuresBeforeOffline: 3
}

const matcher = (entry: { readonly host?: string; readonly mac?: string }): DeviceMatcher => ({
  host: entry.host?.trim() || undefined,
  mac: entry.mac === undefined || entry.mac.trim() === "" ? undefined : normalizeMac(entry.mac)
})

const nonNegative = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value

export const decodeConfig = (input: unknown) =>
  Schema.decodeUnknownEffect(RawConfig)(input).pipe(
    Effect.map((raw): WizConfig => {
      const discovery = nonNegative(raw.discoveryInterval, defaults.discoveryInterval)
      return {
        port: raw.port ?? defaults.port,
        enableScenes: raw.enableScenes ?? defaults.enableScenes,
        lastStatus: raw.lastStatus ?? defaults.lastStatus,
        broadcast: raw.broadcast?.trim() || defaults.broadcast,
        address: raw.address?.trim() || undefined,
        mac: raw.mac?.trim() || undefined,
        devices: (raw.devices ?? []).map((d) => ({ ...matcher(d), name: d.name?.trim() || undefined })),
        ignoredDevices: (raw.ignoredDevices ?? []).map(matcher),
        refreshInterval: nonNegative(raw.refreshInterval, defaults.refreshInterval),
        discoveryInterval: discovery === 0 ? 0 : Math.max(MIN_DISCOVERY_INTERVAL, discovery),
        pingFailuresBeforeOffline: Math.max(1, Math.floor(raw.pingFailuresBeforeOffline ?? defaults.pingFailuresBeforeOffline))
      }
    })
  )

const matches = (m: DeviceMatcher, mac: string, ip: string | undefined) =>
  (m.mac !== undefined && m.mac === mac) || (m.host !== undefined && ip !== undefined && m.host === ip)

export const isIgnored = (config: WizConfig, mac: string, ip: string | undefined): boolean =>
  config.ignoredDevices.some((m) => matches(m, mac, ip))

/** Configured display name for a device, if any. */
export const configuredName = (config: WizConfig, mac: string, ip: string | undefined): string | undefined =>
  config.devices.find((d) => d.name !== undefined && matches(d, mac, ip))?.name
