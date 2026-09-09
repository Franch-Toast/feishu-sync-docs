import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { FilesystemProvider } from "../src/index.js";
import type { SyncRoot } from "../src/index.js";

function makeRoot(directory: string): SyncRoot {
  return { id: "root", localPath: directory, remoteToken: "folder", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 };
}

test("scan discovers markdown and images recursively and skips hidden files and node_modules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-local-"));
  try {
    writeFileSync(join(directory, "note.md"), "# Note\n", "utf8");
    writeFileSync(join(directory, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(directory, "ignored.txt"), "not synced", "utf8");
    writeFileSync(join(directory, ".hidden.md"), "invisible", "utf8");
    mkdirSync(join(directory, "sub"));
    writeFileSync(join(directory, "sub", "guide.md"), "# Guide\n", "utf8");
    writeFileSync(join(directory, "sub", "photo.JPG"), Buffer.from([0xff, 0xd8]));
    mkdirSync(join(directory, "node_modules"));
    writeFileSync(join(directory, "node_modules", "dep.md"), "dependency", "utf8");
    mkdirSync(join(directory, ".git"));
    writeFileSync(join(directory, ".git", "config.md"), "git", "utf8");

    const files = await new FilesystemProvider().scan(makeRoot(directory));
    const paths = files.map((file) => file.relativePath).sort();
    assert.deepEqual(paths, ["note.md", "pic.png", "sub/guide.md", "sub/photo.JPG"]);
    assert.ok(files.every((file) => !file.relativePath.includes("\\")), "relativePath must use posix separators");
    const byPath = new Map(files.map((file) => [file.relativePath, file]));
    assert.equal(byPath.get("note.md")?.kind, "document");
    assert.equal(byPath.get("pic.png")?.kind, "asset");
    assert.equal(byPath.get("sub/photo.JPG")?.kind, "asset", "extension matching must be case-insensitive");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scan produces stable content hashes that change with the content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-hash-"));
  try {
    writeFileSync(join(directory, "note.md"), "shared line\n", "utf8");
    const provider = new FilesystemProvider();
    const root = makeRoot(directory);
    const first = await provider.scan(root);
    const second = await provider.scan(root);
    assert.equal(first[0]?.contentHash, second[0]?.contentHash, "unchanged content must hash identically");
    assert.ok(first[0]?.contentHash, "every file must carry a content hash");

    writeFileSync(join(directory, "note.md"), "changed line\n", "utf8");
    const third = await provider.scan(root);
    assert.notEqual(first[0]?.contentHash, third[0]?.contentHash, "edited content must produce a new hash");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readText and writeText reject paths that escape the sync root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-escape-"));
  const outside = mkdtempSync(join(tmpdir(), "feishu-sync-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "outside content", "utf8");
    const provider = new FilesystemProvider();
    const root = makeRoot(directory);

    await assert.rejects(provider.readText(root, "../outside.txt"), /Path escapes sync root/);
    await assert.rejects(provider.readText(root, join(outside, "secret.txt")), /Path escapes sync root/, "absolute path injection must be rejected");
    await assert.rejects(provider.writeText(root, "../planted.md", "evil"), /Path escapes sync root/);
    await assert.rejects(provider.readText(root, join("..", basename(outside), "secret.txt")), /Path escapes sync root/);
    assert.equal(readdirSync(directory).length, 0, "rejected writes must not create files");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writeText writes atomically through nested directories without leftovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-atomic-"));
  try {
    const provider = new FilesystemProvider();
    const root = makeRoot(directory);
    await provider.writeText(root, "nested/dir/note.md", "round trip\n");
    assert.equal(await provider.readText(root, "nested/dir/note.md"), "round trip\n");
    assert.equal(readFileSync(join(directory, "nested", "dir", "note.md"), "utf8"), "round trip\n");

    // Overwriting must replace the content and clean up the temporary file.
    await provider.writeText(root, "nested/dir/note.md", "updated\n");
    assert.equal(readFileSync(join(directory, "nested", "dir", "note.md"), "utf8"), "updated\n");
    const leftovers = readdirSync(join(directory, "nested", "dir")).filter((name) => name.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "no temporary files may remain after a write");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
