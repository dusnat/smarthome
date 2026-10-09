/**
 * The single UDP socket the plugin talks through.
 *
 * Bound to all interfaces (not to the host's own IP like upstream) because a
 * socket bound to a unicast address does not receive broadcast datagrams, and
 * bulbs broadcast `firstBeat` when they power up.
 */
import dgram from "node:dgram"
import { Context, Effect, Layer, Option, PubSub, Schema, type Scope, Stream } from "effect"
import { DEVICE_PORT, type Inbound, parseInbound } from "../protocol/messages.js"

export class SendError extends Schema.TaggedError<SendError>()("SendError", {
  ip: Schema.String,
  message: Schema.String
}) {}

export class Transport extends Context.Service<Transport, {
  /** Send a JSON request to a device (or broadcast address) on the WiZ port. */
  send(ip: string, payload: object): Effect.Effect<void, SendError>
  /**
   * Every decoded datagram received after the subscription is taken. The
   * subscription is live as soon as this effect completes, so nothing that
   * arrives between subscribing and consuming is lost.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<Inbound>, never, Scope.Scope>
}>()("wiz/core/Transport") {
  static readonly layer = (port: number) =>
    Layer.effect(
      Transport,
      Effect.gen(function*() {
        const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Inbound>(), PubSub.shutdown)

        const socket = yield* Effect.acquireRelease(
          Effect.callback<dgram.Socket, Error>((resume) => {
            // No reuseAddr: if another process (e.g. the old plugin) holds
            // the port, fail loudly instead of silently splitting replies.
            const socket = dgram.createSocket("udp4")
            const onError = (error: Error) => resume(Effect.fail(error))
            socket.once("error", onError)
            socket.bind(port, "0.0.0.0", () => {
              socket.off("error", onError)
              socket.setBroadcast(true)
              resume(Effect.succeed(socket))
            })
          }),
          (socket) => Effect.sync(() => socket.close())
        ).pipe(
          Effect.mapError((error) => new Error(`Could not listen on UDP port ${port}: ${error.message}`)),
          Effect.orDie
        )

        const context = yield* Effect.context<never>()
        socket.on("error", (error) => {
          Effect.runForkWith(context)(Effect.logWarning(`UDP socket error: ${error.message}`))
        })
        socket.on("message", (data, rinfo) => {
          const inbound = parseInbound(data.toString("utf8"), rinfo.address)
          if (Option.isSome(inbound)) {
            PubSub.publishUnsafe(pubsub, inbound.value)
          }
        })
        yield* Effect.logDebug(`Listening on UDP 0.0.0.0:${port}`)

        const send = (ip: string, payload: object) =>
          Effect.callback<void, SendError>((resume) => {
            socket.send(JSON.stringify(payload), DEVICE_PORT, ip, (error) =>
              resume(error ? Effect.fail(new SendError({ ip, message: error.message })) : Effect.void)
            )
          })

        return Transport.of({
          send,
          subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription))
        })
      })
    )
}
