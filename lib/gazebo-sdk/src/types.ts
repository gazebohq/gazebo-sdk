/** HTTP wire timestamps remain strings, not JavaScript Date objects. */
export type Timestamp = string;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthType = "account" | "agent" | "consent";
export type Auth<T extends AuthType = AuthType> = T extends "consent"
  ? { type: T; token: string; tokenProvider?: never } | { type: T; tokenProvider: () => Promise<string>; token?: never }
  : { type: T; token: string };
export interface GazeboOptions<T extends AuthType = AuthType> {
  endpoint: string;
  auth: Auth<T>;
  /** Total request/body-read timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Optional fetch implementation for testing or other server runtimes. */
  fetch?: typeof globalThis.fetch;
}
export interface RequestOptions { signal?: AbortSignal }
export interface Account {
  id: string;
  email: string;
  createdAt: Timestamp;
  hasApiToken: boolean;
  agentsEnabled: boolean;
  agentsEnabledDefault: boolean;
}
export interface Agent {
  id: string;
  name: string;
  createdAt: Timestamp;
  lastActiveAt: Timestamp | null;
  revokedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  services: string[];
}
/** Token is returned only by create; store it securely and never log this object. */
export interface CreatedAgent {
  id: string;
  name: string;
  token: string;
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
}
export interface CreateAgentInput { name: string; expiresAt?: Timestamp | null }
export interface Service { service: string; connectedAt: Timestamp; keyType: "oauth" | "api_key" }
export interface AccessPolicy { service: string; enabled: boolean; methods: HttpMethod[] }
/** Explicit methods avoid the server's broad default on replacement updates. */
export interface SetAccessInput { enabled: boolean; methods: HttpMethod[] }
export interface Ok { ok: boolean }
export interface CredentialOptions extends RequestOptions { method?: HttpMethod; keyName?: string }
/** Contains a single sensitive credential. Do not log or persist indiscriminately. */
export interface Credentials { service: string; credentials: Record<string, string> }
export interface AuditEvent {
  id: string;
  agentId: string;
  agentName?: string | null;
  service: string;
  keyName: string;
  action: string;
  outcome: string;
  method?: string | null;
  createdAt: Timestamp;
}
export interface AuditFilters {
  limit?: number;
  cursor?: string;
  agentId?: string;
  service?: string;
  outcome?: "success" | "denied" | "not_found";
  from?: Timestamp;
  to?: Timestamp;
}
export interface AuditPage { events: AuditEvent[]; nextCursor: string | null; hasMore: boolean }
export interface AccountOperations {
  account: { get(options?: RequestOptions): Promise<Account> };
  agents: {
    list(options?: RequestOptions): Promise<Agent[]>;
    create(input: CreateAgentInput, options?: RequestOptions): Promise<CreatedAgent>;
    delete(id: string, options?: RequestOptions): Promise<Ok>;
  };
  services: { list(options?: RequestOptions): Promise<Service[]> };
  access: {
    get(agentId: string, options?: RequestOptions): Promise<AccessPolicy[]>;
    set(agentId: string, service: string, input: SetAccessInput, options?: RequestOptions): Promise<Ok>;
  };
  auditEvents: { list(filters?: AuditFilters, options?: RequestOptions): Promise<AuditPage> };
}
export interface AgentOperations {
  credentials: { get(service: string, options?: CredentialOptions): Promise<Credentials> };
}
export interface Connection {
  id: string; agentId: string; subject: string; clientId: string; connected: boolean;
  expiresAt: Timestamp | null; resources: { service: string; keyName: string }[];
}
export interface ConsentOperations {
  credentials: { get(service: string, options: CredentialOptions & { keyName: string }): Promise<Credentials> };
  connection: {
    get(options?: RequestOptions): Promise<Connection>;
    disconnect(options?: RequestOptions): Promise<Ok>;
  };
}
