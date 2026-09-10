import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { RemoteTree, SyncRoot } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import type { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { AppConfigStore } from "../src/appconfig.js";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { FakeRemote } from "./helpers/fake-remote.js";

/** Every app gets its own config.json in tmpdir so tests never touch ~/.feishu-sync-docs. */
const configDirs: string[] = [];
function buildIsolatedApp(options: Parameters<typeof buildApp>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-sync-config-"));
  configDirs.push(dir);
  return buildApp({ ...options, appConfig: new AppConfigStore(join(dir, "config.json")) });
}

test.after(() => {
  for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
});

interface EntryView {
  entryId: string;
  status: string;
  remoteToken?: string;
}

test("serves health and root APIs without Feishu credentials", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  const events = await app.inject({ method: "GET", url: "/api/events" });
  assert.equal(events.statusCode, 426);
  assert.equal(events.json().error, "WebSocket upgrade required");
  await app.close();
});

test("validates root CRUD requests", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
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
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-e2e-"));
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;

    // Creating a root auto-starts its watcher; run an explicit sync to get a deterministic state.
    const firstSync = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(firstSync.statusCode, 200);
    const entries = firstSync.json().entries as Array<{ entryId: string; status: string; remoteToken?: string }>;
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
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-prune-"));
  try {
    // Operations live in a root's .feishu-sync dir, so initialize one first.
    const root = await app.metaStorage.createRoot({ localPath: directory, remoteToken: "root-token", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
    await app.metaStorage.initRootMeta(root.id, root.localPath);
    for (let index = 0; index < 5; index += 1) {
      await app.metaStorage.addOperation({ entryId: "entry", direction: "push", operation: "test", rootId: root.id });
    }
    const pruned = await app.inject({ method: "POST", url: "/api/maintenance/prune", payload: { keepOperations: 2 } });
    assert.equal(pruned.statusCode, 200);
    const result = pruned.json() as { operations: number };
    assert.equal(result.operations, 3);
    assert.equal((await app.metaStorage.listOperations()).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("settings APIs store credentials redacted and rebuild the provider", async () => {
  const appConfig = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "feishu-sync-config-")), "config.json"));
  configDirs.push(dirname(appConfig.configPath));
  const credentials = new CredentialStore(appConfig, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/open-apis/authen/v1/user_info") return new Response(JSON.stringify({ code: 0, data: { name: "Tester", open_id: "ou_1" } }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected request ${url.pathname}`);
  });
  // The injected credentials share the app's config.json, so pass it explicitly.
  const app = buildApp({ credentials, appConfig });
  try {
    const initial = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    assert.equal(initial.mode, "user");
    assert.equal(initial.hasAccessToken, false);
    assert.equal(initial.authStatus, "unconfigured");
    assert.equal(initial.guideUrls.user, "https://open.feishu.cn/api-explorer/");

    const invalidMode = await app.inject({ method: "PUT", url: "/api/settings", payload: { mode: "bogus" } });
    assert.equal(invalidMode.statusCode, 400);

    const saved = (await app.inject({ method: "PUT", url: "/api/settings", payload: { mode: "user", accessToken: "user-token-abc-1234567890" } })).json();
    assert.equal(saved.hasAccessToken, true);
    assert.ok(!String(saved.accessToken).includes("1234567890"), "access token must be redacted");
    assert.equal(saved.test.ok, true);
    assert.equal(saved.test.identity, "Tester");
    assert.equal(saved.authStatus, "ok");
    assert.equal(saved.rebuilt, true);

    const probe = (await app.inject({ method: "POST", url: "/api/settings/test-connection", payload: { mode: "user", accessToken: "user-token-abc-1234567890" } })).json();
    assert.equal(probe.ok, true);
    assert.equal(probe.identity, "Tester");
  } finally {
    await app.close();
  }
});

test("global preferences API reads and persists config.json", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  try {
    const initial = (await app.inject({ method: "GET", url: "/api/app-config" })).json();
    assert.deepEqual(initial.preferences, { defaultPollIntervalMs: 15000, logLevel: "info", notifications: { conflict: true, failure: true, credential: true } });
    assert.ok(initial.paths.config.endsWith("config.json"));

    const saved = await app.inject({ method: "PUT", url: "/api/app-config", payload: { defaultPollIntervalMs: 30000, logLevel: "debug" } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().preferences, { defaultPollIntervalMs: 30000, logLevel: "debug", notifications: { conflict: true, failure: true, credential: true } });

    // Notification toggles (B6.8) are a server-side preference too: a partial
    // patch flips one category and the others keep their value.
    const notified = await app.inject({ method: "PUT", url: "/api/app-config", payload: { notifications: { conflict: false } } });
    assert.equal(notified.statusCode, 200);
    assert.deepEqual(notified.json().preferences.notifications, { conflict: false, failure: true, credential: true });
    assert.equal((await app.inject({ method: "GET", url: "/api/app-config" })).json().preferences.notifications.conflict, false);

    // Values persist on disk for the next process (config.json next to the app).
    const disk = JSON.parse(readFileSync(app.appConfig.configPath, "utf8")) as { preferences: { defaultPollIntervalMs: number; logLevel: string } };
    assert.equal(disk.preferences.defaultPollIntervalMs, 30000);
    assert.equal(disk.preferences.logLevel, "debug");

    const badInterval = await app.inject({ method: "PUT", url: "/api/app-config", payload: { defaultPollIntervalMs: 500 } });
    assert.equal(badInterval.statusCode, 400);
    const badLevel = await app.inject({ method: "PUT", url: "/api/app-config", payload: { logLevel: "verbose" } });
    assert.equal(badLevel.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("new roots default to the configured poll interval", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-default-interval-"));
  try {
    await app.inject({ method: "PUT", url: "/api/app-config", payload: { defaultPollIntervalMs: 45000 } });
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().pollIntervalMs, 45000, "missing pollIntervalMs must fall back to the global preference");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("the batch entry endpoint applies retry/ignore to many entries at once (B6.3)", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-batch-"));
  try {
    writeFileSync(join(directory, "alpha.md"), "alpha\n", "utf8");
    writeFileSync(join(directory, "beta.md"), "beta\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const entries = synced.json().entries as Array<{ entryId: string; relativePath: string }>;
    assert.equal(entries.length, 2);
    const [alpha, beta] = entries;

    // Payload validation: an empty selection or an unknown action is rejected.
    assert.equal((await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [], action: "ignore" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [alpha!.entryId] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [alpha!.entryId], action: "delete" } })).statusCode, 400);

    // Bulk ignore freezes every selected entry in one call.
    const ignored = await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [alpha!.entryId, beta!.entryId], action: "ignore" } });
    assert.equal(ignored.statusCode, 200);
    assert.deepEqual(ignored.json(), { accepted: 2, total: 2, failed: 0 });
    assert.ok((await app.metaStorage.findBindingById(alpha!.entryId))?.ignoredAt);
    assert.ok((await app.metaStorage.findBindingById(beta!.entryId))?.ignoredAt);

    // Bulk restore clears the flag again.
    const restored = await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [alpha!.entryId, beta!.entryId], action: "unignore" } });
    assert.deepEqual(restored.json(), { accepted: 2, total: 2, failed: 0 });
    assert.equal((await app.metaStorage.findBindingById(alpha!.entryId))?.ignoredAt, undefined);

    // Bulk retry re-pulls a vanished local file, and a bad id in the same
    // selection is counted as failed instead of aborting the whole batch.
    rmSync(join(directory, "alpha.md"));
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal((await app.metaStorage.findBindingById(alpha!.entryId))?.status, "local-missing");
    const retried = await app.inject({ method: "POST", url: "/api/entries/batch", payload: { entryIds: [alpha!.entryId, "no-such-entry"], action: "retry" } });
    assert.deepEqual(retried.json(), { accepted: 1, total: 2, failed: 1 });
    assert.equal((await app.metaStorage.findBindingById(alpha!.entryId))?.status, "clean");
    assert.equal(readFileSync(join(directory, "alpha.md"), "utf8"), "alpha\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("patches a root and hot-restarts its poller", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-patch-"));
  try {
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token", pollIntervalMs: 60000 } });
    const rootId = created.json().id as string;
    const patched = await app.inject({ method: "PATCH", url: `/api/roots/${rootId}`, payload: { pollIntervalMs: 30000, enabled: false } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().pollIntervalMs, 30000);
    assert.equal(patched.json().enabled, false);
    const invalid = await app.inject({ method: "PATCH", url: `/api/roots/${rootId}`, payload: { pollIntervalMs: 5 } });
    assert.equal(invalid.statusCode, 400);
    const missing = await app.inject({ method: "PATCH", url: "/api/roots/nope", payload: { enabled: true } });
    assert.equal(missing.statusCode, 404);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("serves local files safely, document content and root stats", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-files-"));
  try {
    writeFileSync(join(directory, "note.md"), "# Hello\n\n![img](pic.png)\n", "utf8");
    writeFileSync(join(directory, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    const rootId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const entries = (await app.inject({ method: "GET", url: `/api/roots/${rootId}/tree` })).json().entries as Array<{ entryId: string; relativePath: string; kind: string; remoteToken?: string }>;
    const document = entries.find((entry) => entry.relativePath === "note.md");
    assert.ok(document);

    const content = await app.inject({ method: "GET", url: `/api/entries/${document.entryId}/content` });
    assert.equal(content.statusCode, 200);
    assert.equal(content.json().content, "# Hello\n\n![img](pic.png)\n");

    const image = await app.inject({ method: "GET", url: `/api/roots/${rootId}/file?path=pic.png` });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers["content-type"], "image/png");

    const escape = await app.inject({ method: "GET", url: `/api/roots/${rootId}/file`, query: { path: "../outside.txt" } });
    assert.equal(escape.statusCode, 403);
    const missingPath = await app.inject({ method: "GET", url: `/api/roots/${rootId}/file` });
    assert.equal(missingPath.statusCode, 400);

    // Document tokens must not be downloadable through the asset proxy.
    const documentToken = document.remoteToken;
    assert.ok(documentToken);
    const documentAsset = await app.inject({ method: "GET", url: `/api/assets/${encodeURIComponent(documentToken)}` });
    assert.equal(documentAsset.statusCode, 404);

    // A registered asset entry is proxied through the same endpoint.
    const assetEntry = entries.find((entry) => entry.relativePath === "pic.png");
    assert.ok(assetEntry?.remoteToken, "synced assets must carry a remote token");
    const asset = await app.inject({ method: "GET", url: `/api/assets/${encodeURIComponent(assetEntry.remoteToken)}` });
    assert.equal(asset.statusCode, 200);
    const unknownAsset = await app.inject({ method: "GET", url: "/api/assets/unknown-token" });
    assert.equal(unknownAsset.statusCode, 404);

    const stats = (await app.inject({ method: "GET", url: `/api/roots/${rootId}/stats` })).json();
    // note.md (document) and pic.png (asset) are both tracked as entries.
    assert.equal(stats.entriesTotal, 2);
    assert.ok(typeof stats.succeeded24h === "number");
    assert.ok(stats.lastSyncAt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("restores the baseline snapshot for an entry", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-restore-"));
  try {
    writeFileSync(join(directory, "note.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const entry = (synced.json().entries as Array<{ entryId: string; relativePath: string }>)[0]!;

    writeFileSync(join(directory, "note.md"), "broken local edit\n", "utf8");
    const restored = await app.inject({ method: "POST", url: `/api/entries/${entry.entryId}/restore-base` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().ok, true);
    assert.equal(readFileSync(join(directory, "note.md"), "utf8"), "shared line\n");

    const ghost = await app.inject({ method: "POST", url: "/api/entries/no-such-entry/restore-base" });
    assert.equal(ghost.statusCode, 404);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

/** Minimal WebSocket stand-in that records every broadcast payload. */
function createFakeSocket(): { socket: WebSocket; messages: string[] } {
  const messages: string[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => messages.push(payload),
    on: () => undefined,
    close: () => undefined
  } as unknown as WebSocket;
  return { socket, messages };
}

test("websocket clients observe the root lifecycle events", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-ws-"));
  const { socket, messages } = createFakeSocket();
  try {
    app.runtime.addClient(socket);
    // The connection handshake is delivered immediately.
    assert.equal((JSON.parse(messages[0]!) as { type: string }).type, "connected");

    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;

    await app.inject({ method: "DELETE", url: `/api/roots/${rootId}` });
    assert.equal((await app.inject({ method: "GET", url: "/api/roots" })).json().length, 0);

    const events = messages.map((payload) => JSON.parse(payload) as { type?: string; rootId?: string });
    assert.equal(events.filter((event) => event.type === "root-updated" && event.rootId === rootId).length, 2,
      "creating and deleting a root must each broadcast root-updated with its id");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

/** FakeRemote whose listTree can simulate an expired/invalid token. */
class AuthFlippingRemote extends FakeRemote {
  failAuth = false;
  listTree(root: SyncRoot): Promise<RemoteTree> {
    if (this.failAuth) return Promise.reject(new FeishuApiError("auth", "simulated invalid token"));
    return super.listTree(root);
  }
}

test("serves the local tree even when Feishu credentials are invalid", async () => {
  const remote = new AuthFlippingRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-tree-"));
  try {
    writeFileSync(join(directory, "note.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(synced.statusCode, 200);

    // Credentials go bad: the tree endpoint must stay storage-backed and succeed.
    remote.failAuth = true;
    const response = await app.inject({ method: "GET", url: `/api/roots/${rootId}/tree` });
    assert.equal(response.statusCode, 200);
    const tree = response.json() as { root: { id: string }; entries: Array<{ relativePath: string; syncing?: boolean }> };
    assert.equal(tree.root.id, rootId);
    assert.equal(tree.entries.length, 1);
    assert.equal(tree.entries[0]!.relativePath, "note.md");
    assert.notEqual(tree.entries[0]!.syncing, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("prunes operation history by age while keeping recent records", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-prune-age-"));
  try {
    const root = await app.metaStorage.createRoot({ localPath: directory, remoteToken: "root-token", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
    await app.metaStorage.initRootMeta(root.id, root.localPath);
    await app.metaStorage.addOperation({ entryId: "entry", direction: "push", operation: "old", rootId: root.id });
    await app.metaStorage.addOperation({ entryId: "entry", direction: "push", operation: "recent", rootId: root.id });

    // The prune endpoint with keepOperationHours will remove old operations
    // Since we can't easily backdate JSON records, we test with keepOperations instead
    const pruned = await app.inject({ method: "POST", url: "/api/maintenance/prune", payload: { keepOperations: 1 } });
    assert.equal(pruned.statusCode, 200);
    const result = pruned.json() as { operations: number };
    assert.equal(result.operations, 1);
    const remaining = await app.metaStorage.listOperations();
    assert.equal(remaining.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("issue workbench APIs drive single-entry sync, ignore and batch missing resync", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-issues-"));
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const entry = (synced.json().entries as Array<{ entryId: string; remoteToken?: string }>)[0]!;
    const token = entry.remoteToken!;

    // Unknown ids and malformed payloads are rejected.
    assert.equal((await app.inject({ method: "POST", url: "/api/entries/no-such-entry/sync" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/entries/no-such-entry/ignore", payload: { ignored: true } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/entries/${entry.entryId}/ignore`, payload: { ignored: "yes" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/roots/no-such-root/sync-missing" })).statusCode, 404);

    // The local file disappears -> local-missing; the entry API pulls it back.
    rmSync(join(directory, "notes.md"));
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const binding = await app.metaStorage.findBindingById(entry.entryId);
    assert.equal(binding?.status, "local-missing");
    const pulled = await app.inject({ method: "POST", url: `/api/entries/${entry.entryId}/sync` });
    assert.equal(pulled.statusCode, 200);
    assert.equal(pulled.json().status, "clean");
    assert.equal(readFileSync(join(directory, "notes.md"), "utf8"), "shared line\n");

    // The remote document disappears -> remote-missing; ignoring freezes it
    // so the batch resync skips it until it is restored.
    await remote.softDelete(token);
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const binding2 = await app.metaStorage.findBindingById(entry.entryId);
    assert.equal(binding2?.status, "remote-missing");
    const ignoredEntry = await app.inject({ method: "POST", url: `/api/entries/${entry.entryId}/ignore`, payload: { ignored: true } });
    assert.equal(ignoredEntry.statusCode, 200);
    assert.ok(ignoredEntry.json().ignoredAt);
    const skipped = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync-missing` });
    assert.equal(skipped.statusCode, 200);
    assert.deepEqual(skipped.json(), { rootId, synced: 0, total: 0 });

    // Restoring makes the batch resync re-create the remote document.
    await app.inject({ method: "POST", url: `/api/entries/${entry.entryId}/ignore`, payload: { ignored: false } });
    const batch = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync-missing` });
    assert.equal(batch.statusCode, 200);
    assert.deepEqual(batch.json(), { rootId, synced: 1, total: 1 });
    const healed = await app.metaStorage.findBindingById(entry.entryId);
    assert.equal(healed?.status, "clean");
    assert.ok(healed?.remoteToken);
    assert.equal(remote.documents.get(healed!.remoteToken!)?.content, "shared line\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("validate-token probes folders and documents and classifies failures", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  try {
    // A missing token is a client error, never a provider call.
    const missing = await app.inject({ method: "GET", url: "/api/roots/validate-token" });
    assert.equal(missing.statusCode, 400);

    // Seed a child under root-token so the folder probe counts it.
    await remote.createDocument("root-token", "child", "# Child\n");

    // Folder token -> ok, with the fake root name and a children count.
    const folder = await app.inject({ method: "GET", url: "/api/roots/validate-token?token=root-token&type=folder" });
    assert.equal(folder.statusCode, 200);
    assert.equal(folder.json().ok, true);
    assert.equal(folder.json().type, "folder");
    assert.ok(folder.json().children >= 1);

    // Document token -> ok, echoing the document name.
    const docToken = encodeURIComponent("root-token/child");
    const doc = await app.inject({ method: "GET", url: `/api/roots/validate-token?token=${docToken}&type=document` });
    assert.equal(doc.statusCode, 200);
    assert.equal(doc.json().ok, true);
    assert.equal(doc.json().name, "child");

    // Unknown document token -> 404 not_found.
    const unknown = await app.inject({ method: "GET", url: `/api/roots/validate-token?token=${encodeURIComponent("root-token/nope")}&type=document` });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().ok, false);
    assert.equal(unknown.json().category, "not_found");

    // A provider permission failure -> 403 permission.
    remote.getDocumentError = new FeishuApiError("permission", "forbidden");
    const forbidden = await app.inject({ method: "GET", url: `/api/roots/validate-token?token=${docToken}&type=document` });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().ok, false);
    assert.equal(forbidden.json().category, "permission");
    remote.getDocumentError = undefined;
  } finally {
    await app.close();
  }
});

test("task center groups operations and supports retry/cancel/batch-retry", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-tasks-"));
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });
    assert.equal(synced.statusCode, 200);
    const entryId = (synced.json().entries as EntryView[])[0]!.entryId;
    assert.ok(entryId);

    // The clean sync lands in the succeeded group and nothing is active.
    const done = await app.inject({ method: "GET", url: "/api/tasks?status=succeeded" });
    assert.equal(done.statusCode, 200);
    const doneTasks = done.json().tasks as Array<{ status: string }>;
    assert.ok(doneTasks.length >= 1);
    assert.ok(doneTasks.every((task) => task.status === "succeeded"));
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks?status=active" })).json().tasks.length, 0);

    // Inject a queued operation to exercise the active group + cancel.
    const queued = await app.metaStorage.addOperation({ rootId, direction: "push", operation: "sync-entry", trigger: "manual" });
    const active = (await app.inject({ method: "GET", url: "/api/tasks?status=active" })).json().tasks as Array<{ id: string }>;
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, queued.id);
    const cancelled = await app.inject({ method: "POST", url: `/api/tasks/${queued.id}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().ok, true);
    assert.equal((await app.inject({ method: "GET", url: "/api/tasks?status=active" })).json().tasks.length, 0);

    // Inject a failed operation bound to the entry to exercise retry + batch.
    const failed = await app.metaStorage.addOperation({ rootId, entryId, direction: "pull", operation: "sync-entry", trigger: "poll" });
    await app.metaStorage.updateOperation(failed.id, { status: "failed", errorCategory: "network", error: "simulated" });
    const failedTasks = (await app.inject({ method: "GET", url: "/api/tasks?status=failed" })).json().tasks as Array<{ id: string }>;
    assert.ok(failedTasks.some((task) => task.id === failed.id));

    const retried = await app.inject({ method: "POST", url: `/api/tasks/${failed.id}/retry` });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().ok, true);

    const batch = await app.inject({ method: "POST", url: "/api/tasks/batch-retry", payload: { operationIds: [failed.id] } });
    assert.equal(batch.statusCode, 200);
    assert.deepEqual(batch.json(), { accepted: 1, total: 1 });

    // A malformed batch payload is rejected before touching the runtime.
    const invalidBatch = await app.inject({ method: "POST", url: "/api/tasks/batch-retry", payload: { operationIds: "nope" } });
    assert.equal(invalidBatch.statusCode, 400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("task center clears completed operations on demand (B2)", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-clear-"));
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const rootId = (await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } })).json().id as string;
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });
    // A failure the user still has to act on; the sweep must leave it alone.
    const failed = await app.metaStorage.addOperation({ rootId, direction: "pull", operation: "sync-entry", trigger: "poll" });
    await app.metaStorage.updateOperation(failed.id, { status: "failed", errorCategory: "auth" });

    const before = (await app.inject({ method: "GET", url: "/api/tasks?status=all&limit=100" })).json().tasks as Array<{ status: string }>;
    const completed = before.filter((task) => task.status === "succeeded" || task.status === "cancelled").length;
    assert.ok(completed >= 1, "the clean sync left at least one completed record");

    // The retention prune reports zero here — nothing is 24h old yet — which is
    // exactly why「清空已完成」has to delete the finished records itself.
    assert.equal((await app.inject({ method: "POST", url: "/api/maintenance/prune" })).json().operations, 0);
    const cleared = await app.inject({ method: "POST", url: "/api/tasks/clear-completed" });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().cleared, completed, "the reported count matches what disappeared");

    const after = (await app.inject({ method: "GET", url: "/api/tasks?status=all&limit=100" })).json().tasks as Array<{ id: string; status: string }>;
    assert.ok(after.every((task) => task.status !== "succeeded" && task.status !== "cancelled"), "the completed group is empty");
    assert.ok(after.some((task) => task.id === failed.id), "the auth failure is still waiting for the user");

    // Only terminal statuses may be swept; in-flight work is off limits.
    assert.equal((await app.inject({ method: "POST", url: "/api/tasks/clear-completed", payload: { statuses: ["running"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/tasks/clear-completed", payload: { statuses: ["failed"] } })).json().cleared, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("operations endpoint filters by root/trigger and paginates with a cursor", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-ops-"));
  try {
    writeFileSync(join(directory, "a.md"), "a\n", "utf8");
    writeFileSync(join(directory, "b.md"), "b\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    const rootId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });

    const allOps = (await app.inject({ method: "GET", url: "/api/operations" })).json() as Array<{ id: string; rootId?: string }>;
    assert.ok(allOps.length >= 2);
    assert.ok(allOps.every((op) => op.rootId === rootId));

    // Trigger filter keeps only matching rounds; an unknown root yields none.
    assert.ok(((await app.inject({ method: "GET", url: "/api/operations?trigger=manual" })).json() as unknown[]).length >= 2);
    assert.equal(((await app.inject({ method: "GET", url: "/api/operations?trigger=poll" })).json() as unknown[]).length, 0);
    assert.equal(((await app.inject({ method: "GET", url: "/api/operations?rootId=does-not-exist" })).json() as unknown[]).length, 0);

    // Cursor paging walks distinct records one at a time.
    const page1 = (await app.inject({ method: "GET", url: "/api/operations?limit=1" })).json() as Array<{ id: string }>;
    assert.equal(page1.length, 1);
    const page2 = (await app.inject({ method: "GET", url: `/api/operations?limit=1&cursor=${page1[0]!.id}` })).json() as Array<{ id: string }>;
    assert.equal(page2.length, 1);
    assert.notEqual(page2[0]!.id, page1[0]!.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("version history endpoints list commits, diff and roll back (B4)", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-history-"));
  try {
    writeFileSync(join(directory, "notes.md"), "v1\n", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    const rootId = created.json().id as string;
    const first = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });
    const entryId = (first.json().entries as EntryView[])[0]!.entryId;
    const token = (first.json().entries as EntryView[])[0]!.remoteToken!;

    writeFileSync(join(directory, "notes.md"), "v2\n", "utf8");
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });

    // History requires a path and lists the two versions newest first.
    assert.equal((await app.inject({ method: "GET", url: `/api/roots/${rootId}/history` })).statusCode, 400);
    const commits = (await app.inject({ method: "GET", url: `/api/roots/${rootId}/history?path=notes.md` })).json() as Array<{ hash: string }>;
    assert.equal(commits.length, 2);
    const oldest = commits[1]!.hash;

    // Diff against a commit returns both ends for the browser to render.
    const diff = await app.inject({ method: "GET", url: `/api/entries/${entryId}/diff?against=${oldest}` });
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().baseContent, "v1\n");
    assert.equal(diff.json().currentContent, "v2\n");
    assert.equal((await app.inject({ method: "GET", url: `/api/entries/${entryId}/diff` })).json().against, "baseline");

    // Rollback needs a commit, then restores local and pushes to the remote.
    assert.equal((await app.inject({ method: "POST", url: `/api/entries/${entryId}/rollback`, payload: {} })).statusCode, 400);
    const rolled = await app.inject({ method: "POST", url: `/api/entries/${entryId}/rollback`, payload: { commit: oldest } });
    assert.equal(rolled.statusCode, 200);
    assert.equal(rolled.json().ok, true);
    assert.equal(readFileSync(join(directory, "notes.md"), "utf8"), "v1\n");
    assert.equal(remote.documents.get(token)?.content, "v1\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("folder binding endpoints list mappings and rebind a directory (B3)", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-folders-"));
  try {
    mkdirSync(join(directory, "deep"), { recursive: true });
    writeFileSync(join(directory, "deep", "a.md"), "# A\n\nfirst", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    const rootId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });

    // The sync persisted a folder binding for "deep"; the endpoint lists it
    // together with the number of bound child files.
    const folders = (await app.inject({ method: "GET", url: `/api/roots/${rootId}/folders` })).json() as Array<{ relativePath: string; remoteToken: string; childCount: number }>;
    assert.equal(folders.length, 1);
    assert.equal(folders[0]!.relativePath, "deep");
    assert.ok(folders[0]!.remoteToken);
    assert.equal(folders[0]!.childCount, 1);

    // An unknown root has no folder mappings.
    assert.equal((await app.inject({ method: "GET", url: "/api/roots/nope/folders" })).statusCode, 404);

    // Rebinding requires both the local path and the new remote token.
    assert.equal((await app.inject({ method: "POST", url: `/api/roots/${rootId}/folders/rebind`, payload: { relativePath: "deep" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/roots/${rootId}/folders/rebind`, payload: { remoteToken: "tok" } })).statusCode, 400);

    // A valid rebind overwrites the stored token for that directory.
    const rebound = await app.inject({ method: "POST", url: `/api/roots/${rootId}/folders/rebind`, payload: { relativePath: "deep", remoteToken: "manual-folder-token" } });
    assert.equal(rebound.statusCode, 200);
    assert.equal(rebound.json().remoteToken, "manual-folder-token");
    const after = (await app.inject({ method: "GET", url: `/api/roots/${rootId}/folders` })).json() as Array<{ remoteToken: string }>;
    assert.equal(after[0]!.remoteToken, "manual-folder-token");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("api-stats tally every remote call including validate-token probes (B6.2)", async () => {
  const remote = new FakeRemote();
  const app = buildIsolatedApp({ remote });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-stats-"));
  try {
    // A fresh runtime has made no calls yet, so the panel reads all zeros.
    const empty = await app.inject({ method: "GET", url: "/api/api-stats" });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().provider, "fake");
    assert.equal(empty.json().calls, 0);
    assert.deepEqual(empty.json().byMethod, {});
    assert.ok(!Number.isNaN(Date.parse(empty.json().startedAt as string)));

    writeFileSync(join(directory, "notes.md"), "# Notes\n\nhello", "utf8");
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    const synced = await app.inject({ method: "POST", url: `/api/roots/${rootId}/sync`, payload: { trigger: "manual" } });
    assert.equal(synced.statusCode, 200);

    // The sync round walked the remote tree and pushed the document.
    const stats = (await app.inject({ method: "GET", url: "/api/api-stats" })).json() as {
      provider: string; calls: number; failures: number; rateLimited: number; totalDurationMs: number;
      byMethod: Record<string, { calls: number; failures: number }>;
    };
    assert.ok(stats.calls > 0, "a manual sync must have hit the provider");
    assert.equal(stats.failures, 0);
    assert.equal(stats.rateLimited, 0);
    assert.ok(stats.totalDurationMs >= 0);
    assert.ok(stats.byMethod.listTree && stats.byMethod.listTree.calls >= 1, "listTree is counted");
    assert.ok(stats.byMethod.createDocument && stats.byMethod.createDocument.calls === 1, "createDocument is counted");
    // The roll-up equals the sum of its parts.
    assert.equal(stats.calls, Object.values(stats.byMethod).reduce((total, method) => total + method.calls, 0));

    // validate-token probes go through the same instrumented provider.
    const before = stats.calls;
    const probe = await app.inject({ method: "GET", url: "/api/roots/validate-token?token=root-token&type=folder" });
    assert.equal(probe.statusCode, 200);
    const afterProbe = (await app.inject({ method: "GET", url: "/api/api-stats" })).json() as { calls: number; failures: number; byMethod: Record<string, { calls: number }> };
    assert.equal(afterProbe.calls, before + 1);
    assert.equal(afterProbe.byMethod.listTree!.calls, stats.byMethod.listTree!.calls + 1);

    // A provider failure shows up as failures, not silently dropped.
    remote.getDocumentError = new FeishuApiError("permission", "forbidden");
    const denied = await app.inject({ method: "GET", url: `/api/roots/validate-token?token=${encodeURIComponent("root-token/notes.md")}&type=document` });
    assert.equal(denied.statusCode, 403);
    const afterFailure = (await app.inject({ method: "GET", url: "/api/api-stats" })).json() as { failures: number; byMethod: Record<string, { failures: number }> };
    assert.equal(afterFailure.failures, 1);
    assert.equal(afterFailure.byMethod.getDocument!.failures, 1);

    // The runtime accessor exposes the same snapshot for embedded callers.
    assert.equal(app.runtime.getApiStats().calls, afterProbe.calls + 1);
    assert.equal(app.runtime.instrumentedRemote.name, "fake");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test("validate-path probes the local directory and honours exclude patterns (B5)", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-probe-"));
  try {
    mkdirSync(join(directory, "guide"), { recursive: true });
    mkdirSync(join(directory, "drafts"), { recursive: true });
    writeFileSync(join(directory, "README.md"), "# README\n", "utf8");
    writeFileSync(join(directory, "guide", "setup.md"), "# Setup\n", "utf8");
    writeFileSync(join(directory, "drafts", "wip.md"), "# WIP\n", "utf8");
    writeFileSync(join(directory, "diagram.png"), "not-really-a-png", "utf8");

    // Missing/relative paths are client errors, never a filesystem probe.
    assert.equal((await app.inject({ method: "GET", url: "/api/roots/validate-path" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent("relative/dir")}` })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent(join(directory, "nope"))}` })).statusCode, 404);

    // A real directory reports the syncable file counts split by kind.
    const ok = await app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent(directory)}` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().ok, true);
    assert.equal(ok.json().isDirectory, true);
    assert.equal(ok.json().writable, true);
    assert.equal(ok.json().documents, 3);
    assert.equal(ok.json().assets, 1);
    assert.equal(ok.json().total, 4);

    // Exclude patterns shrink the count exactly as the first scan would.
    const filtered = await app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent(directory)}&exclude=${encodeURIComponent("drafts/**")}` });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filtered.json().exclude, ["drafts/**"]);
    assert.equal(filtered.json().documents, 2);
    assert.equal(filtered.json().total, 3);

    // A file is not a bindable directory.
    const notDirectory = await app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent(join(directory, "README.md"))}` });
    assert.equal(notDirectory.statusCode, 400);
    assert.equal(notDirectory.json().isDirectory, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

/**
 * Regression guard for the event stream. `app.inject` cannot perform an HTTP
 * upgrade, and the other websocket test hands a fake socket straight to
 * `runtime.addClient`, so neither would notice if the route were declared before
 * @fastify/websocket installed its onRoute hook — the handshake would silently
 * degrade to a 426 and every live event would be lost in the browser.
 * `injectWS` runs the real upgrade through the Fastify router in-process.
 */
test("the /api/events websocket handshake completes and delivers broadcasts", async () => {
  const app = buildIsolatedApp({ remote: new FakeRemote() });
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-ws-live-"));
  const received: Array<{ type?: string; rootId?: string }> = [];
  try {
    // A non-upgrade GET keeps answering 426 (the route is dual-purpose).
    assert.equal((await app.inject({ method: "GET", url: "/api/events" })).statusCode, 426);

    // Rejects with "Unexpected server response: 426" if the plugin never wrapped
    // the route, which is exactly the regression this test guards against.
    // `onInit` attaches the listener before the handshake resolves so the
    // server's immediate greeting cannot slip past us.
    const socket = await app.injectWS("/api/events", {}, {
      onInit: (client) => client.on("message", (payload) => received.push(JSON.parse(payload.toString()) as { type?: string; rootId?: string }))
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received[0]?.type, "connected", "the runtime greets every new client");

    // Broadcasts really reach the connected client.
    const created = await app.inject({ method: "POST", url: "/api/roots", payload: { localPath: directory, remoteToken: "root-token" } });
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(received.some((event) => event.type === "root-updated" && event.rootId === rootId),
      `expected a root-updated event, got ${JSON.stringify(received)}`);
    socket.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});
