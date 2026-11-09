import { readFile } from "node:fs/promises";
import { Gazebo, GazeboError } from "@gazebohq/sdk";
import { parse, help, UsageError, text, integer, method, policy, auditFilters, type Command } from "./arguments.js";
import { readCredentialInput, parseCredentialInput } from "./credential-input.js";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout(value: string): void;
  stderr(value: string): void;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  readTokenFile?: (path: string) => Promise<string>;
  readCredentialInput?: (path: string, signal?: AbortSignal) => Promise<string>;
}

function preflight(command: Command): void {
  const { name, flags } = command;
  integer(flags["timeout-ms"], "--timeout-ms", 1, 2_147_483_647);
  if (name === "agents create") {
    text(flags.name, "--name");
    if (!flags.reveal) throw new UsageError("Agent creation requires --reveal to output the one-time token. Store stdout securely.");
  }
  if (name === "agents delete" && !flags.yes) throw new UsageError("Agent deletion requires --yes.");
  if (name === "credentials get") {
    if (!flags.reveal) throw new UsageError("Credential retrieval requires --reveal. This prints a sensitive credential to stdout.");
    if (flags.method) method(flags.method);
  }
  if (name === "access set") policy(flags);
  if (name === "audit list") auditFilters(flags);
  if (name.startsWith("services credentials ")) {
    if (name.endsWith("replace") || name.endsWith("delete")) {
      if (!flags.yes) throw new UsageError("Whole-service credential replacement/deletion requires --yes.");
    }
    if (!name.endsWith("delete")) text(flags["input-file"], "--input-file");
    if (flags["token-file"] === "-") throw new UsageError("--token-file must name a file, not stdin.");
    if (flags["input-file"] && flags["input-file"] !== "-" && flags["input-file"] === flags["token-file"]) {
      throw new UsageError("Token and credential input must use separate files.");
    }
  }
}

async function execute(command: Command, context: CliContext): Promise<unknown> {
  const { name, flags, args } = command;
  preflight(command);
  const credentialInput = name === "services credentials replace" || name === "services credentials test"
    ? parseCredentialInput(await (context.readCredentialInput ?? readCredentialInput)(flags["input-file"]!, context.signal))
    : undefined;
  const mode = name === "credentials get" ? "agent" : "account";
  let token: string | undefined;
  if (flags["token-file"] !== undefined) {
    text(flags["token-file"], "--token-file");
    try {
      token = (await (context.readTokenFile ?? (path => readFile(path, "utf8")))(flags["token-file"])).trim();
    } catch { throw new UsageError("Unable to read --token-file."); }
  } else {
    token = mode === "agent" ? context.env.GAZEBO_AGENT_TOKEN : context.env.GAZEBO_ACCOUNT_TOKEN ?? context.env.GAZEBO_API_TOKEN;
  }
  if (!token?.trim()) throw new UsageError(mode === "agent" ? "Set GAZEBO_AGENT_TOKEN or use --token-file." : "Set GAZEBO_ACCOUNT_TOKEN or use --token-file.");
  const common = {
    endpoint: flags.endpoint ?? context.env.GAZEBO_ENDPOINT ?? "https://app.gazebohq.com",
    timeoutMs: integer(flags["timeout-ms"], "--timeout-ms", 1, 2_147_483_647),
    fetch: context.fetch,
  };
  const options = { signal: context.signal };
  if (mode === "agent") {
    const client = new Gazebo({ ...common, auth: { type: "agent", token } });
    return client.credentials.get(args[0], {
      ...options, method: flags.method === undefined ? undefined : method(flags.method), keyName: flags["key-name"],
    });
  }
  const client = new Gazebo({ ...common, auth: { type: "account", token } });
  switch (name) {
    case "account get": return client.account.get(options);
    case "agents list": return client.agents.list(options);
    case "agents create": return client.agents.create({ name: flags.name!, expiresAt: flags["expires-at"] }, options);
    case "agents delete": return client.agents.delete(args[0], options);
    case "services list": return client.services.list(options);
    case "services credentials replace": return client.services.replaceCredentials(args[0], credentialInput!, options);
    case "services credentials test": return client.services.testCredentials(args[0], credentialInput!, options);
    case "services credentials delete": return client.services.deleteCredentials(args[0], options);
    case "access get": return client.access.get(args[0], options);
    case "access set": return client.access.set(args[0], args[1], policy(flags), options);
    case "audit list": return client.auditEvents.list(auditFilters(flags), options);
    default: throw new UsageError("Unsupported command.");
  }
}

/** Only the SDK performs HTTP requests. This function is testable without process globals. */
export async function runCli(argv: string[], context: CliContext): Promise<number> {
  let json = argv.includes("--json");
  try {
    const command = parse(argv);
    json = command.flags.json === true;
    if (command.name === "help") { context.stdout(help); return 0; }
    const result = await execute(command, context);
    if (command.name === "services credentials test") {
      const test = result as import("@gazebohq/sdk").CredentialTestResult;
      if (!test.ok || !test.verified) {
        const code = test.ok ? "not_verified" : "verification_failed";
        const message = test.ok ? "Remote verification is not available for this service." : "Credential verification failed; check the credential or service availability.";
        context.stderr(json ? `${JSON.stringify({ error: { code, message } })}\n` : `${message}\n`);
        return 1;
      }
    }
    context.stdout(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    let code = "failure";
    let message = "Gazebo CLI failed.";
    let exit = 1;
    let status: number | undefined;
    let retryAfter: string | undefined;
    if (context.signal?.aborted) { code = "cancelled"; message = "Gazebo CLI cancelled."; exit = 130; }
    else if (error instanceof UsageError) { code = "usage"; message = error.message; exit = 2; }
    else if (error instanceof GazeboError) {
      code = error.code; message = error.message; status = error.status; retryAfter = error.retryAfter;
      if (error.code === "cancelled") exit = 130;
    } else if (error instanceof TypeError) {
      code = "invalid_input"; message = "Invalid request configuration or arguments. Check endpoint and option formats.";
    }
    // Never print a stack, raw server details, token, or underlying fetch error.
    context.stderr(json
      ? `${JSON.stringify({ error: { code, message, status, retryAfter } })}\n`
      : `${message}\n`);
    return exit;
  }
}
