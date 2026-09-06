import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FilesystemProvider, SyncEngine } from "@feishu-sync/core";
import { SqliteStateStore } from "@feishu-sync/storage";
import { FakeRemote } from "./helpers/fake-remote.js";

test("sync engine creates once, pulls remote changes, and records conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-"));
  const path = join(directory, "notes.md");
  await writeFile(path, "# Notes\n\noriginal", "utf8");
  const store = new SqliteStateStore();
  const remote = new FakeRemote();
  const root = await store.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  const engine = new SyncEngine(store, new FilesystemProvider(), remote);

  let scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  let entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  const token = entry.remoteToken!;
  assert.equal((await engine.scan(root)).entries[0]?.status, "clean");

  remote.edit(token, "# Notes\n\nremote change");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  assert.match(await readFile(path, "utf8"), /remote change/);

  await writeFile(path, "# Notes\n\nlocal change", "utf8");
  await engine.scan(root);
  remote.edit(token, "# Notes\n\nremote again");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  await engine.syncEntry(scan.entries[0]!, root);
  assert.equal((await store.listConflicts("open")).length, 1);
  remote.edit(token, "# Notes\n\nremote after conflict");
  await engine.scan(root);
  assert.equal((await store.listConflicts("open"))[0]?.remoteContent, "# Notes\n\nremote after conflict");
  store.close();
});

test("imports a remote-only document into the local tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-remote-"));
  const store = new SqliteStateStore();
  const remote = new FakeRemote();
  await remote.createDocument("root", "remote-notes", "# Remote\n\nCreated in Feishu");
  const root = await store.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  const engine = new SyncEngine(store, new FilesystemProvider(), remote);

  const result = await engine.scan(root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.status, "clean");
  assert.equal(await readFile(join(directory, "remote-notes.md"), "utf8"), "# Remote\n\nCreated in Feishu");
  store.close();
});
