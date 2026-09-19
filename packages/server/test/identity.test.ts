import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  FilesystemProvider, readSyncDocument, splitDocument, stripEnvelope, writeSyncDocument
} from "@feishu-sync/core";
import type { EntryBinding, SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { SyncRuntime } from "../src/runtime.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/**
 * End-to-end coverage for the frontmatter identity envelope: every test drives
 * the real runtime (scan + sync of the pending entries) against the in-memory
 * FakeRemote and asserts on the bytes that land on disk, so a regression in
 * stamping, pairing or hash basis shows up here rather than in production.
 */

interface Scenario {
  gitStorage: GitStorageImpl;
  metaStorage: JsonMetaStorage;
  remote: FakeRemote;
  runtime: SyncRuntime;
  directory: string;
  globalDir: string;
  provider: FilesystemProvider;
}

interface EntryView extends EntryBinding {
  entryId: string;
}

function createScenario(): Scenario {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-identity-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-identity-global-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const provider = new FilesystemProvider();
  const runtime = new SyncRuntime(gitStorage, metaStorage, provider, remote, undefined, undefined, undefined, undefined, {
    sleep: async (): Promise<void> => {}
  });
  return { gitStorage, metaStorage, remote, runtime, directory, globalDir, provider };
}

async function createRoot(scenario: Scenario, name = "notes.md", content = "# notes\n\nlocal body\n"): Promise<SyncRoot> {
  writeFileSync(join(scenario.directory, name), content, "utf8");
  return registerRoot(scenario);
}

/** Register the temp directory as a root without writing any local document. */
async function registerRoot(scenario: Scenario): Promise<SyncRoot> {
  const root = await scenario.metaStorage.createRoot({
    localPath: scenario.directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000
  });
  await scenario.gitStorage.initRoot(root);
  await scenario.metaStorage.initRootMeta(root.id, root.localPath);
  return root;
}

function cleanup(scenario: Scenario): void {
  scenario.runtime.stop();
  rmSync(scenario.directory, { recursive: true, force: true });
  rmSync(scenario.globalDir, { recursive: true, force: true });
}

/** Read a local file and return it split into envelope token and pure body. */
function readEnvelope(scenario: Scenario, root: SyncRoot, relativePath: string): { token?: string; rootId?: string; body: string } {
  const raw = readFileSync(join(scenario.directory, relativePath), "utf8");
  const split = splitDocument(raw);
  const document = readSyncDocument(raw, relativePath);
  return { token: split.token, rootId: split.rootId, body: document.body };
}

async function syncAll(scenario: Scenario, rootId: string): Promise<EntryView[]> {
  const result = (await scenario.runtime.syncRoot(rootId)) as { entries: EntryView[] };
  return result.entries;
}

test("scenario A: a pushed document is stamped once and the next round changes nothing", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const entries = await syncAll(scenario, root.id);
    const entry = entries[0]!;
    assert.equal(entry.status, "clean");
    const token = entry.remoteToken!;
    // The file on disk carries the identity, the body is untouched.
    const stamped = readEnvelope(scenario, root, "notes.md");
    assert.equal(stamped.token, token);
    assert.equal(stamped.rootId, root.id);
    assert.equal(stamped.body, "# notes\n\nlocal body\n");
    // The envelope must never travel to the drive.
    assert.equal(scenario.remote.documents.get(token)?.content, "# notes\n\nlocal body\n");
    const revision = scenario.remote.documents.get(token)?.revisionId;

    // Self-excitation regression: the stamping write must not create a second
    // round of work, a second remote document or a second remote write.
    const second = await syncAll(scenario, root.id);
    assert.equal(second.length, 1);
    assert.equal(second[0]?.status, "clean");
    assert.equal(second[0]?.remoteToken, token);
    assert.equal(scenario.remote.documents.size, 1);
    assert.equal(scenario.remote.documents.get(token)?.revisionId, revision);
    assert.equal(readEnvelope(scenario, root, "notes.md").token, token);
  } finally {
    cleanup(scenario);
  }
});

test("scenario B: an imported remote-only document arrives already stamped", async () => {
  const scenario = createScenario();
  try {
    await scenario.remote.createDocument("root-token", "remote-notes", "# Remote\n\nCreated in Feishu");
    const root = await registerRoot(scenario);
    const entries = await syncAll(scenario, root.id);
    const imported = entries.find((item) => item.relativePath === "remote-notes.md");
    assert.ok(imported, "the remote document must be imported");
    assert.equal(imported!.remoteToken, "root-token/remote-notes");
    const stamped = readEnvelope(scenario, root, "remote-notes.md");
    assert.equal(stamped.token, "root-token/remote-notes");
    assert.equal(stamped.rootId, root.id);
    assert.equal(stamped.body, scenario.remote.documents.get("root-token/remote-notes")!.content);
    assert.equal(scenario.remote.documents.size, 1);
  } finally {
    cleanup(scenario);
  }
});

test("scenario C: the token survives local-only, remote-only and conflicted rounds", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const token = (await syncAll(scenario, root.id))[0]!.remoteToken!;

    // Local edit -> push; the envelope stays and the drive gets the body only.
    writeFileSync(join(scenario.directory, "notes.md"), "# notes\n\nlocal v2\n", "utf8");
    await syncAll(scenario, root.id);
    assert.equal(readEnvelope(scenario, root, "notes.md").token, token);
    assert.equal(readEnvelope(scenario, root, "notes.md").body, "# notes\n\nlocal v2\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "# notes\n\nlocal v2\n");

    // Remote edit -> pull; the stamped body is rewritten, the id is kept.
    scenario.remote.edit(token, "# notes\n\nremote v3\n");
    await syncAll(scenario, root.id);
    assert.equal(readEnvelope(scenario, root, "notes.md").token, token);
    assert.equal(readEnvelope(scenario, root, "notes.md").body, "# notes\n\nremote v3\n");

    // Both sides -> conflict, then a merged resolution keeps the identity too.
    writeFileSync(join(scenario.directory, "notes.md"), "# notes\n\nlocal v4\n", "utf8");
    scenario.remote.edit(token, "# notes\n\nremote v4\n");
    const conflicted = await syncAll(scenario, root.id);
    assert.equal(conflicted[0]?.status, "conflict");
    const open = await scenario.metaStorage.listConflicts("open");
    assert.equal(open.length, 1);
    await scenario.runtime.resolveConflict(open[0]!, { resolution: "merged", mergedContent: "# notes\n\nmerged v5\n" });
    assert.equal(readEnvelope(scenario, root, "notes.md").token, token);
    assert.equal(readEnvelope(scenario, root, "notes.md").body, "# notes\n\nmerged v5\n");
    assert.equal(scenario.remote.documents.get(token)?.content, "# notes\n\nmerged v5\n");
    assert.equal((await syncAll(scenario, root.id))[0]?.status, "clean");
  } finally {
    cleanup(scenario);
  }
});

test("reconnects purely by frontmatter after .feishu-sync is deleted, without duplicating", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const token = (await syncAll(scenario, root.id))[0]!.remoteToken!;
    await scenario.gitStorage.commitBaseline(root.id, "sync: manual", "manual");

    // The whole metadata store is lost: bindings, blocks, operation log.
    rmSync(join(scenario.directory, ".feishu-sync"), { recursive: true, force: true });
    await scenario.metaStorage.initRootMeta(root.id, root.localPath);
    assert.equal((await scenario.metaStorage.listBindings(root.id)).length, 0);

    const entries = await syncAll(scenario, root.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, "clean");
    assert.equal(entries[0]?.remoteToken, token, "the pairing must come from the envelope");
    // No second copy was imported or created on the drive.
    assert.equal(scenario.remote.documents.size, 1);
    assert.equal((await scenario.metaStorage.listBindings(root.id)).find((binding) => binding.remoteToken === token)?.identitySource, "frontmatter");
  } finally {
    cleanup(scenario);
  }
});

test("a local rename re-keys the token onto the new path and never recreates the document", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const token = (await syncAll(scenario, root.id))[0]!.remoteToken!;
    await scenario.gitStorage.commitBaseline(root.id, "sync: manual", "manual");

    // A real move: the envelope travels with the bytes, as any editor would.
    const raw = readFileSync(join(scenario.directory, "notes.md"));
    rmSync(join(scenario.directory, "notes.md"));
    writeFileSync(join(scenario.directory, "renamed.md"), raw);
    await scenario.gitStorage.commitBaseline(root.id, "local: manual", "manual");

    const entries = await syncAll(scenario, root.id);
    const moved = entries.find((item) => item.relativePath === "renamed.md");
    assert.equal(moved?.status, "clean");
    assert.equal(moved?.remoteToken, token);
    assert.equal(entries.find((item) => item.relativePath === "notes.md"), undefined);
    assert.equal(scenario.remote.documents.size, 1);
    assert.equal(readEnvelope(scenario, root, "renamed.md").token, token);
  } finally {
    cleanup(scenario);
  }
});

test("an entire directory move keeps every document on its token", async () => {
  const scenario = createScenario();
  try {
    writeFileSync(join(scenario.directory, "a.md"), "# a\n\nalpha\n", "utf8");
    writeFileSync(join(scenario.directory, "b.md"), "# b\n\nbeta\n", "utf8");
    const root = await registerRoot(scenario);
    const first = await syncAll(scenario, root.id);
    const tokens = new Map(first.filter((item) => item.remoteToken).map((item) => [item.relativePath, item.remoteToken!]));
    assert.equal(tokens.size, 2);
    await scenario.gitStorage.commitBaseline(root.id, "sync: manual", "manual");

    // Move both documents into a sub directory in one shot.
    mkdirSync(join(scenario.directory, "moved"));
    for (const [relativePath, token] of tokens) {
      const raw = readFileSync(join(scenario.directory, relativePath));
      rmSync(join(scenario.directory, relativePath));
      writeFileSync(join(scenario.directory, "moved", relativePath), raw);
    }
    await scenario.gitStorage.commitBaseline(root.id, "local: manual", "manual");

    const entries = await syncAll(scenario, root.id);
    assert.equal(scenario.remote.documents.size, 2, "no document may be re-created");
    for (const [relativePath, token] of tokens) {
      const moved = entries.find((item) => item.relativePath === join("moved", relativePath).replace(/\\/g, "/"));
      assert.equal(moved?.remoteToken, token, `${relativePath} must keep its own token`);
      assert.equal(moved?.status, "clean");
    }
  } finally {
    cleanup(scenario);
  }
});

test("a remote 'create copy' is imported as a new file and leaves the original binding alone", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const token = (await syncAll(scenario, root.id))[0]!.remoteToken!;
    const original = scenario.remote.documents.get(token)!;
    // Feishu's "create copy" clones the page under a fresh token; the user
    // immediately renames its heading, which is what lets the duplicate-import
    // guard tell the copy apart from the original.
    const copy = await scenario.remote.createDocument("root-token", "notes-copy", "# Notes copy\n\nlocal body\n");

    const entries = await syncAll(scenario, root.id);
    const source = entries.find((item) => item.relativePath === "notes.md");
    assert.equal(source?.remoteToken, token, "the original file must keep its token");
    assert.equal(source?.status, "clean");
    const imported = entries.find((item) => item.relativePath === "notes-copy.md");
    assert.ok(imported, "the copy must be imported as its own file");
    assert.equal(imported!.remoteToken, copy.token);
    assert.equal(readEnvelope(scenario, root, "notes-copy.md").token, copy.token);
    assert.equal(scenario.remote.documents.get(token)?.content, original.content);
    assert.equal(scenario.remote.documents.size, 2);
  } finally {
    cleanup(scenario);
  }
});

test("editing only the frontmatter does not trigger a push", async () => {
  const scenario = createScenario();
  try {
    const root = await createRoot(scenario);
    const token = (await syncAll(scenario, root.id))[0]!.remoteToken!;
    const revision = scenario.remote.documents.get(token)?.revisionId;
    const body = readEnvelope(scenario, root, "notes.md").body;

    // The user adds their own key inside the envelope block.
    const raw = readFileSync(join(scenario.directory, "notes.md"), "utf8");
    const edited = raw.replace("feishu_root:", "tags: [ideas]\nfeishu_root:");
    assert.notEqual(edited, raw);
    writeFileSync(join(scenario.directory, "notes.md"), edited, "utf8");

    const entries = await syncAll(scenario, root.id);
    assert.equal(entries[0]?.status, "clean");
    assert.equal(scenario.remote.documents.get(token)?.revisionId, revision, "the drive must not be written");
    assert.equal(scenario.remote.documents.get(token)?.content, body);
    // The user's own key survives: stamping only ever touches the identity keys.
    assert.match(readFileSync(join(scenario.directory, "notes.md"), "utf8"), /tags: \[ideas\]/);
    assert.equal(readEnvelope(scenario, root, "notes.md").token, token);
  } finally {
    cleanup(scenario);
  }
});

test("an untagged file hashes to its exact bytes, so legacy behaviour is unchanged", async () => {
  const scenario = createScenario();
  try {
    const content = "# legacy\n\nnever stamped\n";
    writeFileSync(join(scenario.directory, "legacy.md"), content, "utf8");
    const root = await createRoot(scenario, "other.md", "other\n");
    const [file] = (await scenario.provider.scan(root)).filter((item) => item.relativePath === "legacy.md");
    const digest = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    assert.equal(file?.contentHash, digest, "with no envelope body === raw, so the hash basis is identical");
    assert.equal(file?.rawHash, digest);
    assert.equal(stripEnvelope(content), content);
    // And stamping is exactly reversible: strip(stamp(x)) === x.
    assert.equal(stripEnvelope(writeSyncDocument(content, { token: "t", rootId: "r" }).text), content);
  } finally {
    cleanup(scenario);
  }
});
