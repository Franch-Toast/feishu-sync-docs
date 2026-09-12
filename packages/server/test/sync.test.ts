import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FilesystemProvider, SyncEngine, parseMarkdown } from "@feishu-sync/core";
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

test("blocks duplicate-title pushes instead of creating a second remote copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-dup-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "one.md"), "# Same Title\n\nfirst", "utf8");
  await writeFile(join(directory, "two.md"), "# Same Title\n\nsecond", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  remote.simulateH1Title = true;
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  const first = scan.entries.find((entry) => entry.relativePath === "one.md")!;
  const synced = await engine.syncEntry(first, root);
  assert.equal(synced.status, "clean");
  const second = scan.entries.find((entry) => entry.relativePath === "two.md")!;
  await assert.rejects(() => engine.syncEntry(second, root), /already has a document named "Same Title"/);
  assert.equal(remote.documents.size, 1);
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

test("rebinds by title when the remote document lives in a subfolder (H1 title ≠ path)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-title-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "Weekly Meeting.md"), "# Weekly Meeting\n\nagenda body", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  // The drive copy lives in a subfolder, so the remote relative path
  // ("sub/Weekly Meeting.md") can never equal the local path; the title does.
  const sub = await remote.createFolder("root", "sub");
  const created = await remote.createDocument(sub.token, "Weekly Meeting", "# Weekly Meeting\n\nagenda body");
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  // The title match re-binds instead of importing a duplicate copy.
  assert.equal(remote.documents.size, 1, "no duplicate document is imported");
  const binding = await metaStorage.getBinding(root.id, "Weekly Meeting.md");
  assert.equal(binding?.remoteToken, created.token);
  const entry = await engine.syncEntry(binding!, root);
  assert.equal(entry.status, "clean");

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("identical same-name remote duplicates collapse onto the bound copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-dedupe-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "notes.md"), "# Notes\n\nshared body", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  const entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  const bound = remote.documents.get(entry.remoteToken!)!;

  // A second document with the same parent, same title and the same content:
  // governance collapses it onto the bound copy instead of deadlocking.
  const parsed = parseMarkdown("# Notes\n\nshared body");
  remote.documents.set("root/notes-shadow", {
    token: "root/notes-shadow",
    name: bound.name,
    type: "document",
    parentToken: bound.parentToken,
    content: "# Notes\n\nshared body",
    contentHash: parsed.contentHash,
    revisionId: 4242,
    blocks: []
  });
  await engine.scan(root);
  assert.ok(!remote.documents.has("root/notes-shadow"), "the identical duplicate is soft-deleted");
  assert.ok(remote.documents.has(entry.remoteToken!), "the bound copy survives");
  assert.equal((await metaStorage.listConflicts("open")).length, 0);

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

test("divergent same-name remote duplicates surface a conflict instead of auto-deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-diverge-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-global-"));
  await writeFile(join(directory, "notes.md"), "# Notes\n\nshared body", "utf8");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);

  const scan = await engine.scan(root);
  const entry = await engine.syncEntry(scan.entries[0]!, root);
  const bound = remote.documents.get(entry.remoteToken!)!;

  // Content differs: the shadow copy must survive for a human decision and
  // the divergence lands in the conflict workbench on the bound entry.
  const divergent = "# Notes\n\ndifferent body";
  remote.documents.set("root/notes-shadow", {
    token: "root/notes-shadow",
    name: bound.name,
    type: "document",
    parentToken: bound.parentToken,
    content: divergent,
    contentHash: parseMarkdown(divergent).contentHash,
    revisionId: 4243,
    blocks: []
  });
  await engine.scan(root);
  assert.ok(remote.documents.has("root/notes-shadow"), "the divergent copy is kept for triage");
  const conflicts = await metaStorage.listConflicts("open");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.remoteContent, divergent);
  const rebound = await metaStorage.getBinding(root.id, "notes.md");
  assert.equal(rebound?.status, "conflict");

  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});
