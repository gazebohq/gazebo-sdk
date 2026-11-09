import { parseArgs } from "node:util";
import type { HttpMethod, AuditFilters } from "@gazebohq/sdk";

export class UsageError extends Error {}
const strings = [
  "endpoint", "token-file", "timeout-ms", "name", "expires-at", "enabled", "methods",
  "limit", "cursor", "agent-id", "service", "outcome", "from", "to", "method", "key-name", "input-file",
] as const;
const booleans = ["help", "json", "reveal", "yes"] as const;
type StringFlag = typeof strings[number];
type BooleanFlag = typeof booleans[number];
export type Flags = Partial<Record<StringFlag, string>> & Partial<Record<BooleanFlag, boolean>>;
export interface Command { name: string; args: string[]; flags: Flags }
const specific: Record<string, string[]> = {
  "account get": [],
  "agents list": [],
  "agents create": ["name", "expires-at", "reveal"],
  "agents delete": ["yes"],
  "services list": [],
  "services credentials replace": ["input-file", "yes"],
  "services credentials test": ["input-file"],
  "services credentials delete": ["yes"],
  "access get": [],
  "access set": ["enabled", "methods"],
  "audit list": ["limit", "cursor", "agent-id", "service", "outcome", "from", "to"],
  "credentials get": ["method", "key-name", "reveal"],
};
const arity: Record<string, number> = {
  "account get": 0, "agents list": 0, "agents create": 0, "agents delete": 1,
  "services list": 0, "access get": 1, "access set": 2, "audit list": 0, "credentials get": 1,
  "services credentials replace": 1, "services credentials test": 1, "services credentials delete": 1,
};
const global = ["help", "json", "endpoint", "token-file", "timeout-ms"];

export function parse(argv: string[]): Command {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true, tokens: true,
      options: {
        ...Object.fromEntries(strings.map(name => [name, { type: "string" as const }])),
        ...Object.fromEntries(booleans.map(name => [name, { type: "boolean" as const, ...(name === "help" ? { short: "h" } : {}) }])),
      },
    });
  } catch { throw new UsageError("Unknown option or missing option value. Run gazebo --help."); }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new UsageError("Duplicate options are not supported.");
    seen.add(token.name);
  }
  const flags = parsed.values as Flags;
  const parts = parsed.positionals;
  const depth = parts[0] === "services" && parts[1] === "credentials" ? 3 : 2;
  const name = parts.slice(0, depth).join(" ");
  const args = parts.slice(depth);
  if (flags.help || !name) return { name: "help", args: [], flags };
  if (!Object.hasOwn(specific, name)) throw new UsageError("Unknown command. Run gazebo --help.");
  if (args.length !== arity[name]) throw new UsageError(`Wrong number of arguments for ${name}. Run gazebo --help.`);
  for (const key of Object.keys(flags)) {
    if (!global.includes(key) && !specific[name].includes(key)) throw new UsageError(`Option --${key} is not supported for ${name}.`);
  }
  return { name, args, flags };
}

export function text(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new UsageError(`${field} is required.`);
  return value;
}
export function integer(value: string | undefined, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`${field} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}
export function method(value: string): HttpMethod {
  const normalized = value.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) throw new UsageError("Unsupported HTTP method.");
  return normalized as HttpMethod;
}
export function policy(flags: Flags) {
  if (!["true", "false"].includes(flags.enabled ?? "")) throw new UsageError("--enabled true or --enabled false is required.");
  const methods = text(flags.methods, "--methods").split(",").map(value => method(value.trim()));
  return { enabled: flags.enabled === "true", methods };
}
export function auditFilters(flags: Flags): AuditFilters {
  if (flags.outcome !== undefined && !["success", "denied", "not_found"].includes(flags.outcome)) throw new UsageError("Unsupported audit outcome.");
  return {
    limit: integer(flags.limit, "--limit", 1, 200), cursor: flags.cursor, agentId: flags["agent-id"],
    service: flags.service, outcome: flags.outcome as AuditFilters["outcome"], from: flags.from, to: flags.to,
  };
}

export const help = `Gazebo CLI

Usage: gazebo <command> [arguments] [options]

Account commands (account token):
  account get
  agents list
  agents create --name NAME --reveal [--expires-at UTC_ISO_TIMESTAMP]
  agents delete AGENT_ID --yes
  services list
  services credentials test SERVICE --input-file PATH|-
  services credentials replace SERVICE --input-file PATH|- --yes
  services credentials delete SERVICE --yes
  access get AGENT_ID
  access set AGENT_ID SERVICE --enabled true|false --methods GET,POST
  audit list [--limit 1..200] [--cursor CURSOR] [--agent-id ID]
             [--service SERVICE] [--outcome success|denied|not_found]
             [--from TIMESTAMP] [--to TIMESTAMP]

Agent command (agent token):
  credentials get SERVICE --reveal [--method GET] [--key-name NAME]

Global options:
  --endpoint URL       Target origin or path prefix; default https://app.gazebohq.com
  --token-file PATH    Read token from a file instead of the environment
  --timeout-ms N       Request timeout; default 10000 milliseconds
  --json               Compact JSON output and structured errors on stderr
  --help, -h           Show help without making a request

Environment:
  GAZEBO_ENDPOINT       Override the default target
  GAZEBO_ACCOUNT_TOKEN  Account commands (GAZEBO_API_TOKEN is a fallback)
  GAZEBO_AGENT_TOKEN    Credential retrieval; never falls back to an account token

Safety:
  --reveal is mandatory before creating an agent or retrieving credentials.
  It prints sensitive values to stdout. Use a private terminal or secure pipe.
  --yes is mandatory for agent deletion. Access updates require explicit methods.
  Service credential replacement/deletion also requires --yes and affects ALL keys
  for the service. Replacement is not a merge; provider keys are not revoked.
  --input-file reads a JSON array of {keyName,value}; - reads noninteractive stdin.
  No raw secret argument. Test exits 1 when verification fails or is unavailable.
  No token argument, saved login/config, cookie auth, retries, or auto-pagination.

Exit codes: 0 success/help; 1 request/configuration failure; 2 usage; 130 cancelled.
`;
