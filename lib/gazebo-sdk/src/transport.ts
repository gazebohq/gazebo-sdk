import { GazeboError } from "./errors.js";
import type { GazeboOptions, AuthType, RequestOptions } from "./types.js";
import { parseResponse, requiredText, type Validator } from "./validation.js";

/** Secrets live in private fields and are not enumerable/serializable. */
export class Transport {
  #endpoint: URL;
  #token?: string;
  #tokenProvider?: () => Promise<string>;
  #mode: AuthType;
  #timeoutMs: number;
  #fetch: typeof globalThis.fetch;

  constructor(options: GazeboOptions) {
    const endpoint = new URL(options.endpoint);
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new TypeError("endpoint must be an HTTP(S) URL without credentials, query, or fragment");
    }
    if (!["account", "agent", "consent"].includes(options.auth?.type)) throw new TypeError("auth.type must be account, agent or consent");
    if (options.auth.type === "consent" && options.auth.tokenProvider !== undefined) {
      if (typeof options.auth.tokenProvider !== "function" || options.auth.token !== undefined) throw new TypeError("Provide one token source");
      this.#tokenProvider = options.auth.tokenProvider;
    } else {
      requiredText(options.auth.token, "auth.token");
      if (/\s/.test(options.auth.token!)) throw new TypeError("auth.token must not contain whitespace");
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive finite number");
    this.#endpoint = endpoint;
    this.#token = options.auth.token;
    this.#mode = options.auth.type;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(mode: AuthType, method: string, path: string, validate: Validator,
    options: RequestOptions = {}, body?: unknown, query?: URLSearchParams): Promise<T> {
    if (this.#mode !== mode) throw new GazeboError("auth_mode");
    if (options.signal?.aborted) throw new GazeboError("cancelled");
    const url = new URL(this.#endpoint);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    if (query) url.search = query.toString();
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      const token = this.#tokenProvider ? await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new GazeboError(timedOut ? "timeout" : "cancelled"));
        if (controller.signal.aborted) { abort(); return; }
        controller.signal.addEventListener("abort", abort, { once: true });
        this.#tokenProvider!().then(resolve, reject)
          .finally(() => controller.signal.removeEventListener("abort", abort));
      }) : this.#token!;
      if (controller.signal.aborted) throw new GazeboError(timedOut ? "timeout" : "cancelled");
      if (!token || /\s/.test(token)) throw new GazeboError("reconnect_required");
      const response = await this.#fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        // Never forward tokens to another location or fall back to cookie auth.
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      let data: unknown;
      try { data = JSON.parse(await response.text()); }
      catch {
        if (controller.signal.aborted) throw new GazeboError(timedOut ? "timeout" : "cancelled");
        if (response.ok) throw new GazeboError("invalid_response");
      }
      if (!response.ok) throw new GazeboError("http", {
        status: response.status, details: data, retryAfter: response.headers.get("retry-after") ?? undefined,
      });
      return parseResponse<T>(data, validate);
    } catch (error) {
      if (error instanceof GazeboError) throw error;
      // Do not retain fetch errors: URLs/headers/body might include secrets.
      throw new GazeboError(timedOut ? "timeout" : options.signal?.aborted ? "cancelled" : "network");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
