import { posix } from "node:path";
import { sanitizeLocalSegment } from "./names.js";
import type { RemoteNode } from "./types.js";

/**
 * Stateless path / name helpers shared by the sync engine and its collaborators.
 *
 * Everything here is a pure function over POSIX-relative paths and remote tree
 * nodes; no provider, storage or engine state is touched. Keeping them in one
 * module makes the binding-table↔drive-listing path derivation a single,
 * testable source of truth (the engine imports these rather than re-declaring
 * them so a change to the sanitizing rule cannot silently diverge).
 */

/** Resolve a markdown/wiki link target relative to the current document path,
 *  dropping any `#anchor`/`?query` suffix before normalising. */
export function resolveRelativePath(currentPath: string, target: string): string {
  const cleanTarget = target.split("#", 1)[0]?.split("?", 1)[0] ?? target;
  return posix.normalize(posix.join(posix.dirname(currentPath), cleanTarget)).replace(/^\.\//, "");
}

/** Heuristic: does this thrown value mean "the remote resource is gone" (404 /
 *  not-found / already-deleted), so callers can treat it as a miss rather than a
 *  transient network failure worth retrying? */
export function isRemoteNotFound(error: unknown): boolean {
  return /(?:HTTP\s+404|not[ -]?found|notexisted|deleted)/i.test(error instanceof Error ? error.message : String(error));
}

/** Drive-visible title for a local document: its base name without `.md`. */
export function documentTitle(relativePath: string): string {
  return posix.basename(relativePath).replace(/\.md$/i, "") || "Untitled";
}

/** Best-effort MIME type from a local asset path; unknown extensions fall back
 *  to the generic octet-stream so uploads never send an empty content type. */
export function mimeType(relativePath: string): string {
  const extension = posix.extname(relativePath).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

/** Walk a remote node's folder ancestry up to the root token, turning each
 *  drive title into a sanitized local segment to build the binding-table path.
 *  Each segment is sanitized so drive titles that carry filesystem-illegal
 *  characters ("a/b", "a:b", trailing dots…) map onto writable local names;
 *  the sanitized path is the single shared key between the binding table and
 *  the drive listing. Returns undefined for an escaping or malformed ancestry. */
export function remoteRelativePath(rootToken: string, node: RemoteNode, nodes: Map<string, RemoteNode>): string | undefined {
  const segments = [sanitizeLocalSegment(node.name)];
  const visited = new Set<string>();
  let parentToken = node.parentToken;
  while (parentToken && parentToken !== rootToken) {
    if (visited.has(parentToken)) return undefined;
    visited.add(parentToken);
    const parent = nodes.get(parentToken);
    if (!parent || parent.type !== "folder") return undefined;
    segments.unshift(sanitizeLocalSegment(parent.name));
    parentToken = parent.parentToken;
  }
  const path = posix.normalize(posix.join(...segments));
  if (!path || path === "." || path.startsWith("../") || path.startsWith("/")) return undefined;
  return path;
}

/** Append `.md` unless the path already ends in it (case-insensitive). */
export function ensureMarkdownPath(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

/** Derive a collision-free local path by appending `-2`, `-3`, ... to the
 *  final segment (before any extension). Deterministic for a fixed assignment
 *  order, so the same drive listing always yields the same names. */
export function uniqueLocalPath(path: string, used: ReadonlySet<string>): string {
  const extension = posix.extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  let suffix = 2;
  let candidate = `${stem}-${suffix}${extension}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${stem}-${suffix}${extension}`;
  }
  return candidate;
}
