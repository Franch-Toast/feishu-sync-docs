import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { SqliteStateStore } from "@feishu-sync/storage";
import { FakeRemote } from "./helpers/fake-remote.js";

interface EntryView {
  id: string;
  status: string;
  remoteToken?: string;
}

test("serves health and root APIs without Feishu credentials", async () => {
  const app = buildApp({ store: new SqliteStateStore(), remote: new FakeRemote() });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  const events = await app.inject({ method: "GET", url: "/api/events" });
  assert.equal(events.statusCode, 426);
  assert.equal(events.json().error, "WebSocket upgrade required");
  await app.close();
});

test("validates root CRUD requests", async () => {
  const app = buildApp({ store: new SqliteStateStore(), remote: new FakeRemote() });
  const missing = await app.inject({ method: "POST", url: "/api/roots", payload: { remoteToken: "root-token" } });
  assert.equal(missing.statusCode, 400);
  const badPath = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: "/nonexistent-directory-xyz", remoteToken: "root-token" } });
  assert.equal(badPath.statusCode, 400);
  const badPoll = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: "/tmp", remoteToken: "root-token", pollIntervalMs: 10 } });
  assert.equal(badPoll.statusCode, 400);

  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-api-"));
  try {
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    assert.ok(rootId);
    assert.equal((await app.inject({ method: "GET", url: "/api/roots" })).json().length, 1);
    const removed = await app.inject({ method: "DELETE", url: `/api/roots/${rootId}` });
    assert.equal(removed.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: "/api/roots" })).json().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("syncs through the API and surfaces conflicts for resolution", async () => {
  const store = new SqliteStateStore();
  const remote = new FakeRemote();
  const app = buildApp({ store, remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-e2e-"));
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;

    // Creating a root auto-starts its watcher; run an explicit sync to get a deterministic state.
    const firstSync = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(firstSync.statusCode, 200);
    const entries = firstSync.json().entries as Array<{ id: string; status: string; remoteToken?: string }>;
    assert.equal(entries[0]?.status, "clean");
    const token = entries[0]!.remoteToken!;
    assert.ok(token);

    // Both sides change -> an open conflict is recorded.
    writeFileSync(join(directory, "notes.md"), "local edit\n", "utf8");
    remote.edit(token, "remote edit\n");
    const conflicted = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal((conflicted.json().entries as EntryView[])[0]?.status, "conflict");

    const openConflicts = (await app.inject({ method: "GET", url: "/api/conflicts" })).json() as Array<{ id: string; relativePath?: string }>;
    assert.equal(openConflicts.length, 1);
    assert.equal(openConflicts[0]!.relativePath, "notes.md");
    const conflictId = openConflicts[0]!.id;

    // Invalid resolution payloads are rejected.
    const invalid = await app.inject({ method: "POST", url: `/api/conflicts/${conflictId}/resolve`, payload: { resolution: "bogus" } });
    assert.equal(invalid.statusCode, 400);
    const missingMerge = await app.inject({ method: "POST", url: `/api/conflicts/${conflictId}/resolve`, payload: { resolution: "merged" } });
    assert.equal(missingMerge.statusCode, 400);

    // Merged resolution writes both sides and clears the conflict.
    const merged = await app.inject({ method: "POST", url: `/api/conflicts/${conflictId}/resolve`, payload: { resolution: "merged", mergedContent: "local edit\nremote edit\n" } });
    assert.equal(merged.statusCode, 200);
    assert.equal(merged.json().status, "resolved");
    assert.equal(readFileSync(join(directory, "notes.md"), "utf8"), "local edit\nremote edit\n");
    assert.equal(remote.documents.get(token)?.content, "local edit\nremote edit\n");
    assert.equal((await app.inject({ method: "GET", url: "/api/conflicts" })).json().length, 0);

    // Abort keeps the disagreement and re-arms the entry for a fresh conflict.
    writeFileSync(join(directory, "notes.md"), "local second\n", "utf8");
    remote.edit(token, "remote second\n");
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const second = (await app.inject({ method: "GET", url: "/api/conflicts" })).json() as Array<{ id: string }>;
    assert.equal(second.length, 1);
    const aborted = await app.inject({ method: "POST", url: `/api/conflicts/${second[0]!.id}/resolve`, payload: { resolution: "abort" } });
    assert.equal(aborted.statusCode, 200);
    assert.equal(aborted.json().status, "aborted");
    const reopened = (await app.inject({ method: "GET", url: "/api/conflicts" })).json() as Array<{ id: string }>;
    assert.equal(reopened.length, 1);
    assert.notEqual(reopened[0]!.id, second[0]!.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("prunes operation history through the maintenance endpoint", async () => {
  const store = new SqliteStateStore();
  const app = buildApp({ store, remote: new FakeRemote() });
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.addOperation({ entryId: "entry", direction: "push", operation: "test" });
    }
    const pruned = await app.inject({ method: "POST", url: "/api/maintenance/prune", payload: { keepOperations: 2 } });
    assert.equal(pruned.statusCode, 200);
    assert.deepEqual(pruned.json(), { operations: 3, conflicts: 0, snapshots: 0 });
    assert.equal((await store.listOperations()).length, 2);
  } finally {
    await app.close();
  }
});
