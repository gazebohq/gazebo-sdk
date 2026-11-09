import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type { ServiceCredential } from "@gazebohq/sdk";
import { UsageError } from "./arguments.js";

const MAX_BYTES = 65_536;

export async function readCredentialInput(path: string, signal?: AbortSignal): Promise<string> {
  if (path === "-" && process.stdin.isTTY) throw new UsageError("Pipe credential JSON to stdin; interactive input is not supported.");
  const stream: Readable = path === "-" ? process.stdin : createReadStream(path);
  const abort = () => stream.destroy(new Error("Input cancelled"));
  if (signal?.aborted) { stream.destroy(); throw new UsageError("Credential input cancelled."); }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BYTES) throw new UsageError("Credential input exceeds 64 KiB.");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    throw new UsageError("Unable to read credential input; check input size, file access or cancellation.");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (path !== "-") stream.destroy();
  }
}

export function parseCredentialInput(input: string): ServiceCredential[] {
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new UsageError("Credential input exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new UsageError("Credential input must be valid JSON."); }
  if (!Array.isArray(value) || !value.length) throw new UsageError("Credential input must be a nonempty array.");
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some(key => !["keyName", "value"].includes(key)) ||
        typeof item.keyName !== "string" || !item.keyName.trim() || item.keyName !== item.keyName.trim() ||
        names.has(item.keyName) || typeof item.value !== "string" || !item.value.trim()) {
      throw new UsageError("Invalid or duplicate credential fields.");
    }
    names.add(item.keyName);
    return { keyName: item.keyName, value: item.value };
  });
}
