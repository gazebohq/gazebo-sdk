/** Server-only helpers for Gazebo's private-beta account connection extension. */
import { generateKeyPairSync, createHash, randomBytes, sign, timingSafeEqual } from "node:crypto";
import type { webcrypto } from "node:crypto";
import { GazeboError } from "./errors.js";

export interface CredentialResource { service: string; keyName: string }
export interface ConnectionTokens {
  access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string;
  agent_id: string; connection_id: string; subject: string;
  connection_expires_at: string | null; refresh_expires_at: string;
}
export interface StoredConnection {
  tokens: ConnectionTokens;
  accessExpiresAt: number;
  /** Persist before sending a renewal, so a retry reuses the same operation. */
  pendingRefreshId?: string;
  /** Blocks local use while remote revocation is pending/retrying. */
  pendingDisconnect?: boolean;
}
export interface ConnectionStore {
  /** Must serialize ALL workers for this application-user connection. */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  get(): Promise<StoredConnection | null>;
  /** Application must encrypt durable storage and commit this atomically. */
  set(connection: StoredConnection): Promise<void>;
  clear(): Promise<void>;
}
export function generateConnectionKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { publicKeyJwk: publicKey.export({ format: "jwk" }), privateKeyJwk: privateKey.export({ format: "jwk" }) };
}
export function generateConnectionState() { return randomBytes(32).toString("base64url"); }
export function validateConnectionState(received: string | null | undefined, expected: string) {
  if (!received || !expected || expected.length < 16) return false;
  const a = Buffer.from(received); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function signedJwt(claims: Record<string, unknown>, privateKey: webcrypto.JsonWebKey) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const text = `${encode({ alg: "ES256", typ: "JWT" })}.${encode(claims)}`;
  return text + "." + sign("sha256", Buffer.from(text), {
    key: privateKey, format: "jwk", dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}
export function createCredentialAuthorizationRequest(input: {
  clientId: string; redirectUri: string; resources: CredentialResource[]; state: string; codeChallenge: string;
  audience?: string;
}, privateKey: webcrypto.JsonWebKey) {
  if (!input.clientId || !input.resources.length || input.state.length < 16 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new TypeError("Invalid connection request");
  const now = Math.floor(Date.now() / 1000);
  return signedJwt({ iss: input.clientId, aud: input.audience ?? "gazebo-consent-v1",
    iat: now, exp: now + 300, jti: generateConnectionState(), redirect_uri: input.redirectUri,
    scope: "gazebo.credentials.read", purpose: "credential_release", credential_resources: input.resources,
    state: input.state, code_challenge: input.codeChallenge, code_challenge_method: "S256" }, privateKey);
}
export function createSignedRefreshRequest(clientId: string, refreshToken: string,
  privateKey: webcrypto.JsonWebKey, requestId = generateConnectionState()) {
  const now = Math.floor(Date.now() / 1000);
  return signedJwt({ iss: clientId, aud: "gazebo-consent-refresh-v1", iat: now, exp: now + 60, jti: requestId,
    refresh_hash: createHash("sha256").update(refreshToken).digest("base64url") }, privateKey);
}
function target(endpoint: string, path: string) {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || endpoint.includes("#") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw new TypeError("Use HTTPS or HTTP loopback");
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url;
}
async function post<T>(endpoint: string, path: string, body: unknown): Promise<T> {
  const url = target(endpoint, path);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(10_000) });
  } catch { throw new GazeboError("network"); }
  if (!response.ok) throw new GazeboError(response.status === 401 || response.status === 400
    ? "reconnect_required" : "http", { status: response.status });
  try { return await response.json() as T; } catch { throw new GazeboError("invalid_response"); }
}
function tokens(value: ConnectionTokens): ConnectionTokens {
  if (!value || !/^gzc_[A-Za-z0-9_-]{43}$/.test(value.access_token) ||
      !/^gzr_[A-Za-z0-9_-]{43}$/.test(value.refresh_token) ||
      !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 3600 ||
      typeof value.agent_id !== "string" || typeof value.connection_id !== "string" ||
      typeof value.subject !== "string" || !Number.isFinite(Date.parse(value.refresh_expires_at))) {
    throw new GazeboError("invalid_response");
  }
  return value;
}
export async function startConnection(endpoint: string, input: {
  clientId: string; redirectUri: string; resources: CredentialResource[]; audience?: string;
}, privateKey: webcrypto.JsonWebKey) {
  const state = generateConnectionState();
  const verifier = randomBytes(48).toString("base64url");
  const requestJwt = createCredentialAuthorizationRequest({ ...input, state,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url") }, privateKey);
  const begun = await post<{ transactionId: string; expiresAt: string }>(endpoint, "/api/consent/v1/authorization", { requestJwt });
  if (!begun.transactionId || !Number.isFinite(Date.parse(begun.expiresAt))) throw new GazeboError("invalid_response");
  const url = target(endpoint, "/consent/authorize");
  url.searchParams.set("transaction", begun.transactionId);
  return { state, verifier, expiresAt: begun.expiresAt, authorizationUrl: url.toString() };
}
/** Caller MUST atomically consume its own session-bound pending state first. */
export async function completeConnection(endpoint: string, callback: {
  state?: string | null; expectedState: string; clientId: string; code?: string; error?: string;
  redirectUri: string; codeVerifier: string;
}) {
  if (!validateConnectionState(callback.state, callback.expectedState)) throw new GazeboError("reconnect_required");
  if (callback.error) throw new GazeboError("cancelled");
  if (!callback.code) throw new GazeboError("reconnect_required");
  return tokens(await post<ConnectionTokens>(endpoint, "/api/consent/v1/token", {
    clientId: callback.clientId, code: callback.code, redirectUri: callback.redirectUri, codeVerifier: callback.codeVerifier,
  }));
}
export const storedConnection = (value: ConnectionTokens): StoredConnection => ({
  tokens: tokens(value), accessExpiresAt: Date.now() + value.expires_in * 1000,
});

/** Application-owned lock/storage makes renewal safe across distributed workers. */
export function createConnectionTokenProvider(options: {
  endpoint: string; clientId: string; privateKeyJwk: webcrypto.JsonWebKey; store: ConnectionStore;
}) {
  // Also serialize calls inside this instance; the store handles other processes.
  let pending: Promise<string> | undefined;
  return async () => {
    if (pending) return pending;
    pending = options.store.withLock(async () => {
      const current = await options.store.get();
      if (!current) throw new GazeboError("reconnect_required");
      if (current.pendingDisconnect) throw new GazeboError("reconnect_required");
      if (Date.parse(current.tokens.refresh_expires_at) <= Date.now() ||
          (current.tokens.connection_expires_at && Date.parse(current.tokens.connection_expires_at) <= Date.now())) {
        await options.store.clear(); throw new GazeboError("reconnect_required");
      }
      if (!current.pendingRefreshId && current.accessExpiresAt > Date.now() + 60_000) return current.tokens.access_token;
      const requestId = current.pendingRefreshId ?? generateConnectionState();
      await options.store.set({ ...current, pendingRefreshId: requestId });
      const body = { clientId: options.clientId, refreshToken: current.tokens.refresh_token,
        requestJwt: createSignedRefreshRequest(options.clientId, current.tokens.refresh_token, options.privateKeyJwk, requestId) };
      try {
        let issued: ConnectionTokens | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { issued = tokens(await post<ConnectionTokens>(options.endpoint, "/api/consent/v1/refresh", body)); break; }
          catch (error) {
            if (!(error instanceof GazeboError) || error.code !== "network" || attempt === 1) throw error;
          }
        }
        if (!issued) throw new GazeboError("network");
        await options.store.set(storedConnection(issued));
        return issued.access_token;
      } catch (error) {
        if (error instanceof GazeboError && error.code === "reconnect_required") await options.store.clear();
        throw error;
      }
    });
    try { return await pending; } finally { pending = undefined; }
  };
}
/** Remote disconnect first; on failure callers must block local use and retry. */
export async function disconnectConnection(endpoint: string, clientId: string, refreshToken: string) {
  return post<{ ok: boolean }>(endpoint, "/api/consent/v1/revoke", { clientId, token: refreshToken });
}
export async function disconnectStoredConnection(options: {
  endpoint: string; clientId: string; store: ConnectionStore;
}) {
  await options.store.withLock(async () => {
    const current = await options.store.get();
    if (!current) return;
    await options.store.set({ ...current, pendingDisconnect: true });
    await disconnectConnection(options.endpoint, options.clientId, current.tokens.refresh_token);
    await options.store.clear();
  });
}
