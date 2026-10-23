import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { before, beforeEach, after, test } from "node:test";
import { fileURLToPath } from "node:url";

const date = "2026-01-01T00:00:00.000Z";
const accountToken = "synthetic-account-secret";
const agentToken = "synthetic-agent-secret";
const providerKey = "synthetic-provider-key";
let base;
let requests = [];
let status = 200;
let denial;
const server = createServer((req, res) => {
  requests.push({ path: req.url, authorization: req.headers.authorization });
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  const path = new URL(req.url, base).pathname;
  const responses = {
    "/api/v1/me": { id: "fixture-account", email: "private@example.invalid", createdAt: date, hasApiToken: true, agentsEnabled: true, agentsEnabledDefault: true },
    "/api/v1/services": [{ service: "stripe", keyType: "api_key", connectedAt: date }],
    "/api/v1/agents": [],
    "/api/v1/audit-events": { events: [], nextCursor: null, hasMore: false },
    "/api/agents/me/credentials/stripe": { service: "stripe", credentials: { api_key: providerKey } },
  };
  res.end(JSON.stringify(denial ?? responses[path] ?? {}));
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { requests = []; status = 200; denial = undefined; });
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function run(relativePath, args = [], env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(relativePath, import.meta.url)), ...args], {
    // Intentionally exclude inherited tokens and real deployment configuration.
    env: { PATH: process.env.PATH, GAZEBO_ENDPOINT: base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [exit] = await once(child, "close");
  return { exit, stdout, stderr };
}

test("runnable account quickstart uses the compiled SDK and read-only endpoints", async () => {
  const result = await run("../examples/account.mjs", [], { GAZEBO_ACCOUNT_TOKEN: accountToken });
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    accountId: "fixture-account", connectedServices: ["stripe"], activeAgentCount: 0, auditEventCount: 0, auditHasMore: false,
  });
  assert.equal(result.stderr, "");
  assert.deepEqual(requests.map(req => req.path), ["/api/v1/me", "/api/v1/services", "/api/v1/agents", "/api/v1/audit-events?limit=5"]);
  assert.ok(requests.every(req => req.authorization === `Bearer ${accountToken}`));
  assert.equal(result.stdout.includes(accountToken), false);
  assert.equal(result.stdout.includes("private@example.invalid"), false);
});

test("runnable agent quickstart retrieves one credential without printing its value", async () => {
  const result = await run("../examples/agent.mjs", ["--retrieve"], { GAZEBO_AGENT_TOKEN: agentToken, GAZEBO_SERVICE: "stripe" });
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.stdout), { service: "stripe", keyNames: ["api_key"], credentialRetrieved: true });
  assert.equal(requests[0].authorization, `Bearer ${agentToken}`);
  assert.equal(requests[0].path, "/api/agents/me/credentials/stripe?method=GET");
  assert.equal(result.stdout.includes(providerKey), false);
  assert.equal(result.stdout.includes(agentToken), false);
});

test("agent example requires explicit retrieval consent before HTTP", async () => {
  const result = await run("../examples/agent.mjs", [], { GAZEBO_AGENT_TOKEN: agentToken, GAZEBO_SERVICE: "stripe" });
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /--retrieve/);
  assert.equal(requests.length, 0);
});

test("examples fail explicitly on missing token and do not fall back between modes", async () => {
  const result = await run("../examples/account.mjs");
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /GAZEBO_ACCOUNT_TOKEN/);
  const agent = await run("../examples/agent.mjs", ["--retrieve"], { GAZEBO_ACCOUNT_TOKEN: accountToken, GAZEBO_SERVICE: "stripe" });
  assert.equal(agent.exit, 1);
  assert.match(agent.stderr, /GAZEBO_AGENT_TOKEN/);
  assert.equal(requests.length, 0);
});

test("denial diagnostics omit raw server data and sensitive fields", async () => {
  status = 403;
  denial = { error: providerKey, token: accountToken, credentials: { api_key: providerKey } };
  const result = await run("../examples/agent.mjs", ["--retrieve"], { GAZEBO_AGENT_TOKEN: agentToken, GAZEBO_SERVICE: "stripe" });
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.status, 403);
  for (const secret of [accountToken, agentToken, providerKey]) assert.equal(result.stderr.includes(secret), false);
});

test("documented compiled CLI read commands work against the same fixture", async () => {
  for (const args of [["account", "get", "--json"], ["services", "list", "--json"], ["agents", "list", "--json"], ["audit", "list", "--limit", "5", "--json"]]) {
    const result = await run("../../gazebo-cli/dist/bin.js", args, { GAZEBO_ACCOUNT_TOKEN: accountToken });
    assert.equal(result.exit, 0);
    assert.equal(result.stderr, "");
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
  assert.equal(requests.length, 4);
});

test("documented CLI credential command prints a secret only with explicit reveal", async () => {
  const env = { GAZEBO_AGENT_TOKEN: agentToken };
  const denied = await run("../../gazebo-cli/dist/bin.js", ["credentials", "get", "stripe", "--json"], env);
  assert.equal(denied.exit, 2);
  assert.equal(requests.length, 0);
  const result = await run("../../gazebo-cli/dist/bin.js", ["credentials", "get", "stripe", "--reveal", "--method", "GET", "--key-name", "api_key", "--json"], env);
  assert.equal(result.exit, 0);
  assert.equal(JSON.parse(result.stdout).credentials.api_key, providerKey);
});
