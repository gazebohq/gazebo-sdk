import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Gazebo, GazeboError } from "../src/index.js";
import type { AccountOperations, AgentOperations, HttpMethod } from "../src/index.js";

const date = "2026-01-01T00:00:00.000Z";
const account = { id: "user", email: "fixture@example.invalid", createdAt: date, hasApiToken: true, agentsEnabled: true, agentsEnabledDefault: true };
const agent = { id: "agent", name: "Builder", createdAt: date, lastActiveAt: null, revokedAt: null, expiresAt: null, services: ["stripe"] };
const created = { id: "agent", name: "Builder", createdAt: date, expiresAt: null, token: "one-time-secret" };
const services = [{ service: "stripe", connectedAt: date, keyType: "api_key" }];
const policies = [{ service: "stripe", enabled: true, methods: ["GET"] }];
const event = { id: "event", agentId: "agent", agentName: null, service: "stripe", keyName: "api_key", action: "read", outcome: "success", method: "GET", createdAt: date };
const page = { events: [event], nextCursor: "opaque+/=", hasMore: true };
const credential = { service: "stripe", credentials: { api_key: "sensitive-value" } };
type Recorded = { method?: string; url?: string; authorization?: string; body?: unknown };
let requests: Recorded[] = [];
let responseBody: unknown = account;
let status = 200;
let raw: string | undefined;
let delay = 0;
let retryAfter: string | undefined;
let base: string;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (retryAfter) res.setHeader("Retry-After", retryAfter);
  if (status === 302) res.setHeader("Location", "/redirect-target");
  res.end(raw ?? JSON.stringify(responseBody));
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  requests = []; responseBody = account; status = 200; raw = undefined; delay = 0; retryAfter = undefined;
});
function accountClient(endpoint = base) {
  return new Gazebo({ endpoint, auth: { type: "account", token: "account-secret" } });
}
function agentClient() {
  return new Gazebo({ endpoint: base, auth: { type: "agent", token: "agent-secret" } });
}
function checkError(code: string, httpStatus?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof GazeboError);
    assert.equal(error.code, code);
    assert.equal(error.status, httpStatus);
    return true;
  };
}

test("account identity preserves string timestamps and forwards compatible fields", async () => {
  responseBody = { ...account, future: true };
  const result = await accountClient().account.get();
  assert.equal(result.createdAt, date);
  assert.equal((result as typeof account & { future: boolean }).future, true);
  assert.equal(requests[0].url, "/api/v1/me");
  assert.equal(requests[0].authorization, "Bearer account-secret");
});

test("all account operations use the documented routes and verbs", async () => {
  const client = accountClient();
  responseBody = [agent]; assert.deepEqual(await client.agents.list(), [agent]);
  responseBody = created; assert.deepEqual(await client.agents.create({ name: "Builder", expiresAt: null }), created);
  assert.deepEqual(requests[1].body, { name: "Builder", expiresAt: null });
  responseBody = { ok: true }; await client.agents.delete("agent");
  responseBody = services; assert.deepEqual(await client.services.list(), services);
  responseBody = policies; assert.deepEqual(await client.access.get("agent"), policies);
  responseBody = { ok: true }; await client.access.set("agent", "stripe", { enabled: true, methods: ["GET", "GET"] });
  assert.deepEqual(requests[5].body, { enabled: true, methods: ["GET"] });
  assert.deepEqual(requests.map(req => [req.method, req.url]), [
    ["GET", "/api/v1/agents"], ["POST", "/api/v1/agents"], ["DELETE", "/api/v1/agents/agent"],
    ["GET", "/api/v1/services"], ["GET", "/api/v1/agents/agent/access"], ["PUT", "/api/v1/agents/agent/access/stripe"],
  ]);
});

test("agent credentials map keyName/method and encode service as one segment", async () => {
  responseBody = credential;
  assert.deepEqual(await agentClient().credentials.get("provider/key ?#", { method: "POST", keyName: "api key&x" }), credential);
  assert.equal(requests[0].url, "/api/agents/me/credentials/provider%2Fkey%20%3F%23?method=POST&key_name=api+key%26x");
  assert.equal(requests[0].authorization, "Bearer agent-secret");
});

test("default credential lookup omits query options and returns exactly one key", async () => {
  responseBody = credential;
  assert.deepEqual(await agentClient().credentials.get("stripe"), credential);
  assert.equal(requests[0].url, "/api/agents/me/credentials/stripe");
});

test("audit pagination preserves opaque cursor and filters without automatic requests", async () => {
  responseBody = page;
  const client = accountClient();
  const filters = { limit: 1, agentId: "agent", service: "stripe", outcome: "success" as const, from: date, to: date };
  const first = await client.auditEvents.list(filters);
  responseBody = { events: [], nextCursor: null, hasMore: false };
  const second = await client.auditEvents.list({ ...filters, cursor: first.nextCursor! });
  assert.equal(second.nextCursor, null);
  const query = new URL(requests[1].url!, base).searchParams;
  assert.equal(query.get("cursor"), page.nextCursor);
  assert.equal(query.get("agent_id"), "agent");
  assert.equal(query.get("limit"), "1");
  assert.equal(query.get("from"), date);
  assert.equal(query.get("service"), "stripe");
  assert.equal(query.get("outcome"), "success");
  assert.equal(requests.length, 2);
});

test("endpoint prefix and trailing slash are preserved for local deployments", async () => {
  await accountClient(`${base}/broker///`).account.get();
  assert.equal(requests[0].url, "/broker/api/v1/me");
});

test("cloud origin uses identical paths and secure transport flags", async () => {
  let called = false;
  const client = new Gazebo({
    endpoint: "https://app.gazebohq.com", auth: { type: "agent", token: "agent-secret" },
    fetch: async (input, init) => {
      called = true;
      assert.equal(String(input), "https://app.gazebohq.com/api/agents/me/credentials/stripe");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.cache, "no-store");
      return new Response(JSON.stringify(credential));
    },
  });
  await client.credentials.get("stripe");
  assert.equal(called, true);
});

test("different auth modes expose disjoint operations at runtime", () => {
  assert.equal("credentials" in accountClient(), false);
  assert.equal("agents" in agentClient(), false);
  assert.equal("account" in agentClient(), false);
});

test("types prevent mixed-mode calls and incomplete policy updates", () => {
  const trusted: AccountOperations = accountClient();
  const runtime: AgentOperations = agentClient();
  // These checks are compiled by typecheck but never executed.
  if (false) {
    // @ts-expect-error account clients do not release credentials
    trusted.credentials.get("stripe");
    // @ts-expect-error agent clients cannot administer agents
    runtime.agents.list();
    // @ts-expect-error explicit methods are required
    trusted.access.set("agent", "stripe", { enabled: true });
  }
});

test("policy update fails locally if methods are omitted, empty, or invalid", async () => {
  for (const input of [{ enabled: true }, { enabled: true, methods: [] }, { enabled: true, methods: ["OPTIONS"] }]) {
    await assert.rejects(accountClient().access.set("agent", "stripe", input as never), TypeError);
  }
  assert.equal(requests.length, 0);
});

test("invalid audit pagination and dates fail before sending requests", async () => {
  for (const filters of [
    { limit: 1.5 }, { limit: 0 }, { limit: 201 }, { cursor: "" }, { from: "invalid" },
    { from: "2026-02-01T00:00:00Z", to: date },
  ]) {
    await assert.rejects(async () => accountClient().auditEvents.list(filters), TypeError);
  }
  assert.equal(requests.length, 0);
});

test("invalid agent inputs and runtime selectors fail locally", async () => {
  await assert.rejects(accountClient().agents.create({ name: "" }), TypeError);
  await assert.rejects(accountClient().agents.create({ name: "x".repeat(101) }), TypeError);
  await assert.rejects(accountClient().agents.create({ name: "x", expiresAt: "yesterday" }), TypeError);
  await assert.rejects(agentClient().credentials.get("stripe", { keyName: " " }), TypeError);
  await assert.rejects(agentClient().credentials.get("stripe", { method: "OPTIONS" as HttpMethod }), TypeError);
  await assert.rejects(agentClient().credentials.get(".."), TypeError);
  assert.equal(requests.length, 0);
});

test("constructor rejects invalid targets and configuration without leaking token", () => {
  for (const endpoint of ["ftp://example.com", "https://user:password@example.com", `${base}?q=1`, `${base}#fragment`]) {
    assert.throws(() => accountClient(endpoint), TypeError);
  }
  assert.throws(() => new Gazebo({ endpoint: base, auth: { type: "agent", token: "bad token" } }), TypeError);
  assert.throws(() => new Gazebo({ endpoint: base, auth: { type: "agent", token: "valid" }, timeoutMs: 0 }), TypeError);
  assert.equal(JSON.stringify(accountClient()).includes("account-secret"), false);
});

test("denied and not-found error shapes are retained explicitly", async () => {
  for (const [code, body] of [
    [403, { status: "denied", service: "stripe", reason: "method_not_allowed", allowed_methods: ["GET"], next_action: "contact_owner" }],
    [404, { status: "not_found", service: "stripe" }],
    [401, { error: "Invalid token" }],
  ] as const) {
    status = code; responseBody = body;
    await assert.rejects(agentClient().credentials.get("stripe"), error => {
      assert.ok(error instanceof GazeboError);
      assert.equal(error.code, "http");
      assert.equal(error.status, code);
      assert.deepEqual(error.details, body);
      return true;
    });
  }
});

test("429 exposes retry-after without retrying", async () => {
  status = 429; responseBody = { error: "Rate limited" }; retryAfter = "60";
  await assert.rejects(accountClient().account.get(), error => {
    assert.ok(error instanceof GazeboError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, "60");
    return true;
  });
  assert.equal(requests.length, 1);
});

test("failed token creation is never retried", async () => {
  status = 500; responseBody = { error: "Unavailable" };
  await assert.rejects(accountClient().agents.create({ name: "Builder" }), checkError("http", 500));
  assert.equal(requests.length, 1);
});

test("server payloads are excluded from error message and JSON serialization", async () => {
  status = 403; responseBody = { error: "account-secret", credentials: credential.credentials };
  await assert.rejects(accountClient().account.get(), error => {
    assert.ok(error instanceof GazeboError);
    for (const value of ["account-secret", "sensitive-value"]) {
      assert.equal(error.message.includes(value), false);
      assert.equal(JSON.stringify(error).includes(value), false);
    }
    assert.deepEqual(error.details, responseBody);
    return true;
  });
});

test("non-JSON failures retain HTTP status; malformed success is invalid_response", async () => {
  status = 502; raw = "<html>gateway failure</html>";
  await assert.rejects(accountClient().account.get(), checkError("http", 502));
  status = 200;
  await assert.rejects(accountClient().account.get(), checkError("invalid_response"));
});

test("malformed success shapes fail without including sensitive response content", async () => {
  responseBody = { ...account, createdAt: "invalid" };
  await assert.rejects(accountClient().account.get(), checkError("invalid_response"));
  responseBody = { service: "stripe", credentials: { api_key: "secret", access_token: "other" } };
  await assert.rejects(agentClient().credentials.get("stripe"), checkError("invalid_response"));
});

test("redirect responses are not followed", async () => {
  status = 302;
  await assert.rejects(accountClient().account.get(), checkError("network"));
  assert.equal(requests.length, 1);
});

test("fetch failures are redacted", async () => {
  const client = new Gazebo({
    endpoint: base, auth: { type: "account", token: "account-secret" },
    fetch: async () => { throw new Error("network detail account-secret"); },
  });
  await assert.rejects(client.account.get(), error => {
    assert.ok(error instanceof GazeboError);
    assert.equal(error.code, "network");
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes("account-secret"), false);
    return true;
  });
});

test("pre-aborted caller signal prevents the request", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(accountClient().account.get({ signal: controller.signal }), checkError("cancelled"));
  assert.equal(requests.length, 0);
});

test("timeout aborts a real HTTP request", async () => {
  delay = 150;
  const client = new Gazebo({ endpoint: base, auth: { type: "account", token: "token" }, timeoutMs: 30 });
  await assert.rejects(client.account.get(), checkError("timeout"));
});

test("caller cancellation aborts a real HTTP request", async () => {
  delay = 150;
  const controller = new AbortController();
  const result = accountClient().account.get({ signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(result, checkError("cancelled"));
});

test("timeout includes response-body consumption", async () => {
  const client = new Gazebo({
    endpoint: base, auth: { type: "account", token: "token" }, timeoutMs: 30,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true });
        stream.enqueue(new TextEncoder().encode('{"id":'));
      },
    })),
  });
  await assert.rejects(client.account.get(), checkError("timeout"));
});
