import type { Entry } from "./api";

/** A half-open [start, end) range inside a display name, used to highlight the
 *  part of a file name that matched the search needle (B6.7). */
export interface MatchRange {
  start: number;
  end: number;
}

/** A synthetic folder node (no DB record) or a file leaf backed by an entry.
 *  `hits` carries the needle matches inside `name` after a filtering pass. */
export type FileTreeNode =
  | { kind: "folder"; name: string; path: string; children: FileTreeNode[]; bound?: boolean; hits?: MatchRange[] }
  | { kind: "file"; name: string; path: string; entry: Entry; hits?: MatchRange[] };

/** Case-insensitive, non-overlapping occurrence ranges of `needle` in `text`.
 *  An empty/blank needle yields no ranges so callers can render plain text. */
export function matchRanges(text: string, needle: string): MatchRange[] {
  const target = needle.trim().toLowerCase();
  if (!target) return [];
  const haystack = text.toLowerCase();
  const ranges: MatchRange[] = [];
  let index = haystack.indexOf(target);
  while (index !== -1) {
    ranges.push({ start: index, end: index + target.length });
    index = haystack.indexOf(target, index + target.length);
  }
  return ranges;
}

function isFolder(node: FileTreeNode): node is Extract<FileTreeNode, { kind: "folder" }> {
  return node.kind === "folder";
}

/** Build a filesystem-like hierarchy from flat relative paths. Siblings are
 *  sorted folders-first then by name, matching file-manager conventions.
 *  Intermediate folders are synthesized even when they contain no files.
 *  `boundFolders` marks which directory paths already have a remote folder
 *  binding so the tree can badge them (B3). */
export function buildFileTree(entries: Entry[], boundFolders?: ReadonlySet<string>): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const folders = new Map<string, Extract<FileTreeNode, { kind: "folder" }>>();
  const ensureFolder = (path: string): Extract<FileTreeNode, { kind: "folder" }> => {
    const existing = folders.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: Extract<FileTreeNode, { kind: "folder" }> = { kind: "folder", name: segments.at(-1)!, path, children: [], bound: boundFolders?.has(path) ?? false };
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
 *  matches the needle; folder names that match keep their subtree intact.
 *  Surviving nodes carry `hits`: the ranges inside their own name that matched,
 *  so the tree can highlight them (B6.7). */
export function filterFileTree(nodes: FileTreeNode[], needle: string): FileTreeNode[] {
  const lower = needle.toLowerCase();
  const walk = (input: FileTreeNode[]): FileTreeNode[] => {
    const result: FileTreeNode[] = [];
    for (const node of input) {
      if (!isFolder(node)) {
        if (node.path.toLowerCase().includes(lower)) result.push({ ...node, hits: matchRanges(node.name, needle) });
        continue;
      }
      const children = walk(node.children);
      if (children.length > 0 || node.path.toLowerCase().includes(lower)) result.push({ ...node, children, hits: matchRanges(node.name, needle) });
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
