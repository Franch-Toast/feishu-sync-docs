import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider } from "@feishu-sync/core";
import type { RemoteTree, SyncRoot } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import { SqliteStateStore } from "@feishu-sync/storage";
import { SyncRuntime } from "../src/runtime.js";
import type { WebSocket } from "ws";
import { FakeRemote } from "./helpers/fake-remote.js";

interface Scenario {
  store: SqliteStateStore;
  remote: FakeRemote;
  runtime: SyncRuntime;
  directory: string;
}

interface EntryView {
  id: string;
  status: string;
  remoteToken?: string;
}

function createScenario(): Scenario {
  const store = new SqliteStateStore();
  const remote = new FakeRemote();
  const runtime = new SyncRuntime(store, new FilesystemProvider(), remote);
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-"));
  return { store, remote, runtime, directory };
}

async function createRoot(scenario: Scenario, initialContent?: string): Promise<SyncRoot> {
  if (initialContent !== undefined) writeFileSync(join(scenario.directory, "notes.md"), initialContent, "utf8");
  return scenario.store.createRoot({ localPath: scenario.directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });
}

function cleanup(scenario: Scenario): void {
  scenario.runtime.stop();
  scenario.store.close();
  rmSync(scenario.directory, { recursive: true, force: true });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("pushes a new local document and records a snapshot", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    assert.equal(entry.status, "clean");
    assert.ok(entry.remoteToken);
    assert.equal(scenario.remote.documents.get(entry.remoteToken!)?.content, "shared line\n");
    const snapshot = await scenario.store.getSnapshot(entry.id);
    assert.equal(snapshot?.baseContent, "shared line\n");
  } finally {
    cleanup(scenario);
  }
});

test("pulls remote changes into the local file", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    scenario.remote.edit(token, "remote edit\n");
    await scenario.runtime.syncRoot(root.id);
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "remote edit\n");
  } finally {
    cleanup(scenario);
  }
});

test("flags a conflict when both sides changed", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.edit(token, "remote edit\n");
    const conflicted = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(conflicted.entries[0]?.status, "conflict");
    const open = await scenario.store.listConflicts("open");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.localContent, "local edit\n");
    assert.equal(open[0]?.remoteContent, "remote edit\n");
  } finally {
    cleanup(scenario);
  }
});

test("resolves a conflict with merged content on both sides", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.edit(token, "remote edit\n");
    await scenario.runtime.syncRoot(root.id);
    const conflict = (await scenario.store.listConflicts("open"))[0]!;

    const resolved = await scenario.runtime.resolveConflict(conflict, { resolution: "merged", mergedContent: "local edit\nremote edit\n" });
    assert.equal(resolved.status, "resolved");
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "local edit\nremote edit\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "local edit\nremote edit\n");
    assert.equal((await scenario.store.listConflicts("open")).length, 0);

    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(synced.entries[0]?.status, "clean");
  } finally {
    cleanup(scenario);
  }
});

test("aborting a conflict re-evaluates it with fresh three-way data", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.edit(token, "remote edit\n");
    await scenario.runtime.syncRoot(root.id);
    const conflict = (await scenario.store.listConflicts("open"))[0]!;

    await scenario.runtime.resolveConflict(conflict, { resolution: "abort" });
    const all = await scenario.store.listConflicts();
    assert.equal(all.filter((item) => item.status === "aborted").length, 1);
    // The abort re-arms the entry, and the enqueued rescan recreates an open conflict.
    const open = await scenario.store.listConflicts("open");
    assert.equal(open.length, 1);
    assert.notEqual(open[0]?.id, conflict.id);
  } finally {
    cleanup(scenario);
  }
});

test("records failures on the entry and recovers on the next sync", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entryId = result.entries[0]!.id;
    const token = result.entries[0]!.remoteToken!;

    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.failNextWrite();
    const failed = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(failed.entries[0]?.status, "error");
    const failedOperation = (await scenario.store.listOperations()).find((operation) => operation.status === "failed");
    assert.ok(failedOperation, "expected a failed operation record");
    assert.equal(failedOperation.entryId, entryId);
    assert.ok(failedOperation.error);

    // The next scan re-arms error entries; the retry succeeds and pushes the content.
    const recovered = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(recovered.entries[0]?.status, "clean");
    assert.equal(scenario.remote.documents.get(token)?.content, "local edit\n");
  } finally {
    cleanup(scenario);
  }
});

test("serializes work per root through the internal queue", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const enqueue = (scenario.runtime as unknown as {
      enqueue(id: string, callback: () => Promise<unknown>): Promise<void>;
    }).enqueue.bind(scenario.runtime);

    const events: string[] = [];
    const finished: Array<{ id: number; end: number }> = [];
    const tasks = [1, 2, 3].map((id) =>
      enqueue(root.id, async () => {
        await sleep(20);
        events.push(`task-${id}`);
        finished.push({ id, end: Date.now() });
      })
    );
    await Promise.all(tasks);

    assert.deepEqual(events, ["task-1", "task-2", "task-3"]);
    for (let index = 1; index < finished.length; index += 1) {
      const previous = finished[index - 1]!;
      const current = finished[index]!;
      assert.ok(previous.end <= current.end, `task ${current.id} overlapped with task ${previous.id}`);
    }
  } finally {
    cleanup(scenario);
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

function broadcastTypes(messages: string[]): string[] {
  return messages.map((payload) => {
    try { return (JSON.parse(payload) as { type?: string }).type ?? ""; } catch { return ""; }
  });
}

test("auth failures flag the credential state and recovery clears it", async () => {
  const store = new SqliteStateStore();
  const remote = new AuthFlippingRemote();
  const runtime = new SyncRuntime(store, new FilesystemProvider(), remote);
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-auth-"));
  const { socket, messages } = createFakeSocket();
  runtime.addClient(socket);
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const root = await store.createRoot({ localPath: directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });

    // A healthy round never touches the auth state.
    await runtime.syncRoot(root.id);
    assert.equal(await store.getSetting("feishu.authStatus"), undefined);
    assert.ok(!broadcastTypes(messages).includes("auth-invalid"));

    // An auth error flags the credentials once and short-circuits the round.
    remote.failAuth = true;
    const failed = (await runtime.syncRoot(root.id)) as { authInvalid?: boolean };
    assert.equal(failed.authInvalid, true);
    assert.equal(await store.getSetting("feishu.authStatus"), "invalid");
    assert.equal(broadcastTypes(messages).filter((type) => type === "auth-invalid").length, 1);

    // Repeated failures stay quiet: the flag is broadcast once, not per sync.
    await runtime.syncRoot(root.id);
    assert.equal(await store.getSetting("feishu.authStatus"), "invalid");
    assert.equal(broadcastTypes(messages).filter((type) => type === "auth-invalid").length, 1);

    // A healthy round restores the credential state and announces it.
    remote.failAuth = false;
    await runtime.syncRoot(root.id);
    assert.equal(await store.getSetting("feishu.authStatus"), "ok");
    assert.ok(broadcastTypes(messages).includes("auth-restored"), "expected an auth-restored broadcast");
  } finally {
    runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plain remote errors never flag the credential state", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.failNextWrite();
    const failed = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(failed.entries[0]?.status, "error");
    assert.equal(scenario.remote.documents.get(token)?.content, "shared line\n");
    const authStatus = await scenario.store.getSetting("feishu.authStatus");
    assert.ok(authStatus !== "invalid", "a plain write failure must not flag the credentials");
  } finally {
    cleanup(scenario);
  }
});
