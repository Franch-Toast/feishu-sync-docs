import type { Entry } from "./api";

/** A synthetic folder node (no DB record) or a file leaf backed by an entry. */
export type FileTreeNode =
  | { kind: "folder"; name: string; path: string; children: FileTreeNode[] }
  | { kind: "file"; name: string; path: string; entry: Entry };

function isFolder(node: FileTreeNode): node is Extract<FileTreeNode, { kind: "folder" }> {
  return node.kind === "folder";
}

/** Build a filesystem-like hierarchy from flat relative paths. Siblings are
 *  sorted folders-first then by name, matching file-manager conventions.
 *  Intermediate folders are synthesized even when they contain no files. */
export function buildFileTree(entries: Entry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const folders = new Map<string, Extract<FileTreeNode, { kind: "folder" }>>();
  const ensureFolder = (path: string): Extract<FileTreeNode, { kind: "folder" }> => {
    const existing = folders.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: Extract<FileTreeNode, { kind: "folder" }> = { kind: "folder", name: segments.at(-1)!, path, children: [] };
    folders.set(path, node);
    const parentPath = segments.slice(0, -1).join("/");
    if (parentPath) ensureFolder(parentPath).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const entry of entries) {
    const segments = entry.relativePath.split("/");
    const file: FileTreeNode = { kind: "file", name: segments.at(-1)!, path: entry.relativePath, entry };
    const parentPath = segments.slice(0, -1).join("/");
    if (parentPath) ensureFolder(parentPath).children.push(file);
    else roots.push(file);
  }
  const sortNodes = (nodes: FileTreeNode[]): void => {
    nodes.sort((left, right) => (left.kind !== right.kind ? (left.kind === "folder" ? -1 : 1) : left.name.localeCompare(right.name)));
    for (const node of nodes) if (isFolder(node)) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

/** Keep only subtrees that contain at least one file whose relative path
 *  matches the needle; folder names that match keep their subtree intact. */
export function filterFileTree(nodes: FileTreeNode[], needle: string): FileTreeNode[] {
  const lower = needle.toLowerCase();
  const walk = (input: FileTreeNode[]): FileTreeNode[] => {
    const result: FileTreeNode[] = [];
    for (const node of input) {
      if (!isFolder(node)) {
        if (node.path.toLowerCase().includes(lower)) result.push(node);
        continue;
      }
      const children = walk(node.children);
      if (children.length > 0 || node.path.toLowerCase().includes(lower)) result.push({ ...node, children });
    }
    return result;
  };
  return walk(nodes);
}

/** Collect every folder path in the tree; callers use this to auto-expand
 *  the ancestors of filtered matches. */
export function collectFolderPaths(nodes: FileTreeNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (isFolder(node)) {
      into.add(node.path);
      collectFolderPaths(node.children, into);
    }
  }
  return into;
}
