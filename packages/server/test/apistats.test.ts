import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapabilities } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import { ApiCallStats, instrumentRemote } from "../src/apistats.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/** A provider whose `name` mutates, to prove the wrapper reads it live rather
 *  than copying it once (the credential registry swaps its delegate on refresh).
 *  Object.create keeps FakeRemote's prototype methods, which a spread would drop. */
function mutableNameProvider(start: string): { remote: FakeRemote; rename(next: string): void } {
  const remote = new FakeRemote();
  const clone = Object.assign(Object.create(Object.getPrototypeOf(remote) as object), remote) as FakeRemote;
  let current = start;
  Object.defineProperty(clone, "name", { get: () => current, configurable: true });
  Object.defineProperty(clone, "capabilities", {
    value: { blockPatch: false, revisionGuard: false, assetUpload: false, remoteEvents: true } satisfies ProviderCapabilities,
    configurable: true
  });
  return { remote: clone, rename(next: string) { current = next; } };
}

test("ApiCallStats tallies per method, orders by calls and rolls up totals (B6.2)", () => {
  const stats = new ApiCallStats();
  assert.deepEqual(stats.snapshot("feishu"), {
    provider: "feishu",
    startedAt: stats.snapshot("feishu").startedAt,
    calls: 0,
    failures: 0,
    rateLimited: 0,
    totalDurationMs: 0,
    byMethod: {}
  });
  assert.ok(!Number.isNaN(Date.parse(stats.snapshot("feishu").startedAt)), "startedAt is an ISO timestamp");

  stats.record("listTree", { ok: true, durationMs: 12 });
  stats.record("listTree", { ok: true, durationMs: 8 });
  stats.record("applyPatch", { ok: false, durationMs: 30, rateLimited: true });

  const snapshot = stats.snapshot("feishu");
  assert.equal(snapshot.calls, 3);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.rateLimited, 1);
  assert.equal(snapshot.totalDurationMs, 50);
  // Busiest method first: the panel lists the hot path at the top.
  assert.deepEqual(Object.keys(snapshot.byMethod), ["listTree", "applyPatch"]);
  assert.deepEqual(snapshot.byMethod.listTree, { calls: 2, failures: 0, rateLimited: 0, totalDurationMs: 20 });
  assert.deepEqual(snapshot.byMethod.applyPatch, { calls: 1, failures: 1, rateLimited: 1, totalDurationMs: 30 });

  // The snapshot is a copy: mutating it must not corrupt the tally.
  snapshot.byMethod.listTree!.calls = 99;
  assert.equal(stats.snapshot("feishu").byMethod.listTree!.calls, 2);
  // Negative/garbage durations are clamped rather than poisoning the total.
  stats.record("listTree", { ok: true, durationMs: -5 });
  assert.equal(stats.snapshot("feishu").byMethod.listTree!.totalDurationMs, 20);
});

test("instrumentRemote counts successes, failures and 429s without changing behaviour", async () => {
  const remote = new FakeRemote();
  const stats = new ApiCallStats();
  const counted = instrumentRemote(remote, stats);

  const tree = await counted.listTree({ id: "r", localPath: "/tmp", remoteToken: "root-token", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 });
  assert.equal(tree.root.token, "root-token");
  assert.equal(remote.listTreeCalls, 1, "the wrapper must delegate, not short-circuit");

  const created = await counted.createDocument("root-token", "notes.md", "# Notes\n");
  assert.equal(created.name, "notes.md");
  await counted.applyPatch(created.token, { operations: [{ type: "overwrite", content: "# Notes v2\n" }] });

  // A plain failure is counted as a failure but never as a rate limit.
  remote.getDocumentError = new Error("boom");
  await assert.rejects(counted.getDocument("nope"), /boom/);
  remote.getDocumentError = undefined;

  // A 429 FeishuApiError is additionally flagged so the badge can light up.
  remote.failWritesRateLimit(1, 1_500);
  await assert.rejects(
    counted.applyPatch(created.token, { operations: [{ type: "overwrite", content: "# Notes v3\n" }] }),
    (error: unknown) => error instanceof FeishuApiError && error.httpStatus === 429
  );

  const snapshot = stats.snapshot("fake");
  assert.equal(snapshot.provider, "fake");
  assert.deepEqual(snapshot.byMethod.listTree, { calls: 1, failures: 0, rateLimited: 0, totalDurationMs: snapshot.byMethod.listTree!.totalDurationMs });
  assert.equal(snapshot.byMethod.createDocument!.calls, 1);
  assert.equal(snapshot.byMethod.getDocument!.failures, 1);
  assert.equal(snapshot.byMethod.getDocument!.rateLimited, 0);
  assert.equal(snapshot.byMethod.applyPatch!.calls, 2);
  assert.equal(snapshot.byMethod.applyPatch!.failures, 1);
  assert.equal(snapshot.byMethod.applyPatch!.rateLimited, 1);
  assert.equal(snapshot.failures, 2);
  assert.equal(snapshot.rateLimited, 1);
  assert.ok(snapshot.totalDurationMs >= 0);
});

test("instrumentRemote keeps name/capabilities live and omits absent optional methods", async () => {
  const { remote, rename } = mutableNameProvider("feishu");
  const stats = new ApiCallStats();
  const counted = instrumentRemote(remote, stats);

  assert.equal(counted.name, "feishu");
  rename("feishu-wiki");
  assert.equal(counted.name, "feishu-wiki", "name is read through on every access");
  assert.equal(counted.capabilities.remoteEvents, true, "capabilities are read through");
  // Delegation still works through the live-accessor wrapper.
  assert.equal((await counted.listTree({ id: "r", localPath: "/tmp", remoteToken: "root-token", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 })).root.token, "root-token");

  // FakeRemote has no uploadInlineAsset: exposing one would make the
  // `if (remote.uploadInlineAsset)` feature check lie about provider support.
  assert.equal("uploadInlineAsset" in counted, false);
  assert.equal(counted.uploadInlineAsset, undefined);

  // ...but a provider that does have it keeps the capability, still counted.
  const withInline = new FakeRemote();
  let uploaded = "";
  withInline.uploadInlineAsset = async (rootToken: string, name: string) => {
    uploaded = `${rootToken}/${name}`;
    return { token: uploaded, name, type: "asset", parentToken: rootToken, mimeType: "image/png", size: 1 };
  };
  const countedInline = instrumentRemote(withInline, stats);
  assert.ok(typeof countedInline.uploadInlineAsset === "function");
  await countedInline.uploadInlineAsset!("root-token", "a.png", new Uint8Array([1]), "image/png");
  assert.equal(uploaded, "root-token/a.png");
  assert.equal(stats.snapshot("fake").byMethod.uploadInlineAsset!.calls, 1);
});
