export type GazeboErrorCode = "http" | "network" | "timeout" | "cancelled" | "invalid_response" | "auth_mode" | "reconnect_required";

/**
 * Safe generic message; server-provided details are explicit and non-enumerable.
 * Inspect details intentionally, not by logging the whole error.
 */
export class GazeboError extends Error {
  readonly code: GazeboErrorCode;
  readonly status?: number;
  readonly retryAfter?: string;
  declare readonly details?: unknown;

  constructor(code: GazeboErrorCode, options: { status?: number; retryAfter?: string; details?: unknown } = {}) {
    super(options.status === undefined ? `Gazebo request failed (${code})` : `Gazebo request failed (HTTP ${options.status})`);
    this.name = "GazeboError";
    this.code = code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    Object.defineProperty(this, "details", { value: options.details, enumerable: false });
  }
}
