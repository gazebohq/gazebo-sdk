import { GazeboError } from "./errors.js";
import type { HttpMethod } from "./types.js";

export const methods: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const string = (value: unknown): value is string => typeof value === "string";
export const boolean = (value: unknown): value is boolean => typeof value === "boolean";
export const nullableString = (value: unknown) => value === null || string(value);
export const optionalString = (value: unknown) => value === undefined || nullableString(value);
export const strings = (value: unknown) => Array.isArray(value) && value.every(string);
export const timestamp = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));
export const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
export type Validator = (value: unknown) => boolean;
export function shape(fields: Record<string, Validator>): Validator {
  return value => object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
export const array = (check: Validator): Validator => value => Array.isArray(value) && value.every(check);
export const validMethod = (value: unknown): value is HttpMethod => methods.includes(value as HttpMethod);
export function requiredText(value: unknown, field: string): asserts value is string {
  if (!string(value) || value.trim() === "") throw new TypeError(`${field} must be a nonempty string`);
}
export function segment(value: string, field: string): string {
  requiredText(value, field);
  // Dot segments can be normalized by URL/fetch instead of sent literally.
  if (value === "." || value === "..") throw new TypeError(`${field} cannot be a dot segment`);
  return encodeURIComponent(value);
}
export function parseResponse<T>(value: unknown, validate: Validator): T {
  if (!validate(value)) throw new GazeboError("invalid_response");
  return value as T;
}

export const accountResponse = shape({
  id: string, email: string, createdAt: timestamp, hasApiToken: boolean,
  agentsEnabled: boolean, agentsEnabledDefault: boolean,
});
export const agentsResponse = array(shape({
  id: string, name: string, createdAt: timestamp, lastActiveAt: nullableTimestamp,
  revokedAt: nullableTimestamp, expiresAt: nullableTimestamp, services: strings,
}));
export const createdAgentResponse = shape({
  id: string, name: string, token: string, createdAt: timestamp, expiresAt: nullableTimestamp,
});
export const servicesResponse = array(shape({
  service: string, connectedAt: timestamp, keyType: value => value === "oauth" || value === "api_key",
}));
export const accessResponse = array(shape({ service: string, enabled: boolean, methods: array(validMethod) }));
export const okResponse = shape({ ok: boolean });
export const credentialsResponse = shape({
  service: string,
  credentials: value => object(value) && Object.keys(value).length === 1 && Object.values(value).every(string),
});
export const auditResponse = shape({
  events: array(shape({
    id: string, agentId: string, agentName: optionalString, service: string,
    keyName: string, action: string, outcome: string, method: optionalString, createdAt: timestamp,
  })),
  nextCursor: nullableString, hasMore: boolean,
});
