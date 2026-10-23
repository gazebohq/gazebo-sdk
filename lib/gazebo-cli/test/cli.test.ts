import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliContext } from "../src/cli.js";

const date = "2026-01-01T00:00:00.000Z";
const identity = { id: "user", email: "test@example.invalid", createdAt: date, hasApiToken: true, agentsEnabled: true, agentsEnabledDefault: true };
const created = { id: "agent", name: "Builder", createdAt: date, expiresAt: null, token: "new-agent-secret" };
const credentials = { service: "stripe", credentials: { api_key: "provider-secret" } };
const audit = { events: [], nextCursor: "opaque+/=", hasMore: true };
let base: string;
let status = 200;
let body: unknown = identity;
let delay = 0;
let raw: string | undefined;
let requests: { url?: string; method?: string; authorization?: string; body?: unknown }[] = [];
const server = createServer(async (req, res) => {
  let input = "";
  for await (const chunk of req) input += chunk;
  requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: input ? JSON.parse(input) : undefined });
  const responseStatus = status, responseBody = body, responseRaw = raw;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.statusCode = responseStatus;
  res.setHeader("Content-Type", "application/json");
  if (responseStatus === 429) res.setHeader("Retry-After", "60");
  res.end(responseRaw ?? JSON.stringify(responseBody));
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
beforeEach(() => { requests = []; status = 200; body = identity; delay = 0; raw = undefined; });

async function cli(args: string[], overrides: Partial<CliContext> = {}) {
  let out = "", err = "";
  const exit = await runCli(args, {
    env: { GAZEBO_ENDPOINT: base, GAZEBO_ACCOUNT_TOKEN: "account-secret", GAZEBO_AGENT_TOKEN: "agent-secret" },
    stdout: value => { out += value; }, stderr: value => { err += value; },
    ...overrides,
  });
  return { exit, out, err };
}

test("help needs no token and sends no request", async () => {
  const result = await cli(["--help"], { env: {} });
  assert.equal(result.exit, 0);
  assert.match(result.out, /access set/);
  assert.match(result.out, /GAZEBO_AGENT_TOKEN/);
  assert.equal(requests.length, 0);
  assert.equal((await cli([], { env: {} })).exit, 0);
});

test("account get returns machine JSON and uses account auth", async () => {
  const result = await cli(["account", "get", "--json"]);
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.out), identity);
  assert.equal(result.err, "");
  assert.equal(requests[0].authorization, "Bearer account-secret");
  assert.equal(requests[0].url, "/api/v1/me");
});

test("list and access-read commands use the SDK routes", async () => {
  body = [];
  for (const args of [["agents", "list"], ["services", "list"], ["access", "get", "agent"]]) {
    assert.equal((await cli(args)).exit, 0);
  }
  assert.deepEqual(requests.map(req => req.url), ["/api/v1/agents", "/api/v1/services", "/api/v1/agents/agent/access"]);
});

test("agent creation refuses before a request unless one-time token output is explicit", async () => {
  const result = await cli(["agents", "create", "--name", "Builder", "--json"]);
  assert.equal(result.exit, 2);
  assert.equal(result.out, "");
  assert.match(JSON.parse(result.err).error.message, /--reveal/);
  assert.equal(requests.length, 0);
});

test("agent creation prints the one-time token with --reveal", async () => {
  body = created;
  const result = await cli(["agents", "create", "--name", "Builder", "--reveal", "--expires-at", date, "--json"]);
  assert.equal(result.exit, 0);
  assert.equal(JSON.parse(result.out).token, "new-agent-secret");
  assert.deepEqual(requests[0].body, { name: "Builder", expiresAt: date });
  assert.equal(requests[0].method, "POST");
});

test("agent deletion requires --yes and executes once", async () => {
  assert.equal((await cli(["agents", "delete", "agent"])).exit, 2);
  assert.equal(requests.length, 0);
  body = { ok: true };
  assert.equal((await cli(["agents", "delete", "agent", "--yes"])).exit, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "DELETE");
});

test("access updates require explicit enabled and methods and normalize input", async () => {
  for (const args of [
    ["access", "set", "agent", "stripe", "--enabled", "true"],
    ["access", "set", "agent", "stripe", "--methods", "GET"],
    ["access", "set", "agent", "stripe", "--enabled", "true", "--methods", "GET,"],
  ]) assert.equal((await cli(args)).exit, 2);
  assert.equal(requests.length, 0);
  body = { ok: true };
  assert.equal((await cli(["access", "set", "agent", "stripe", "--enabled", "false", "--methods", "get,post"])).exit, 0);
  assert.deepEqual(requests[0].body, { enabled: false, methods: ["GET", "POST"] });
  assert.equal(requests[0].method, "PUT");
});

test("audit filters and opaque cursor are mapped without auto-pagination", async () => {
  body = audit;
  const result = await cli(["audit", "list", "--limit", "10", "--cursor", "opaque+/=", "--agent-id", "agent",
    "--service", "stripe", "--outcome", "success", "--from", date, "--to", date, "--json"]);
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.out), audit);
  assert.equal(requests.length, 1);
  const query = new URL(requests[0].url!, base).searchParams;
  assert.equal(query.get("agent_id"), "agent");
  assert.equal(query.get("cursor"), "opaque+/=");
  assert.equal(query.get("limit"), "10");
  assert.equal(query.get("from"), date);
  assert.equal(query.get("outcome"), "success");
});

test("invalid page size and timeout fail before HTTP", async () => {
  for (const value of ["0", "201", "1.5", "NaN"]) assert.equal((await cli(["audit", "list", "--limit", value])).exit, 2);
  assert.equal((await cli(["account", "get", "--timeout-ms", "0"])).exit, 2);
  assert.equal(requests.length, 0);
});

test("credential retrieval requires explicit reveal before any request", async () => {
  const result = await cli(["credentials", "get", "stripe"]);
  assert.equal(result.exit, 2);
  assert.equal(result.out, "");
  assert.equal(requests.length, 0);
});

test("credential retrieval uses only agent auth and maps selectors", async () => {
  body = credentials;
  const result = await cli(["credentials", "get", "stripe", "--reveal", "--method", "post", "--key-name", "api_key", "--json"]);
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.out), credentials);
  assert.equal(requests[0].authorization, "Bearer agent-secret");
  assert.equal(requests[0].url, "/api/agents/me/credentials/stripe?method=POST&key_name=api_key");
});

test("account-token fallback is supported, but never used for agent commands", async () => {
  const env = { GAZEBO_ENDPOINT: base, GAZEBO_API_TOKEN: "fallback-account" };
  assert.equal((await cli(["account", "get"], { env })).exit, 0);
  assert.equal(requests[0].authorization, "Bearer fallback-account");
  assert.equal((await cli(["credentials", "get", "stripe", "--reveal"], { env })).exit, 2);
  assert.equal(requests.length, 1);
});

test("missing tokens fail explicitly and without HTTP", async () => {
  const result = await cli(["account", "get", "--json"], { env: {} });
  assert.equal(result.exit, 2);
  assert.equal(JSON.parse(result.err).error.code, "usage");
  assert.equal(requests.length, 0);
});

test("token files override environment and trim trailing newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gazebo-cli-"));
  const path = join(directory, "token");
  try {
    await writeFile(path, "file-token\n", { mode: 0o600 });
    assert.equal((await cli(["account", "get", "--token-file", path])).exit, 0);
    assert.equal(requests[0].authorization, "Bearer file-token");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unreadable token files do not expose filesystem errors or paths", async () => {
  const result = await cli(["account", "get", "--token-file", "/sensitive-path", "--json"], {
    readTokenFile: async () => { throw new Error("file-token /sensitive-path"); },
  });
  assert.equal(result.exit, 2);
  assert.equal(result.err.includes("file-token"), false);
  assert.equal(result.err.includes("/sensitive-path"), false);
  assert.equal(requests.length, 0);
});

test("endpoint option overrides environment and preserves local prefix", async () => {
  const result = await cli(["--endpoint", `${base}/broker/`, "account", "get"]);
  assert.equal(result.exit, 0);
  assert.equal(requests[0].url, "/broker/api/v1/me");
});

test("unknown commands, duplicate/misplaced options and token arguments fail explicitly", async () => {
  for (const args of [
    ["unknown", "command"], ["agents", "list", "extra"], ["account", "get", "--reveal"],
    ["account", "get", "--json", "--json"], ["account", "get", "--token", "account-secret"],
    ["credentials", "get", "stripe", "--reveal", "--method", "OPTIONS"],
  ]) {
    const result = await cli(args);
    assert.equal(result.exit, 2);
    assert.equal(result.err.includes("account-secret"), false);
  }
  assert.equal(requests.length, 0);
});

test("server error details are not leaked and stdout stays empty", async () => {
  for (const code of [401, 403, 404, 500]) {
    status = code; body = { error: "provider-secret", token: "account-secret", stack: "secret stack" };
    const result = await cli(["account", "get", "--json"]);
    assert.equal(result.exit, 1);
    assert.equal(result.out, "");
    assert.equal(JSON.parse(result.err).error.status, code);
    assert.equal(result.err.includes("provider-secret"), false);
    assert.equal(result.err.includes("account-secret"), false);
    assert.equal(result.err.includes("secret stack"), false);
  }
});

test("rate limit exposes Retry-After and does not retry", async () => {
  status = 429; body = { error: "limited" };
  const result = await cli(["account", "get", "--json"]);
  assert.equal(result.exit, 1);
  assert.equal(JSON.parse(result.err).error.retryAfter, "60");
  assert.equal(requests.length, 1);
});

test("malformed success returns invalid_response, not raw body", async () => {
  raw = "provider-secret";
  const result = await cli(["account", "get", "--json"]);
  assert.equal(result.exit, 1);
  assert.equal(JSON.parse(result.err).error.code, "invalid_response");
  assert.equal(result.err.includes(raw), false);
});

test("configuration errors are sanitized", async () => {
  const result = await cli(["account", "get", "--endpoint", "invalid secret-url", "--json"]);
  assert.equal(result.exit, 1);
  assert.equal(JSON.parse(result.err).error.code, "invalid_input");
  assert.equal(result.err.includes("secret-url"), false);
});

test("timeout and cancellation produce distinct exit behavior", async () => {
  delay = 100;
  const timed = await cli(["account", "get", "--timeout-ms", "20", "--json"]);
  assert.equal(timed.exit, 1);
  assert.equal(JSON.parse(timed.err).error.code, "timeout");
  const controller = new AbortController(); controller.abort();
  const cancelled = await cli(["account", "get", "--json"], { signal: controller.signal });
  assert.equal(cancelled.exit, 130);
  assert.equal(JSON.parse(cancelled.err).error.code, "cancelled");
});

async function binary(args: string[], env: Record<string, string> = {}, compiled = false) {
  const entry = compiled
    ? [fileURLToPath(new URL("../dist/bin.js", import.meta.url))]
    : ["--import", "tsx", fileURLToPath(new URL("../src/bin.ts", import.meta.url))];
  const child = spawn(process.execPath, [...entry, ...args], {
    env: { PATH: process.env.PATH, GAZEBO_ENDPOINT: base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const [exit] = await once(child, "close");
  return { exit, out, err };
}
test("actual executable provides help without tokens", async () => {
  const result = await binary(["--help"]);
  assert.equal(result.exit, 0);
  assert.match(result.out, /Gazebo CLI/);
  assert.equal(result.err, "");
});

test("actual executable returns JSON with correct exit codes", async () => {
  const result = await binary(["account", "get", "--json"], { GAZEBO_ACCOUNT_TOKEN: "process-token" });
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.out), identity);
  assert.equal(requests[0].authorization, "Bearer process-token");
  const invalid = await binary(["account", "get", "--json"]);
  assert.equal(invalid.exit, 2);
  assert.equal(invalid.out, "");
  assert.equal(JSON.parse(invalid.err).error.code, "usage");
});

test("compiled executable makes a real SDK request", async () => {
  const result = await binary(["account", "get", "--json"], { GAZEBO_ACCOUNT_TOKEN: "compiled-token" }, true);
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.out), identity);
  assert.equal(requests[0].authorization, "Bearer compiled-token");
});

test("compiled executable handles SIGINT with exit 130 and no secret diagnostics", async () => {
  delay = 300;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "account", "get", "--json"], {
    env: { PATH: process.env.PATH, GAZEBO_ENDPOINT: base, GAZEBO_ACCOUNT_TOKEN: "interrupt-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const interrupt = () => { setTimeout(() => child.kill("SIGINT"), 20); };
  server.once("request", interrupt);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [exit] = await once(child, "close");
    assert.equal(exit, 130);
    assert.equal(out, "");
    assert.equal(JSON.parse(err).error.code, "cancelled");
    assert.equal(err.includes("interrupt-token"), false);
  } finally {
    clearTimeout(deadline);
    server.removeListener("request", interrupt);
  }
});
