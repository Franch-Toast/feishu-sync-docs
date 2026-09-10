/** Semantic classification of Feishu API failures, used by the sync runtime
 *  to decide when a failure means "credentials need user attention". */
export type FeishuErrorKind = "auth" | "permission" | "rate_limit" | "not_found" | "network" | "other";

import type { EntryStatus, ErrorCategory } from "@feishu-sync/core";

/** Feishu error codes that unambiguously indicate an invalid/expired token. */
const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991679]);

export class FeishuApiError extends Error {
  constructor(
    readonly kind: FeishuErrorKind,
    message: string,
    readonly code?: number,
    readonly httpStatus?: number,
    /** Parsed from a 429 Retry-After header; the runtime uses it as the
     *  auto-retry delay floor so backoff respects the server's window (B6.2). */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

/** Parse an HTTP Retry-After header into milliseconds. Accepts both the
 *  delta-seconds form ("120") and the HTTP-date form; returns undefined when
 *  the value is absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Error raised by the OAuth v3 token endpoint when refreshing a user access
 *  token fails. `permanent` marks codes where retrying can never succeed and
 *  the user must re-authorize (expired/revoked/consumed refresh token, bad
 *  client credentials, app-side refresh switch disabled). */
export class FeishuOAuthError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly permanent = false
  ) {
    super(message);
    this.name = "FeishuOAuthError";
  }
}

/** OAuth v3 error codes that make refreshing impossible until re-authorization:
 *  20002 invalid client secret, 20026 invalid refresh token, 20037 refresh
 *  token expired (>7d unused or 365d since consent), 20064 revoked,
 *  20073 already consumed, 20074 app refresh switch disabled. */
export const PERMANENT_REFRESH_OAUTH_CODES = new Set([20002, 20026, 20037, 20064, 20073, 20074]);

/** Best-effort classification from a Feishu envelope code and/or HTTP status. */
export function classifyFeishuFailure(code?: number, httpStatus?: number): FeishuErrorKind {
  if (code !== undefined && AUTH_CODES.has(code)) return "auth";
  if (httpStatus === 401) return "auth";
  if (httpStatus === 403) return "permission";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 429) return "rate_limit";
  return "other";
}

/** Wrap a low-level fetch failure (DNS, refused, aborted) as a network error. */
export function networkError(cause: unknown): FeishuApiError {
  const message = cause instanceof Error ? `Network error talking to Feishu: ${cause.message}` : `Network error talking to Feishu: ${String(cause)}`;
  return new FeishuApiError("network", message);
}

/** Classify a free-form message coming from the lark-cli adapter. */
export function classifyCliMessage(message: string): FeishuErrorKind {
  if (/token|auth|认证|登录|login|unauthorized|401/i.test(message)) return "auth";
  if (/permission|forbidden|权限|403|access denied/i.test(message)) return "permission";
  if (/rate.?limit|too many|429|限流/i.test(message)) return "rate_limit";
  return "other";
}

/** Map a thrown error (plus the entry's status) onto the task-center error
 *  category. A conflict entry status wins over the transport classification so
 *  the UI routes the user to the issue workbench; Feishu API errors carry a
 *  semantic kind, and anything else is best-effort matched from the message.
 *  "other" collapses to "unknown". */
export function categorizeError(error: unknown, entryStatus?: EntryStatus): ErrorCategory {
  if (entryStatus === "conflict") return "conflict";
  if (error instanceof FeishuApiError) {
    switch (error.kind) {
      case "auth": return "auth";
      case "permission": return "permission";
      case "rate_limit": return "rate_limit";
      case "not_found": return "not_found";
      case "network": return "network";
      default: return "unknown";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP\s+404|not[ -]?found|notexisted|deleted/i.test(message)) return "not_found";
  if (/HTTP\s+403|forbidden|permission|access denied|权限/i.test(message)) return "permission";
  if (/HTTP\s+401|unauthorized|invalid[^\n]*token|token[^\n]*invalid|认证|登录/i.test(message)) return "auth";
  if (/rate.?limit|too many|HTTP\s+429|限流/i.test(message)) return "rate_limit";
  if (/network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|aborted|fetch failed/i.test(message)) return "network";
  return "unknown";
}

/** Categories the runtime auto-retries with exponential backoff. Auth and
 *  permission failures need user action, conflicts need a human decision, and
 *  not_found is terminal for this round, so none of them are retried. */
export const RETRIABLE_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set(["network", "rate_limit", "unknown"]);
