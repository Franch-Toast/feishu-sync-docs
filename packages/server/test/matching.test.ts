import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider, SyncEngine, dedupeSegment } from "@feishu-sync/core";
import type { EntryBinding, SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { SyncRuntime } from "../src/runtime.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/**
 * B: the one-to-one matching model.
 *
 * Identity is `relativePath ⟷ remoteToken`; titles are only the discovery
 * heuristic for the *first* pairing, and every branch of that heuristic has to
 * be spelled out, because the old engine silently lost documents in exactly one
 * of them (both sides exist, nothing is bound) and hard-aborted a round in
 * another (the title is already owned by a different entry).
 */

interface Harness {
  directory: string;
  globalDir: string;
  gitStorage: GitStorageImpl;
  metaStorage: JsonMetaStorage;
  remote: FakeRemote;
  root: SyncRoot;
  engine: SyncEngine;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-match-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-match-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);
  return { directory, globalDir, gitStorage, metaStorage, remote, root, engine };
}

async function teardown(scenario: Harness): Promise<void> {
  await rm(scenario.directory, { recursive: true, force: true });
  await rm(scenario.globalDir, { recursive: true, force: true });
}

function find(entries: EntryBinding[], relativePath: string): EntryBinding {
  const entry = entries.find((item) => item.relativePath === relativePath);
  if (!entry) throw new Error(`no binding for ${relativePath}: ${JSON.stringify(entries.map((item) => item.relativePath))}`);
  return entry;
}

test("scenario 1: local-only files are created once, titled by their file names", async () => {
  const scenario = await harness();
  try {
    await writeFile(join(scenario.directory, "report.md"), "# 季度报告\n\nQ3 numbers", "utf8");
    await writeFile(join(scenario.directory, "nested.md"), "# 完全不同的标题\n\nsecond", "utf8");
    const scan = await scenario.engine.scan(scenario.root);
    for (const relativePath of ["report.md", "nested.md"]) {
      assert.equal((await scenario.engine.syncEntry(find(scan.entries, relativePath), scenario.root)).status, "clean");
    }
    // B2: the drive title is the deterministic file name. The H1 is content and
    // may repeat across files, so it can never be the identity.
    assert.deepEqual([...scenario.remote.documents.values()].map((document) => document.name).sort(), ["nested", "report"]);
    assert.equal(scenario.remote.documents.get("root/report")?.content.includes("季度报告"), true);
    assert.equal((await scenario.metaStorage.listConflicts("open")).length, 0);

    // Nothing changed: a second round must not create or rewrite anything.
    await scenario.gitStorage.commitBaseline(scenario.root.id, "sync: manual", "manual");
    const rescan = await scenario.engine.scan(scenario.root);
    assert.deepEqual(rescan.entries.map((entry) => entry.status).sort(), ["clean", "clean"]);
    assert.equal(scenario.remote.documents.size, 2);
  } finally {
    await teardown(scenario);
  }
});

test("scenario 1: a nested local path mirrors itself into remote folders", async () => {
  const scenario = await harness();
  try {
    await mkdir(join(scenario.directory, "docs"), { recursive: true });
    await writeFile(join(scenario.directory, "docs", "nested.md"), "# Nested\n\nbody", "utf8");
    const scan = await scenario.engine.scan(scenario.root);
    const synced = await scenario.engine.syncEntry(find(scan.entries, "docs/nested.md"), scenario.root);
    assert.equal(synced.status, "clean");
    assert.equal(synced.remoteToken, "root/docs/nested");
    assert.equal(synced.remoteParentToken, "root/docs");
    assert.equal(scenario.remote.folders.get("root/docs")?.name, "docs");
  } finally {
    await teardown(scenario);
  }
});

test("scenario 2: an unbound remote document is imported and bound", async () => {
  const scenario = await harness();
  try {
    await scenario.remote.createDocument("root", "solo", "# Solo\n\nfrom the drive");
    const scan = await scenario.engine.scan(scenario.root);
    assert.equal(scan.entries.length, 1);
    assert.equal(scan.entries[0]?.status, "clean");
    assert.equal(scan.entries[0]?.remoteToken, "root/solo");
    assert.match(await readFile(join(scenario.directory, "solo.md"), "utf8"), /from the drive/);
    // The pairing survives a re-scan: no second document, no re-download.
    const rescan = await scenario.engine.scan(scenario.root);
    assert.equal(rescan.entries[0]?.status, "clean");
    assert.equal(scenario.remote.documents.size, 1);
  } finally {
    await teardown(scenario);
  }
});

test("scenario 2: two remote titles that clean to one file name get a token suffix", async () => {
  const scenario = await harness();
  try {
    // The drive allows `notes` and `notes.` side by side; after sanitising both
    // derive to `notes.md`. Neither copy may overwrite the other.
    await scenario.remote.createDocument("root", "notes", "# Notes one");
    await scenario.remote.createDocument("root", "notes.", "# Notes two");
    const scan = await scenario.engine.scan(scenario.root);
    const suffixPath = dedupeSegment("notes.md", "root/notes.");
    assert.notEqual(suffixPath, "notes.md");
    assert.deepEqual(scan.entries.map((entry) => entry.relativePath).sort(), ["notes.md", suffixPath].sort());
    assert.equal(find(scan.entries, suffixPath).remoteToken, "root/notes.");
    assert.match(await readFile(join(scenario.directory, "notes.md"), "utf8"), /Notes one/);
    assert.match(await readFile(join(scenario.directory, suffixPath), "utf8"), /Notes two/);
    // The suffix is deterministic, so the next round recognises both again.
    const rescan = await scenario.engine.scan(scenario.root);
    assert.deepEqual(rescan.entries.map((entry) => entry.status).sort(), ["clean", "clean"]);
    assert.equal(scenario.remote.documents.size, 2);
  } finally {
    await teardown(scenario);
  }
});

test("scenario 3: an unbound same-title document with identical content pairs instead of duplicating", async () => {
  const scenario = await harness();
  try {
    // The silent hole in the old engine: both sides exist, no binding exists,
    // so the local pass armed the file for a *push* while the remote pass
    // ignored the unclaimed document — one file, two documents on the drive.
    await writeFile(join(scenario.directory, "mine.md"), "shared line\n", "utf8");
    await scenario.remote.createDocument("root", "mine", "shared line\n");
    const scan = await scenario.engine.scan(scenario.root);
    const entry = find(scan.entries, "mine.md");
    assert.equal(entry.remoteToken, "root/mine", "the scan paired the two halves");
    assert.equal(scenario.remote.documents.size, 1);
    const synced = await scenario.engine.syncEntry(entry, scenario.root);
    assert.equal(synced.status, "clean");
    assert.equal(scenario.remote.documents.size, 1, "pairing must never create a second copy");
  } finally {
    await teardown(scenario);
  }
});

test("scenario 3: the same name with different content becomes a conflict that touches nothing", async () => {
  const scenario = await harness();
  try {
    await writeFile(join(scenario.directory, "dupe.md"), "local copy\n", "utf8");
    await scenario.remote.createDocument("root", "dupe", "remote copy\n");
    const scan = await scenario.engine.scan(scenario.root);
    const entry = find(scan.entries, "dupe.md");
    assert.equal(entry.status, "conflict", "the engine never guesses a winner");
    const conflict = (await scenario.metaStorage.listConflicts("open"))[0]!;
    assert.equal(conflict.entryId, entry.entryId);
    assert.match(conflict.reason ?? "", /同名文档/);
    assert.equal(conflict.localContent, "local copy\n");
    assert.equal(conflict.remoteContent, "remote copy\n");
    assert.equal(await readFile(join(scenario.directory, "dupe.md"), "utf8"), "local copy\n", "the local file is left alone");
    assert.equal(scenario.remote.documents.get("root/dupe")?.content, "remote copy\n", "the remote document is left alone");
    assert.equal(scenario.remote.documents.size, 1);
    // The pairing is still recorded, so a resolution has something to write to.
    assert.equal(entry.remoteToken, "root/dupe");
  } finally {
    await teardown(scenario);
  }
});

test("scenario 4: nothing on either side creates nothing", async () => {
  const scenario = await harness();
  try {
    const scan = await scenario.engine.scan(scenario.root);
    assert.deepEqual(scan.entries, []);
    assert.equal(scan.scanned, 0);
    assert.equal(scenario.remote.documents.size, 0);
    assert.equal(scenario.remote.folders.size, 0, "no placeholder folders for an empty root");
    assert.equal(scenario.remote.createFolderCalls, 0);
    assert.equal((await scenario.metaStorage.listBindings(scenario.root.id)).length, 0);
  } finally {
    await teardown(scenario);
  }
});

test("B2: a creation whose body push fails keeps its token and is adopted next round", async () => {
  const scenario = await harness();
  try {
    // Models the real two-step create: `docx/v1/documents` answered with a
    // document id, the `docs_ai` overwrite died. The document exists on the
    // drive, so the binding must own its token immediately.
    await writeFile(join(scenario.directory, "half.md"), "# Half\n\nbody", "utf8");
    scenario.remote.stubOnCreate = true;
    scenario.remote.failNextWrite("simulated overwrite failure");
    const scan = await scenario.engine.scan(scenario.root);
    await assert.rejects(scenario.engine.syncEntry(find(scan.entries, "half.md"), scenario.root), /simulated overwrite failure/);
    const persisted = (await scenario.metaStorage.listBindings(scenario.root.id))[0]!;
    assert.equal(persisted.remoteToken, "root/half", "the token lands before the content does");
    assert.equal(scenario.remote.documents.size, 1);

    scenario.remote.stubOnCreate = false;
    const retryScan = await scenario.engine.scan(scenario.root);
    const retry = await scenario.engine.syncEntry(find(retryScan.entries, "half.md"), scenario.root);
    assert.equal(retry.status, "clean");
    assert.equal(scenario.remote.documents.size, 1, "the next round adopts the half-created document instead of making a second one");
    assert.match(scenario.remote.documents.get("root/half")!.content, /body/);
  } finally {
    await teardown(scenario);
  }
});

/** Runtime-level fixture: the collision actions are offered through the
 *  workbench endpoints, which live on SyncRuntime. */
async function runtimeScenario(): Promise<{ runtime: SyncRuntime; metaStorage: JsonMetaStorage; remote: FakeRemote; directory: string; globalDir: string; root: SyncRoot }> {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-collide-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const runtime = new SyncRuntime(gitStorage, metaStorage, new FilesystemProvider(), remote, undefined, undefined, undefined, undefined, { sleep: async () => {} });
  await writeFile(join(directory, "alpha.md"), "# Alpha\n\na", "utf8");
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  await runtime.syncRoot(root.id);
  return { runtime, metaStorage, remote, directory, globalDir, root };
}

async function teardownRuntime(scenario: { runtime: SyncRuntime; directory: string; globalDir: string }): Promise<void> {
  scenario.runtime.stop();
  await rm(scenario.directory, { recursive: true, force: true });
  await rm(scenario.globalDir, { recursive: true, force: true });
}

test("B4: a title collision is a conflict with three actions, not an aborted round", async () => {
  const scenario = await runtimeScenario();
  try {
    const alpha = (await scenario.metaStorage.listBindings(scenario.root.id))[0]!;
    // The user renames the document in the drive onto a name a second local file
    // would claim.
    scenario.remote.rename(alpha.remoteToken!, "beta");
    await writeFile(join(scenario.directory, "beta.md"), "# Beta\n\nb", "utf8");

    // The old code threw here, so the whole round died and *nothing* else in the
    // folder synced.
    const result = (await scenario.runtime.syncRoot(scenario.root.id)) as { entries: EntryBinding[] };
    const beta = find(result.entries, "beta.md");
    assert.equal(beta.status, "conflict");
    assert.equal(beta.remoteToken, undefined, "an unowned title must not be stolen implicitly");
    const conflict = (await scenario.metaStorage.listConflicts("open"))[0]!;
    assert.equal(conflict.collidingToken, alpha.remoteToken);
    assert.equal(conflict.collidingOwnerPath, "alpha.md");
    assert.match(conflict.reason ?? "", /重命名本地文件/);

    // Action 1「保留本地」 cannot work while the title is owned elsewhere and is
    // answered with the Chinese guidance the workbench shows.
    await assert.rejects(scenario.runtime.resolveConflict(conflict, { resolution: "local" }), /重命名本地文件/);
    // Action 2「忽略」 freezes the row and leaves the other owner untouched.
    await scenario.runtime.setEntryIgnored(beta.entryId, true);
    assert.equal((await scenario.metaStorage.listBindings(scenario.root.id)).find((entry) => entry.relativePath === "beta.md")?.ignoredAt !== undefined, true);
    assert.equal(scenario.remote.documents.size, 1);
    await scenario.runtime.setEntryIgnored(beta.entryId, false);
    // Action 3「采用该远端文档」 transfers the colliding document to beta: the
    // conflict closes, beta owns a token and its local file shows the adopted
    // body, and nothing on the drive is ever deleted to make that happen.
    const resolved = await scenario.runtime.resolveConflict(conflict, { resolution: "remote" });
    assert.equal(resolved.resolution, "remote");
    assert.equal((await scenario.metaStorage.listConflicts("open")).length, 0);
    const bindings = await scenario.metaStorage.listBindings(scenario.root.id);
    assert.equal(find(bindings, "beta.md").remoteToken, alpha.remoteToken);
    assert.equal(await readFile(join(scenario.directory, "beta.md"), "utf8"), conflict.remoteContent);
    assert.ok(scenario.remote.documents.has(alpha.remoteToken!), "adopting transfers a document, never copies or deletes it");
  } finally {
    await teardownRuntime(scenario);
  }
});

test("B4: renaming the local file is the other way out of a title collision", async () => {
  const scenario = await harness();
  try {
    await writeFile(join(scenario.directory, "alpha.md"), "# Same\n\na", "utf8");
    await writeFile(join(scenario.directory, "beta.md"), "# Same\n\nb", "utf8");
    const scan = await scenario.engine.scan(scenario.root);
    const alpha = await scenario.engine.syncEntry(find(scan.entries, "alpha.md"), scenario.root);
    assert.equal(alpha.status, "clean");
    // Simulate the drive-side rename that steals the title beta would claim.
    scenario.remote.rename(alpha.remoteToken!, "beta");
    const collisionScan = await scenario.engine.scan(scenario.root);
    const collided = await scenario.engine.syncEntry(find(collisionScan.entries, "beta.md"), scenario.root);
    assert.equal(collided.status, "conflict");
    assert.equal(scenario.remote.documents.size, 1);

    // The user renames the local file: the deterministic title is free again.
    await writeFile(join(scenario.directory, "beta-renamed.md"), "# Same\n\nb", "utf8");
    const scan2 = await scenario.engine.scan(scenario.root);
    const renamed = await scenario.engine.syncEntry(find(scan2.entries, "beta-renamed.md"), scenario.root);
    assert.equal(renamed.status, "clean");
    assert.equal(renamed.remoteToken, "root/beta-renamed");
    assert.equal(scenario.remote.documents.size, 2);
    assert.deepEqual([...scenario.remote.documents.values()].map((document) => document.name).sort(), ["beta", "beta-renamed"]);
  } finally {
    await teardown(scenario);
  }
});
