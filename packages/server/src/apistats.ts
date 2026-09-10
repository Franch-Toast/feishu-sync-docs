import type { RemoteProvider } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";

/** Per-method counters for the lightweight "API 调用统计" panel (B6.2). */
export interface ApiMethodStats {
  calls: number;
  failures: number;
  /** Calls rejected with HTTP 429; the runtime backs off by Retry-After. */
  rateLimited: number;
  totalDurationMs: number;
}

export interface ApiStatsSnapshot {
  /** Provider being counted, so the panel can label the numbers. */
  provider: string;
  startedAt: string;
  calls: number;
  failures: number;
  rateLimited: number;
  totalDurationMs: number;
  byMethod: Record<string, ApiMethodStats>;
}

function emptyMethod(): ApiMethodStats {
  return { calls: 0, failures: 0, rateLimited: 0, totalDurationMs: 0 };
}

/**
 * In-memory tally of every remote API call the runtime makes.
 *
 * Deliberately process-local and lossy: it answers "is Feishu throttling us
 * right now?" without adding another persisted table. Counters reset on restart.
 */
export class ApiCallStats {
  private readonly byMethod = new Map<string, ApiMethodStats>();
  private readonly startedAt = new Date().toISOString();

  record(method: string, outcome: { ok: boolean; durationMs: number; rateLimited?: boolean }): void {
    const current = this.byMethod.get(method) ?? emptyMethod();
    current.calls += 1;
    if (!outcome.ok) current.failures += 1;
    if (outcome.rateLimited) current.rateLimited += 1;
    current.totalDurationMs += Math.max(0, Math.round(outcome.durationMs));
    this.byMethod.set(method, current);
  }

  snapshot(provider: string): ApiStatsSnapshot {
    const byMethod: Record<string, ApiMethodStats> = {};
    let calls = 0;
    let failures = 0;
    let rateLimited = 0;
    let totalDurationMs = 0;
    for (const [method, stats] of [...this.byMethod.entries()].sort((left, right) => right[1].calls - left[1].calls)) {
      byMethod[method] = { ...stats };
      calls += stats.calls;
      failures += stats.failures;
      rateLimited += stats.rateLimited;
      totalDurationMs += stats.totalDurationMs;
    }
    return { provider, startedAt: this.startedAt, calls, failures, rateLimited, totalDurationMs, byMethod };
  }
}

/**
 * Wrap a provider so every remote call is tallied.
 *
 * `name` / `capabilities` stay live getters: the credential-backed registry
 * resolves them lazily, so copying the values would freeze a stale view.
 */
export function instrumentRemote(remote: RemoteProvider, stats: ApiCallStats): RemoteProvider {
  const wrap = <Args extends unknown[], Result>(method: string, fn: ((...args: Args) => Promise<Result>) | undefined) => {
    if (!fn) return undefined;
    const bound = fn.bind(remote);
    return async (...args: Args): Promise<Result> => {
      const started = Date.now();
      try {
        const result = await bound(...args);
        stats.record(method, { ok: true, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        const rateLimited = error instanceof FeishuApiError && error.httpStatus === 429;
        stats.record(method, { ok: false, durationMs: Date.now() - started, rateLimited });
        throw error;
      }
    };
  };

  const instrumented: RemoteProvider = {
    get name() { return remote.name; },
    get capabilities() { return remote.capabilities; },
    listTree: wrap("listTree", remote.listTree)!,
    getDocument: wrap("getDocument", remote.getDocument)!,
    createFolder: wrap("createFolder", remote.createFolder)!,
    createDocument: wrap("createDocument", remote.createDocument)!,
    applyPatch: wrap("applyPatch", remote.applyPatch)!,
    uploadAsset: wrap("uploadAsset", remote.uploadAsset)!,
    downloadAsset: wrap("downloadAsset", remote.downloadAsset)!,
    softDelete: wrap("softDelete", remote.softDelete)!
  };
  // Optional capability: only expose it when the underlying provider has it,
  // otherwise callers' `if (remote.uploadInlineAsset)` feature check would lie.
  const uploadInlineAsset = wrap("uploadInlineAsset", remote.uploadInlineAsset);
  if (uploadInlineAsset) instrumented.uploadInlineAsset = uploadInlineAsset;
  return instrumented;
}
