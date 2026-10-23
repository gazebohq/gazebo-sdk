import { Transport } from "./transport.js";
import * as v from "./validation.js";
import type {
  Account, Agent, CreatedAgent, Service, AccessPolicy, Ok, AuditPage, Credentials,
  GazeboOptions, AuthType, AccountOperations, AgentOperations, ConsentOperations, Connection, AuditFilters,
} from "./types.js";
export { GazeboError } from "./errors.js";
export type { GazeboErrorCode } from "./errors.js";
export type * from "./types.js";

type Operations<T extends AuthType> = T extends "account" ? AccountOperations : T extends "consent" ? ConsentOperations : AgentOperations;

function auditQuery(filters: AuditFilters): URLSearchParams {
  if (filters.limit !== undefined && (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 200)) {
    throw new TypeError("limit must be an integer between 1 and 200");
  }
  if (filters.outcome !== undefined && !["success", "denied", "not_found"].includes(filters.outcome)) throw new TypeError("Invalid audit outcome");
  for (const date of [filters.from, filters.to]) {
    if (date !== undefined && !v.timestamp(date)) throw new TypeError("Audit dates must be valid timestamp strings");
  }
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) throw new TypeError("from must not be later than to");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({
    limit: filters.limit, cursor: filters.cursor, agent_id: filters.agentId,
    service: filters.service, outcome: filters.outcome, from: filters.from, to: filters.to,
  })) {
    if (value !== undefined) {
      if (key !== "limit") v.requiredText(value, key);
      query.set(key, String(value));
    }
  }
  return query;
}

function createClient<T extends AuthType>(options: GazeboOptions<T>): Operations<T> {
  const http = new Transport(options);
  if (options.auth.type === "agent" || options.auth.type === "consent") {
    const mode = options.auth.type;
    const client: AgentOperations = {
      credentials: {
        async get(service, options = {}) {
          if (mode === "consent" && !options.keyName) throw new TypeError("Consent retrieval requires an explicit keyName");
          const query = new URLSearchParams();
          if (options.method !== undefined) {
            if (!v.validMethod(options.method)) throw new TypeError("Invalid credential method");
            query.set("method", options.method);
          }
          if (options.keyName !== undefined) {
            v.requiredText(options.keyName, "keyName");
            if (options.keyName.trim().length > 128) throw new TypeError("keyName must be at most 128 characters");
            query.set("key_name", options.keyName.trim());
          }
          return http.request<Credentials>(mode, "GET", `/api/agents/me/credentials/${v.segment(service, "service")}`,
            v.credentialsResponse, options, undefined, query);
        },
      },
    };
    if (mode === "consent") return {
      ...client,
      connection: {
        get: (requestOptions?: import("./types.js").RequestOptions) => http.request<Connection>("consent", "GET", "/api/consent/v1/me",
          (value: unknown) => {
            if (!value || typeof value !== "object") return false;
            const connection = value as Connection;
            return ["id", "agentId", "subject", "clientId"].every(key =>
              typeof connection[key as keyof Connection] === "string" && !!connection[key as keyof Connection]) &&
              (connection.expiresAt === null || v.timestamp(connection.expiresAt)) &&
              Array.isArray(connection.resources) && connection.resources.every(resource =>
                !!resource && typeof resource.service === "string" && !!resource.service &&
                typeof resource.keyName === "string" && !!resource.keyName) && connection.connected === true;
          }, requestOptions),
        disconnect: (requestOptions?: import("./types.js").RequestOptions) =>
          http.request<Ok>("consent", "POST", "/api/consent/v1/disconnect", v.okResponse, requestOptions, {}),
      },
    } as Operations<T>;
    return client as Operations<T>;
  }
  const client: AccountOperations = {
    account: { get: options => http.request<Account>("account", "GET", "/api/v1/me", v.accountResponse, options) },
    agents: {
      list: options => http.request<Agent[]>("account", "GET", "/api/v1/agents", v.agentsResponse, options),
      async create(input, options) {
        v.requiredText(input.name, "name");
        if (input.name.length > 100) throw new TypeError("name must be at most 100 characters");
        if (input.expiresAt !== undefined && input.expiresAt !== null &&
          (!v.timestamp(input.expiresAt) || !/T.*Z$/.test(input.expiresAt))) throw new TypeError("expiresAt must be a UTC ISO timestamp");
        return http.request<CreatedAgent>("account", "POST", "/api/v1/agents", v.createdAgentResponse, options,
          { name: input.name, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) });
      },
      delete: (id, options) => http.request<Ok>("account", "DELETE", `/api/v1/agents/${v.segment(id, "id")}`, v.okResponse, options),
    },
    services: { list: options => http.request<Service[]>("account", "GET", "/api/v1/services", v.servicesResponse, options) },
    access: {
      get: (id, options) => http.request<AccessPolicy[]>("account", "GET", `/api/v1/agents/${v.segment(id, "agentId")}/access`, v.accessResponse, options),
      async set(id, service, input, options) {
        if (typeof input.enabled !== "boolean" || !Array.isArray(input.methods) ||
          input.methods.length === 0 || !input.methods.every(v.validMethod)) throw new TypeError("enabled and explicit nonempty methods are required");
        return http.request<Ok>("account", "PUT",
          `/api/v1/agents/${v.segment(id, "agentId")}/access/${v.segment(service, "service")}`, v.okResponse, options,
          { enabled: input.enabled, methods: [...new Set(input.methods)] });
      },
    },
    auditEvents: {
      list: (filters = {}, options) => http.request<AuditPage>("account", "GET", "/api/v1/audit-events", v.auditResponse,
        options, undefined, auditQuery(filters)),
    },
  };
  return client as Operations<T>;
}

/**
 * Constructor returns only the operations for the explicit auth mode.
 * No token is stored on the public client object.
 */
export const Gazebo: {
  new <T extends AuthType>(options: GazeboOptions<T>): Operations<T>;
} = function Gazebo<T extends AuthType>(options: GazeboOptions<T>) {
  return createClient(options);
} as unknown as { new <T extends AuthType>(options: GazeboOptions<T>): Operations<T> };
