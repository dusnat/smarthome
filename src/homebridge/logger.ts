import type { Logging } from "homebridge"
import { Layer, Logger, References } from "effect"

const render = (message: unknown): string =>
  (Array.isArray(message) ? message : [message])
    .map((part) => (typeof part === "string" ? part : part instanceof Error ? part.message : JSON.stringify(part)))
    .join(" ")

/** Route Effect logs to Homebridge's logger (which applies its own debug filter). */
export const homebridgeLogger = (log: Logging) =>
  Layer.mergeAll(
    Logger.layer([
      Logger.make(({ logLevel, message }) => {
        const text = render(message)
        switch (logLevel) {
          case "Fatal":
          case "Error":
            return log.error(text)
          case "Warn":
            return log.warn(text)
          case "Info":
            return log.info(text)
          default:
            return log.debug(text)
        }
      })
    ]),
    Layer.succeed(References.MinimumLogLevel, "Debug")
  )
