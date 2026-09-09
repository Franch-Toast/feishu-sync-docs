import { describe, expect, it } from "vitest";
import { buildFileTree, collectFolderPaths, filterFileTree } from "./fileTree";
import type { Entry } from "./api";

function entry(relativePath: string, id = relativePath): Entry {
  return { id, rootId: "root-1", relativePath, kind: "document", status: "clean", updatedAt: "2026-01-01T00:00:00Z" };
}

describe("buildFileTree", () => {
  it("returns empty arrays for empty input", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("places root-level files directly under the tree root", () => {
    const tree = buildFileTree([entry("readme.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "file", name: "readme.md", path: "readme.md" });
  });

  it("nests files under synthesized folders and reuses shared ancestors", () => {
    const tree = buildFileTree([entry("docs/guide/setup.md"), entry("docs/guide/usage.md"), entry("docs/api.md")]);
    expect(tree).toHaveLength(1);
    const docs = tree[0]!;
    expect(docs.kind).toBe("folder");
    if (docs.kind !== "folder") return;
    expect(docs.name).toBe("docs");
    // Folders sort before files: the guide folder precedes api.md.
    expect(docs.children.map((node) => node.name)).toEqual(["guide", "api.md"]);
    const guide = docs.children[0]!;
    expect(guide.kind).toBe("folder");
    if (guide.kind !== "folder") return;
    expect(guide.children.map((node) => node.name)).toEqual(["setup.md", "usage.md"]);
  });

  it("synthesizes folders even when they contain no files", () => {
    const tree = buildFileTree([entry("a/b/c/leaf.md")]);
    expect(collectFolderPaths(tree)).toEqual(new Set(["a", "a/b", "a/b/c"]));
  });

  it("sorts folders before files and names alphabetically", () => {
    const tree = buildFileTree([entry("zeta.md"), entry("alpha/inner.md"), entry("beta.md")]);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "folder:alpha",
      "file:beta.md",
      "file:zeta.md"
    ]);
  });
});

describe("filterFileTree", () => {
  const tree = buildFileTree([
    entry("docs/guide/setup.md"),
    entry("docs/api.md"),
    entry("notes.txt")
  ]);

  it("keeps matching files and their ancestor folders", () => {
    const filtered = filterFileTree(tree, "setup");
    expect(filtered).toHaveLength(1);
    const docs = filtered[0]!;
    expect(docs.kind).toBe("folder");
    if (docs.kind !== "folder") return;
    const guide = docs.children[0]!;
    expect(guide.kind).toBe("folder");
    if (guide.kind !== "folder") return;
    expect(guide.children.map((node) => node.path)).toEqual(["docs/guide/setup.md"]);
  });

  it("matches by full relative path, not only the file name", () => {
    const filtered = filterFileTree(tree, "docs/api");
    expect(filtered).toHaveLength(1);
    if (filtered[0]!.kind !== "folder") return;
    expect(filtered[0]!.children.map((node) => node.path)).toEqual(["docs/api.md"]);
  });

  it("keeps a whole subtree when the folder name matches", () => {
    const filtered = filterFileTree(tree, "guide");
    expect(filtered).toHaveLength(1);
    const docs = filtered[0]!;
    if (docs.kind !== "folder") return;
    const guide = docs.children[0]!;
    if (guide.kind !== "folder") return;
    expect(guide.children.map((node) => node.path)).toEqual(["docs/guide/setup.md"]);
  });

  it("is case-insensitive and drops non-matching branches", () => {
    const filtered = filterFileTree(tree, "NOTES");
    expect(filtered.map((node) => node.path)).toEqual(["notes.txt"]);
  });
});
