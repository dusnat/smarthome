import { Context, Layer } from "effect"
import type { WizConfig } from "../config.js"

/** Decoded plugin configuration, available to every service. */
export class Settings extends Context.Service<Settings, WizConfig>()("wiz/core/Settings") {
  static readonly layer = (config: WizConfig) => Layer.succeed(Settings, config)
}
