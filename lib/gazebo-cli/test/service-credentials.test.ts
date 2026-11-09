import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { readCredentialInput } from "../src/credential-input.js";

const input = JSON.stringify([{ keyName: "api_key", value: "synthetic-secret" }]);
function fixture(body: unknown = { ok: true }, status = 200) {
  const out: string[] = [], err: string[] = [], requests: RequestInit[] = [], paths: string[] = [];
  const run = (args: string[], source = input, env: Record<string, string> = { GAZEBO_ACCOUNT_TOKEN: "account-fixture" }) =>
    runCli([...args, "--json", "--endpoint", "https://fixture.invalid"], {
      env, stdout: s => out.push(s), stderr: s => err.push(s),
      readCredentialInput: async () => source,
      fetch: async (url, init) => {
        requests.push(init!); paths.push(String(url));
        return new Response(JSON.stringify(body), { status });
      },
    });
  return { run, out, err, requests, paths };
}

test("service commands route through SDK with file/stdin input and safe output", async () => {
  const f = fixture({ ok: true, echo: "synthetic-secret" });
  assert.equal(await f.run(["services", "credentials", "replace", " STRIPE ", "--input-file", "-", "--yes"]), 0);
  assert.equal(f.requests[0].method, "PUT");
  assert.deepEqual(JSON.parse(f.requests[0].body as string), {
    service: "stripe", credentials: JSON.parse(input),
  });
  assert.equal(await f.run(["services", "credentials", "delete", "STRIPE", "--yes"]), 0);
  assert.equal(f.requests[1].method, "DELETE");
  assert.ok(f.paths[1].endsWith("/services/credentials/stripe"));
  assert.ok(![...f.out, ...f.err].join("").includes("synthetic-secret"));
});

test("verification exit status distinguishes verified, unavailable, failed and transport errors", async () => {
  for (const [body, status, exit, code] of [
    [{ ok: true, verified: true }, 200, 0, ""],
    [{ ok: true, verified: false }, 200, 1, "not_verified"],
    [{ ok: false, error: "synthetic-secret" }, 200, 1, "verification_failed"],
    [{ error: "synthetic-secret" }, 403, 1, "http"],
  ] as const) {
    const f = fixture(body, status);
    assert.equal(await f.run(["services", "credentials", "test", "stripe", "--input-file", "private.json"]), exit);
    if (exit) { assert.equal(f.out.length, 0); assert.equal(JSON.parse(f.err[0]).error.code, code); }
    assert.ok(![...f.out, ...f.err].join("").includes("synthetic-secret"));
  }
});

test("unsafe or malformed credential input and missing confirmations fail before HTTP", async () => {
  for (const args of [
    ["services", "credentials", "replace", "stripe", "--input-file", "-"],
    ["services", "credentials", "delete", "stripe"],
    ["services", "credentials", "test", "stripe"],
    ["services", "credentials", "test", "stripe", "--input-file", "-", "--token-file", "-"],
    ["services", "credentials", "test", "stripe", "--input-file", "same", "--token-file", "same"],
    ["services", "credentials", "replace", "stripe", "--input-file", "-", "--yes", "--value", "synthetic-secret"],
  ]) {
    const f = fixture();
    assert.equal(await f.run(args), 2);
    assert.equal(f.requests.length, 0);
    assert.ok(!f.err.join("").includes("synthetic-secret"));
  }
  for (const source of ["synthetic-secret", "[]", "{}", "[".repeat(70_000),
    JSON.stringify([...JSON.parse(input), ...JSON.parse(input)]),
    JSON.stringify([{ keyName: "api_key", value: "" }]),
    JSON.stringify([{ keyName: "api_key", value: "synthetic-secret", extra: true }])]) {
    const f = fixture();
    assert.equal(await f.run(["services", "credentials", "test", "stripe", "--input-file", "-"], source), 2);
    assert.equal(f.requests.length, 0);
    assert.ok(!f.err.join("").includes("synthetic-secret"));
  }
});

test("service management never falls back to a scoped agent token", async () => {
  const f = fixture();
  assert.equal(await f.run(["services", "credentials", "replace", "stripe", "--input-file", "-", "--yes"],
    input, { GAZEBO_AGENT_TOKEN: "agent-fixture" }), 2);
  assert.equal(f.requests.length, 0);
});

test("file reader bounds input and sanitizes file failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gazebo-input-"));
  try {
    const path = join(dir, "credentials.json");
    await writeFile(path, input, { mode: 0o600 });
    assert.equal(await readCredentialInput(path), input);
    await writeFile(path, "x".repeat(70_000));
    await assert.rejects(readCredentialInput(path), /Unable to read credential input/);
    await assert.rejects(readCredentialInput(join(dir, "synthetic-secret")), error =>
      error instanceof Error && !error.message.includes("synthetic-secret"));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readCredentialInput(path, controller.signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("built CLI consumes actual stdin and rejects missing account authentication locally", async () => {
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  const child = spawn(process.execPath, [bin, "services", "credentials", "test", "custom",
    "--input-file", "-", "--json"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const closed = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  child.stdin.end(input);
  // Missing account authentication must fail locally after valid stdin parsing.
  assert.equal(await closed, 2);
  assert.equal(stdout, "");
  assert.equal(JSON.parse(stderr).error.code, "usage");
  assert.ok(!stderr.includes("synthetic-secret"));
});

test("built CLI sends actual file/stdin through SDK and exits nonzero for unavailable verification", async () => {
  const calls: { method?: string; path?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: JSON.parse(body) });
    assert.equal(req.headers.authorization, "Bearer account-fixture");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("/test") ? { ok: true, verified: false } : { ok: true }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const dir = await mkdtemp(join(tmpdir(), "gazebo-cli-input-"));
  try {
    const path = join(dir, "credentials.json"); await writeFile(path, input, { mode: 0o600 });
    for (const [action, inputPath, expected] of [["replace", path, 0], ["test", "-", 1]] as const) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
        "services", "credentials", action, "STRIPE", "--input-file", inputPath,
        ...(action === "replace" ? ["--yes"] : []), "--json", "--endpoint",
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`], {
        env: { GAZEBO_ACCOUNT_TOKEN: "account-fixture" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", error = "";
      child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { error += b; });
      const closed = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
      child.stdin.end(inputPath === "-" ? input : "");
      assert.equal(await closed, expected);
      if (expected === 1) assert.equal(JSON.parse(error).error.code, "not_verified");
      assert.ok(!(output + error).includes("synthetic-secret"));
    }
    assert.deepEqual(calls.map(c => [c.method, c.path]), [
      ["PUT", "/api/v1/services/credentials"], ["POST", "/api/v1/services/test"],
    ]);
    assert.deepEqual(calls[0].body, { service: "stripe", credentials: JSON.parse(input) });
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
