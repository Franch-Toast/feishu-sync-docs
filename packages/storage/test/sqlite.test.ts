import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStateStore } from "../src/index.js";

test("persists roots, snapshots and conflicts", async () => {
  const store = new SqliteStateStore();
  const root = await store.createRoot({ localPath: "/tmp/docs", remoteToken: "folder", remoteType: "folder", enabled: true, pollIntervalMs: 5000 });
  assert.equal((await store.listRoots()).length, 1);
  await store.upsertEntry({ id: "entry", rootId: root.id, relativePath: "a.md", kind: "document", status: "conflict", updatedAt: new Date().toISOString() });
  await store.saveSnapshot({ entryId: "entry", baseContent: "base", localContent: "local", remoteContent: "remote", baseHash: "b", localHash: "l", remoteHash: "r", createdAt: new Date().toISOString() });
  const conflict = await store.createConflict({ entryId: "entry", baseContent: "base", localContent: "local", remoteContent: "remote" });
  assert.equal((await store.listConflicts("open"))[0]?.id, conflict.id);
  const updated = await store.updateConflict(conflict.id, { remoteContent: "remote-latest", remoteRevision: 7, remoteContentHash: "hash" });
  assert.equal(updated.remoteContent, "remote-latest");
  assert.equal(updated.remoteRevision, 7);
  assert.equal(updated.remoteContentHash, "hash");
  const resolved = await store.resolveConflict(conflict.id, "merged", "merged");
  assert.equal(resolved.status, "resolved");
  const operation = await store.addOperation({ entryId: "entry", direction: "push", operation: "test" });
  await store.updateOperation(operation.id, { status: "succeeded", completedAt: new Date().toISOString() });
  assert.equal((await store.listOperations())[0]?.status, "succeeded");
  await store.saveAssetReferences(root.id, "images/a.png", ["entry"]);
  assert.deepEqual(await store.listAssetReferences(root.id, "images/a.png"), ["entry"]);
  await store.saveAssetBindings("entry", [{ documentEntryId: "entry", assetEntryId: "asset", token: "asset-token", contentHash: "hash" }]);
  assert.equal((await store.getAssetBindings("entry"))[0]?.token, "asset-token");
  store.close();
});

test("persists key/value settings and finds entries by remote token", async () => {
  const store = new SqliteStateStore();
  assert.equal(await store.getSetting("feishu.mode"), undefined);
  await store.setSetting("feishu.mode", "user");
  await store.setSetting("feishu.accessToken", "tok-123");
  await store.setSetting("feishu.mode", "tenant");
  assert.equal(await store.getSetting("feishu.mode"), "tenant");
  assert.deepEqual(await store.getSettings(), { "feishu.mode": "tenant", "feishu.accessToken": "tok-123" });

  const root = await store.createRoot({ localPath: "/tmp/docs", remoteToken: "folder", remoteType: "folder", enabled: false, pollIntervalMs: 5000 });
  await store.upsertEntry({ id: "entry-remote", rootId: root.id, relativePath: "b.md", kind: "document", status: "clean", remoteToken: "doc-token-9", updatedAt: new Date().toISOString() });
  const found = await store.findEntryByRemoteToken("doc-token-9");
  assert.equal(found?.id, "entry-remote");
  assert.equal(await store.findEntryByRemoteToken("missing-token"), undefined);
  store.close();
});

test("pruneHistory keeps recent operations and drops expired conflicts and orphan snapshots", async () => {
  const store = new SqliteStateStore();
  const root = await store.createRoot({ localPath: "/tmp/prune", remoteToken: "folder", remoteType: "folder", enabled: false, pollIntervalMs: 5000 });
  await store.upsertEntry({ id: "entry-1", rootId: root.id, relativePath: "a.md", kind: "document", status: "clean", updatedAt: new Date().toISOString() });
  await store.saveSnapshot({ entryId: "entry-1", baseContent: "base", localContent: "local", remoteContent: "remote", baseHash: "b", localHash: "l", remoteHash: "r", createdAt: new Date().toISOString() });
  // Orphan snapshot: its entry no longer exists, so retention must reclaim it.
  await store.saveSnapshot({ entryId: "ghost", baseContent: "base", localContent: "local", remoteContent: "remote", baseHash: "b", localHash: "l", remoteHash: "r", createdAt: new Date().toISOString() });

  // Five operations with deterministic created_at ordering (oldest first).
  const raw = store as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } };
  for (let index = 0; index < 5; index += 1) {
    const operation = await store.addOperation({ entryId: "entry-1", direction: "push", operation: "op" });
    raw.db.prepare("UPDATE operations SET created_at=? WHERE id=?").run(new Date(Date.UTC(2026, 0, index + 1)).toISOString(), operation.id);
  }

  // A resolved conflict older than the retention window, plus an open conflict that must survive.
  const stale = await store.createConflict({ entryId: "entry-1", baseContent: "b", localContent: "l", remoteContent: "r" });
  await store.resolveConflict(stale.id, "merged", "m");
  raw.db.prepare("UPDATE conflicts SET resolved_at=? WHERE id=?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), stale.id);
  await store.createConflict({ entryId: "entry-1", baseContent: "b2", localContent: "l2", remoteContent: "r2" });

  const result = await store.pruneHistory({ keepOperations: 2, resolvedConflictDays: 30 });
  assert.deepEqual(result, { operations: 3, conflicts: 1, snapshots: 1 });
  assert.equal((await store.listOperations()).length, 2);
  assert.equal((await store.listConflicts("open")).length, 1);
  assert.equal((await store.listConflicts()).length, 1);
  assert.ok(await store.getSnapshot("entry-1"));
  assert.equal(await store.getSnapshot("ghost"), undefined);
  store.close();
});
