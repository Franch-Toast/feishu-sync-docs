import assert from "node:assert/strict";
import test from "node:test";
import { IdentityResolver, splitDocument } from "../src/index.js";
import { composeSyncDocument } from "../src/frontmatter.js";
import type { ConflictRecord, EntryBinding, LocalFile, RemoteTree, SyncRoot, SyncServices } from "../src/index.js";

// Unit coverage for the frontmatter ↔ bindings.json arbitration matrix. Each
// matrix row gets exactly one test so a behaviour change has to break a named
// case. The fakes implement only what IdentityResolver touches.

const root: SyncRoot = { id: "root-1", localPath: "/tmp/root", remoteToken: "spaceRoot", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 };

class FakeLocal {
  readonly files = new Map<string, string>();
  async scan(_root: SyncRoot): Promise<LocalFile[]> {
    return [...this.files.keys()].sort().map((relativePath) => ({
      relativePath, absolutePath: `/tmp/root/${relativePath}`, kind: "document" as const, size: 0, mtimeMs: 0, contentHash: ""
    }));
  }
  async readText(_root: SyncRoot, relativePath: string): Promise<string> {
    const value = this.files.get(relativePath);
    if (value === undefined) throw new Error(`missing ${relativePath}`);
    return value;
  }
  async writeText(_root: SyncRoot, relativePath: string, content: string): Promise<void> { this.files.set(relativePath, content); }
}

class FakeMeta {
  readonly bindings = new Map<string, EntryBinding>();
  readonly conflicts: ConflictRecord[] = [];
  async getBinding(_rootId: string, relativePath: string): Promise<EntryBinding | undefined> { return this.bindings.get(relativePath); }
  async setBinding(_rootId: string, relativePath: string, binding: EntryBinding): Promise<void> { this.bindings.set(relativePath, binding); }
  async deleteBinding(_rootId: string, relativePath: string): Promise<void> { this.bindings.delete(relativePath); }
  async listBindings(): Promise<EntryBinding[]> { return [...this.bindings.values()]; }
  async findBindingByToken(_rootId: string, remoteToken: string): Promise<EntryBinding | undefined> {
    return [...this.bindings.values()].find((binding) => binding.remoteToken === remoteToken);
  }
  async listConflicts(): Promise<ConflictRecord[]> { return this.conflicts; }
  async createConflict(input: Omit<ConflictRecord, "id" | "createdAt" | "status">): Promise<ConflictRecord> {
    const conflict = { ...input, id: `c${this.conflicts.length}`, status: "open" as const, createdAt: "" };
    this.conflicts.push(conflict);
    return conflict;
  }
  async updateConflict(id: string, patch: Partial<ConflictRecord>): Promise<ConflictRecord> {
    const conflict = this.conflicts.find((item) => item.id === id)!;
    Object.assign(conflict, patch);
    return conflict;
  }
}

function services(local: FakeLocal, meta: FakeMeta): SyncServices {
  return { local, metaStorage: meta, remote: {}, gitStorage: {} } as unknown as SyncServices;
}

function tree(...tokens: string[]): RemoteTree {
  return {
    root: { token: "spaceRoot", name: "root", type: "folder", parentToken: "" },
    nodes: tokens.map((token) => ({ token, name: token, type: "document", parentToken: "spaceRoot" }))
  } as unknown as RemoteTree;
}

function binding(relativePath: string, remoteToken: string, extra: Partial<EntryBinding> = {}): EntryBinding {
  return { entryId: `e-${relativePath}`, rootId: root.id, relativePath, kind: "document", remoteToken, status: "clean", updatedAt: "", ...extra };
}

test("matrix #1: a steady pair only gains the missing feishu_root", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", composeSyncDocument("# A\n", { token: "tokA" }));
  const meta = new FakeMeta();
  meta.bindings.set("a.md", binding("a.md", "tokA"));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA"));
  assert.equal(splitDocument(local.files.get("a.md")!).rootId, root.id, "feishu_root was back-filled");
  assert.deepEqual(report.rootCompleted, ["a.md"]);
  assert.equal(report.conflicts.length, 0);
  // A second round finds nothing left to do.
  const resolver2 = new IdentityResolver(services(local, meta));
  const second = await resolver2.reconcile(root, await resolver2.index(root), tree("tokA"));
  assert.equal(second.unchanged, 1);
  assert.deepEqual(second.rootCompleted, []);
});

test("matrix #2: a bound but unstamped file gets its envelope back-filled", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", "# A\n\nplain, stamp lost in a crash\n");
  const meta = new FakeMeta();
  meta.bindings.set("a.md", binding("a.md", "tokA"));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA"));
  assert.deepEqual(report.backfilled, ["a.md"]);
  assert.equal(splitDocument(local.files.get("a.md")!).token, "tokA");
  assert.equal(splitDocument(local.files.get("a.md")!).body, "# A\n\nplain, stamp lost in a crash\n", "content untouched");
});

test("matrix #3: the file-side token wins and the binding re-keys onto the file", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", composeSyncDocument("# A\n", { token: "tokA", rootId: root.id }));
  const meta = new FakeMeta();
  // The path record carries a stale token while tokA's record sits at old.md.
  meta.bindings.set("a.md", binding("a.md", "tokStale"));
  meta.bindings.set("old.md", binding("old.md", "tokA"));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA", "tokStale"));
  assert.deepEqual(report.rekeyed.map((drift) => [drift.token, drift.from, drift.to, drift.lostToken]), [["tokA", "old.md", "a.md", "tokStale"]]);
  assert.equal(meta.bindings.get("a.md")?.remoteToken, "tokA");
  assert.ok(!meta.bindings.has("old.md"), "the migrated record left the old path");
  // R1: the file kept its own token; nothing was auto-merged or deleted.
  assert.equal(splitDocument(local.files.get("a.md")!).token, "tokA");
});

test("matrix #4: an unknown file token against a bound path freezes a conflict", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", composeSyncDocument("# A\n", { token: "tokGhost", rootId: root.id }));
  const meta = new FakeMeta();
  meta.bindings.set("a.md", binding("a.md", "tokDb"));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokDb"));
  assert.deepEqual(report.conflicts, ["a.md"]);
  assert.equal(meta.bindings.get("a.md")?.remoteToken, "tokDb", "the DB token is kept");
  assert.equal(meta.bindings.get("a.md")?.status, "conflict");
  assert.equal(splitDocument(local.files.get("a.md")!).token, "tokGhost", "the user's id is never deleted");
  assert.equal(meta.conflicts.at(-1)?.kind, "identity");
});

test("matrix #5: a local move re-keys the binding onto the moved path", async () => {
  const local = new FakeLocal();
  local.files.set("new/dir/a.md", composeSyncDocument("# A\n", { token: "tokA", rootId: root.id }));
  const meta = new FakeMeta();
  meta.bindings.set("old/dir/a.md", binding("old/dir/a.md", "tokA", { status: "local-missing" }));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA"));
  assert.deepEqual(report.rekeyed.map((drift) => [drift.from, drift.to]), [["old/dir/a.md", "new/dir/a.md"]]);
  assert.equal(meta.bindings.get("new/dir/a.md")?.remoteToken, "tokA");
  assert.ok(!meta.bindings.has("old/dir/a.md"));
});

test("matrix #5 (deleted .feishu-sync): a remote token with no binding claims a new record", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", composeSyncDocument("# A\n", { token: "tokA", rootId: root.id }));
  const meta = new FakeMeta();
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA"));
  assert.equal(meta.bindings.get("a.md")?.remoteToken, "tokA");
  assert.equal(meta.bindings.get("a.md")?.identitySource, "frontmatter");
  assert.equal(report.conflicts.length, 0);
});

test("matrix #6 / R2: two files claiming one token both go to identity conflict", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", composeSyncDocument("# A\n", { token: "dup", rootId: root.id }));
  local.files.set("b.md", composeSyncDocument("# B\n", { token: "dup", rootId: root.id }));
  const meta = new FakeMeta();
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("dup"));
  assert.deepEqual(report.conflicts, ["a.md", "b.md"]);
  assert.equal(meta.bindings.get("a.md")?.status, "conflict");
  assert.equal(meta.bindings.get("b.md")?.status, "conflict");
  assert.equal(meta.conflicts.length, 2);
  assert.ok(meta.conflicts.every((conflict) => conflict.kind === "identity"));
});

test("R1 support: claimed and foreign paths are reported so pairing can exclude them", async () => {
  const local = new FakeLocal();
  local.files.set("claimed.md", composeSyncDocument("# C\n", { token: "tokC", rootId: root.id }));
  local.files.set("foreign.md", composeSyncDocument("# F\n", { token: "tokF", rootId: "other-root" }));
  local.files.set("plain.md", "# P\n");
  local.files.set("broken.md", "---\nfeishu_token: neverClosed\nbody");
  const resolver = new IdentityResolver(services(local, new FakeMeta()));
  const index = await resolver.index(root);
  assert.equal(index.byToken.get("tokC"), "claimed.md");
  assert.deepEqual(index.missing, ["plain.md"], "a foreign claim has no usable token here but keeps its own record");
  assert.equal(index.foreign.get("foreign.md"), "other-root", "another root's id must not pair here");
  assert.ok(!index.byToken.has("tokF"), "a foreign claim never enters byToken");
  assert.deepEqual(index.malformed, ["broken.md"]);
});

test("a malformed envelope is never rewritten and surfaces in the report", async () => {
  const local = new FakeLocal();
  const raw = "---\nfeishu_token: unterminated\n# still body\n";
  local.files.set("a.md", raw);
  const meta = new FakeMeta();
  meta.bindings.set("a.md", binding("a.md", "tokA"));
  const resolver = new IdentityResolver(services(local, meta));
  const report = await resolver.reconcile(root, await resolver.index(root), tree("tokA"));
  assert.equal(local.files.get("a.md"), raw, "content must never be swallowed");
  assert.deepEqual(report.malformed, ["a.md"]);
  assert.deepEqual(report.backfilled, [], "a malformed file is not auto-stamped");
});
