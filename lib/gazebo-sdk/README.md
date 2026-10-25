# Gazebo TypeScript SDK

Gazebo manages credential access for AI agents. Choose which service keys each agent can retrieve, manage access centrally, and review credential-access history.

`@gazebohq/sdk` is the official JavaScript and TypeScript client for Gazebo. Add account automation and scoped credential retrieval to your server-side applications without writing an API client from scratch.

**[Get started with Gazebo](https://gazebohq.com/docs/sdk)**


Dependency-free, ESM, Node.js 20+. This is a server-side client: never expose account or agent tokens in browser bundles.

## Account automation

```ts
import { Gazebo } from "@gazebohq/sdk";

const gazebo = new Gazebo({
  endpoint: "https://app.gazebohq.com",
  auth: { type: "account", token: accountToken },
});

const identity = await gazebo.account.get();
const services = await gazebo.services.list();
const agents = await gazebo.agents.list();
const created = await gazebo.agents.create({ name: "My agent" });
// Store created.token securely: it is returned only once. Do not log created.
await gazebo.access.set(created.id, "stripe", { enabled: true, methods: ["GET"] });
const access = await gazebo.access.get(created.id);
// Revocation:
await gazebo.agents.delete(created.id);
```

`access.set` replaces a policy; an explicit nonempty methods list is required even when disabling access. The HTTP API's omitted-method default grants all five supported methods, so the SDK intentionally has no implicit default.

## Scoped runtime access

```ts
const agent = new Gazebo({
  endpoint: "https://app.gazebohq.com",
  auth: { type: "agent", token: agentToken },
});

const result = await agent.credentials.get("stripe", {
  method: "GET",
  // Optional: keyName: "api_key"
});
// result.credentials contains one sensitive key. Never log this response.
```

Account clients expose administration operations; agent clients expose only `credentials.get`. This distinction applies to TypeScript and runtime objects. The server remains the authorization boundary.

Method policies govern credential release, not requests made afterward to a provider. Provider scopes/IAM still constrain downstream actions.

## Security boundary

`credentials.get` returns the actual stored provider credential to the agent runtime. If a developer hosts that runtime, their infrastructure receives the key. Use trusted runtimes and provider credentials with the narrowest permissions available; Gazebo does not proxy provider requests or reduce a key's permissions after release.

Revoking an agent prevents future credential retrieval with its token. It does not invalidate a provider key already retrieved or undo provider actions. A leaked key may require revocation or rotation at the provider. Audit events describe credential retrieval, not subsequent provider activity.

Manual setup remains supported. Keep each user's token separate; do not request account administration tokens for runtime access. The consent extension below requires the matching server release and your application's authenticated callback/storage adapters.

## Audit pagination

```ts
const filters = { service: "stripe", limit: 50 };
let page = await gazebo.auditEvents.list(filters);
while (page.hasMore && page.nextCursor) {
  page = await gazebo.auditEvents.list({ ...filters, cursor: page.nextCursor });
}
```

Filters: `limit` (integer 1–200), `cursor`, `agentId`, `service`, `outcome`, `from`, `to`. Keep filters unchanged when advancing opaque cursors. The SDK never fetches additional pages automatically. Timestamps remain wire-format strings.

## Endpoints, timeouts, and cancellation

The endpoint selects the deployment without changing method signatures:

```ts
new Gazebo({ endpoint: "https://app.gazebohq.com", auth });
new Gazebo({ endpoint: "http://localhost:8787", auth });
```

Local example demonstrates client configurability only. No local broker is implemented and cloud parity is not promised. Optional endpoint path prefixes are preserved.

Default timeout is 10 seconds, including reading the response body; override with constructor `timeoutMs`. Every operation accepts a request-options argument containing `signal`; credential retrieval accepts it alongside `method`/`keyName`.

```ts
const controller = new AbortController();
const pending = gazebo.agents.list({ signal: controller.signal });
controller.abort();
```

Core API requests do not retry, follow redirects, use cookies, log responses, or retain underlying fetch errors. HTTP is supported for local development; use HTTPS for remote tokens. An optional constructor `fetch` can adapt transports or inject a test fixture.

## Account connection

`@gazebohq/sdk/consent` is a **server-only module in the same package**, not another npm package. Register a public ES256 key, exact callback and `gazebo.credentials.read` scope in Agent Consent Flow. The user approves specific service/key pairs and the existing agent expiry. Legacy scope-only grants remain non-runtime grants.

Use `startConnection` and `completeConnection`, binding state/PKCE to your application's authenticated user and initiating session. See `examples/connect-application.ts` for the callback and storage adapter contract.

```ts
import { Gazebo } from "@gazebohq/sdk";
import { createConnectionTokenProvider } from "@gazebohq/sdk/consent";

const agent = new Gazebo({
  endpoint: "https://app.gazebohq.com",
  auth: { type: "consent", tokenProvider: createConnectionTokenProvider({
    endpoint: "https://app.gazebohq.com",
    clientId, privateKeyJwk, store: encryptedPerUserConnectionStore,
  }) },
});
await agent.credentials.get("github", { keyName: "api_key" });
await agent.connection.get();
```

Supply encrypted persistent storage and a shared cross-worker lock per application user. The helper persists a renewal operation ID, rotates near access expiry and retries one lost network response with the same operation. Identical retries are accepted for 60 seconds; older lost-response recovery requires reconnecting. Different-operation reuse revokes the connection.

Access lasts at most one hour; renewal credentials expire after 30 inactive days. Both are capped by the grant/agent deadline. Use `disconnectStoredConnection` to block local use while unavailable remote revocation is retried. Runtime operations are named-key retrieval and identity/disconnect only—not account administration, bulk retrieval or MCP.

**The runtime and its host receive the actual provider key.** Revocation stops future retrieval/renewal, not use of keys already delivered. This is not a provider proxy or OAuth compatibility. Applications are responsible for securing their own authentication, callback and storage adapters.

## Errors

```ts
import { GazeboError } from "@gazebohq/sdk";

try {
  await agent.credentials.get("stripe");
} catch (error) {
  if (error instanceof GazeboError) {
    // code: http | network | timeout | cancelled | invalid_response | auth_mode
    // status: HTTP status for server errors
    // retryAfter: raw Retry-After header, when supplied
    // details: parsed server payload; inspect intentionally, never log blindly
  }
}
```

Server messages are not copied into the error's generic message. `details` is non-enumerable so JSON serialization omits it, but direct access can contain sensitive fields. SDK input validation throws `TypeError`. Successful JSON is checked for expected fields; unknown additive fields are preserved.

## Development

Runnable examples ship in `examples/account.mjs` and `examples/agent.mjs`:

```sh
node node_modules/@gazebohq/sdk/examples/account.mjs
node node_modules/@gazebohq/sdk/examples/agent.mjs --retrieve
```

Supply `GAZEBO_ACCOUNT_TOKEN` for the account example; it reads identity, services, agents, and one audit page without making changes. Supply `GAZEBO_AGENT_TOKEN` and `GAZEBO_SERVICE` for the agent example. The latter retrieves a credential and creates an audit event, but prints only service/key-name metadata, never the value. Both optionally use `GAZEBO_ENDPOINT`; default is Gazebo Cloud. 

Compiled ESM JavaScript, declarations, MIT license, source, and a self-contained build configuration are included. To rebuild from a standalone source checkout with development dependencies installed, run `pnpm run build`. It does not require the Gazebo monorepo or emit declaration maps pointing at missing files.

From this repository's root:

```sh
pnpm --filter @gazebohq/sdk run typecheck
pnpm --filter @gazebohq/sdk test
pnpm --filter @gazebohq/sdk build
```

Tests use a local HTTP server and synthetic tokens. Cloud URL construction is tested with an injected transport, not a live account. 


License: MIT. Copyright notice: Gazebo contributors.

The SDK includes server-side Agent Consent Flow helpers. Applications supply their own sign-in, connection UI, callback route, encrypted storage and shared locking; see [the consent guide](https://gazebohq.com/docs/consent).

Out of scope for the SDK: a ready-made browser UI, MCP wrapping, credential uploads, automatic approval polling, Python, and a local broker.
