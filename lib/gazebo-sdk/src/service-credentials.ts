import { GazeboError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { ServiceCredential, CredentialTestResult, RequestOptions, Ok } from "./types.js";
import * as v from "./validation.js";

export function serviceName(service: string): string {
  v.requiredText(service, "service");
  const normalized = service.trim().toLowerCase();
  v.segment(normalized, "service");
  return normalized;
}

export function credentialInput(credentials: ServiceCredential[]): ServiceCredential[] {
  if (!Array.isArray(credentials) || credentials.length === 0) throw new TypeError("Credentials must be a nonempty array");
  const names = new Set<string>();
  return credentials.map(credential => {
    if (!v.object(credential) || typeof credential.keyName !== "string" ||
        !credential.keyName.trim() || credential.keyName !== credential.keyName.trim() ||
        names.has(credential.keyName) || typeof credential.value !== "string" || !credential.value.trim()) {
      throw new TypeError("Invalid or duplicate credential fields");
    }
    names.add(credential.keyName);
    return { keyName: credential.keyName, value: credential.value };
  });
}

const testResult: v.Validator = value => v.object(value) &&
  (value.ok === true ? typeof value.verified === "boolean" : value.ok === false);

/** No raw server errors/details or extra response fields escape these secret-input operations. */
export function serviceCredentialOperations(http: Transport) {
  async function request<T>(method: string, path: string, validate: v.Validator,
    options?: RequestOptions, body?: unknown): Promise<T> {
    try { return await http.request<T>("account", method, path, validate, options, body); }
    catch (error) {
      if (error instanceof GazeboError) throw new GazeboError(error.code, {
        status: error.status, retryAfter: error.retryAfter,
      });
      throw error;
    }
  }
  return {
    async replaceCredentials(service: string, credentials: ServiceCredential[], options?: RequestOptions): Promise<Ok> {
      const body = { service: serviceName(service), credentials: credentialInput(credentials) };
      const result = await request<Ok>("PUT", "/api/v1/services/credentials",
        value => v.object(value) && value.ok === true, options, body);
      return { ok: result.ok };
    },
    async testCredentials(service: string, credentials: ServiceCredential[], options?: RequestOptions): Promise<CredentialTestResult> {
      const body = { service: serviceName(service), credentials: credentialInput(credentials) };
      const result = await request<CredentialTestResult>("POST", "/api/v1/services/test", testResult, options, body);
      return result.ok ? { ok: true, verified: result.verified }
        : { ok: false, error: "Credential verification failed; check the credential or service availability." };
    },
    async deleteCredentials(service: string, options?: RequestOptions): Promise<Ok> {
      const path = `/api/v1/services/credentials/${v.segment(serviceName(service), "service")}`;
      const result = await request<Ok>("DELETE", path, value => v.object(value) && value.ok === true, options);
      return { ok: result.ok };
    },
  };
}
