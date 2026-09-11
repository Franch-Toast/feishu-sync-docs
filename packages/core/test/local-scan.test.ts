import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider, sha256 } from "../src/index.js";
import type { SyncRoot } from "../src/index.js";

/** E1: an event- or watcher-triggered round must describe only the paths it was
 *  told about. The way to prove "nothing else was touched" is to make the rest
 *  of the tree unreadable: a walk would fail, a scoped scan must not even notice. */

function makeRoot(directory: string, extra: Partial<SyncRoot> = {}): SyncRoot {
  return { id: "root", localPath: directory, remoteToken: "folder", remoteType: "folder", enabled: true, pollIntervalMs: 60_000, ...extra };
}

/** Create a tree whose unreadable members would abort any traversal. */
async function makeLockedTree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scan-"));
  await writeFile(join(directory, "readable.md"), "# Readable\n\nbody", "utf8");
  await mkdir(join(directory, "sub"), { recursive: true });
  await writeFile(join(directory, "sub", "guide.md"), "# Guide\n\ncontent", "utf8");
  await writeFile(join(directory, "unreadable.md"), "cannot be read", "utf8");
  await chmod(join(directory, "unreadable.md"), 0o000);
  await mkdir(join(directory, "locked-dir"), { recursive: true });
  await writeFile(join(directory, "locked-dir", "hidden.md"), "# Hidden", "utf8");
  await chmod(join(directory, "locked-dir"), 0o000);
  return directory;
}

async function releaseLockedTree(directory: string): Promise<void> {
  await chmod(join(directory, "unreadable.md"), 0o644).catch(() => undefined);
  await chmod(join(directory, "locked-dir"), 0o755).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

test("a full scan walks the whole tree and therefore hits the unreadable members", async () => {
  const directory = await makeLockedTree();
  try {
    // Guard for the cases below: if this ever stops throwing, the scoped-scan
    // assertions would prove nothing.
    await assert.rejects(new FilesystemProvider().scan(makeRoot(directory)), /EACCES|permission denied/i);
  } finally {
    await releaseLockedTree(directory);
  }
});

test("onlyPaths reads exactly the requested files and never traverses", async () => {
  const directory = await makeLockedTree();
  try {
    const provider = new FilesystemProvider();
    const files = await provider.scan(makeRoot(directory), { onlyPaths: ["sub/guide.md"] });
    assert.deepEqual(files.map((file) => file.relativePath), ["sub/guide.md"]);
    const expected = await readFile(join(directory, "sub", "guide.md"), "utf8");
    assert.equal(files[0]?.contentHash, sha256(Buffer.from(expected, "utf8")));
    assert.equal(files[0]?.kind, "document");
    assert.equal(files[0]?.absolutePath, join(directory, "sub", "guide.md"));
    assert.equal(files[0]?.size, Buffer.byteLength(expected, "utf8"));
  } finally {
    await releaseLockedTree(directory);
  }
});

test("onlyPaths skips what is gone, is a directory or is not synced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scan-"));
  try {
    await writeFile(join(directory, "note.md"), "# Note", "utf8");
    await writeFile(join(directory, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(directory, "notes.txt"), "plain text", "utf8");
    await mkdir(join(directory, "folder"), { recursive: true });
    const provider = new FilesystemProvider();
    const files = await provider.scan(makeRoot(directory), {
      onlyPaths: ["missing.md", "folder", "notes.txt", "pic.png", "note.md"]
    });
    assert.deepEqual(files.map((file) => file.relativePath).sort(), ["note.md", "pic.png"]);
    assert.deepEqual(files.find((file) => file.relativePath === "pic.png")?.kind, "asset");
    // Repeated paths collapse to one entry, keeping the result cheap to consume.
    const twice = await provider.scan(makeRoot(directory), { onlyPaths: ["note.md", "note.md"] });
    assert.equal(twice.length, 1);
    // An empty scope is an empty result, not a full walk.
    assert.deepEqual(await provider.scan(makeRoot(directory), { onlyPaths: [] }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("onlyPaths cannot be used to read outside the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scan-"));
  try {
    await writeFile(join(directory, "note.md"), "# Note", "utf8");
    await writeFile(join(tmpdir(), "feishu-sync-outside-probe.md"), "secret", "utf8").catch(() => undefined);
    const files = await new FilesystemProvider().scan(makeRoot(directory), {
      onlyPaths: ["../feishu-sync-outside-probe.md", "note.md"]
    });
    assert.deepEqual(files.map((file) => file.relativePath), ["note.md"], "escaping paths are dropped");
  } finally {
    await rm(join(tmpdir(), "feishu-sync-outside-probe.md"), { force: true }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scoped scan hashes exactly like a full scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scan-"));
  try {
    await writeFile(join(directory, "a.md"), "# A\n\nfirst", "utf8");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested", "b.md"), "# B\n\nsecond", "utf8");
    const provider = new FilesystemProvider();
    const full = await provider.scan(makeRoot(directory));
    const scoped = await provider.scan(makeRoot(directory), { onlyPaths: ["a.md", "nested/b.md"] });
    assert.deepEqual(
      scoped.map((file) => `${file.relativePath}:${file.contentHash}:${file.kind}:${file.size}`).sort(),
      full.map((file) => `${file.relativePath}:${file.contentHash}:${file.kind}:${file.size}`).sort()
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeText keeps using atomic temp files that a scan never picks up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-scan-"));
  try {
    const provider = new FilesystemProvider();
    await provider.writeText(makeRoot(directory), "out/deep.md", "# Deep\n\nwritten");
    assert.equal(await readFile(join(directory, "out", "deep.md"), "utf8"), "# Deep\n\nwritten");
    const files = await provider.scan(makeRoot(directory));
    assert.deepEqual(files.map((file) => file.relativePath), ["out/deep.md"]);
    const leftovers = await provider.scan(makeRoot(directory), { onlyPaths: ["out/deep.md.feishu-sync-tmp"] });
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
