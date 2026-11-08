import assert from "node:assert/strict";
import { test } from "node:test";
import { Gazebo } from "@gazebohq/sdk";
import { createBalanceTool } from "../examples/backend-action.mjs";

const key = "fictional-provider-key-not-valid-anywhere";
const session = Object.freeze({ fixture: "customer-a" });
function fixture({ denied = false, revoked = false, fails = false, malformed = false } = {}) {
  const calls = [];
  const client = new Gazebo({
    endpoint: "https://gazebo.example.invalid",
    auth: { type: "agent", token: "fictional-agent-token" },
    fetch: async (url, init) => {
      calls.push("retrieval");
      assert.equal(new URL(url).pathname, "/api/agents/me/credentials/stripe");
      assert.equal(new URL(url).searchParams.get("key_name"), "api_key");
      assert.equal(new URL(url).searchParams.get("method"), "GET");
      assert.equal(init.headers.Authorization ?? new Headers(init.headers).get("Authorization"), "Bearer fictional-agent-token");
      return revoked
        ? new Response(JSON.stringify({ error: "Revoked" }), { status: 401 })
        : new Response(JSON.stringify({ service: "stripe", credentials: { api_key: key } }));
    },
  });
  const action = createBalanceTool({
    clientForSession: async current => !denied && current === session ? client : null,
    providerFetch: async (url, init) => {
      calls.push("provider");
      assert.equal(url, "https://api.stripe.com/v1/balance");
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return fails
        ? new Response(JSON.stringify({ error: key }), { status: 500 })
        : new Response(JSON.stringify({
          available: [{ amount: malformed ? key : 12500, currency: "usd", secret: key }],
          pending: [], debugCredential: key,
        }));
    },
  });
  return { action, calls };
}

test("backend action retrieves with SDK and returns only selected balance fields", async () => {
  const { action, calls } = fixture();
  assert.deepEqual(await action(session), { available: [{ amount: 12500, currency: "usd" }], pending: [] });
  assert.deepEqual(calls, ["retrieval", "provider"]);
});
test("missing session, cross-customer session and denied action never retrieve", async () => {
  for (const current of [undefined, { fixture: "customer-b" }]) {
    const { action, calls } = fixture();
    await assert.rejects(action(current), { message: "Balance action unavailable" });
    assert.deepEqual(calls, []);
  }
  const { action, calls } = fixture({ denied: true });
  await assert.rejects(action(session), { message: "Balance action unavailable" });
  assert.deepEqual(calls, []);
});
test("revoked retrieval prevents a provider call", async () => {
  const { action, calls } = fixture({ revoked: true });
  await assert.rejects(action(session), { message: "Balance action unavailable" });
  assert.deepEqual(calls, ["retrieval"]);
});
test("provider errors and malformed values do not leak to the caller", async () => {
  for (const options of [{ fails: true }, { malformed: true }]) {
    const { action } = fixture(options);
    await assert.rejects(action(session), error => {
      assert.equal(error.message, "Balance action unavailable");
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes(key));
      return true;
    });
  }
});
