/**
 * HomeKit services for a device. Handlers translate between HomeKit values and
 * device patches; all I/O, retries and state live in the device worker.
 *
 * Values are pushed to HomeKit from the worker's state changes, which also
 * keeps the Lightbulb, scene (Television) and Adaptive Lighting views in sync
 * without cross-wiring their handlers.
 */
import type {
  API,
  Characteristic,
  CharacteristicValue,
  PlatformAccessory,
  Service
} from "homebridge"
import { Effect, Stream } from "effect"
import type { Scope } from "effect"
import type { WizConfig } from "../config.js"
import type { DeviceHandle, Snapshot } from "../core/DeviceWorker.js"
import { hsvToWiz, miredToKelvin } from "../protocol/color.js"
import { type DeviceKind, sceneFamily } from "../protocol/models.js"
import { describeChange, dimmingFromBrightness, homeKitView, type Pilot, type PilotPatch } from "../protocol/pilot.js"
import { NO_SCENE_KELVIN, sceneName, scenesFor } from "../protocol/scenes.js"

/** Runs an effect from a HomeKit handler. */
export type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

interface Binding {
  readonly api: API
  readonly accessory: PlatformAccessory
  readonly handle: DeviceHandle
  readonly kind: DeviceKind
  readonly settings: WizConfig
  readonly run: Run
}

/** Wire an accessory to its device. Lives as long as the enclosing scope. */
export const bindAccessory = (binding: Binding): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const { api, accessory, handle, kind } = binding
    const { Service, Characteristic } = api.hap

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, "Wiz")
      .setCharacteristic(Characteristic.Model, handle.model)
      .setCharacteristic(Characteristic.SerialNumber, handle.mac)

    const push = kind._tag === "Socket" ? bindOutlet(binding) : bindLight(binding, kind)
    const name = accessory.displayName
    let wasReachable = true
    let lastConfirmed: Pilot | undefined
    yield* handle.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.gen(function*() {
          // Clearing "No Response" needs a forced update: HomeKit's stored
          // value can't tell us it is showing an error.
          push(snapshot, snapshot.reachable && !wasReachable)

          // The only things logged at normal level: reachability changes and
          // state changes the device confirmed (never optimistic ones).
          if (wasReachable && !snapshot.reachable) yield* Effect.logInfo(`${name}: offline (not responding)`)
          if (!wasReachable && snapshot.reachable) yield* Effect.logInfo(`${name}: back online`)
          wasReachable = snapshot.reachable
          if (snapshot.confirmed !== undefined && snapshot.confirmed !== lastConfirmed) {
            const change = lastConfirmed === undefined
              ? undefined
              : describeChange(lastConfirmed, snapshot.confirmed, { light: kind._tag === "Light", sceneName })
            if (change !== undefined) yield* Effect.logInfo(`${name}: ${change}`)
            lastConfirmed = snapshot.confirmed
          }
        })
      ),
      Effect.forkScoped
    )
  })

type Push = (snapshot: Snapshot, force: boolean) => void

const communicationFailure = (api: API) => new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)

/** Turn worker failures into the HomeKit "No Response" status. */
const handler = <A, E>(binding: Binding, effect: Effect.Effect<A, E>) =>
  binding.run(effect).catch((error) => {
    throw error instanceof binding.api.hap.HapStatusError ? error : communicationFailure(binding.api)
  })

const getter = <A extends CharacteristicValue>(binding: Binding, f: (pilot: Pilot) => A) => () =>
  handler(binding, Effect.map(binding.handle.read, f))

const setter = (binding: Binding, toPatch: (value: CharacteristicValue) => PilotPatch) => async (value: CharacteristicValue) => {
  await handler(binding, binding.handle.write(toPatch(value)))
}

const update = (characteristic: Characteristic, value: CharacteristicValue | Error, force: boolean) => {
  // Re-publishing an unchanged value still notifies every controller, which
  // then reads again; only publish real changes.
  if (force || value instanceof Error || characteristic.value !== value) {
    characteristic.updateValue(value)
  }
}

const ensureService = (accessory: PlatformAccessory, type: typeof Service.Lightbulb | typeof Service.Outlet | typeof Service.Television) =>
  accessory.getService(type) ?? accessory.addService(type, accessory.displayName)

// ---------------------------------------------------------------------------

const bindOutlet = (binding: Binding): Push => {
  const { api, accessory } = binding
  const { Service, Characteristic } = api.hap
  const on = ensureService(accessory, Service.Outlet)
    .getCharacteristic(Characteristic.On)
    .onGet(getter(binding, (p) => p.state))
    .onSet(setter(binding, (v) => ({ state: Boolean(v) })))

  return (snapshot, force) => {
    if (!snapshot.reachable) return update(on, communicationFailure(api), true)
    if (snapshot.pilot) update(on, snapshot.pilot.state, force)
  }
}

const bindLight = (binding: Binding, kind: Extract<DeviceKind, { _tag: "Light" }>): Push => {
  const { api, accessory, settings } = binding
  const { Service, Characteristic } = api.hap
  const service = ensureService(accessory, Service.Lightbulb)

  const on = service
    .getCharacteristic(Characteristic.On)
    .onGet(getter(binding, (p) => homeKitView(p).on))
    .onSet(setter(binding, (v) => ({ state: Boolean(v) })))

  const brightness = service
    .getCharacteristic(Characteristic.Brightness)
    .onGet(getter(binding, (p) => homeKitView(p).brightness))
    .onSet(setter(binding, (v) => ({ dimming: dimmingFromBrightness(Number(v)) })))

  const removeIfPresent = (type: typeof Characteristic.Hue) => {
    if (service.testCharacteristic(type)) service.removeCharacteristic(service.getCharacteristic(type))
  }

  let temperature: Characteristic | undefined
  if (kind.temperature) {
    temperature = service
      .getCharacteristic(Characteristic.ColorTemperature)
      .onGet(getter(binding, (p) => homeKitView(p).colorTemperature))
      .onSet(setter(binding, (v) => ({ temp: miredToKelvin(Number(v)) })))
  } else {
    removeIfPresent(Characteristic.ColorTemperature)
  }

  let hue: Characteristic | undefined
  let saturation: Characteristic | undefined
  if (kind.color) {
    // HomeKit sets hue and saturation as two separate writes. Remember the
    // last of each so the second write combines with the first rather than
    // with the stale device state; the worker merges the two into one packet.
    const chosen = { hue: 0, saturation: 0 }
    const toColor = (): PilotPatch => hsvToWiz(chosen.hue / 360, chosen.saturation / 100)
    hue = service
      .getCharacteristic(Characteristic.Hue)
      .onGet(getter(binding, (p) => homeKitView(p).hue))
      .onSet(setter(binding, (v) => ((chosen.hue = Number(v)), toColor())))
    saturation = service
      .getCharacteristic(Characteristic.Saturation)
      .onGet(getter(binding, (p) => homeKitView(p).saturation))
      .onSet(setter(binding, (v) => ((chosen.saturation = Number(v)), toColor())))
    chosen.hue = Number(hue.value ?? 0)
    chosen.saturation = Number(saturation.value ?? 0)
    hue.on("change", ({ newValue }) => (chosen.hue = Number(newValue)))
    saturation.on("change", ({ newValue }) => (chosen.saturation = Number(newValue)))
  } else {
    removeIfPresent(Characteristic.Hue)
    removeIfPresent(Characteristic.Saturation)
  }

  const adaptive = kind.temperature ? bindAdaptiveLighting(binding, service) : undefined
  const scenes = settings.enableScenes ? bindScenes(binding) : (removeScenes(binding), undefined)

  return (snapshot, force) => {
    const targets = [on, brightness, temperature, hue, saturation].filter((c) => c !== undefined)
    if (!snapshot.reachable) {
      for (const c of targets) update(c, communicationFailure(api), true)
      scenes?.(snapshot, force)
      return
    }
    if (snapshot.pilot === undefined) return
    const view = homeKitView(snapshot.pilot)
    update(on, view.on, force)
    update(brightness, view.brightness, force)
    // While a scene runs the bulb reports no meaningful white temperature.
    if (temperature && view.sceneId === 0) update(temperature, view.colorTemperature, force)
    if (hue) update(hue, view.hue, force)
    if (saturation) update(saturation, view.saturation, force)
    adaptive?.(snapshot)
    scenes?.(snapshot, force)
  }
}

// ---------------------------------------------------------------------------

const bindAdaptiveLighting = (binding: Binding, service: Service) => {
  const { api, accessory } = binding
  const controller = new api.hap.AdaptiveLightingController(service, {
    controllerMode: api.hap.AdaptiveLightingControllerMode.AUTOMATIC
  })
  accessory.configureController(controller)
  let seen: number | undefined
  return (snapshot: Snapshot) => {
    // Someone changed the color or scene outside HomeKit: step aside, as
    // Adaptive Lighting would otherwise overwrite it on its next update.
    if (seen !== undefined && snapshot.externalChanges !== seen && controller.isAdaptiveLightingActive()) {
      controller.disableAdaptiveLighting()
    }
    seen = snapshot.externalChanges
  }
}

const removeScenes = ({ api, accessory }: Binding) => {
  const tv = accessory.getService(api.hap.Service.Television)
  if (tv) accessory.removeService(tv)
  for (const input of accessory.services.filter((s) => s.UUID === api.hap.Service.InputSource.UUID)) {
    accessory.removeService(input)
  }
}

const bindScenes = (binding: Binding): Push => {
  const { api, accessory, handle } = binding
  const { Service, Characteristic } = api.hap
  const tv = ensureService(accessory, Service.Television)

  const active = tv
    .getCharacteristic(Characteristic.Active)
    .onGet(getter(binding, (p) => (p.state ? 1 : 0)))
    .onSet(setter(binding, (v) => ({ state: Boolean(v) })))

  const activeIdentifier = tv
    .getCharacteristic(Characteristic.ActiveIdentifier)
    .onGet(getter(binding, (p) => p.sceneId ?? 0))
    .onSet(setter(binding, (v) => (Number(v) === 0 ? { temp: NO_SCENE_KELVIN } : { sceneId: Number(v) })))

  const supported = scenesFor(sceneFamily(handle.model))
  const supportedIds = new Set(supported.map((s) => String(s.id)))
  for (const input of accessory.services.filter((s) => s.UUID === Service.InputSource.UUID)) {
    if (!supportedIds.has(input.subtype ?? "")) accessory.removeService(input)
  }
  for (const scene of supported) {
    const input =
      accessory.getServiceById(Service.InputSource, String(scene.id)) ??
      accessory.addService(Service.InputSource, scene.name, String(scene.id))
    input
      .setCharacteristic(Characteristic.Identifier, scene.id)
      .setCharacteristic(Characteristic.ConfiguredName, scene.name)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI)
    tv.addLinkedService(input)
  }

  return (snapshot, force) => {
    if (!snapshot.reachable) {
      update(active, communicationFailure(api), true)
      update(activeIdentifier, communicationFailure(api), true)
      return
    }
    if (snapshot.pilot === undefined) return
    update(active, snapshot.pilot.state ? 1 : 0, force)
    update(activeIdentifier, snapshot.pilot.sceneId ?? 0, force)
  }
}
