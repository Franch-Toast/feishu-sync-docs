import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import git from "isomorphic-git";
import { GitStorageImpl, JsonMetaStorage } from "../src/index.js";
import type { SyncRoot } from "@feishu-sync/core";

function createTestRoot(localPath: string): SyncRoot {
  return {
    id: `test-root-${Date.now()}`,
    localPath,
    remoteToken: "test-token",
    remoteType: "folder",
    enabled: true,
    pollIntervalMs: 15000
  };
}

test("GitStorageImpl initializes a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    const git = new GitStorageImpl();
    const root = createTestRoot(dir);
    await git.initRoot(root);

    // .git directory should exist
    assert.ok(existsSync(join(dir, ".git")), ".git directory should be created");
    // .gitignore should exist and contain .feishu-sync/
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(gitignore.includes(".feishu-sync/"), ".gitignore should ignore .feishu-sync/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitStorageImpl detects changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    const git = new GitStorageImpl();
    const root = createTestRoot(dir);
    await git.initRoot(root);

    // Initially no changes
    let changes = await git.detectChanges(root.id);
    assert.equal(changes.length, 0, "no changes initially");

    // Create a new file
    writeFileSync(join(dir, "test.md"), "# Hello\n", "utf-8");
    changes = await git.detectChanges(root.id);
    assert.equal(changes.length, 1, "one change detected");
    assert.equal(changes[0]!.type, "added");
    assert.equal(changes[0]!.relativePath, "test.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitStorageImpl commits baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    const git = new GitStorageImpl();
    const root = createTestRoot(dir);
    await git.initRoot(root);

    // Create a file
    writeFileSync(join(dir, "test.md"), "# Hello\n", "utf-8");

    // Commit
    const commitHash = await git.commitBaseline(root.id, "test commit", "manual");
    assert.ok(commitHash, "commit hash should be returned");
    assert.ok(commitHash.length > 0, "commit hash should not be empty");

    // No more changes after commit
    const changes = await git.detectChanges(root.id);
    assert.equal(changes.length, 0, "no changes after commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonMetaStorage initializes root metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  try {
    const meta = new JsonMetaStorage(join(tmpdir(), "feishu-global-"));
    const rootId = "test-root";
    await meta.initRootMeta(rootId, dir);

    // .feishu-sync directory should exist
    assert.ok(existsSync(join(dir, ".feishu-sync")), ".feishu-sync directory should be created");
    assert.ok(existsSync(join(dir, ".feishu-sync", "bindings.json")), "bindings.json should exist");
    assert.ok(existsSync(join(dir, ".feishu-sync", "blocks")), "blocks directory should exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonMetaStorage creates and lists roots", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  try {
    const meta = new JsonMetaStorage(globalDir);
    const root = await meta.createRoot({
      localPath: "/tmp/test",
      remoteToken: "token-123",
      remoteType: "folder",
      enabled: true,
      pollIntervalMs: 15000
    });

    assert.ok(root.id, "root should have an id");
    assert.equal(root.remoteToken, "token-123");

    const roots = await meta.listRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.id, root.id);
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("JsonMetaStorage manages bindings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  try {
    const meta = new JsonMetaStorage(globalDir);
    const rootId = "test-root";
    await meta.initRootMeta(rootId, dir);

    // Set a binding
    await meta.setBinding(rootId, "test.md", {
      entryId: "entry-1",
      rootId,
      relativePath: "test.md",
      kind: "document",
      remoteToken: "remote-token",
      status: "clean",
      updatedAt: new Date().toISOString()
    });

    // Get the binding
    const binding = await meta.getBinding(rootId, "test.md");
    assert.ok(binding, "binding should exist");
    assert.equal(binding.entryId, "entry-1");
    assert.equal(binding.remoteToken, "remote-token");

    // List bindings
    const bindings = await meta.listBindings(rootId);
    assert.equal(bindings.length, 1);

    // Find by token
    const found = await meta.findBindingByToken(rootId, "remote-token");
    assert.ok(found, "should find binding by token");
    assert.equal(found.entryId, "entry-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("JsonMetaStorage paginates operations with a stable cursor and filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  try {
    const meta = new JsonMetaStorage(globalDir);
    const rootId = "test-root";
    await meta.initRootMeta(rootId, dir);
    for (let i = 0; i < 5; i++) {
      await meta.addOperation({ rootId, direction: "push", operation: "sync-entry", trigger: i % 2 === 0 ? "manual" : "poll" });
    }

    const all = await meta.listOperations({ rootId });
    assert.equal(all.length, 5, "all five operations are listed by default");

    // Cursor paging walks the whole ring buffer exactly once, newest first.
    const page1 = await meta.listOperations({ rootId, limit: 2 });
    assert.equal(page1.length, 2);
    const page2 = await meta.listOperations({ rootId, limit: 2, cursor: page1[1]!.id });
    assert.equal(page2.length, 2);
    const page3 = await meta.listOperations({ rootId, limit: 2, cursor: page2[1]!.id });
    assert.equal(page3.length, 1, "the tail page holds the remaining record");
    const pagedIds = [...page1, ...page2, ...page3].map((op) => op.id);
    assert.equal(new Set(pagedIds).size, 5, "pages are disjoint");
    assert.deepEqual([...pagedIds].sort(), all.map((op) => op.id).sort(), "pages cover every record");

    // Trigger filter narrows the result set.
    const manual = await meta.listOperations({ rootId, trigger: "manual" });
    assert.equal(manual.length, 3);
    assert.ok(manual.every((op) => op.trigger === "manual"));

    // Status + errorCategory filters drive the task-center groups.
    await meta.updateOperation(all[0]!.id, { status: "failed", errorCategory: "auth" });
    const failed = await meta.listOperations({ rootId, status: "failed" });
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.errorCategory, "auth");
    const authOnly = await meta.listOperations({ rootId, errorCategory: "auth" });
    assert.equal(authOnly.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("JsonMetaStorage clears completed operations without touching open work (B2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  try {
    const meta = new JsonMetaStorage(globalDir);
    const rootId = "test-root";
    await meta.initRootMeta(rootId, dir);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await meta.addOperation({ rootId, direction: "push", operation: "sync-entry" })).id);
    }
    // Two finished, one still waiting to run, one the user must act on.
    await meta.updateOperation(ids[0]!, { status: "succeeded" });
    await meta.updateOperation(ids[1]!, { status: "cancelled" });
    await meta.updateOperation(ids[3]!, { status: "failed", errorCategory: "auth" });

    const cleared = await meta.clearCompletedOperations();
    assert.equal(cleared, 2, "succeeded + cancelled records are the completed ones");
    const remaining = (await meta.listOperations({ rootId })).map((op) => op.id).sort();
    assert.deepEqual(remaining, [ids[2]!, ids[3]!].sort(), "queued and failed work survives the sweep");

    assert.equal(await meta.clearCompletedOperations(), 0, "a second sweep finds nothing left");
    // Failures only go when the caller asks for them explicitly.
    assert.equal(await meta.clearCompletedOperations(["failed"]), 1);
    assert.equal((await meta.listOperations({ rootId })).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("GitStorageImpl reads blobs and lists commits per path (B4 version history)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    const git = new GitStorageImpl();
    const root = createTestRoot(dir);
    await git.initRoot(root);

    // Three successive versions of the same document, each its own baseline.
    // onlyPaths mirrors the runtime's commit (forces a content re-hash so a
    // same-size edit like v2->v3 is still detected despite mtime granularity).
    writeFileSync(join(dir, "test.md"), "# v1\n", "utf-8");
    const c1 = await git.commitBaseline(root.id, "v1", "manual", new Set(["test.md"]));
    writeFileSync(join(dir, "test.md"), "# v2\n", "utf-8");
    const c2 = await git.commitBaseline(root.id, "v2", "poll", new Set(["test.md"]));
    writeFileSync(join(dir, "test.md"), "# v3\n", "utf-8");
    const c3 = await git.commitBaseline(root.id, "v3", "watch", new Set(["test.md"]));
    assert.ok(c1 && c2 && c3, "each version produced a commit");
    assert.notEqual(c1, c2);
    assert.notEqual(c2, c3);

    // readBlobAt returns the exact content stored at each historical commit.
    assert.equal(await git.readBlobAt(root.id, c1, "test.md"), "# v1\n");
    assert.equal(await git.readBlobAt(root.id, c2, "test.md"), "# v2\n");
    assert.equal(await git.readBlobAt(root.id, c3, "test.md"), "# v3\n");
    // A path that never existed at that commit resolves to undefined.
    assert.equal(await git.readBlobAt(root.id, c1, "missing.md"), undefined);
    // The baseline is the newest commit's content.
    assert.equal(await git.getBaseline(root.id, "test.md"), "# v3\n");

    // listCommitsForPath walks only the commits that touched this path,
    // newest first, and carries the parsed trigger.
    const commits = await git.listCommitsForPath(root.id, "test.md", 50);
    assert.equal(commits.length, 3, "the init/.gitignore commit is excluded");
    assert.deepEqual(commits.map((c) => c.hash), [c3, c2, c1]);
    assert.deepEqual(commits.map((c) => c.trigger), ["watch", "poll", "manual"]);

    // A limit truncates the timeline to the most recent versions.
    const limited = await git.listCommitsForPath(root.id, "test.md", 2);
    assert.deepEqual(limited.map((c) => c.hash), [c3, c2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- G1/G2/G4/G5: 重复绑定、元数据接管与不污染用户仓库 ---------------- */

/** A repository the user brought themselves: `master`, their own `.gitignore`
 *  and — as an earlier build of this tool left it — the metadata committed by
 *  accident. */
async function seedUserRepo(dir: string, options: { trackMetadata?: boolean } = {}): Promise<string> {
  writeFileSync(join(dir, ".gitignore"), "# my own rules\nnode_modules/\n", "utf-8");
  writeFileSync(join(dir, "notes.md"), "# Notes\n", "utf-8");
  await git.init({ fs, dir, defaultBranch: "master" });
  await git.add({ fs, dir, filepath: ".gitignore" });
  await git.add({ fs, dir, filepath: "notes.md" });
  if (options.trackMetadata) {
    mkdirSync(join(dir, ".feishu-sync"), { recursive: true });
    writeFileSync(join(dir, ".feishu-sync", "bindings.json"), JSON.stringify({ "notes.md": { entryId: "stale" } }), "utf-8");
    await git.add({ fs, dir, filepath: ".feishu-sync/bindings.json" });
  }
  return git.commit({ fs, dir, message: "initial user commit", author: { name: "User", email: "user@example.com" } });
}

test("G1: createRoot canonicalizes the path so one directory keeps a single root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  const link = join(mkdtempSync(join(tmpdir(), "feishu-link-")), "docs");
  const meta = new JsonMetaStorage(globalDir);
  try {
    await meta.init();
    symlinkSync(dir, link);
    const first = await meta.createRoot({ localPath: dir, remoteToken: "token-a", remoteType: "folder", enabled: true, pollIntervalMs: 15000 });

    // The same directory reached through a symlink is not a second root.
    const second = await meta.createRoot({ localPath: link, remoteToken: "token-b", remoteType: "folder", enabled: true, pollIntervalMs: 30000 });
    assert.equal(second.id, first.id, "the existing record is reused instead of duplicated");
    assert.equal(second.remoteToken, "token-b", "the new intent still wins");
    assert.equal(second.pollIntervalMs, 30000);
    assert.equal(second.localPath, first.localPath);
    assert.equal((await meta.listRoots()).length, 1);

    // And the occupant is findable for the bind form and the 409 path.
    assert.equal((await meta.findRootByLocalPath(join(link, ".")))?.id, first.id);
    mkdirSync(join(dir, "sub"), { recursive: true });
    assert.equal(await meta.findRootByLocalPath(join(dir, "sub")), undefined, "a subdirectory is its own directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(join(link, ".."), { recursive: true, force: true });
  }
});
test("G2: initRootMeta is idempotent and takes over a retired root's history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  const meta = new JsonMetaStorage(globalDir);
  try {
    await meta.init();
    await meta.initRootMeta("root-old", dir);
    await meta.setBinding("root-old", "notes.md", {
      entryId: "entry-1", rootId: "root-old", relativePath: "notes.md", kind: "document",
      remoteToken: "doc-token", status: "clean", updatedAt: new Date().toISOString()
    });
    await meta.addOperation({ rootId: "root-old", entryId: "entry-1", direction: "push", operation: "sync-entry" });

    // Re-initializing the same root (every startup, every restartRoot) changes nothing.
    await meta.initRootMeta("root-old", dir);
    assert.equal((await meta.listBindings("root-old")).length, 1);
    assert.equal(readdirSync(join(dir, ".feishu-sync")).filter((name) => name.startsWith("backup-")).length, 0, "no backup for a no-op");

    // A fresh record for the same directory adopts the previous one's history.
    await meta.initRootMeta("root-new", dir);
    const bindings = await meta.listBindings("root-new");
    assert.equal(bindings.length, 1, "the binding is inherited, not recreated");
    assert.equal(bindings[0]!.rootId, "root-new");
    assert.equal(bindings[0]!.remoteToken, "doc-token", "its remote identity survives the takeover");
    const operations = await meta.listOperations({ rootId: "root-new" });
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.rootId, "root-new");
    assert.equal(JSON.parse(readFileSync(join(dir, ".feishu-sync", "state.json"), "utf-8")).rootId, "root-new");

    // The originals are kept next to the rewritten ones, so a wrong takeover is
    // still undoable by hand.
    const backups = readdirSync(join(dir, ".feishu-sync")).filter((name) => name.startsWith("backup-"));
    assert.equal(backups.length, 1, backups.join(","));
    const archived = JSON.parse(readFileSync(join(dir, ".feishu-sync", backups[0]!, "bindings.json"), "utf-8")) as Record<string, { rootId: string }>;
    assert.equal(archived["notes.md"]!.rootId, "root-old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("G3: an orphan .feishu-sync is reported until a root adopts or archives it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  const meta = new JsonMetaStorage(globalDir);
  try {
    await meta.init();
    assert.equal(await meta.findOrphanMetaOwner(dir), undefined, "an empty directory has nothing to adopt");

    // Metadata written by a record that has since been deleted: the bind form has
    // to see it before it can offer 「接管」 versus 「重新绑定」.
    await meta.initRootMeta("root-old", dir);
    assert.equal(await meta.findOrphanMetaOwner(dir), "root-old");
    const root = await meta.createRoot({ localPath: dir, remoteToken: "token-a", remoteType: "folder", enabled: true, pollIntervalMs: 15000 });
    assert.equal(root.localPath, await fs.promises.realpath(dir), "the record stores the canonical path");

    // 接管: the new root adopts the history and the orphan marker disappears.
    await meta.initRootMeta(root.id, dir);
    assert.equal(await meta.findOrphanMetaOwner(dir), undefined);
    assert.ok(existsSync(join(dir, ".feishu-sync", "bindings.json")));

    // 重新绑定: everything moves into a backup and the next init starts from zero.
    assert.equal(await meta.archiveRootMeta(dir), true);
    assert.equal(await meta.findOrphanMetaOwner(dir), undefined, "state.json went into the backup");
    await meta.initRootMeta("root-reset", dir);
    assert.equal((await meta.listBindings("root-reset")).length, 0);
    assert.ok(existsSync(join(dir, ".feishu-sync", "bindings.json")));
    // One backup from the takeover above, one from the archive.
    assert.equal(readdirSync(join(dir, ".feishu-sync")).filter((name) => name.startsWith("backup-")).length, 2);
    assert.equal(await meta.archiveRootMeta(join(tmpdir(), "feishu-meta-does-not-exist")), false, "nothing to archive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("G5: retiring a root backs its metadata up and never touches .git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-meta-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-global-"));
  const meta = new JsonMetaStorage(globalDir);
  try {
    await meta.init();
    await git.init({ fs, dir, defaultBranch: "main" });
    writeFileSync(join(dir, "notes.md"), "# Notes\n", "utf-8");
    const rootA = await meta.createRoot({ localPath: dir, remoteToken: "token-a", remoteType: "folder", enabled: true, pollIntervalMs: 15000 });
    await meta.initRootMeta(rootA.id, dir);
    await meta.setBinding(rootA.id, "notes.md", {
      entryId: "entry-1", rootId: rootA.id, relativePath: "notes.md", kind: "document",
      remoteToken: "doc-token", status: "clean", updatedAt: new Date().toISOString()
    });

    // A legacy duplicate (written before G1 deduped) must not wipe the shared
    // metadata when it is unbound.
    const legacy = { ...rootA, id: "root-legacy" };
    writeFileSync(join(globalDir, "roots.json"), JSON.stringify([...await meta.listRoots(), legacy]), "utf-8");
    await meta.deleteRoot(legacy.id);
    assert.ok(existsSync(join(dir, ".feishu-sync", "bindings.json")), "another root still owns the directory");
    assert.equal(readdirSync(join(dir, ".feishu-sync")).filter((name) => name.startsWith("backup-")).length, 0);

    // Unbinding the last owner retires the metadata into a backup instead of
    // deleting it, and leaves the user's files and history alone.
    await meta.deleteRoot(rootA.id);
    assert.equal(existsSync(join(dir, ".feishu-sync", "bindings.json")), false, "the live metadata is gone");
    assert.ok(existsSync(join(dir, ".git")), ".git is never deleted");
    assert.ok(existsSync(join(dir, "notes.md")), "user files are never deleted");
    const backups = readdirSync(join(dir, ".feishu-sync")).filter((name) => name.startsWith("backup-"));
    assert.equal(backups.length, 1);
    const archived = JSON.parse(readFileSync(join(dir, ".feishu-sync", backups[0]!, "bindings.json"), "utf-8")) as Record<string, unknown>;
    assert.ok(archived["notes.md"], "the binding is readable from the backup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("G4: initRoot adopts a master repository and untracks its metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    const initial = await seedUserRepo(dir, { trackMetadata: true });
    const storage = new GitStorageImpl();
    const root = createTestRoot(dir);
    await storage.initRoot(root);

    // The user's rules survive; ours are appended, never a rewrite.
    const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(ignore.includes("# my own rules"), ignore);
    assert.ok(ignore.includes("node_modules/"), ignore);
    assert.ok(ignore.includes(".feishu-sync/"), ignore);
    assert.ok(ignore.includes("*.feishu-sync-*.tmp"), ignore);
    assert.ok(ignore.indexOf("node_modules/") < ignore.indexOf(".feishu-sync/"), "appended after the user rules");

    // The accidentally tracked metadata is dropped from the index in its own commit.
    const tracked = await git.listFiles({ fs, dir });
    assert.equal(tracked.some((file) => file.startsWith(".feishu-sync/")), false, tracked.join(","));
    assert.ok(tracked.includes("notes.md"), "user files stay tracked");
    const log = await git.log({ fs, dir });
    assert.equal(log[0]!.commit.message.trim(), "chore: untrack feishu-sync metadata");
    assert.equal(log.at(-1)!.commit.message.trim(), "initial user commit");

    // A `master` repository is still readable: the baseline falls back to HEAD.
    assert.equal(await storage.getBaselineCommit(root.id), log[0]!.oid);
    assert.equal(await storage.getBaseline(root.id, "notes.md"), "# Notes\n");
    assert.notEqual(await storage.getBaselineCommit(root.id), initial);

    // The next baseline lands on the same line instead of a phantom `main`.
    writeFileSync(join(dir, "notes.md"), "# Notes edited\n", "utf-8");
    const committed = await storage.commitBaseline(root.id, "sync: notes", "manual", new Set(["notes.md"]));
    assert.equal(await git.resolveRef({ fs, dir, ref: "HEAD" }), committed);
    assert.equal((await git.resolveRef({ fs, dir, ref: "refs/heads/master" })), committed);
    await assert.rejects(() => git.resolveRef({ fs, dir, ref: "refs/heads/main" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G4: an idempotent initRoot never repeats the untrack commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    await seedUserRepo(dir, { trackMetadata: true });
    const storage = new GitStorageImpl();
    const root = createTestRoot(dir);
    await storage.initRoot(root);
    const first = await git.log({ fs, dir });
    // A restart (binding a different id onto the same directory) re-runs init.
    await storage.initRoot({ ...root, id: `${root.id}-again` });
    await storage.initRoot({ ...root, id: `${root.id}-third` });
    const after = await git.log({ fs, dir });
    assert.equal(after.length, first.length, "no empty commits pile up");
    assert.equal(after.filter((entry) => entry.commit.message.includes("untrack")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G4: a repository without commits reports no baseline instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-git-"));
  try {
    await git.init({ fs, dir, defaultBranch: "main" });
    const storage = new GitStorageImpl();
    const root = createTestRoot(dir);
    await storage.initRoot(root);

    // Nothing to untrack, no initial commit faked: the first sync is the baseline.
    assert.equal(await storage.getBaselineCommit(root.id), undefined);
    assert.equal(await storage.getBaseline(root.id, "notes.md"), undefined);
    assert.equal((await git.listFiles({ fs, dir })).length, 0);
    assert.ok(readFileSync(join(dir, ".gitignore"), "utf-8").includes(".feishu-sync/"));

    writeFileSync(join(dir, "notes.md"), "# Notes\n", "utf-8");
    const committed = await storage.commitBaseline(root.id, "first sync", "manual", new Set(["notes.md"]));
    assert.ok(committed);
    assert.equal(await storage.getBaseline(root.id, "notes.md"), "# Notes\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

