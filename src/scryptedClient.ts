import { connectScryptedClient, type ScryptedClientStatic } from "@scrypted/client";

// Self-hosted homelab instance with a self-signed cert — trust it explicitly
// rather than disabling TLS verification globally for the whole process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.SCRYPTED_INSECURE === "1" ? "0" : process.env.NODE_TLS_REJECT_UNAUTHORIZED;

let clientPromise: Promise<ScryptedClientStatic> | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function getScryptedClient(): Promise<ScryptedClientStatic> {
  if (!clientPromise) {
    const baseUrl = requireEnv("SCRYPTED_BASE_URL");
    const username = requireEnv("SCRYPTED_USERNAME");
    const password = requireEnv("SCRYPTED_PASSWORD");

    clientPromise = connectScryptedClient({
      baseUrl,
      username,
      password,
      // Must be an actual plugin id present on the server — the RPC endpoint
      // is scoped per-plugin (/endpoint/<pluginId>/engine.io/api). @scrypted/core
      // is a built-in plugin that's always installed, so it's a safe default.
      pluginId: "@scrypted/core",
      local: true,
    }).catch((err) => {
      // Reset so the next call retries the connection instead of caching a rejected promise.
      clientPromise = undefined;
      if (err instanceof AggregateError) {
        console.error("connectScryptedClient AggregateError, sub-errors:");
        for (const sub of err.errors) console.error(sub);
      } else {
        console.error("connectScryptedClient error:", err);
      }
      throw err;
    });
  }
  return clientPromise;
}
