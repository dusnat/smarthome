import type { API } from "homebridge"
import { PLATFORM_NAME, WizPlatform } from "./homebridge/platform.js"

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, WizPlatform)
}
