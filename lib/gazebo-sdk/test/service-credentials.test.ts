import assert from "node:assert/strict";
import { test } from "node:test";
import { Gazebo, GazeboError } from "../src/index.js";

const credentials = [{ keyName: "api_key", value: "synthetic-secret" }];
function fixture() {
  const requests: { url: string; init?: RequestInit }[] = [];
  let body: unknown = { ok: true }, status = 200;
  const client = new Gazebo({
    endpoint: "https://fixture.invalid/prefix", auth: { type: "account", token: "account-fixture" },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    },
  });
  return { client, requests, response(value: unknown, code = 200) { body = value; status = code; } };
}

test("service lifecycle uses existing account contracts and normalises names", async () => {
  const f = fixture();
  await f.client.services.replaceCredentials(" STRIPE ", credentials);
  f.response({ ok: true, verified: true });
  assert.deepEqual(await f.client.services.testCredentials(" STRIPE ", credentials), { ok: true, verified: true });
  f.response({ ok: true });
  await f.client.services.deleteCredentials(" Provider/key ");
  assert.deepEqual(f.requests.map(r => [r.init?.method, r.url]), [
    ["PUT", "https://fixture.invalid/prefix/api/v1/services/credentials"],
    ["POST", "https://fixture.invalid/prefix/api/v1/services/test"],
    ["DELETE", "https://fixture.invalid/prefix/api/v1/services/credentials/provider%2Fkey"],
  ]);
  assert.deepEqual(JSON.parse(f.requests[0].init?.body as string), { service: "stripe", credentials });
  assert.equal((f.requests[0].init?.headers as Record<string, string>).Authorization, "Bearer account-fixture");
});

test("service tests preserve failed and skipped verification without exposing server text", async () => {
  const f = fixture();
  f.response({ ok: true, verified: false, debug: "synthetic-secret" });
  assert.deepEqual(await f.client.services.testCredentials("custom", credentials), { ok: true, verified: false });
  f.response({ ok: false, error: "synthetic-secret" });
  const result = await f.client.services.testCredentials("stripe", credentials);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  f.response({ ok: true });
  await assert.rejects(f.client.services.testCredentials("stripe", credentials),
    (e: unknown) => e instanceof GazeboError && e.code === "invalid_response");
});

test("credential writes validate before HTTP and never echo invalid values", async () => {
  const f = fixture();
  for (const invalid of [[], [...credentials, ...credentials], [{ keyName: " ", value: "synthetic-secret" }],
    [{ keyName: "api_key", value: " " }], [{ keyName: " api_key", value: "synthetic-secret" }]]) {
    await assert.rejects(f.client.services.replaceCredentials("stripe", invalid), error =>
      error instanceof TypeError && !String(error).includes("synthetic-secret"));
  }
  await assert.rejects(f.client.services.deleteCredentials(" .. "));
  assert.equal(f.requests.length, 0);
});

test("secret-input operations strip raw errors, extra fields and false acknowledgements", async () => {
  const f = fixture();
  f.response({ ok: true, value: "synthetic-secret" });
  assert.deepEqual(await f.client.services.replaceCredentials("stripe", credentials), { ok: true });
  f.response({ error: "synthetic-secret" }, 403);
  await assert.rejects(f.client.services.replaceCredentials("stripe", credentials), (error: unknown) => {
    assert.ok(error instanceof GazeboError);
    assert.equal(error.status, 403);
    assert.equal(error.details, undefined);
    assert.ok(!String(error).includes("synthetic-secret"));
    return true;
  });
  f.response({ ok: false });
  await assert.rejects(f.client.services.deleteCredentials("stripe"));
});

test("runtime clients do not expose service administration", () => {
  const agent = new Gazebo({ endpoint: "https://fixture.invalid", auth: { type: "agent", token: "fixture" } });
  assert.equal("services" in agent, false);
});
