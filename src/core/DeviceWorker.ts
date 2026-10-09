/**
 * One worker per device. It owns the device's state and is the only thing
 * that talks to it, one exchange at a time. That makes reply attribution
 * simple (a reply can only belong to the single open request) and removes the
 * need for upstream's generation counters and duplicate-reply bookkeeping.
 *
 * The device's IP is never stored here: every attempt asks the registry, so
 * a device that moved is reached at its new address on the next attempt.
 */
import { Clock, Deferred, Duration, Effect, Exit, Option, Queue, Random, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import {
  getPilotRequest,
  type Inbound,
  setPilotRequest
} from "../protocol/messages.js"
import { applyPatch, colorDiffers, contradicts, type Pilot, type PilotPatch, toParams } from "../protocol/pilot.js"
import { Settings } from "./Settings.js"
import { Transport } from "./Transport.js"

export class DeviceUnreachable extends Schema.TaggedError<DeviceUnreachable>()("DeviceUnreachable", {
  mac: Schema.String,
  reason: Schema.String
}) {}

export class DeviceRejected extends Schema.TaggedError<DeviceRejected>()("DeviceRejected", {
  mac: Schema.String,
  message: Schema.String
}) {}

export interface Snapshot {
  readonly mac: string
  readonly model: string
  /** State HomeKit should show; includes a write that is still in flight. */
  readonly pilot: Pilot | undefined
  /** Last state the device itself confirmed (a state reply or a write ack). */
  readonly confirmed: Pilot | undefined
  readonly reachable: boolean
  /**
   * Bumped whenever a poll shows a color, white or scene change this plugin
   * did not make. Adaptive Lighting turns itself off when it changes.
   */
  readonly externalChanges: number
}

export interface DeviceHandle {
  readonly mac: string
  readonly model: string
  readonly snapshot: Effect.Effect<Snapshot>
  readonly changes: Stream.Stream<Snapshot>
  /** Current state for a HomeKit read: cached when possible, never stale for long. */
  readonly read: Effect.Effect<Pilot, DeviceUnreachable>
  /** Apply a change and resolve once the device acknowledged it. */
  write(patch: PilotPatch): Effect.Effect<Pilot, DeviceUnreachable | DeviceRejected>
}

export interface Worker extends DeviceHandle {
  /** Route a reply that belongs to this device. */
  deliver(message: Inbound): Effect.Effect<void>
  /**
   * The device was just heard from outside our own requests. `booted` means
   * it announced a power-up, so its state may have reset even if we never
   * noticed it was gone.
   */
  revive(booted: boolean): Effect.Effect<void>
}

// Timings. Each exchange is one request and one reply on a LAN, normally a
// few tens of milliseconds; the timeouts allow for Wi-Fi power saving.
const PROBE_TIMEOUT = Duration.seconds(1)
const WRITE_TIMEOUT = Duration.millis(1500)
const UNREACHABLE_WRITE_TIMEOUT = Duration.seconds(1)
/** A HomeKit read refreshes the cache in the background if it is older than this. */
const CACHE_FRESH_MS = 2_000
/** Window after a write in which a contradicting report is double-checked. */
const SETTLE_MS = 2_000
const SETTLE_RECHECK = Duration.millis(300)
/** Reads of an unreachable device trigger a probe at most this often. */
const UNREACHABLE_KICK_MS = 10_000
const UNREACHABLE_POLL_MIN_SECONDS = 60

type ProbeMode = "background" | "interactive" | "revive"

const probeSchedule = (mode: ProbeMode) => {
  switch (mode) {
    case "background":
      return Schedule.recurs(0)
    case "interactive":
      return Schedule.max([Schedule.recurs(2), Schedule.spaced("300 millis")])
    case "revive":
      // A device that just booted can take a moment before it answers.
      return Schedule.max([Schedule.recurs(4), Schedule.spaced("1 second")])
  }
}

type Job =
  | { readonly _tag: "Probe"; readonly mode: ProbeMode; readonly done: Deferred.Deferred<Pilot, DeviceUnreachable> | undefined }
  | { readonly _tag: "Write"; readonly patch: PilotPatch; readonly done: Deferred.Deferred<Pilot, DeviceUnreachable | DeviceRejected> }

type Reply =
  | { readonly _tag: "Pilot"; readonly pilot: Pilot }
  | { readonly _tag: "Ack" }

interface Pending {
  readonly method: "getPilot" | "setPilot"
  readonly reply: Deferred.Deferred<Reply, DeviceRejected>
}

class ExchangeFailed extends Schema.TaggedError<ExchangeFailed>()("ExchangeFailed", {
  reason: Schema.String
}) {}

const rank: Record<ProbeMode, number> = { background: 0, interactive: 1, revive: 2 }

export const makeWorker = Effect.fnUntraced(function*(options: {
  readonly mac: string
  readonly model: string
  /** Current address from the registry, looked up on every attempt. */
  readonly address: Effect.Effect<string | undefined>
}): Effect.fn.Return<Worker, never, Transport | Settings | Scope.Scope> {
  const { mac, model, address } = options
  const transport = yield* Transport
  const settings = yield* Settings

  const state = yield* SubscriptionRef.make<Snapshot>({
    mac,
    model,
    pilot: undefined,
    confirmed: undefined,
    reachable: true,
    externalChanges: 0
  })
  const jobs = yield* Effect.acquireRelease(Queue.unbounded<Job>(), Queue.shutdown)

  // Mutable bookkeeping owned by this worker. Only the worker fiber and
  // synchronous handlers touch it, so no locking is needed.
  let pending: Pending | undefined
  let failures = 0
  let lastProbeAt = 0
  let lastKickAt = 0
  let lastWrite: { readonly at: number; readonly patch: PilotPatch } | undefined
  let queuedProbe: ProbeMode | undefined

  // Reachability and state changes are logged by the Homebridge layer, which
  // knows the accessory names. Everything here is diagnostic.
  const warn = (message: string) => Effect.logWarning(`${mac}: ${message}`)
  const debug = (message: string) => Effect.logDebug(`${mac}: ${message}`)

  // --- one request, one reply ------------------------------------------------

  const exchange = (method: Pending["method"], payload: object, timeout: Duration.Duration) =>
    Effect.gen(function*() {
      const ip = yield* address
      if (ip === undefined) {
        return yield* new ExchangeFailed({ reason: "address unknown" })
      }
      const reply = yield* Deferred.make<Reply, DeviceRejected>()
      pending = { method, reply }
      const started = yield* Clock.currentTimeMillis
      yield* transport.send(ip, payload).pipe(
        Effect.mapError((e) => new ExchangeFailed({ reason: `send failed: ${e.message}` }))
      )
      const result = yield* Deferred.await(reply).pipe(
        Effect.timeout(timeout),
        Effect.catchTag("TimeoutError", () => Effect.fail(new ExchangeFailed({ reason: `no reply from ${ip}` })))
      )
      yield* debug(`${method} ${ip} answered in ${(yield* Clock.currentTimeMillis) - started}ms`)
      return result
    }).pipe(Effect.ensuring(Effect.sync(() => (pending = undefined))))

  const deliver = (message: Inbound) =>
    Effect.gen(function*() {
      const open = pending
      switch (message._tag) {
        case "PilotReply":
          if (open?.method === "getPilot") {
            yield* Deferred.succeed(open.reply, { _tag: "Pilot", pilot: message.pilot })
          } else {
            // A late or unsolicited report. It proves the device is alive, but
            // its contents may predate a write, so it is not applied.
            yield* revive(false)
          }
          return
        case "SetPilotAck":
          if (open?.method === "setPilot") {
            yield* message.error === undefined
              ? Deferred.succeed(open.reply, { _tag: "Ack" })
              : Deferred.fail(open.reply, new DeviceRejected({ mac, message: message.error }))
          }
          return
        case "ErrorReply":
          if (open?.method === message.method) {
            yield* Deferred.fail(open.reply, new DeviceRejected({ mac, message: message.message }))
          }
          return
        default:
          return
      }
    })

  // --- reachability -----------------------------------------------------------

  const succeeded = Effect.gen(function*() {
    failures = 0
    const wasReachable = (yield* SubscriptionRef.get(state)).reachable
    if (!wasReachable) {
      yield* debug("Device is responding again")
      yield* SubscriptionRef.update(state, (s) => ({ ...s, reachable: true }))
    }
  })

  const failed = (reason: string) =>
    Effect.gen(function*() {
      failures += 1
      const snapshot = yield* SubscriptionRef.get(state)
      yield* debug(`Exchange failed (${failures} in a row): ${reason}`)
      if (snapshot.reachable && failures >= settings.pingFailuresBeforeOffline) {
        yield* debug(`Device is not responding (${failures} failed attempts); showing "No Response"`)
        yield* SubscriptionRef.update(state, (s) => ({ ...s, reachable: false }))
      }
    })

  // --- probes -------------------------------------------------------------------

  const getPilot = (schedule: ReturnType<typeof probeSchedule>) =>
    exchange("getPilot", getPilotRequest, PROBE_TIMEOUT).pipe(
      Effect.flatMap((reply) =>
        reply._tag === "Pilot" ? Effect.succeed(reply.pilot) : Effect.fail(new ExchangeFailed({ reason: "unexpected reply" }))
      ),
      Effect.retry({ schedule, while: (e) => e._tag === "ExchangeFailed" })
    )

  /** Store a fresh report, unless it plausibly predates our last write. */
  const accept = (reported: Pilot, previous: Pilot | undefined) =>
    SubscriptionRef.update(state, (s) => {
      const external = previous !== undefined && (colorDiffers(previous, reported) || (reported.sceneId ?? 0) !== 0)
      return {
        ...s,
        pilot: reported,
        confirmed: reported,
        reachable: true,
        externalChanges: external ? s.externalChanges + 1 : s.externalChanges
      }
    })

  const probe = (mode: ProbeMode) =>
    Effect.gen(function*() {
      lastProbeAt = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(getPilot(probeSchedule(mode)))
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Exit.findErrorOption(exit))
        yield* failed(error?._tag === "ExchangeFailed" ? error.reason : "device returned an error")
        return yield* new DeviceUnreachable({ mac, reason: "no state reply" })
      }
      let reported = exit.value
      yield* succeeded
      const now = yield* Clock.currentTimeMillis
      if (lastWrite !== undefined && now - lastWrite.at < SETTLE_MS && contradicts(lastWrite.patch, reported)) {
        // Either the device has not applied our write yet, or this reply was
        // generated before it. Ask once more and believe the second answer.
        yield* debug("State report contradicts a just-acknowledged write; checking again")
        yield* Effect.sleep(SETTLE_RECHECK)
        const again = yield* Effect.exit(getPilot(probeSchedule("background")))
        if (Exit.isSuccess(again)) reported = again.value
      }
      const previous = (yield* SubscriptionRef.get(state)).pilot
      yield* accept(reported, previous)
      return reported
    })

  // --- writes ---------------------------------------------------------------------

  const write = (patch: PilotPatch) =>
    Effect.gen(function*() {
      let current = (yield* SubscriptionRef.get(state)).pilot
      if (current === undefined) {
        // After a restart we may not know the full state yet. Writes send the
        // complete state, so learn it first instead of refusing (upstream).
        current = yield* probe("interactive")
      }
      const desired = applyPatch(current, patch)
      const stateOnly = Object.keys(patch).length === 1 && patch.state !== undefined
      const params = settings.lastStatus && stateOnly ? { state: desired.state } : toParams(desired)
      const reachable = (yield* SubscriptionRef.get(state)).reachable
      // An unreachable device still gets one quick attempt: it may be back
      // and nothing has told us yet.
      const schedule = reachable ? Schedule.max([Schedule.recurs(2), Schedule.spaced("200 millis")]) : Schedule.recurs(0)
      const timeout = reachable ? WRITE_TIMEOUT : UNREACHABLE_WRITE_TIMEOUT

      // Optimistic: HomeKit reads during the write see the new value.
      yield* SubscriptionRef.update(state, (s) => ({ ...s, pilot: desired }))
      const exit = yield* Effect.exit(
        exchange("setPilot", setPilotRequest(mac, params), timeout).pipe(
          Effect.retry({ schedule, while: (e) => e._tag === "ExchangeFailed" })
        )
      )
      if (Exit.isSuccess(exit)) {
        lastWrite = { at: yield* Clock.currentTimeMillis, patch }
        yield* debug(`Applied ${JSON.stringify(patch)}`)
        yield* SubscriptionRef.update(state, (s) => ({ ...s, confirmed: desired }))
        yield* succeeded
        if (settings.lastStatus && stateOnly && desired.state) {
          // The device restored its own last settings; learn what they are.
          yield* enqueueProbe("background")
        }
        return desired
      }
      yield* SubscriptionRef.update(state, (s) => (s.pilot === desired ? { ...s, pilot: current } : s))
      const error = Option.getOrUndefined(Exit.findErrorOption(exit))
      if (error?._tag === "DeviceRejected") {
        yield* warn(`Device rejected a change: ${error.message}`)
        return yield* error
      }
      yield* failed(error?.reason ?? "write failed")
      // The write may still have landed with only the ack lost; re-sync.
      yield* enqueueProbe("background")
      return yield* new DeviceUnreachable({ mac, reason: "no acknowledgement" })
    })

  // --- the worker loop --------------------------------------------------------------

  const enqueueProbe = (mode: ProbeMode) =>
    Effect.suspend(() => {
      if (queuedProbe !== undefined && rank[queuedProbe] >= rank[mode]) return Effect.void
      queuedProbe = mode
      return Queue.offer(jobs, { _tag: "Probe", mode, done: undefined })
    })

  const runBatch = (batch: ReadonlyArray<Job>) =>
    Effect.gen(function*() {
      const writes = batch.filter((j): j is Extract<Job, { _tag: "Write" }> => j._tag === "Write")
      const probes = batch.filter((j): j is Extract<Job, { _tag: "Probe" }> => j._tag === "Probe")
      queuedProbe = undefined

      if (writes.length > 0) {
        // Rapid changes (e.g. dragging a slider) collapse into one write.
        const patch = writes.reduce<PilotPatch>((acc, job) => ({ ...acc, ...job.patch }), {})
        const exit = yield* Effect.exit(write(patch))
        for (const job of writes) yield* Deferred.done(job.done, exit)
        if (Exit.isSuccess(exit)) {
          for (const job of probes) if (job.done) yield* Deferred.succeed(job.done, exit.value)
          return
        }
      }
      if (probes.length > 0) {
        const mode = probes.reduce<ProbeMode>((m, j) => (rank[j.mode] > rank[m] ? j.mode : m), "background")
        const exit = yield* Effect.exit(probe(mode))
        for (const job of probes) if (job.done) yield* Deferred.done(job.done, exit)
      }
    })

  yield* Queue.takeBetween(jobs, 1, 64).pipe(
    Effect.flatMap(runBatch),
    Effect.forever,
    Effect.forkScoped
  )

  // --- background polling -----------------------------------------------------------

  if (settings.refreshInterval > 0) {
    const interval = settings.refreshInterval
    yield* Effect.gen(function*() {
      // Spread devices across the interval instead of polling all at once.
      yield* Effect.sleep(Duration.millis(yield* Random.nextIntBetween(0, interval * 1000)))
      while (true) {
        yield* enqueueProbe("background")
        const { reachable } = yield* SubscriptionRef.get(state)
        yield* Effect.sleep(Duration.seconds(reachable ? interval : Math.max(interval, UNREACHABLE_POLL_MIN_SECONDS)))
      }
    }).pipe(Effect.forkScoped)
  }

  // --- public operations ---------------------------------------------------------------

  const revive = (booted: boolean) =>
    Effect.gen(function*() {
      const snapshot = yield* SubscriptionRef.get(state)
      if (booted || !snapshot.reachable || snapshot.pilot === undefined) {
        yield* debug(booted ? "Boot announcement received; re-reading state" : "Heard from device; re-reading state")
        yield* enqueueProbe("revive")
      }
    })

  const read = Effect.gen(function*() {
    const snapshot = yield* SubscriptionRef.get(state)
    const now = yield* Clock.currentTimeMillis
    if (!snapshot.reachable) {
      if (now - lastKickAt > UNREACHABLE_KICK_MS) {
        lastKickAt = now
        yield* enqueueProbe("background")
      }
      return yield* new DeviceUnreachable({ mac, reason: "not responding" })
    }
    if (snapshot.pilot !== undefined) {
      if (now - lastProbeAt > CACHE_FRESH_MS) yield* enqueueProbe("background")
      return snapshot.pilot
    }
    const done = yield* Deferred.make<Pilot, DeviceUnreachable>()
    yield* Queue.offer(jobs, { _tag: "Probe", mode: "interactive", done })
    return yield* Deferred.await(done)
  })

  const enqueueWrite = (patch: PilotPatch) =>
    Effect.gen(function*() {
      const done = yield* Deferred.make<Pilot, DeviceUnreachable | DeviceRejected>()
      yield* Queue.offer(jobs, { _tag: "Write", patch, done })
      return yield* Deferred.await(done)
    })

  return {
    mac,
    model,
    snapshot: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    read,
    write: enqueueWrite,
    deliver,
    revive
  }
})
