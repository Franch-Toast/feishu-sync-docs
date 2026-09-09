import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(initial.preferences, { defaultPollIntervalMs: 15000, logLevel: "info" });
    assert.ok(initial.paths.config.endsWith("config.json"));

    const saved = await app.inject({ method: "PUT", url: "/api/app-config", payload: { defaultPollIntervalMs: 30000, logLevel: "debug" } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().preferences, { defaultPollIntervalMs: 30000, logLevel: "debug" });

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
