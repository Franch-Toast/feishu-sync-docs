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
