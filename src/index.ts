import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getScryptedClient } from "./scryptedClient.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "scrypted-mcp",
    version: "0.1.0",
  });

  server.tool(
    "list_devices",
    "List all devices known to the Scrypted server, with their id, name, type, and supported interfaces (e.g. Camera, OnOff, Lock).",
    {},
    async () => {
      const client = await getScryptedClient();
      const state = client.systemManager.getSystemState();
      const devices = Object.entries(state).map(([id, deviceState]) => ({
        id,
        name: deviceState.name?.value,
        type: deviceState.type?.value,
        interfaces: deviceState.interfaces?.value ?? [],
        room: deviceState.room?.value,
      }));
      return { content: [{ type: "text", text: JSON.stringify(devices, null, 2) }] };
    },
  );

  server.tool(
    "get_device_state",
    "Get the full current state (all properties) of a single device by its id or exact name.",
    { idOrName: z.string().describe("Device id or exact device name") },
    async ({ idOrName }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(device, null, 2) }] };
    },
  );

  server.tool(
    "camera_snapshot",
    "Take a still snapshot from a camera device and return it as an image.",
    { idOrName: z.string().describe("Camera device id or exact device name") },
    async ({ idOrName }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      if (typeof (device as any).takePicture !== "function") {
        return {
          content: [{ type: "text", text: `Device "${idOrName}" does not support Camera.takePicture()` }],
          isError: true,
        };
      }
      const mediaObject = await (device as any).takePicture();
      const buffer: Buffer = await client.mediaManager.convertMediaObjectToBuffer(mediaObject, "image/jpeg");
      return {
        content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" }],
      };
    },
  );

  server.tool(
    "record_clip",
    "Capture a short live video clip from a camera right now and return it as video/mp4. This pulls " +
      "directly from the camera's live stream, not from NVR-stored recordings, so it works even when " +
      "NVR recording is disabled/unlicensed.",
    {
      idOrName: z.string().describe("Camera device id or exact device name"),
      timeoutSeconds: z.number().optional().describe("How long to wait for the clip before giving up (default 20)"),
    },
    async ({ idOrName, timeoutSeconds }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      if (typeof (device as any).getVideoStream !== "function") {
        return {
          content: [{ type: "text", text: `Device "${idOrName}" does not support VideoCamera.getVideoStream()` }],
          isError: true,
        };
      }
      const timeoutMs = (timeoutSeconds ?? 20) * 1000;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for clip`)), timeoutMs),
      );
      try {
        const buffer = await Promise.race([
          (async () => {
            const mediaObject = await (device as any).getVideoStream();
            return client.mediaManager.convertMediaObjectToBuffer(mediaObject, "video/mp4");
          })(),
          timeout,
        ]);
        return {
          content: [
            {
              type: "resource",
              resource: { uri: `clip:${idOrName}:${Date.now()}`, mimeType: "video/mp4", blob: (buffer as Buffer).toString("base64") },
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to capture clip: ${err?.message ?? err}` }], isError: true };
      }
    },
  );

  server.tool(
    "set_onoff",
    "Turn an OnOff-capable device (switch, plug, light) on or off.",
    {
      idOrName: z.string().describe("Device id or exact device name"),
      on: z.boolean().describe("true to turn on, false to turn off"),
    },
    async ({ idOrName, on }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      const method = on ? "turnOn" : "turnOff";
      if (typeof (device as any)[method] !== "function") {
        return { content: [{ type: "text", text: `Device "${idOrName}" does not support OnOff` }], isError: true };
      }
      await (device as any)[method]();
      return { content: [{ type: "text", text: `${idOrName} turned ${on ? "on" : "off"}` }] };
    },
  );

  server.tool(
    "set_lock",
    "Lock or unlock a Lock-capable device.",
    {
      idOrName: z.string().describe("Device id or exact device name"),
      locked: z.boolean().describe("true to lock, false to unlock"),
    },
    async ({ idOrName, locked }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      const method = locked ? "lock" : "unlock";
      if (typeof (device as any)[method] !== "function") {
        return { content: [{ type: "text", text: `Device "${idOrName}" does not support Lock` }], isError: true };
      }
      await (device as any)[method]();
      return { content: [{ type: "text", text: `${idOrName} ${locked ? "locked" : "unlocked"}` }] };
    },
  );

  server.tool(
    "get_recording_active",
    "Check whether a camera is actively recording to the NVR. Reflects the VideoRecorder.recordingActive " +
      "state and the NVR's per-camera \"Disable Scrypted NVR\" privacy-mode setting.",
    { idOrName: z.string().describe("Camera device id or exact device name") },
    async ({ idOrName }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      const recordingActive = await (device as any).recordingActive;
      let privacyModeDisabled: boolean | undefined;
      if (typeof (device as any).getSettings === "function") {
        const settings = await (device as any).getSettings();
        privacyModeDisabled = settings.find((s: any) => s.key === "recording:privacyMode")?.value;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ idOrName, recordingActive, privacyModeDisabled }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "set_recording_active",
    "Turn NVR recording on or off for a camera. Calls VideoRecorderManagement.setRecordingActive() and " +
      "flips the NVR's per-camera \"Disable Scrypted NVR\" privacy-mode setting to match, since both must " +
      "agree for recording to actually start or stop.",
    {
      idOrName: z.string().describe("Camera device id or exact device name"),
      active: z.boolean().describe("true to enable recording, false to disable it"),
    },
    async ({ idOrName, active }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      if (typeof (device as any).setRecordingActive !== "function") {
        return {
          content: [{ type: "text", text: `Device "${idOrName}" does not support VideoRecorderManagement` }],
          isError: true,
        };
      }
      await (device as any).setRecordingActive(active);
      if (typeof (device as any).putSetting === "function") {
        await (device as any).putSetting("recording:privacyMode", !active);
      }
      const recordingActive = await (device as any).recordingActive;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ idOrName, requestedActive: active, recordingActive }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "get_device_mixins",
    "List the mixin provider ids currently applied to a device (e.g. HomeKit, Rebroadcast/prebuffer, motion detection).",
    { idOrName: z.string().describe("Device id or exact device name") },
    async ({ idOrName }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      const mixins = await (device as any).mixins;
      return { content: [{ type: "text", text: JSON.stringify(mixins ?? [], null, 2) }] };
    },
  );

  server.tool(
    "add_device_mixin",
    "Apply a mixin provider to a device without disturbing its other existing mixins. Reads the " +
      "device's current mixin list, appends the given mixin id if not already present, and calls " +
      "setMixins() with the combined list.",
    {
      idOrName: z.string().describe("Device id or exact device name"),
      mixinId: z.string().describe("Device id of the mixin provider to add (e.g. the id of a MixinProvider device from list_devices)"),
    },
    async ({ idOrName, mixinId }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      const current: string[] = (await (device as any).mixins) ?? [];
      if (current.includes(mixinId)) {
        return { content: [{ type: "text", text: JSON.stringify({ idOrName, mixinId, alreadyApplied: true, mixins: current }, null, 2) }] };
      }
      const updated = [...current, mixinId];
      await (device as any).setMixins(updated);
      const confirmed = await (device as any).mixins;
      return { content: [{ type: "text", text: JSON.stringify({ idOrName, mixinId, mixins: confirmed }, null, 2) }] };
    },
  );

  server.tool(
    "invoke_device_method",
    "Escape hatch: call an arbitrary method on a device by name, with JSON-encoded arguments. " +
      "Use this for plugin-specific capabilities not covered by a dedicated tool (e.g. NVR recording " +
      "mode/schedule settings, which vary by plugin and aren't part of the core SDK interfaces).",
    {
      idOrName: z.string().describe("Device id or exact device name"),
      method: z.string().describe("Method name to invoke on the device"),
      argsJson: z.string().optional().describe("JSON array of arguments, e.g. \"[true, 42]\". Omit for no-arg calls."),
    },
    async ({ idOrName, method, argsJson }) => {
      const client = await getScryptedClient();
      const device =
        client.systemManager.getDeviceById(idOrName) ??
        client.systemManager.getDeviceByName(idOrName);
      if (!device) {
        return { content: [{ type: "text", text: `No device found for "${idOrName}"` }], isError: true };
      }
      if (typeof (device as any)[method] !== "function") {
        return { content: [{ type: "text", text: `Device "${idOrName}" has no method "${method}"` }], isError: true };
      }
      const args = argsJson ? JSON.parse(argsJson) : [];
      const result = await (device as any)[method](...args);
      return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
    },
  );

  return server;
}

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());

// One transport per MCP session, keyed by the session id the transport itself
// assigns on initialize. Each session also gets its own McpServer instance,
// since the SDK only allows a single active transport per server.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await createServer().connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session and not an initialize request" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Unknown or missing session");
    return;
  }
  await transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.get("/health", (_req, res) => res.type("text/plain").send("ok"));

app.listen(PORT, () => {
  console.log(`scrypted-mcp listening on :${PORT} (POST/GET/DELETE /mcp, GET /health)`);
});
