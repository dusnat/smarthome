/**
 * The Homebridge dynamic platform. It owns nothing but the bridge between
 * Homebridge's lifecycle and the Effect layers:
 *
 *   didFinishLaunching → build layers (socket, registry, accessory bindings,
 *                        discovery) and keep them running
 *   shutdown           → interrupt, which closes the socket and stops timers
 *
 * Accessory UUIDs are derived from the device MAC exactly as homebridge-wiz-lan
 * does, so replacing that plugin keeps HomeKit rooms, scenes and automations.
 */
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from "homebridge"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { configuredName, decodeConfig, isIgnored, type WizConfig } from "../config.js"
import { Devices } from "../core/Devices.js"
import { DiscoveryLive } from "../core/Discovery.js"
import { Settings } from "../core/Settings.js"
import { Transport } from "../core/Transport.js"
import { normalizeMac } from "../protocol/messages.js"
import { classify, defaultName } from "../protocol/models.js"
import { bindAccessory, type Run } from "./accessories.js"
import { homebridgeLogger } from "./logger.js"

export const PLATFORM_NAME = "WizSmarthome"
export const PLUGIN_NAME = "homebridge-wiz-resilient"

/** What is persisted in each accessory's context; same shape as upstream. */
interface AccessoryContext {
  mac?: string
  model?: string
  ip?: string
}

export class WizPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>()
  private fiber: Fiber.Fiber<never, unknown> | undefined

  constructor(
    private readonly log: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API
  ) {
    const decoded = Effect.runSyncExit(decodeConfig(rawConfig))
    if (Exit.isFailure(decoded)) {
      log.error(`Invalid configuration; plugin disabled: ${String(decoded.cause)}`)
      return
    }
    const config = decoded.value
    api.on("didFinishLaunching", () => this.start(config))
    api.on("shutdown", () => {
      if (this.fiber) Effect.runFork(Fiber.interrupt(this.fiber))
    })
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory)
  }

  private start(config: WizConfig) {
    const core = Devices.layer.pipe(Layer.provideMerge(Transport.layer(config.port)))
    const withAccessories = this.accessoriesLayer().pipe(Layer.provideMerge(core))
    // Discovery starts last, so replies find the accessory bindings in place.
    const app = DiscoveryLive.pipe(
      Layer.provide(withAccessories),
      Layer.provide(Layer.mergeAll(Settings.layer(config), homebridgeLogger(this.log)))
    )
    this.fiber = Effect.runFork(Layer.launch(app))
    this.fiber.addObserver((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        this.log.error(`Plugin stopped: ${String(exit.cause)}`)
      }
    })
  }

  /** Restores cached accessories, creates new ones, keeps contexts current. */
  private accessoriesLayer() {
    const { api, log, cached } = this
    return Layer.effectDiscard(
      Effect.gen(function*() {
        const devices = yield* Devices
        const settings = yield* Settings
        const context = yield* Effect.context<never>()
        const run: Run = (effect) => Effect.runPromiseWith(context)(effect)
        const bound = new Map<string, PlatformAccessory>()
        // Subscribe before anything can be discovered.
        const events = yield* devices.events

        const bind = (accessory: PlatformAccessory, mac: string, model: string) =>
          Effect.gen(function*() {
            const kind = classify(model)
            if (kind === undefined || bound.has(accessory.UUID)) return
            const handle = yield* devices.seed({ mac, model, ip: (accessory.context as AccessoryContext).ip })
            yield* bindAccessory({ api, accessory, handle, kind, settings, run })
            bound.set(accessory.UUID, accessory)
          })

        // 1. Accessories from the cache.
        const stale: Array<PlatformAccessory> = []
        for (const accessory of cached.values()) {
          const ctx = accessory.context as AccessoryContext
          if (typeof ctx.mac !== "string" || typeof ctx.model !== "string" || classify(ctx.model) === undefined) {
            log.debug(`Cached accessory ${accessory.displayName} has no usable device info; leaving it untouched`)
            continue
          }
          const mac = normalizeMac(ctx.mac)
          if (isIgnored(settings, mac, ctx.ip)) {
            log.debug(`Removing ignored device ${accessory.displayName}`)
            stale.push(accessory)
            continue
          }
          const name = configuredName(settings, mac, ctx.ip)
          if (name !== undefined && name !== accessory.displayName) {
            log.debug(`Renaming ${accessory.displayName} to ${name}`)
            accessory.displayName = name
            api.updatePlatformAccessories([accessory])
          }
          yield* bind(accessory, mac, ctx.model)
        }
        if (stale.length > 0) {
          api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
          for (const accessory of stale) cached.delete(accessory.UUID)
        }
        log.debug(`Restored ${bound.size} accessories from cache`)

        // 2. New devices and address changes.
        yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function*() {
              const uuid = api.hap.uuid.generate(event.mac)
              if (event._tag === "Moved") {
                const accessory = bound.get(uuid)
                if (accessory) {
                  // Persist the address only as a hint for the next start.
                  ;(accessory.context as AccessoryContext).ip = event.ip
                  api.updatePlatformAccessories([accessory])
                }
                return
              }
              const existing = cached.get(uuid)
              if (existing) {
                // Seen before its cache entry was bound (e.g. its boot beacon
                // raced startup): reuse it, never register a duplicate.
                Object.assign(existing.context as AccessoryContext, { mac: event.mac, model: event.model, ip: event.ip })
                api.updatePlatformAccessories([existing])
                return yield* bind(existing, event.mac, event.model)
              }
              const kind = classify(event.model)
              if (kind === undefined) return
              const name = configuredName(settings, event.mac, event.ip) ?? defaultName(kind, event.mac)
              const accessory = new api.platformAccessory(name, uuid)
              Object.assign(accessory.context as AccessoryContext, { mac: event.mac, model: event.model, ip: event.ip })
              yield* bind(accessory, event.mac, event.model)
              cached.set(uuid, accessory)
              api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
              log.debug(`Added ${name}`)
            })
          ),
          Effect.forkScoped
        )
      })
    )
  }
}
