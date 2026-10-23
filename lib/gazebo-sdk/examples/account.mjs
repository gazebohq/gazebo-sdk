import { Gazebo } from "@gazebohq/sdk";
import { requiredEnv, endpoint, fail } from "./support.mjs";

// Read-only account example. Does not create/revoke agents or change policies.
try {
  const account = new Gazebo({
    endpoint: endpoint(),
    auth: { type: "account", token: requiredEnv("GAZEBO_ACCOUNT_TOKEN") },
  });
  const identity = await account.account.get();
  const services = await account.services.list();
  const agents = await account.agents.list();
  const audit = await account.auditEvents.list({ limit: 5 });
  // A useful success check without printing email, tokens, or audit contents.
  process.stdout.write(`${JSON.stringify({
    accountId: identity.id,
    connectedServices: services.map(service => service.service),
    activeAgentCount: agents.length,
    auditEventCount: audit.events.length,
    auditHasMore: audit.hasMore,
  })}\n`);
} catch (error) { fail(error); }
