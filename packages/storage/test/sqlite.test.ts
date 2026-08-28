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
