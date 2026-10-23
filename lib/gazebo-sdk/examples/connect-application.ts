/**
 * Framework-neutral backend integration. This example deliberately requires
 * the application's existing authenticated sessions and encrypted database.
 * No process-memory token store or "trust userId from a URL" shortcut.
 */
import { Gazebo } from "../src/index.js";
import {
  startConnection, completeConnection, storedConnection, createConnectionTokenProvider,
  disconnectStoredConnection, type ConnectionStore,
} from "../src/consent.js";
import type { webcrypto } from "node:crypto";

interface Pending {
  state: string; verifier: string; expiresAt: string; sessionId: string; userId: string;
}
interface ApplicationStorage {
  // Must bind to the signed-in local application user AND initiating session.
  savePending(sessionId: string, userId: string, pending: Pending): Promise<void>;
  // Atomically remove-and-return once, checking both bindings.
  consumePending(sessionId: string, userId: string): Promise<Pending | null>;
  connectionForUser(userId: string): ConnectionStore;
}
export function applicationConnection(config: {
  endpoint: string; clientId: string; callbackUri: string;
  privateKeyJwk: webcrypto.JsonWebKey; storage: ApplicationStorage;
}) {
  return {
    async connect(authenticatedSession: { id: string; userId: string }) {
      const pending = await startConnection(config.endpoint, {
        clientId: config.clientId, redirectUri: config.callbackUri,
        resources: [{ service: "github", keyName: "api_key" }],
      }, config.privateKeyJwk);
      await config.storage.savePending(authenticatedSession.id, authenticatedSession.userId,
        { ...pending, sessionId: authenticatedSession.id, userId: authenticatedSession.userId });
      return pending.authorizationUrl; // send an HTTP redirect; do not log it
    },
    async callback(authenticatedSession: { id: string; userId: string },
      query: { state?: string; code?: string; error?: string }) {
      const pending = await config.storage.consumePending(authenticatedSession.id, authenticatedSession.userId);
      if (!pending || pending.userId !== authenticatedSession.userId ||
          pending.sessionId !== authenticatedSession.id || Date.parse(pending.expiresAt) <= Date.now()) {
        throw new Error("Restart Connect Gazebo from this application session");
      }
      const issued = await completeConnection(config.endpoint, {
        ...query, expectedState: pending.state, codeVerifier: pending.verifier,
        clientId: config.clientId, redirectUri: config.callbackUri,
      });
      const store = config.storage.connectionForUser(authenticatedSession.userId);
      await store.withLock(async () => store.set(storedConnection(issued)));
      // Return to a fixed application page. Never send tokens to the browser.
      return "/settings/connections";
    },
    runtimeFor(userId: string) {
      return new Gazebo({ endpoint: config.endpoint, auth: { type: "consent",
        tokenProvider: createConnectionTokenProvider({ ...config,
          store: config.storage.connectionForUser(userId) }),
      } });
    },
    async disconnect(userId: string) {
      const store = config.storage.connectionForUser(userId);
      await disconnectStoredConnection({ endpoint: config.endpoint, clientId: config.clientId, store });
    },
  };
}
