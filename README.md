# homebridge-wiz-resilient

A Homebridge plugin for WiZ lights and plugs on the local network. It is a
drop-in replacement for [homebridge-wiz-lan](https://github.com/kpsuperplane/homebridge-wiz-lan)
(same platform name, same config, same accessory identities) that keeps
devices working through power cuts and IP address changes without restarting
Homebridge.

## What it fixes

| Problem in homebridge-wiz-lan (3.3.3 / 3.4.2) | Here |
|---|---|
| Discovery runs once at startup (3.3.3); periodic discovery is off by default (3.4.x) | Several startup rounds, then every 60s by default |
| After rediscovery at a new IP, accessories keep using the old IP (the device object is captured at startup) | Only the registry stores IPs; every request looks up the current one |
| Bulbs announce themselves (`firstBeat`) when power returns; ignored | Handled: the device is re-read within about a second of booting |
| The socket is bound to the host IP, so broadcasts aren't received | Bound to all interfaces |
| Writes to a device marked offline are refused without trying | One quick attempt; success brings it back online |
| Writes with no cached state (e.g. after a restart) are refused | State is read first, then the write goes out |
| Offline recovery needs `refreshInterval > 0`, which defaults to 0 | Polling every 30s by default; boot beacons and discovery also recover devices |
| Lost write acknowledgements are not retried | Retried; safe because every write sends the complete state |
| Replies can't be matched to requests, so state can roll back | One request at a time per device; a contradicting report right after a write is checked again |

## Supported devices

The same as homebridge-wiz-lan: RGB, tunable white and dimmable bulbs, light
strips, string lights, light poles (`SHRGB`, `SHTW`, `SHDW`, `MHORGB`,
`MHWRGB`, `DHRGB`) and plugs (`ESP10_SOCKET_06`, `ESP25_SOCKET_01`). Scenes
(opt-in), Adaptive Lighting and `lastStatus` behave as they do upstream.

"Allow local communication" must be on in the WiZ app.

## Configuration

Every homebridge-wiz-lan key is accepted. A minimal block:

```json
{ "platform": "WizSmarthome", "name": "Dusnat's Big Perfect Smart Home" }
```

`platform` must stay `WizSmarthome`: Homebridge matches cached accessories
to the plugin by it, so changing it would orphan (and delete) every WiZ
accessory. `name` is free text; it prefixes the log lines and titles the
plugin in the UI.

Only two defaults differ:

| Key | Default | Upstream default |
|---|---|---|
| `refreshInterval` | `30` seconds (0 = off) | `0` |
| `discoveryInterval` | `60` seconds, minimum 10 (0 = startup only) | `0` |

See `config.schema.json` for all keys.

## Switching from homebridge-wiz-lan

Accessory UUIDs come from each device's MAC address, exactly as upstream
generates them. Homebridge hands the cached accessories to the new plugin
because it registers the same platform name (`WizSmarthome`). HomeKit rooms,
scenes and automations carry over.

The order matters: if Homebridge starts while neither plugin is installed, it
deletes the orphaned accessories and the HomeKit setup goes with them. If both
are installed, the platform name clashes.

1. Turn off anything that restarts Homebridge on a timer.
2. Back up the Homebridge storage directory (at least `accessories/` and
   `persist/`).
3. On this machine: `npm pack`. This builds the plugin and creates
   `homebridge-wiz-resilient-<version>.tgz`.
4. Stop Homebridge (`hb-service stop`).
5. In the directory Homebridge loads plugins from: `npm uninstall homebridge-wiz-lan`,
   then `npm install /path/to/homebridge-wiz-resilient-<version>.tgz`.
6. Start Homebridge (`hb-service start`). The log should say the plugin name
   changed from `homebridge-wiz-lan` to `homebridge-wiz-resilient` for each
   accessory, then `Restored N accessories from cache`.

## Development

```sh
npm install
npm test          # unit and behaviour tests on a simulated network
npm run typecheck
npm run build
```

Layout:

- `src/protocol/`: message schemas, state model, color math, models, scenes
- `src/core/`: the UDP transport, the device registry (`Devices`), one worker
  per device (`DeviceWorker`), and discovery. No Homebridge imports.
- `src/homebridge/`: the platform class, HomeKit service bindings, and logging

## License

MIT (see `LICENSE`). The color conversion (`src/protocol/color.ts`) and scene
table (`src/protocol/scenes.ts`) are adapted from homebridge-wiz-lan and remain
under the Apache License 2.0; see `THIRD_PARTY_NOTICES.md`.
