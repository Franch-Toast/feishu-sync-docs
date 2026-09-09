/** Semantic classification of Feishu API failures, used by the sync runtime
 *  to decide when a failure means "credentials need user attention". */
export type FeishuErrorKind = "auth" | "permission" | "rate_limit" | "not_found" | "network" | "other";

/** Feishu error codes that unambiguously indicate an invalid/expired token. */
const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991679]);

export class FeishuApiError extends Error {
  constructor(
    readonly kind: FeishuErrorKind,
    message: string,
    readonly code?: number,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
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
