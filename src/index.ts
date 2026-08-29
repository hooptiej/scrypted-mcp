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
