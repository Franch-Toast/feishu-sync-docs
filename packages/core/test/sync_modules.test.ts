import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalNameAligner, RemoteImporter, RemoteTreeCache, RenameDetector
} from "../src/index.js";
import type { EntryBinding, LocalFile, RemoteDocument, SyncRoot, SyncServices } from "../src/index.js";

// Minimal unit coverage for the collaborators split out of SyncEngine. Each
// test drives one class directly with the single dependency that method needs,
// so the behaviour stays pinned even as SyncEngine's orchestration changes.

const root: SyncRoot = { id: "root", localPath: "/tmp/root", remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 };

function makeFile(relativePath: string): LocalFile {
  return { relativePath, absolutePath: `/tmp/root/${relativePath}`, kind: "document", size: 0, mtimeMs: 0, contentHash: "" };
}

/** In-memory LocalProvider covering just what name-alignment calls. */
class FakeLocal {
  readonly files = new Map<string, string>();
  async readText(_root: SyncRoot, relativePath: string): Promise<string> {
    const value = this.files.get(relativePath);
    if (value === undefined) throw new Error(`missing ${relativePath}`);
    return value;
  }
  async writeText(_root: SyncRoot, relativePath: string, content: string): Promise<void> { this.files.set(relativePath, content); }
  async delete(_root: SyncRoot, relativePath: string): Promise<void> { this.files.delete(relativePath); }
}

test("RemoteTreeCache.buildPathMaps sanitizes '/' titles and disambiguates distinct collisions", () => {
  const cache = new RemoteTreeCache({} as unknown as SyncServices);
  const tree = {
    root: { token: "root", name: "root", type: "folder", parentToken: "" },
    nodes: [
      { token: "root/f", name: "x/y", type: "folder", parentToken: "root" },
      { token: "root/1", name: "a/b", type: "document", parentToken: "root" },
      { token: "root/2", name: "a-b", type: "document", parentToken: "root" },
      { token: "root/3", name: "a/b", type: "document", parentToken: "root" },
      { token: "root/4", name: "note", type: "document", parentToken: "root/f" }
    ]
  } as unknown as import("../src/index.js").RemoteTree;
  const { documents } = cache.buildPathMaps("root", tree);
  // "a/b" and "a-b" sanitize onto "a-b.md": the distinct second title gets a
  // deterministic -2 suffix so it is never dropped.
  assert.equal(documents.get("root/1"), "a-b.md");
  assert.equal(documents.get("root/2"), "a-b-2.md");
  // An identical title is a true same-name duplicate: it must keep sharing the
  // base path so duplicate governance can collapse it (not be pushed aside).
  assert.equal(documents.get("root/3"), "a-b.md");
  // Folder segments sanitize too: "x/y" → "x-y".
  assert.equal(documents.get("root/4"), "x-y/note.md");
});

test("LocalNameAligner.normalize renames fresh docs to their H1, skips bound, and never clobbers a sibling", async () => {
  const local = new FakeLocal();
  local.files.set("a.md", "# Alpha\n\nsee [draft](./b.md)");
  local.files.set("b.md", "# Beta\n\ncontent");
  local.files.set("plain.md", "no heading here");
  local.files.set("bound.md", "# Other\n\nbound");
  const aligner = new LocalNameAligner({ local } as unknown as SyncServices);
  const existingByPath = new Map<string, EntryBinding>([["bound.md", { entryId: "e", rootId: "root", relativePath: "bound.md", kind: "document", status: "clean", updatedAt: "" } as EntryBinding]]);
  const files = ["a.md", "b.md", "plain.md", "bound.md"].map(makeFile);

  const result = await aligner.normalize(root, files, existingByPath);
  const paths = result.map((file) => file.relativePath).sort();
  assert.deepEqual(paths, ["Alpha.md", "Beta.md", "bound.md", "plain.md"]);
  // Old names are gone; the aligned file exists.
  assert.ok(!local.files.has("a.md") && local.files.has("Alpha.md"));
  // The internal link cascaded onto the renamed destination.
  assert.match(local.files.get("Alpha.md")!, /\[draft\]\(Beta\.md\)/);
  // The already-bound file was neither renamed nor touched.
  assert.equal(local.files.get("bound.md"), "# Other\n\nbound");
});

test("RenameDetector.ensureRemoteTitle patches a drifted drive title back and no-ops when it matches", async () => {
  const renames: Array<[string, string]> = [];
  const remote = { renameDocument: async (token: string, title: string): Promise<void> => { renames.push([token, title]); } };
  const detector = new RenameDetector({ remote } as unknown as SyncServices);
  const doc = { token: "t", name: "stale", type: "document", parentToken: "root", content: "", contentHash: "", revisionId: 1, blocks: [] } as RemoteDocument;

  const renamed = await detector.ensureRemoteTitle(doc, "expected");
  assert.equal(renamed.name, "expected");
  assert.deepEqual(renames, [["t", "expected"]]);

  const same = await detector.ensureRemoteTitle({ ...doc, name: "expected" }, "expected");
  assert.equal(same.name, "expected");
  assert.equal(renames.length, 1, "an already-correct title triggers no rename");
});

test("RemoteImporter.buildLinkMaps maps bound documents both ways and ignores assets", async () => {
  const bindings = [
    { kind: "document", relativePath: "a.md", remoteToken: "ta" },
    { kind: "document", relativePath: "sub/b.md", remoteToken: "tb" },
    { kind: "asset", relativePath: "img.png", remoteToken: "ia" }
  ] as unknown as EntryBinding[];
  const metaStorage = { listBindings: async (): Promise<EntryBinding[]> => bindings };
  const importer = new RemoteImporter({ metaStorage } as unknown as SyncServices);

  const { forwardMap, reverseMap } = await importer.buildLinkMaps("root");
  assert.equal(forwardMap.get("a.md")?.token, "ta");
  assert.equal(forwardMap.get("a")?.token, "ta", "the .md extension is stripped for a second lookup key");
  assert.equal(reverseMap.get("tb"), "sub/b.md");
  assert.ok(!forwardMap.has("img.png"), "assets are not part of the document link map");
});
