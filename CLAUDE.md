# scrypted-mcp

## What this is

An MCP server exposing a [Scrypted](https://www.scrypted.app/) home-automation/NVR server's
devices, cameras, and controls as tools an LLM can call. Personal single-user tool, LAN-only, no
auth on the MCP endpoint itself — same security posture as quest-log (network perimeter is the
boundary, not a login gate).

No CLAUDE.md existed until 2026-09-13 (built before the owner knew the convention existed) —
this is the first pass, written from the source rather than carried over from anywhere.

## Architecture at a glance

Two source files, both under `src/`:

- **`src/index.ts`** (~450 lines) — the whole server. An Express app exposes
  `POST/GET/DELETE /mcp` (streamable-HTTP MCP transport) and `GET /health`. Session handling: one
  `StreamableHTTPServerTransport` *and one dedicated `McpServer` instance* per MCP session, keyed
  by the session id the SDK assigns on `initialize` — the SDK only allows a single active
  transport per server, so sessions can't share a server instance the way quest-log's MCP does.
  Sessions are in-memory only (a `transports` map) — a restart drops every connected client the
  same way quest-log's does.
- **`src/scryptedClient.ts`** — a lazy, module-level singleton (`clientPromise`) wrapping
  `@scrypted/client`'s `connectScryptedClient()`. Every tool call does `await
  getScryptedClient()`, so **all MCP sessions share one underlying RPC connection to Scrypted**,
  not one per session. `client.onClose` resets the singleton to `undefined` so the *next* call
  reconnects instead of reusing (or getting stuck retrying) a dead RPC peer — this matters because
  the Scrypted server itself can restart out from under this process (e.g. its own container
  restarting).
  - `pluginId: "@scrypted/core"` is required by the client (the RPC endpoint is scoped
    per-plugin) — `@scrypted/core` is just a safe always-installed default, not meaningfully tied
    to what this server does.
  - TLS: `NODE_TLS_REJECT_UNAUTHORIZED` is set process-wide from `SCRYPTED_INSECURE=1` — a
    deliberate choice (see the file's own comment) for a self-hosted instance with a self-signed
    cert, trusted explicitly rather than disabling verification globally by default.

Every device-targeting tool repeats the same lookup: `systemManager.getDeviceById(idOrName) ??
getDeviceByName(idOrName)` — id or **exact** name, no fuzzy matching. A typo'd or
partially-matching name just falls through to "No device found," not a nearest-match suggestion.

## MCP tool surface

See `README.md`'s table for the list and one-line descriptions — accurate as of 2026-09-13, but
trust `src/index.ts` over any doc if they drift (same discipline as the other repos' CLAUDE.md's).

Two real gotchas the README doesn't spell out:

- **`get_live_stream_url` doesn't ask Scrypted for the real stream path — it guesses.** It builds
  `rtsp://user:pass@<ip>:554/11` from the device's ONVIF `ip`/`username`/`password` settings, using
  a hardcoded port/path convention for "this camera family." The tool's own returned text already
  warns "if a camera doesn't respond on this URL, its real stream path may differ" — that's not
  boilerplate, it's a real limitation: a different camera model could silently get a URL that
  doesn't work, with no verification against the device's actual configured stream.
- **`record_clip` shells out to `ffmpeg` directly** (`node:child_process.execFile`), not through
  any Scrypted API — it converts the camera's video stream to an `x-scrypted/x-ffmpeg-input`
  descriptor, then runs `ffmpeg -i <url> -t <duration> -c copy` itself against a temp file. Needs
  a real `ffmpeg` binary on PATH (present in the Docker image via `apt-get install ffmpeg`; install
  it separately for local `npm run dev`).
- **`get_recording_active`/`set_recording_active`** only cover the on/off `VideoRecorderManagement`
  interface plus the NVR's `recording:privacyMode` setting — per the README, the richer
  Always/Motion-Triggered/Off mode and schedule grid in the NVR console isn't backed by any
  device-level RPC method or Settings key (confirmed by grepping the NVR plugin's compiled
  backend), so it's not wrapped here. `invoke_device_method` is the escape hatch if that ever gets
  reverse-engineered.

## Build / run / test

No test suite (no `tests/`, no CI config) — same as Constructicon and quest-log, verification is
manual.

```bash
npm install
npm run dev     # tsx src/index.ts, no build step
npm run build   # tsc -> dist/
npm start        # node dist/index.js (needs npm run build first)
```

Needs `.env` (copy `.env.example`): `SCRYPTED_BASE_URL`, `SCRYPTED_USERNAME`,
`SCRYPTED_PASSWORD`, optional `SCRYPTED_INSECURE=1` for a self-signed cert, `PORT` (default 3000).

## Deployment

Runs on the shared TrueNAS box (`10.0.1.78`) as a **plain `docker compose` checkout** (container
`scrypted-mcp`) — not TrueNAS's "Apps"/catalog system — same pattern as Constructicon/quest-log.
Reachable at `http://10.0.1.78:3300/mcp` (the box's actual `PORT` value; not the image's `3000`
default).

**`network_mode: host` is required**, not incidental — `record_clip`'s ffmpeg process needs to
reach Scrypted's internal loopback stream proxy (`127.0.0.1:<random port>`), which only exists
inside the host's own network namespace and isn't reachable from a bridged container network. Host
mode means no port remapping, so `PORT` in `.env` must already be the port you want exposed.

Talks to the actual Scrypted instance also running on that box as a TrueNAS-catalog "App"
(`ix-scrypted-scrypted-1`, `ghcr.io/koush/scrypted`) at `https://10.0.1.78:30131` — a different
container/access path than the hand-run docker-compose apps, since it came from TrueNAS's Apps
catalog rather than a checkout.

## Gotchas worth knowing up front

- **All MCP sessions share one Scrypted RPC connection** (`scryptedClient.ts`'s module-level
  singleton) — this is not per-session state. A Scrypted-side restart invalidates it for every
  connected client at once; the *next* tool call anywhere reconnects and fixes it for everyone,
  there's nothing to restart on this server's side.
- **Device lookup is id-or-exact-name only.** No fuzzy matching anywhere — `list_devices` first if
  a name-based call unexpectedly says "not found."
- **`get_live_stream_url`'s RTSP URL is a guessed convention, not a verified value** — see above.
  Don't treat its output as authoritative for a camera family that hasn't been confirmed to work.
- **This server predates its own CLAUDE.md** — written 2026-09-13 straight from `src/`, not
  carried over from an older doc. If something here drifts from the code, the code wins (same rule
  as every other repo's CLAUDE.md in this set).
