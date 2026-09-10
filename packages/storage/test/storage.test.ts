import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
