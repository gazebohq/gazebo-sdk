import { Gazebo } from "@gazebohq/sdk";
import { requiredEnv, endpoint, fail, QuickstartInputError } from "./support.mjs";

try {
  if (process.argv.slice(2).join(" ") !== "--retrieve") {
    throw new QuickstartInputError("Pass --retrieve to explicitly request a credential; this creates an audit event.");
  }
  const agent = new Gazebo({
    endpoint: endpoint(),
    auth: { type: "agent", token: requiredEnv("GAZEBO_AGENT_TOKEN") },
  });
  const result = await agent.credentials.get(requiredEnv("GAZEBO_SERVICE"), { method: "GET" });
  // result.credentials is the sensitive value to use in your server-side code.
  // Do not print it. This example verifies retrieval without calling a provider.
  process.stdout.write(`${JSON.stringify({
    service: result.service,
    keyNames: Object.keys(result.credentials),
    credentialRetrieved: true,
  })}\n`);
} catch (error) { fail(error); }
