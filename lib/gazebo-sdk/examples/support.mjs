import { GazeboError } from "@gazebohq/sdk";

export class QuickstartInputError extends Error {}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new QuickstartInputError(`Set ${name} before running this example.`);
  return value;
}

export function endpoint() {
  return process.env.GAZEBO_ENDPOINT ?? "https://app.gazebohq.com";
}

export function fail(error) {
  const message = error instanceof QuickstartInputError
    ? error.message
    : error instanceof GazeboError
      ? error.message
      : "Quickstart failed. Check endpoint and environment configuration.";
  // No server payloads, credential values, token values, or stack traces.
  process.stderr.write(`${JSON.stringify({
    error: {
      message,
      ...(error instanceof GazeboError ? { code: error.code, status: error.status } : {}),
    },
  })}\n`);
  process.exitCode = 1;
}
