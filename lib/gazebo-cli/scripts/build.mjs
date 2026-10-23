import { chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const directory = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: directory,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status === 0) await chmod(new URL("../dist/bin.js", import.meta.url), 0o755);
process.exitCode = result.status ?? 1;
