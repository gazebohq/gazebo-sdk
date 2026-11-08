/**
 * Server-only integration pattern, not a hosted proxy or authentication system.
 * clientForSession must authenticate the application session, authorize balance
 * access and select that user's scoped Gazebo connection entirely server-side.
 * Never expose this callback or credential retrieval as a model-callable tool.
 */
import { Gazebo } from "@gazebohq/sdk";
import { pathToFileURL } from "node:url";

export function createBalanceTool({ clientForSession, providerFetch = globalThis.fetch }) {
  return async function readBalance(authenticatedSession) {
    try {
      const client = await clientForSession(authenticatedSession);
      if (!client) throw new Error("No authorized connection");
      const result = await client.credentials.get("stripe", { keyName: "api_key", method: "GET" });
      const key = result.credentials.api_key;
      if (typeof key !== "string" || !key.trim()) throw new Error("Missing credential");
      // Fixed, read-only action. The agent cannot supply URLs, headers or keys.
      const response = await providerFetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Provider request failed");
      const body = await response.json();
      function balances(entries) {
        if (!Array.isArray(entries)) throw new Error("Invalid provider response");
        return entries.map(entry => {
          if (!entry || !Number.isSafeInteger(entry.amount) ||
              typeof entry.currency !== "string" || !/^[a-z]{3}$/.test(entry.currency)) {
            throw new Error("Invalid balance");
          }
          return { amount: entry.amount, currency: entry.currency };
        });
      }
      // Allowlist result fields; do not forward raw objects, errors or headers.
      return { available: balances(body.available), pending: balances(body.pending) };
    } catch {
      // Don't forward SDK error.details, raw provider errors or token material.
      // In production, record only safe diagnostic metadata in protected logs.
      throw new Error("Balance action unavailable");
    }
  };
}

// Safe, runnable demonstration: injected transports; no network or environment
// credentials. Real deployments import createBalanceTool and provide real auth.
async function demo() {
  const session = Object.freeze({ fixture: "signed-in-user-a" });
  const fictionalKey = "fictional-provider-key-not-valid-anywhere";
  const client = new Gazebo({
    endpoint: "https://gazebo.example.invalid",
    auth: { type: "agent", token: "fictional-agent-token" },
    fetch: async () => new Response(JSON.stringify({
      service: "stripe", credentials: { api_key: fictionalKey },
    })),
  });
  const readBalance = createBalanceTool({
    clientForSession: async current => current === session ? client : null,
    providerFetch: async (_url, options) => {
      if (options.headers.Authorization !== `Bearer ${fictionalKey}`) throw new Error("Unexpected auth");
      return new Response(JSON.stringify({
        available: [{ amount: 12500, currency: "usd", ignored: "not returned" }],
        pending: [{ amount: 3000, currency: "usd" }],
      }));
    },
  });
  process.stdout.write(`${JSON.stringify(await readBalance(session))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(" ") !== "--demo") {
    process.stderr.write("Pass --demo for the offline fictional-data demonstration.\n");
    process.exitCode = 1;
  } else {
    demo().catch(() => {
      process.stderr.write("Backend demonstration failed.\n");
      process.exitCode = 1;
    });
  }
}
