import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider } from "@feishu-sync/core";
import type { OperationRecord, RemoteTree, RoundSummary, SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { SyncRuntime } from "../src/runtime.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/**
 * A: the lifecycle of a failing task.
 *
 * The old semantics revived `error` entries on every scan and let one round try
 * the same file three times, so a permanently broken file burned a round forever
 * and the「失败待处理」queue kept growing. These cases pin the new contract:
 * stop at the first failure, stay stopped until something changes or a human
 * acts, and make every round visible while it runs.
 */

interface Scenario {
  gitStorage: GitStorageImpl;
  metaStorage: JsonMetaStorage;
  remote: FakeRemote;
  runtime: SyncRuntime;
  directory: string;
  globalDir: string;
}

function createScenario(remote?: FakeRemote): Scenario {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-life-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remoteProvider = remote ?? new FakeRemote();
  // Zero-delay backoff so the auto-retry budget is spent without real waiting.
  const runtime = new SyncRuntime(gitStorage, metaStorage, new FilesystemProvider(), remoteProvider, undefined, undefined, undefined, undefined, { sleep: async () => {} });
  return { gitStorage, metaStorage, remote: remoteProvider, runtime, directory, globalDir };
}

async function createRoot(scenario: Scenario, content = "# Notes\n\nlocal body"): Promise<SyncRoot> {
  writeFileSync(join(scenario.directory, "notes.md"), content, "utf8");
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

/** Every per-entry record of a round, oldest last (listOperations is newest-first). */
async function entryRecords(scenario: Scenario, rootId: string): Promise<OperationRecord[]> {
  return (await scenario.metaStorage.listOperations({ rootId, limit: 500 })).filter((operation) => operation.operation === "sync-entry");
}

async function roundRecords(scenario: Scenario, rootId: string): Promise<OperationRecord[]> {
  return (await scenario.metaStorage.listOperations({ rootId, limit: 500 })).filter((operation) => operation.operation === "sync-round");
}

async function waitUntil(predicate: () => Promise<boolean>, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A remote whose listing blocks until the test releases it, so a round can be
 *  observed while it is still in flight. */
class BlockingRemote extends FakeRemote {
  private release!: () => void;
  private readonly blocked = new Promise<void>((resolve) => { this.release = resolve; });
  listingAttempts = 0;

  override async listTree(root: SyncRoot): Promise<RemoteTree> {
    this.listingAttempts += 1;
    await this.blocked;
    return super.listTree(root);
  }

  releaseListTree(): void {
    this.release();
  }
}

/** A remote whose listing always fails, to break a whole round. */
class BrokenListingRemote extends FakeRemote {
  broken = true;

  override async listTree(root: SyncRoot): Promise<RemoteTree> {
    if (this.broken) throw new Error("simulated listing failure");
    return super.listTree(root);
  }
}

/** FakeRemote injects failures in `applyPatch` only, so a first push (which
 *  creates the document) always succeeds: sync once, edit locally and only then
 *  break writes — that puts the failure on the push path of a bound entry. */
async function breakThePush(scenario: Scenario, root: SyncRoot): Promise<void> {
  await scenario.runtime.syncRoot(root.id);
  writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nsecond edit", "utf8");
  scenario.remote.failWrites = true;
  await scenario.runtime.syncRoot(root.id);
}

async function notesStatus(scenario: Scenario, rootId: string): Promise<string | undefined> {
  return (await scenario.metaStorage.listBindings(rootId)).find((binding) => binding.relativePath === "notes.md")?.status;
}

test("a persistently failing entry is attempted once per round and stays in error", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    assert.equal(await notesStatus(scenario, root.id), "error");

    const records = await entryRecords(scenario, root.id);
    assert.equal(records.length, 2, "the successful push plus exactly one record for the failed round (A2)");
    const record = records[0]!;
    assert.equal(record.status, "failed");
    assert.equal(record.needsAction, true, "a failure whose retry budget is spent waits for a human");
    assert.equal(record.retryCount, 3, "the auto-retry budget lives inside the single record");
    assert.match(record.error ?? "", /persistent/);

    // Two more rounds: the entry is still broken, but nothing re-arms it, so no
    // new work is created (A1).
    await scenario.runtime.syncRoot(root.id);
    await scenario.runtime.syncRoot(root.id);
    assert.equal((await entryRecords(scenario, root.id)).length, 2, "an error entry must not be retried by later rounds");
    assert.equal(await notesStatus(scenario, root.id), "error");
  } finally {
    cleanup(scenario);
  }
});

test("changing the local file re-arms a failed entry", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    assert.equal((await entryRecords(scenario, root.id)).length, 2);

    // A round with nothing new to try still leaves the entry alone.
    await scenario.runtime.syncRoot(root.id);
    assert.equal((await entryRecords(scenario, root.id)).length, 2);

    // An edit gives it something new to try with (A1).
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nthird edit", "utf8");
    await scenario.runtime.syncRoot(root.id);
    assert.equal((await entryRecords(scenario, root.id)).length, 3, "a local edit re-arms the error entry");
    assert.equal(await notesStatus(scenario, root.id), "error");
  } finally {
    cleanup(scenario);
  }
});

test("one entry owns exactly one 失败待处理 record however many rounds fail", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    const pending = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks;
    assert.equal(pending.length, 1);
    const waitingId = pending[0]!.id;

    // The user edits the file, the round re-arms the entry and it fails again.
    // The waiting record absorbs the new failure instead of a second row piling
    // up in the queue (A3).
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nfourth edit", "utf8");
    await scenario.runtime.syncRoot(root.id);
    const after = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks;
    assert.equal(after.length, 1, "the human queue holds one row per broken entry");
    assert.equal(after[0]?.id, waitingId, "the same record keeps the queue slot");
    const failed = (await entryRecords(scenario, root.id)).filter((record) => record.status === "failed");
    assert.equal(failed.length, 2, "the superseded attempt stays in the history");
    assert.equal(failed.filter((record) => record.needsAction).length, 1);
  } finally {
    cleanup(scenario);
  }
});

test("retrying a task takes the record out of the queue and re-arms the entry", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    const failed = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks;
    assert.equal(failed.length, 1);
    const entryId = failed[0]!.entryId!;

    await scenario.runtime.retryTask(failed[0]!.id);
    const original = await scenario.metaStorage.getOperation(failed[0]!.id);
    assert.equal(original?.needsAction, false, "acting on a record retires it (A3)");
    // The retry failed again (writes are still broken), so the entry is back in
    // the queue under a *different* record — never two at once.
    const pending = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks;
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0]!.id, failed[0]!.id);
    assert.equal(pending[0]?.entryId, entryId);
    assert.equal(await notesStatus(scenario, root.id), "error");
  } finally {
    cleanup(scenario);
  }
});

test("ignoring an entry leaves the failure queue, restoring brings it back", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    const entryId = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks[0]!.entryId!;

    const ignored = await scenario.runtime.setEntryIgnored(entryId, true);
    assert.ok(ignored.ignoredAt);
    assert.equal((await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks.length, 0, "ignoring is a way out of the queue (A3)");
    // A frozen entry is not re-evaluated, so ignoring also stops the rounds.
    await scenario.runtime.syncRoot(root.id);
    assert.equal((await entryRecords(scenario, root.id)).length, 2);

    scenario.remote.failWrites = false;
    await scenario.runtime.setEntryIgnored(entryId, false);
    const restored = (await scenario.runtime.syncRoot(root.id)) as { entries: Array<{ entryId: string; status: string }> };
    assert.equal(restored.entries.find((entry) => entry.entryId === entryId)?.status, "clean");
    assert.equal((await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks.length, 0);
  } finally {
    cleanup(scenario);
  }
});

test("a successful manual resync retires the waiting failure record", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    await breakThePush(scenario, root);
    const failed = (await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks;
    const entryId = failed[0]!.entryId!;
    assert.equal(await notesStatus(scenario, root.id), "error");

    // The 「重试」 button on the entry row goes through syncEntryNow, which
    // records nothing of its own — the queue must still drain once it works.
    scenario.remote.failWrites = false;
    const synced = await scenario.runtime.syncEntryNow(entryId);
    assert.equal(synced.status, "clean");
    assert.equal((await scenario.runtime.listTasks({ status: "failed", rootId: root.id })).tasks.length, 0, "a fixed entry must not stay in the human queue");
    assert.match(readFileSync(join(scenario.directory, "notes.md"), "utf8"), /second edit/);
  } finally {
    cleanup(scenario);
  }
});

test("every round is visible as a sync-round task and reports a summary", async () => {
  const remote = new BlockingRemote();
  const scenario = createScenario(remote);
  try {
    const root = await createRoot(scenario);
    const round = scenario.runtime.syncRoot(root.id);
    // While the listing is blocked the round must already be in「进行中」.
    await waitUntil(
      async () => (await scenario.runtime.listTasks({ status: "active", rootId: root.id })).tasks.some((task) => task.operation === "sync-round"),
      "the round never showed up as an active task"
    );
    remote.releaseListTree();
    const result = (await round) as { roundId: string; summary: RoundSummary };
    assert.ok(result.roundId, "the round endpoint reports which record it ran as");
    const record = await scenario.metaStorage.getOperation(result.roundId);
    assert.equal(record?.operation, "sync-round");
    assert.equal(record?.status, "succeeded");
    assert.equal(record?.entryId, undefined, "a round record is not bound to one entry");
    assert.deepEqual(record?.summary, { scanned: 1, pushed: 1, pulled: 0, merged: 0, conflicts: 0, failed: 0, skipped: 0 });

    // A round that finds nothing still gets exactly one visible record, with a
    // summary of zeroes — the old behaviour was to show nothing at all.
    await scenario.runtime.syncRoot(root.id);
    const rounds = await roundRecords(scenario, root.id);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0]?.summary?.scanned, 1);
    assert.equal(rounds[0]?.summary?.pushed, 0);
  } finally {
    cleanup(scenario);
  }
});

test("a round that dies mid-scan fails visibly and can be retried as a round", async () => {
  const remote = new BrokenListingRemote();
  const scenario = createScenario(remote);
  try {
    const root = await createRoot(scenario);
    await assert.rejects(scenario.runtime.syncRoot(root.id), /simulated listing failure/);
    const rounds = await roundRecords(scenario, root.id);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]?.status, "failed");
    assert.equal(rounds[0]?.needsAction, true, "a dead round waits for a human like any other failure");
    assert.match(rounds[0]?.error ?? "", /listing failure/);
    assert.equal(rounds[0]?.errorCategory, "unknown");

    // Retrying a round record means "run the round again", not "entry not bound".
    remote.broken = false;
    const retried = await scenario.runtime.retryTask(rounds[0]!.id);
    assert.equal(retried.ok, true);
    assert.equal((await scenario.metaStorage.getOperation(rounds[0]!.id))?.needsAction, false);
    const entries = await scenario.metaStorage.listBindings(root.id);
    assert.equal(entries[0]?.status, "clean", "the retried round actually synced the file");
  } finally {
    cleanup(scenario);
  }
});

test("start() cancels tasks left queued or running by the previous process", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const queued = await scenario.metaStorage.addOperation({ rootId: root.id, direction: "merge", operation: "sync-entry", trigger: "poll", startedAt: "2026-01-01T00:00:00.000Z", maxRetries: 3 });
    const running = await scenario.metaStorage.addOperation({ rootId: root.id, direction: "push", operation: "sync-round", trigger: "manual" });
    await scenario.metaStorage.updateOperation(running.id, { status: "running" });
    const done = await scenario.metaStorage.addOperation({ rootId: root.id, direction: "push", operation: "sync-entry", trigger: "poll" });
    await scenario.metaStorage.updateOperation(done.id, { status: "succeeded", completedAt: new Date().toISOString() });

    await scenario.runtime.start();

    assert.equal((await scenario.metaStorage.getOperation(queued.id))?.status, "cancelled");
    const cancelledRunning = await scenario.metaStorage.getOperation(running.id);
    assert.equal(cancelledRunning?.status, "cancelled");
    assert.match(cancelledRunning?.error ?? "", /服务重启/);
    assert.equal(cancelledRunning?.needsAction, false, "an interrupted round is not a failure awaiting action");
    assert.equal((await scenario.metaStorage.getOperation(done.id))?.status, "succeeded", "finished records are untouched");
    assert.equal((await scenario.runtime.listTasks({ status: "active", rootId: root.id })).tasks.length, 0, "「进行中」must not carry tasks from a dead process");
  } finally {
    cleanup(scenario);
  }
});
