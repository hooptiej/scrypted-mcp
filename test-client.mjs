import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-client", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"));
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name));

const result = await client.callTool({ name: "list_devices", arguments: {} });
console.log("LIST_DEVICES RESULT:");
console.log(result.content[0].text);

await client.close();
