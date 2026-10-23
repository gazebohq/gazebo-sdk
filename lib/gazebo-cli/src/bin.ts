#!/usr/bin/env node
import { runCli } from "./cli.js";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
// A closed output pipe should not dump a stack or secret response.
process.stdout.on("error", () => { controller.abort(); process.exitCode = 1; });
process.stderr.on("error", () => { controller.abort(); process.exitCode = 1; });
try {
  const exit = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: value => { process.stdout.write(value); },
    stderr: value => { process.stderr.write(value); },
    signal: controller.signal,
  });
  process.exitCode = process.exitCode || exit;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
