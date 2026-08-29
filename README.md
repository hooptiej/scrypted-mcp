# scrypted-mcp

An MCP server that exposes a [Scrypted](https://www.scrypted.app/) home-automation/NVR server's
devices, cameras, and controls as tools an LLM can call.

Talks to Scrypted over its RPC client (`@scrypted/client`), so it works against any Scrypted
server — cloud or self-hosted — not just a Docker deployment.

## Tools

| Tool | Description |
|---|---|
| `list_devices` | List all devices with id, name, type, and supported interfaces |
| `get_device_state` | Full current state of one device by id or name |
| `camera_snapshot` | Take a still snapshot from a camera |
| `set_onoff` | Turn a switch/plug/light on or off |
| `set_lock` | Lock or unlock a device |
| `invoke_device_method` | Escape hatch to call any method on any device (e.g. plugin-specific NVR recording mode/schedule settings not covered by a dedicated tool) |

## Configuration

Copy `.env.example` to `.env` and fill in:

- `SCRYPTED_BASE_URL` — your Scrypted server's URL
- `SCRYPTED_USERNAME` / `SCRYPTED_PASSWORD` — credentials for an account on that server
- `SCRYPTED_INSECURE=1` — only if your server uses a self-signed cert you trust
- `PORT` — HTTP port to listen on (default `3000`)

## Running locally

```bash
npm install
npm run dev
```

## Running with Docker

```bash
docker build -t scrypted-mcp .
docker run -p 3000:3000 --env-file .env scrypted-mcp
```

## Connecting a client

This server speaks MCP over streamable HTTP at `POST /mcp`. Point your MCP client at
`http://<host>:3000/mcp`. A `GET /health` endpoint is available for basic uptime checks.

## Security note

This server holds credentials for full control of your Scrypted devices (cameras, locks,
switches). Do not expose it directly to the internet — run it on a trusted local network,
behind a VPN, or in front of your own auth proxy.
