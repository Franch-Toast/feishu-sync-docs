import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FilesystemProvider, SyncEngine } from "@feishu-sync/core";
import type { LocalFile, LocalScanOptions, SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { FakeRemote } from "./helpers/fake-remote.js";

test("sync engine creates once, pulls remote changes, and records conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  const path = join(directory, "notes.md");
  await writeFile(path, "# Notes\n\noriginal", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  let scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  let entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  const token = entry.remoteToken!;
  // Commit baseline after first sync
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");
  assert.equal((await engine.scan(root)).entries[0]?.status, "clean");

  remote.edit(token, "# Notes\n\nremote change");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  assert.match(await readFile(path, "utf8"), /remote change/);
  // Commit baseline after pull
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");

  await writeFile(path, "# Notes\n\nlocal change", "utf8");
  await engine.scan(root);
  remote.edit(token, "# Notes\n\nremote again");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  await engine.syncEntry(scan.entries[0]!, root);
  assert.equal((await metaStorage.listConflicts("open")).length, 1);
  remote.edit(token, "# Notes\n\nremote after conflict");
  await engine.scan(root);
  assert.equal((await metaStorage.listConflicts("open"))[0]?.remoteContent, "# Notes\n\nremote after conflict");
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("imports a remote-only document into the local tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-remote-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  await remote.createDocument("root", "remote-notes", "# Remote\n\nCreated in Feishu");
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const result = await engine.scan(root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.status, "clean");
  assert.equal(await readFile(join(directory, "remote-notes.md"), "utf8"), "# Remote\n\nCreated in Feishu");
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("two files sharing an H1 push two documents titled by their file names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-dup-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "one.md"), "# Same Title\n\nfirst", "utf8");
  await writeFile(join(directory, "two.md"), "# Same Title\n\nsecond", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  // B2: the drive title is now the deterministic file name, not the H1, so the
  // case that used to abort the round with "already has a document named …" is
  // simply two independent documents.
  const scan = await engine.scan(root);
  for (const relativePath of ["one.md", "two.md"]) {
    const entry = scan.entries.find((item) => item.relativePath === relativePath)!;
    assert.equal((await engine.syncEntry(entry, root)).status, "clean");
  }
  assert.equal(remote.documents.size, 2);
  assert.deepEqual([...remote.documents.values()].map((doc) => doc.name).sort(), ["one", "two"]);
  assert.equal((await metaStorage.listConflicts("open")).length, 0);
  // The remotes keep the titles they were created with, so a later scan of the
  // persisted binding is still unambiguous.
  const rescan = await engine.scan(root);
  assert.deepEqual(rescan.entries.map((entry) => entry.status).sort(), ["clean", "clean"]);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("a remote title owned by another entry becomes an actionable conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-collide-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "alpha.md"), "# Alpha\n\na", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const first = (await engine.scan(root)).entries[0]!;
  const synced = await engine.syncEntry(first, root);
  assert.equal(synced.status, "clean");
  // The user renames the document in the drive, then creates a local file whose
  // deterministic title is now taken by the still-bound alpha entry.
  remote.rename(synced.remoteToken!, "beta");
  await writeFile(join(directory, "beta.md"), "# Beta\n\nb", "utf8");

  const second = (await engine.scan(root)).entries.find((entry) => entry.relativePath === "beta.md")!;
  const collided = await engine.syncEntry(second, root);
  assert.equal(collided.status, "conflict");
  assert.equal(collided.remoteToken, undefined);
  assert.equal(remote.documents.size, 1);
  const conflict = (await metaStorage.listConflicts("open"))[0]!;
  assert.match(conflict.reason ?? "", /远端同名文档/);
  assert.equal(conflict.collidingToken, synced.remoteToken);
  assert.equal(conflict.collidingOwnerPath, "alpha.md");

  // Action 1 (adopt): the colliding document changes hands, alpha re-pushes
  // under its own file name, and no second copy is ever created.
  const adopted = await engine.adoptCollidingDocument(collided.entryId, conflict.collidingToken!);
  assert.equal(adopted.remoteToken, synced.remoteToken);
  const alpha = (await metaStorage.listBindings(root.id)).find((entry) => entry.relativePath === "alpha.md");
  assert.equal(alpha?.remoteToken, undefined);
  assert.equal(alpha?.status, "pending");
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("adopts an unbound same-title remote document instead of duplicating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-adopt-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "orphan.md"), "# Orphan Notes\n\nlocal body", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  // Simulate a previous partial failure: the remote document exists but no
  // local entry is bound to it yet.
  const orphan = await remote.createDocument("root", "orphan", "# Orphan Notes\n\nlocal body");
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  assert.equal(scan.entries.length, 1);
  const entry = scan.entries[0]!;
  const synced = await engine.syncEntry(entry, root);
  assert.equal(synced.remoteToken, orphan.token);
  assert.equal(synced.status, "clean");
  assert.equal(remote.documents.size, 1);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("reuses the cached remote tree so nested pushes create each folder once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-folder-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await mkdir(join(directory, "deep"), { recursive: true });
  await writeFile(join(directory, "deep", "a.md"), "# A\n\nfirst", "utf8");
  await writeFile(join(directory, "deep", "b.md"), "# B\n\nsecond", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  for (const entry of scan.entries) await engine.syncEntry(entry, root);
  assert.equal(remote.createFolderCalls, 1);
  assert.equal(remote.folders.size, 1);
  assert.equal(remote.listTreeCalls, 1);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("an incremental scan scope only probes the in-scope entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scope-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(directory, name), `# ${name}\n\nbody`, "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  // Bind all three files so each carries a remote token and a clean baseline.
  const first = await engine.scan(root);
  for (const entry of first.entries) await engine.syncEntry(entry, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");

  // A full poll scan probes every bound document against the remote side.
  remote.getDocumentCalls = 0;
  await engine.scan(root, "poll");
  const fullCalls = remote.getDocumentCalls;
  assert.equal(fullCalls, 3);

  // An incremental watch scan restricted to one path probes only that entry,
  // which is the whole point of passing a scope from the watcher/event path.
  remote.getDocumentCalls = 0;
  await engine.scan(root, "watch", { relativePaths: ["a.md"] });
  const scopedCalls = remote.getDocumentCalls;
  assert.equal(scopedCalls, 1);
  assert.ok(scopedCalls < fullCalls);

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("pull-only mode never creates a remote document for a local-only file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-pull-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "local-only.md"), "# Local\n\nonly here", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000, mode: "pull-only" });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  const entry = scan.entries.find((item) => item.relativePath === "local-only.md")!;
  const synced = await engine.syncEntry(entry, root);
  // pull-only has nothing to pull down, so the local-only file is left as-is.
  assert.equal(remote.documents.size, 0);
  assert.equal(synced.remoteToken, undefined);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("push-only mode does not import a remote-only document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-push-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  await remote.createDocument("root", "remote-only", "# Remote\n\nonly there");
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000, mode: "push-only" });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  // push-only never pulls the remote-only document down into the local tree.
  assert.equal(scan.entries.length, 0);
  await assert.rejects(() => readFile(join(directory, "remote-only.md"), "utf8"));
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("folder bindings persist so a cold engine reuses the remote folder instead of recreating it (B3)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-folderbind-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await mkdir(join(directory, "deep"), { recursive: true });
  await writeFile(join(directory, "deep", "a.md"), "# A\n\nfirst", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  for (const entry of scan.entries) await engine.syncEntry(entry, root);
  assert.equal(remote.createFolderCalls, 1);
  // folders.json now maps "deep" to the created remote folder token.
  const deepFolder = await metaStorage.getFolderBinding(root.id, "deep");
  assert.ok(deepFolder?.remoteToken);

  // Simulate a restart: a cold engine (no cached remote tree) against a drive
  // that has not been re-listed. A second file in the same folder must resolve
  // its parent from folders.json — no folder is created and none is listed.
  await writeFile(join(directory, "deep", "b.md"), "# B\n\nsecond", "utf8");
  const remote2 = new FakeRemote();
  const engine2 = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote2);
  const scan2 = await engine2.scan(root);
  const bEntry = scan2.entries.find((item) => item.relativePath === "deep/b.md")!;
  await engine2.syncEntry(bEntry, root);
  assert.equal(remote2.createFolderCalls, 0);
  assert.equal(remote2.folders.size, 0);
  assert.equal(remote2.documents.size, 1);

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("a local rename is detected as a move and does not create a duplicate remote document (B3)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-rename-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "old.md"), "# Doc\n\nbody", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  let scan = await engine.scan(root);
  const synced = await engine.syncEntry(scan.entries[0]!, root);
  const token = synced.remoteToken!;
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");
  assert.equal(remote.documents.size, 1);

  // Rename locally: identical content resurfaces at a new, unbound path.
  await rm(join(directory, "old.md"));
  await writeFile(join(directory, "new.md"), "# Doc\n\nbody", "utf8");

  scan = await engine.scan(root);
  const moved = await metaStorage.getBinding(root.id, "new.md");
  assert.ok(moved, "the binding should follow the file to its new path");
  assert.equal(moved!.remoteToken, token);
  assert.equal(await metaStorage.getBinding(root.id, "old.md"), undefined);

  // A full sync round reuses the same remote document: still exactly one copy.
  for (const entry of scan.entries) await engine.syncEntry(entry, root);
  assert.equal(remote.documents.size, 1);

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("an ambiguous rename surfaces a conflict instead of guessing the successor (B3)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-rename-amb-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "original.md"), "# Doc\n\nbody", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  const synced = await engine.syncEntry(scan.entries[0]!, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");

  // The bound path vanishes and TWO identical unbound files appear: the engine
  // cannot tell which one is the successor, so it defers to the user.
  await rm(join(directory, "original.md"));
  await writeFile(join(directory, "copy-a.md"), "# Doc\n\nbody", "utf8");
  await writeFile(join(directory, "copy-b.md"), "# Doc\n\nbody", "utf8");

  await engine.scan(root);
  const binding = await metaStorage.getBinding(root.id, "original.md");
  assert.equal(binding?.status, "conflict");
  assert.equal(binding?.remoteToken, synced.remoteToken);
  const conflicts = await metaStorage.listConflicts("open");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.entryId, binding?.entryId);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("exclude globs keep matching paths out of the scan and freeze already-bound entries (B6.5)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-exclude-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "keep.md"), "# Keep\n\nsynced", "utf8");
  await writeFile(join(directory, "tmp-notes.md"), "# Tmp\n\nexcluded by pattern", "utf8");
  await mkdir(join(directory, "drafts"), { recursive: true });
  await writeFile(join(directory, "drafts", "scratch.md"), "# Scratch\n\nnever synced", "utf8");
  await mkdir(join(directory, "archive"), { recursive: true });
  await writeFile(join(directory, "archive", "old.md"), "# Old\n\nsynced first", "utf8");

  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000, exclude: ["drafts", "tmp-*.md"] });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  // Excluded paths never surface as entries and never get a binding.
  let scan = await engine.scan(root);
  const visible = (): string[] => scan.entries.filter((entry) => !entry.ignoredAt).map((entry) => entry.relativePath).sort();
  assert.deepEqual(visible(), ["archive/old.md", "keep.md"]);
  assert.equal(await metaStorage.getBinding(root.id, "drafts/scratch.md"), undefined);
  assert.equal(await metaStorage.getBinding(root.id, "tmp-notes.md"), undefined);

  for (const entry of scan.entries) await engine.syncEntry(entry, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");
  assert.equal(remote.documents.size, 2, "only the non-excluded documents reach the remote");
  assert.ok(![...remote.documents.keys()].some((token) => token.includes("scratch") || token.includes("tmp-")));
  assert.equal(remote.createFolderCalls, 1, "only the non-excluded archive folder is created");
  assert.equal(await metaStorage.getFolderBinding(root.id, "."), undefined, "a root-level document must not invent a '.' folder");

  // Narrowing the exclusion later freezes the already-bound entry as ignored:
  // it is neither re-synced nor misreported as local-missing, and the remote
  // copy is left alone for the user to restore by editing the patterns.
  const updated = await metaStorage.updateRoot(root.id, { exclude: ["drafts", "tmp-*.md", "archive"] });
  scan = await engine.scan(updated);
  assert.deepEqual(visible(), ["keep.md"]);
  const frozen = await metaStorage.getBinding(root.id, "archive/old.md");
  assert.ok(frozen?.ignoredAt, "an excluded binding is marked ignored");
  assert.notEqual(frozen?.status, "local-missing");
  assert.equal(remote.documents.size, 2, "excluding a path never deletes its remote document");

  // Removing the pattern again thaws the entry back into the scan.
  const thawed = await metaStorage.updateRoot(root.id, { exclude: ["drafts"] });
  await metaStorage.setBinding(root.id, "archive/old.md", { ...frozen!, ignoredAt: undefined, updatedAt: new Date().toISOString() });
  scan = await engine.scan(thawed);
  assert.ok(scan.entries.some((entry) => entry.relativePath === "archive/old.md"));

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

/** Records which slice of the tree each round asked the local provider for. */
class CountingLocal extends FilesystemProvider {
  readonly scopes: (readonly string[] | undefined)[] = [];

  override async scan(root: SyncRoot, options?: LocalScanOptions): Promise<LocalFile[]> {
    this.scopes.push(options?.onlyPaths);
    return super.scan(root, options);
  }
}

test("a watch round hashes only the changed path and a poll round still walks everything (E1)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scopedlocal-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(directory, name), `# ${name}\n\nbody`, "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const local = new CountingLocal();
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, local, remote);

  const first = await engine.scan(root);
  for (const entry of first.entries) await engine.syncEntry(entry, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");

  local.scopes.length = 0;
  await engine.scan(root, "watch", { relativePaths: ["a.md"] });
  assert.deepEqual(local.scopes[0], ["a.md"], "the watcher round must stat one file, not the tree");

  local.scopes.length = 0;
  await engine.scan(root, "poll");
  assert.equal(local.scopes[0], undefined, "a poll round has no scope and keeps the full walk");

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("an event round reuses the cached tree and fetches only the announced token (E2)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-event-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(directory, name), `# ${name}\n\nbody`, "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const first = await engine.scan(root);
  for (const entry of first.entries) await engine.syncEntry(entry, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");
  const token = (await metaStorage.getBinding(root.id, "b.md"))!.remoteToken!;
  remote.edit(token, "# b.md\n\nedited in Feishu");

  remote.listTreeCalls = 0;
  remote.getDocumentCalls = 0;
  const scoped = await engine.scan(root, "event", { remoteTokens: [token] });
  assert.equal(remote.listTreeCalls, 0, "a drive event must not re-list the whole folder");
  assert.equal(remote.getDocumentCalls, 1, "only the token that announced the change is fetched");
  assert.equal((await metaStorage.getBinding(root.id, "b.md"))?.status, "pending", "the changed entry is armed for the pull");
  assert.equal((await metaStorage.getBinding(root.id, "a.md"))?.status, "clean", "untouched entries stay clean");
  assert.equal(scoped.scanned, 1);

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("a token the cache cannot resolve degrades to one full listing and says so (E5)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-degrade-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "a.md"), "# a.md\n\nbody", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const first = await engine.scan(root);
  for (const entry of first.entries) await engine.syncEntry(entry, root);
  await gitStorage.commitBaseline(root.id, "sync: manual", "manual");

  engine.drainWarnings();
  remote.listTreeCalls = 0;
  await engine.scan(root, "event", { remoteTokens: ["a-token-nobody-has-ever-seen"] });
  assert.equal(remote.listTreeCalls, 1, "correctness outranks the API budget: exactly one full listing");
  assert.match(engine.drainWarnings().join("\n"), /回退为全量列举/);
  assert.equal((await metaStorage.getBinding(root.id, "a.md"))?.status, "clean", "the degraded round invents nothing");

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

