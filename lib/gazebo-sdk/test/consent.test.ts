import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Gazebo } from "../src/index";
import { completeConnection, validateConnectionState, createConnectionTokenProvider,
  disconnectStoredConnection, type StoredConnection } from "../src/consent";

afterEach(() => mock.restoreAll());
test("callback state and denial are checked before any code exchange", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call"); });
  const input = { clientId: "fixture-client", redirectUri: "https://app.example/callback",
    codeVerifier: "v".repeat(43), expectedState: "s".repeat(43), code: "fixture-code" };
  await assert.rejects(completeConnection("https://gazebo.example", { ...input, state: "wrong" }),
    error => (error as any).code === "reconnect_required");
  await assert.rejects(completeConnection("https://gazebo.example", { ...input, state: input.expectedState, error: "access_denied" }),
    error => (error as any).code === "cancelled");
  assert.equal(calls, 0);
  assert.equal(validateConnectionState("", ""), false);
});
test("runtime SDK timeout includes an unresolved token provider", async () => {
  const client = new Gazebo({ endpoint: "https://gazebo.example", timeoutMs: 20,
    auth: { type: "consent", tokenProvider: () => new Promise<string>(() => {}) } });
  await assert.rejects(client.connection.get(), error => (error as any).code === "timeout");
});
test("failed remote disconnect blocks local use and preserves an explicit retry", async () => {
  let saved: StoredConnection | null = {
    tokens: { access_token: "gzc_" + "t".repeat(43), refresh_token: "gzr_" + "r".repeat(43),
      token_type: "Bearer", expires_in: 3600, scope: "gazebo.credentials.read",
      agent_id: "fixture-agent", connection_id: "fixture-connection", subject: "fixture-subject",
      connection_expires_at: null, refresh_expires_at: new Date(Date.now() + 86400_000).toISOString() },
    accessExpiresAt: Date.now() + 3600_000,
  };
  const store = { async withLock<T>(operation: () => Promise<T>) { return operation(); },
    async get() { return saved; }, async set(value: StoredConnection) { saved = value; }, async clear() { saved = null; } };
  mock.method(globalThis, "fetch", async () => { throw new Error("fixture unavailable"); });
  await assert.rejects(disconnectStoredConnection({ endpoint: "https://gazebo.example", clientId: "fixture", store }));
  assert.equal(saved?.pendingDisconnect, true);
  const provider = createConnectionTokenProvider({ endpoint: "https://gazebo.example", clientId: "fixture", privateKeyJwk: {}, store });
  await assert.rejects(provider(), error => (error as any).code === "reconnect_required");
  assert.ok(saved, "Retain encrypted revocation payload until remote retry succeeds");
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await disconnectStoredConnection({ endpoint: "https://gazebo.example", clientId: "fixture", store });
  assert.equal(saved, null);
});
