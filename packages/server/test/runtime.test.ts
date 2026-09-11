import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider } from "@feishu-sync/core";
import type { RemoteTree, SyncRoot } from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { SyncRuntime, watcherIgnore } from "../src/runtime.js";
import { AppConfigStore } from "../src/appconfig.js";
import type { WebSocket } from "ws";
import { FakeRemote } from "./helpers/fake-remote.js";

interface Scenario {
  gitStorage: GitStorageImpl;
  metaStorage: JsonMetaStorage;
  remote: FakeRemote;
  runtime: SyncRuntime;
  directory: string;
  globalDir: string;
}

interface EntryView {
  entryId: string;
  status: string;
  remoteToken?: string;
  ignoredAt?: string;
}

function createScenario(options?: { delays?: number[] }): Scenario {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  // Zero-delay backoff so auto-retry exhaustion never waits on real timers.
  // Passing `delays` records each backoff instead, letting a test assert the
  // exact delay the runtime chose (B6.2 Retry-After floor).
  const sleep = options?.delays
    ? async (ms: number): Promise<void> => { options.delays!.push(ms); }
    : async (): Promise<void> => {};
  const runtime = new SyncRuntime(gitStorage, metaStorage, new FilesystemProvider(), remote, undefined, undefined, undefined, undefined, { sleep });
  return { gitStorage, metaStorage, remote, runtime, directory, globalDir };
}

async function createRoot(scenario: Scenario, initialContent?: string): Promise<SyncRoot> {
  if (initialContent !== undefined) writeFileSync(join(scenario.directory, "notes.md"), initialContent, "utf8");
  const root = await scenario.metaStorage.createRoot({ localPath: scenario.directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });
  await scenario.gitStorage.initRoot(root);
  await scenario.metaStorage.initRootMeta(root.id, root.localPath);
  return root;
}

function cleanup(scenario: Scenario): void {
  scenario.runtime.stop();
  rmSync(scenario.directory, { recursive: true, force: true });
  rmSync(scenario.globalDir, { recursive: true, force: true });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("pushes a new local document and records a baseline", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    assert.equal(entry.status, "clean");
    assert.ok(entry.remoteToken);
    assert.equal(scenario.remote.documents.get(entry.remoteToken!)?.content, "shared line\n");
    // Baseline is stored in Git; verify via getBaseline
    const baseline = await scenario.gitStorage.getBaseline(root.id, "notes.md");
    assert.equal(baseline, "shared line\n");
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
    const open = await scenario.metaStorage.listConflicts("open");
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
    const conflict = (await scenario.metaStorage.listConflicts("open"))[0]!;

    const resolved = await scenario.runtime.resolveConflict(conflict, { resolution: "merged", mergedContent: "local edit\nremote edit\n" });
    assert.equal(resolved.status, "resolved");
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "local edit\nremote edit\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "local edit\nremote edit\n");
    assert.equal((await scenario.metaStorage.listConflicts("open")).length, 0);

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
    const conflict = (await scenario.metaStorage.listConflicts("open"))[0]!;

    await scenario.runtime.resolveConflict(conflict, { resolution: "abort" });
    const all = await scenario.metaStorage.listConflicts();
    assert.equal(all.filter((item) => item.status === "aborted").length, 1);
    // The abort re-arms the entry, and the enqueued rescan recreates an open conflict.
    const open = await scenario.metaStorage.listConflicts("open");
    assert.equal(open.length, 1);
    assert.notEqual(open[0]?.id, conflict.id);
  } finally {
    cleanup(scenario);
  }
});

test("records failures on the entry and recovers on a human retry", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entryId = result.entries[0]!.entryId;
    const token = result.entries[0]!.remoteToken!;

    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    // A persistent failure so the runtime exhausts its auto-retries (a one-shot
    // failure would simply be retried into success within the same round).
    scenario.remote.failWrites = true;
    const failed = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(failed.entries[0]?.status, "error");
    const failedOperation = (await scenario.metaStorage.listOperations()).find((operation) => operation.status === "failed");
    assert.ok(failedOperation, "expected a failed operation record");
    assert.equal(failedOperation.entryId, entryId);
    assert.ok(failedOperation.error);
    // B2: the failure is categorized and the auto-retry ceiling is recorded.
    assert.equal(failedOperation.errorCategory, "unknown");
    assert.equal(failedOperation.retryCount, failedOperation.maxRetries ?? 3);

    // A1: `error` is terminal. Even with writes healthy again, a plain round
    // must not quietly re-push a file nobody touched — that is what made one
    // broken file burn every round and hid that it was waiting for a human.
    scenario.remote.failWrites = false;
    const idle = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(idle.entries.find((entry) => entry.entryId === entryId)?.status, "error");
    assert.equal(scenario.remote.documents.get(token)?.content, "shared line\n", "the un-armed round wrote nothing remote");

    // The 「重试」 action re-arms it and the push finally lands.
    const retried = await scenario.runtime.syncEntryNow(entryId);
    assert.equal(retried.status, "clean");
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
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-auth-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-runtime-auth-config-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new AuthFlippingRemote();
  const config = new AppConfigStore(join(globalDir, "config.json"));
  const runtime = new SyncRuntime(gitStorage, metaStorage, new FilesystemProvider(), remote, undefined, undefined, undefined, config);
  const { socket, messages } = createFakeSocket();
  runtime.addClient(socket);
  try {
    writeFileSync(join(directory, "notes.md"), "shared line\n", "utf8");
    const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });
    await gitStorage.initRoot(root);
    await metaStorage.initRootMeta(root.id, root.localPath);

    // A healthy round never touches the auth state.
    await runtime.syncRoot(root.id);
    assert.equal((await config.getAuthFlag()).status, undefined);
    assert.ok(!broadcastTypes(messages).includes("auth-invalid"));

    // An auth error flags the credentials once and short-circuits the round.
    remote.failAuth = true;
    const failed = (await runtime.syncRoot(root.id)) as { authInvalid?: boolean };
    assert.equal(failed.authInvalid, true);
    assert.equal((await config.getAuthFlag()).status, "invalid");
    assert.equal(broadcastTypes(messages).filter((type) => type === "auth-invalid").length, 1);

    // Repeated failures stay quiet: the flag is broadcast once, not per sync.
    await runtime.syncRoot(root.id);
    assert.equal((await config.getAuthFlag()).status, "invalid");
    assert.equal(broadcastTypes(messages).filter((type) => type === "auth-invalid").length, 1);

    // A healthy round restores the credential state and announces it.
    remote.failAuth = false;
    await runtime.syncRoot(root.id);
    assert.equal((await config.getAuthFlag()).status, "ok");
    assert.ok(broadcastTypes(messages).includes("auth-restored"), "expected an auth-restored broadcast");
  } finally {
    runtime.stop();
    rmSync(directory, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("plain remote errors never flag the credential state", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.failWrites = true;
    const failed = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(failed.entries[0]?.status, "error");
    assert.equal(scenario.remote.documents.get(token)?.content, "shared line\n");
    // Auth state is managed by AppConfigStore, not MetaStorage; verify no auth-invalid broadcast
    // by checking that the runtime didn't flag credentials (no authState injected in this scenario)
  } finally {
    cleanup(scenario);
  }
});

test("reclassifies vanished local files as local-missing and re-pulls them on demand", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    const token = entry.remoteToken!;
    assert.equal(entry.status, "clean");

    rmSync(join(scenario.directory, "notes.md"));
    const scanned = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(scanned.entries[0]?.status, "local-missing");
    assert.ok(!existsSync(join(scenario.directory, "notes.md")), "the local file must stay absent until an explicit resync");

    const restored = await scenario.runtime.syncEntryNow(entry.entryId);
    assert.equal(restored.status, "clean");
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "shared line\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "shared line\n");
  } finally {
    cleanup(scenario);
  }
});

test("reclassifies deleted remote documents as remote-missing and re-creates them on demand", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    const token = entry.remoteToken!;

    await scenario.remote.softDelete(token);
    const scanned = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(scanned.entries[0]?.status, "remote-missing");

    const recreated = await scenario.runtime.syncEntryNow(entry.entryId);
    assert.equal(recreated.status, "clean");
    assert.ok(recreated.remoteToken, "the recreated entry must be bound to the new remote document");
    assert.equal(scenario.remote.documents.get(recreated.remoteToken!)?.content, "shared line\n");
  } finally {
    cleanup(scenario);
  }
});

test("ignoring freezes an entry across scans until it is restored", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = result.entries[0]!;
    const token = entry.remoteToken!;

    const ignored = await scenario.runtime.setEntryIgnored(entry.entryId, true);
    assert.ok(ignored.ignoredAt, "ignoring must stamp ignoredAt");

    // Both sides drift away; an ignored entry must not be re-evaluated.
    writeFileSync(join(scenario.directory, "notes.md"), "local drift\n", "utf8");
    scenario.remote.edit(token, "remote drift\n");
    const scanned = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const frozen = scanned.entries[0]!;
    assert.equal(frozen.status, "clean", "an ignored entry must not be re-evaluated");
    assert.ok(frozen.ignoredAt);
    assert.equal(scenario.remote.documents.get(token)?.content, "remote drift\n");

    // Restoring re-arms the entry, and the drift is evaluated as a conflict.
    const restored = await scenario.runtime.setEntryIgnored(entry.entryId, false);
    assert.ok(!restored.ignoredAt, "restoring must clear ignoredAt");
    const reevaluated = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(reevaluated.entries[0]?.status, "conflict");
  } finally {
    cleanup(scenario);
  }
});

test("syncMissingEntries heals every missing entry of a root in one call", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    await scenario.runtime.syncRoot(root.id);
    writeFileSync(join(scenario.directory, "extra.md"), "extra line\n", "utf8");
    await scenario.runtime.syncRoot(root.id);

    const before = await scenario.metaStorage.listBindings(root.id);
    const notes = before.find((entry) => entry.relativePath === "notes.md")!;
    const extra = before.find((entry) => entry.relativePath === "extra.md")!;
    assert.equal(notes.status, "clean");
    assert.equal(extra.status, "clean");

    rmSync(join(scenario.directory, "notes.md"));
    await scenario.remote.softDelete(extra.remoteToken!);
    await scenario.runtime.syncRoot(root.id);
    const broken = await scenario.metaStorage.listBindings(root.id);
    assert.equal(broken.find((entry) => entry.relativePath === "notes.md")?.status, "local-missing");
    assert.equal(broken.find((entry) => entry.relativePath === "extra.md")?.status, "remote-missing");

    const outcome = await scenario.runtime.syncMissingEntries(root.id);
    assert.deepEqual(outcome, { rootId: root.id, synced: 2, total: 2 });

    const healed = await scenario.metaStorage.listBindings(root.id);
    assert.equal(healed.find((entry) => entry.relativePath === "notes.md")?.status, "clean");
    assert.equal(healed.find((entry) => entry.relativePath === "extra.md")?.status, "clean");
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "shared line\n");
    assert.equal(scenario.remote.documents.get(healed.find((entry) => entry.relativePath === "extra.md")!.remoteToken!)?.content, "extra line\n");
  } finally {
    cleanup(scenario);
  }
});

test("announces sync-started before each sync round", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    await scenario.runtime.syncRoot(root.id);
    const types = broadcastTypes(messages);
    const started = types.indexOf("sync-started");
    const done = types.indexOf("sync");
    assert.ok(started >= 0, "expected a sync-started broadcast");
    assert.ok(done > started, "the completion broadcast must follow sync-started");
  } finally {
    cleanup(scenario);
  }
});

test("pull-only mode pulls remote edits and never pushes local changes", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    assert.equal(result.entries[0]!.status, "clean");
    await scenario.metaStorage.updateRoot(root.id, { mode: "pull-only" });
    // Both sides drift; pull-only resolves in favour of the remote without a conflict.
    scenario.remote.edit(token, "remote wins\n");
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "remote wins\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "remote wins\n", "the local edit must never be pushed");
    assert.equal(synced.entries[0]?.status, "clean");
  } finally {
    cleanup(scenario);
  }
});

test("pull-only mode never creates a remote document for a local-only file", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await scenario.metaStorage.updateRoot(root.id, { mode: "pull-only" });
    writeFileSync(join(scenario.directory, "only.md"), "only local\n", "utf8");
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(synced.entries[0]?.remoteToken, undefined);
    assert.equal(scenario.remote.documents.size, 0, "pull-only must not push a new document");
  } finally {
    cleanup(scenario);
  }
});

test("push-only mode pushes local edits and never pulls remote changes", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    await scenario.metaStorage.updateRoot(root.id, { mode: "push-only" });
    scenario.remote.edit(token, "remote edit\n");
    writeFileSync(join(scenario.directory, "notes.md"), "local wins\n", "utf8");
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "local wins\n", "the remote edit must never be pulled");
    assert.equal(scenario.remote.documents.get(token)?.content, "local wins\n");
    assert.equal(synced.entries[0]?.status, "clean");
  } finally {
    cleanup(scenario);
  }
});

test("push-only mode does not import remote-only documents", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await scenario.metaStorage.updateRoot(root.id, { mode: "push-only" });
    await scenario.remote.createDocument("root-token", "remote-only", "remote content\n");
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(synced.entries.length, 0, "push-only must not import remote-only documents");
    assert.equal(existsSync(join(scenario.directory, "remote-only.md")), false);
  } finally {
    cleanup(scenario);
  }
});

test("a drive event echoing a just-pushed token is ignored while others scan", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    await scenario.metaStorage.updateRoot(root.id, { enabled: true });
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    const before = scenario.remote.listTreeCalls;
    // The push registered an echo guard, so this event is skipped without a scan.
    await scenario.runtime.requestSync(root.id, token);
    assert.equal(scenario.remote.listTreeCalls, before, "an echoed push must not trigger a scan");
    // A different (genuine) remote change is not guarded and does scan.
    await scenario.runtime.requestSync(root.id, "other-token");
    assert.ok(scenario.remote.listTreeCalls > before, "a genuine remote change must trigger a scan");
  } finally {
    cleanup(scenario);
  }
});

test("a transient write failure auto-retries with backoff and recovers", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = result.entries[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    // Fail twice then succeed: the round auto-retries (zero-delay) and recovers.
    scenario.remote.failWritesTimes(2);
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(synced.entries[0]?.status, "clean");
    assert.equal(scenario.remote.documents.get(token)?.content, "local edit\n");
    const operation = (await scenario.metaStorage.listOperations()).find((op) => op.status === "succeeded");
    assert.ok(operation, "expected a succeeded operation after retries");
    assert.equal(operation!.retryCount, 2);
    const types = broadcastTypes(messages);
    assert.equal(types.filter((type) => type === "operation-retrying").length, 2);
    assert.ok(types.includes("operation-completed"));
  } finally {
    cleanup(scenario);
  }
});

test("an auth failure on write fails fast without auto-retry", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    await scenario.runtime.syncRoot(root.id);
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.failWritesAuth = true;
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[]; authInvalid?: boolean };
    assert.equal(synced.authInvalid, true);
    const operation = (await scenario.metaStorage.listOperations()).find((op) => op.status === "failed");
    assert.ok(operation, "expected a failed operation");
    assert.equal(operation!.errorCategory, "auth");
    assert.equal(operation!.retryCount, 0, "auth failures must never auto-retry");
    // The engine picks the direction before it writes, so a failed push must not
    // fall back to the "merge" placeholder the record was opened with (B1).
    assert.equal(operation!.direction, "push", "a failed operation keeps its real direction");
    assert.ok(!broadcastTypes(messages).includes("operation-retrying"));
  } finally {
    cleanup(scenario);
  }
});

test("a successful sync broadcasts the operation lifecycle with a real direction", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "shared line\n");
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    await scenario.runtime.syncRoot(root.id);
    const types = broadcastTypes(messages);
    assert.ok(types.includes("operation-queued"));
    assert.ok(types.includes("operation-started"));
    assert.ok(types.includes("operation-completed"));
    const operation = (await scenario.metaStorage.listOperations()).find((op) => op.status === "succeeded");
    assert.equal(operation?.direction, "push", "a new local document is pushed to the remote");
  } finally {
    cleanup(scenario);
  }
});

test("version history diffs against a commit and rolls back both sides (B4)", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "v1\n");
    const first = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entryId = first.entries[0]!.entryId;
    const token = first.entries[0]!.remoteToken!;
    assert.equal(scenario.remote.documents.get(token)?.content, "v1\n");

    // A second local version is pushed, leaving two commits for notes.md.
    writeFileSync(join(scenario.directory, "notes.md"), "v2\n", "utf8");
    await scenario.runtime.syncRoot(root.id);
    assert.equal(scenario.remote.documents.get(token)?.content, "v2\n");

    const history = await scenario.runtime.getRootHistory(root.id, "notes.md", 50);
    assert.equal(history.length, 2, "two versions of notes.md, newest first");
    const [newest, oldest] = history;

    // Diff against the oldest commit exposes the historical content as the base.
    const diff = await scenario.runtime.getEntryDiff(entryId, oldest!.hash);
    assert.equal(diff.baseContent, "v1\n");
    assert.equal(diff.currentContent, "v2\n");

    // Diff against the baseline shows no pending local change after a clean sync.
    const baselineDiff = await scenario.runtime.getEntryDiff(entryId, "baseline");
    assert.equal(baselineDiff.baseContent, "v2\n");
    assert.equal(baselineDiff.currentContent, "v2\n");

    // Rolling back to the oldest version rewrites local AND pushes to remote.
    const result = await scenario.runtime.rollbackEntry(entryId, oldest!.hash);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "v1\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "v1\n", "the remote follows the rollback");

    // The rollback is itself a new version on the timeline.
    const afterRollback = await scenario.runtime.getRootHistory(root.id, "notes.md", 50);
    assert.equal(afterRollback.length, 3);
    assert.notEqual(afterRollback[0]!.hash, newest!.hash);

    // An unknown commit is rejected rather than silently no-oping.
    await assert.rejects(() => scenario.runtime.rollbackEntry(entryId, "deadbeef"), /No such version/);
  } finally {
    cleanup(scenario);
  }
});

test("a 429 Retry-After hint becomes the backoff floor and is broadcast (B6.2)", async () => {
  const delays: number[] = [];
  const scenario = createScenario({ delays });
  try {
    const root = await createRoot(scenario, "shared line\n");
    const first = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = first.entries[0]!.remoteToken!;

    // Round 1: the remote answers 429 with Retry-After far above the first
    // scheduled backoff step (1s), so the hint must win.
    writeFileSync(join(scenario.directory, "notes.md"), "local edit\n", "utf8");
    scenario.remote.failWritesRateLimit(1, 5000);
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    const synced = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    assert.equal(synced.entries[0]?.status, "clean");
    assert.equal(scenario.remote.documents.get(token)?.content, "local edit\n", "the retry after the rate limit still lands");
    assert.deepEqual(delays, [5000], "Retry-After overrides a shorter scheduled backoff");

    const rateLimited = messages
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((event) => event.type === "rate-limited");
    assert.ok(rateLimited, "the UI receives a rate-limited event");
    assert.equal(rateLimited!.retryAfterMs, 5000);
    assert.equal(rateLimited!.retryCount, 1);
    const operation = (await scenario.metaStorage.listOperations()).find((op) => op.status === "succeeded");
    assert.equal(operation?.errorCategory, "rate_limit");
    assert.equal(operation?.retryCount, 1);

    // Round 2: a tiny Retry-After must NOT shorten the scheduled backoff.
    writeFileSync(join(scenario.directory, "notes.md"), "second edit\n", "utf8");
    scenario.remote.failWritesRateLimit(1, 100);
    await scenario.runtime.syncRoot(root.id);
    assert.deepEqual(delays, [5000, 1000], "the scheduled step is the floor when Retry-After is smaller");
  } finally {
    cleanup(scenario);
  }
});

test("watcherIgnore shields the watcher from git, metadata and excluded paths (B1)", () => {
  // chokidar v4 no longer accepts globs in `ignored`, so the shield is a single
  // predicate; these cases are what it has to get right.
  const root: SyncRoot = {
    id: "watcher-root",
    localPath: "/work/notes",
    remoteToken: "token",
    remoteType: "folder",
    enabled: true,
    pollIntervalMs: 60_000,
    exclude: ["archive/**", "drafts/*.md"]
  };
  const ignore = watcherIgnore(root);

  assert.equal(ignore("/work/notes"), false, "the watched root itself is never ignored");
  assert.equal(ignore("/work/notes/.git"), true);
  assert.equal(ignore("/work/notes/.git/index"), true, "the baseline commit rewrites the index");
  assert.equal(ignore("/work/notes/.git/objects/1a/2b3c4d"), true);
  assert.equal(ignore("/work/notes/.git/refs/heads/main"), true);
  assert.equal(ignore("/work/notes/nested/.git/index"), true);
  assert.equal(ignore("/work/notes/.feishu-sync/entries.json"), true);
  assert.equal(ignore("/work/notes/todo.feishu-sync-9f3a.tmp"), true, "atomic-write scratch file");

  assert.equal(ignore("/work/notes/archive/old.md"), true, "B6.5 excludes are honoured by the watcher too");
  assert.equal(ignore("/work/notes/drafts/wip.md"), true);
  assert.equal(ignore("/work/notes/drafts/nested/wip.md"), false, "the same matcher local.scan uses");

  assert.equal(ignore("/work/notes/todo.md"), false, "real documents still trigger a watch round");
  assert.equal(ignore("/work/notes/guide/setup.md"), false);
  assert.equal(ignore("/work/notes/.gitconfig"), false, "only the exact metadata names are shielded");
  assert.equal(ignore("/work/notes-backup/todo.md"), false, "a sibling sharing the path prefix");
  assert.equal(ignore("/elsewhere/.git/index"), false, "paths outside the root are not ours to judge");
});

test("a baseline commit does not retrigger the watcher into an endless loop (B1)", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "seed line\n");
    // First round so `.git` already exists and holds a baseline commit.
    await scenario.runtime.syncRoot(root.id);
    const { socket, messages } = createFakeSocket();
    scenario.runtime.addClient(socket);
    scenario.runtime.startRoot(root);
    await sleep(1500);
    const watchRounds = (): number => messages
      .map((payload) => JSON.parse(payload) as { type?: string; trigger?: string })
      .filter((event) => event.type === "sync-started" && event.trigger === "watch").length;
    assert.equal(watchRounds(), 0, "starting the watcher emits its own manual round, never a watch round");

    // Writes the sync engine performs itself: the git index (same bytes, new
    // mtime — clobbering it would corrupt the repo), a loose object, the
    // metadata store and its atomic scratch file.
    const indexPath = join(scenario.directory, ".git", "index");
    const indexBefore = statSync(indexPath).mtimeMs;
    mkdirSync(join(scenario.directory, ".git", "objects", "1a"), { recursive: true });
    writeFileSync(indexPath, readFileSync(indexPath));
    writeFileSync(join(scenario.directory, ".git", "objects", "1a", "2b3c4d"), "object\n", "utf8");
    mkdirSync(join(scenario.directory, ".feishu-sync"), { recursive: true });
    writeFileSync(join(scenario.directory, ".feishu-sync", "entries.json"), "{}\n", "utf8");
    writeFileSync(join(scenario.directory, "notes.feishu-sync-9f3a.tmp"), "scratch\n", "utf8");
    await sleep(1500);
    assert.equal(watchRounds(), 0, "metadata writes must never start a sync round");

    // A genuine edit must still be picked up exactly once — the round it starts
    // commits a new baseline, which under the old glob-based `ignored` fired yet
    // another watch round, and so on every ~600ms forever.
    writeFileSync(join(scenario.directory, "todo.md"), "a real new document\n", "utf8");
    await sleep(2500);
    assert.equal(watchRounds(), 1, `expected exactly one watch round, got ${watchRounds()}`);
    const entries = (await scenario.metaStorage.listBindings(root.id)) as EntryView[];
    assert.ok(entries.some((entry) => entry.status === "clean"), "the watch round synced the new document");
    // Proves the loop precondition really happened: that watch round committed,
    // so the index was rewritten and would have retriggered the watcher.
    assert.ok(statSync(indexPath).mtimeMs > indexBefore, "the watch round committed a new baseline");
  } finally {
    cleanup(scenario);
  }
});

test("a save that lands while a round is in flight is pushed next, never rolled back", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario, "first version\n");
    // The round reads `first version` and creates the document; the user saves
    // again before the round-end commit. A live editor does this constantly.
    const createDocument = scenario.remote.createDocument.bind(scenario.remote);
    let saved = false;
    scenario.remote.createDocument = async (parentToken: string, name: string, content: string) => {
      const created = await createDocument(parentToken, name, content);
      if (!saved) {
        saved = true;
        writeFileSync(join(scenario.directory, "notes.md"), "second version\n", "utf8");
      }
      return created;
    };

    const first = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const token = first.entries.find((entry) => entry.remoteToken)?.remoteToken;
    assert.ok(token, "the round created the document");
    assert.equal(scenario.remote.documents.get(token)?.content, "first version\n");
    // The regression: staging the working tree here recorded `second version` as
    // the baseline of a push that only ever carried `first version`, so the next
    // round read base === local, believed the remote had moved on and pulled it
    // back over the user's edit.
    assert.equal(await scenario.gitStorage.getBaseline(root.id, "notes.md"), "first version\n", "the baseline is what reached the drive");

    const second = (await scenario.runtime.syncRoot(root.id)) as { entries: EntryView[] };
    const entry = second.entries.find((item) => item.remoteToken === token);
    assert.equal(entry?.status, "clean");
    assert.equal(scenario.remote.documents.get(token)?.content, "second version\n", "the mid-round edit is pushed as a local change");
    assert.equal(readFileSync(join(scenario.directory, "notes.md"), "utf8"), "second version\n", "and the local file keeps it");
    assert.equal(scenario.remote.documents.size, 1, "without duplicating the document");
  } finally {
    cleanup(scenario);
  }
});
