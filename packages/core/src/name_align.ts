import { posix } from "node:path";
import { parseMarkdown } from "./markdown.js";
import { normalizeForMatch, sanitizeLocalSegment } from "./names.js";
import { resolveRelativePath } from "./sync_paths.js";
import { stripEnvelope, withBody } from "./frontmatter.js";
import type { SyncServices } from "./sync_services.js";
import type { EntryBinding, LocalFile, SyncRoot } from "./types.js";
import { sha256 } from "./hash.js";

/**
 * First-binding local-name alignment.
 *
 * Feishu derives the drive document name from the markdown H1, so a freshly
 * seen local document is renamed once (at first binding) to make
 * `file name == H1 == remote name` hold from the start; internal links cascade
 * through so references keep resolving after the move. Files that already own a
 * binding are never touched, so alignment happens exactly once per document.
 */
export class LocalNameAligner {
  constructor(private readonly services: SyncServices) {}

  /** Rename freshly-seen local documents so the file name equals the document's
   *  own H1 (sanitized). Only run on full rounds — an incremental round keys its
   *  scope off the old paths, and a new file left un-normalized this round is
   *  fixed by the next poll/manual round, so keeping the fast path stable is the
   *  safer trade-off. */
  async normalize(root: SyncRoot, files: LocalFile[], existingByPath: Map<string, EntryBinding>): Promise<LocalFile[]> {
    const local = this.services.local;
    const renamed: LocalFile[] = [];
    const takenPaths = new Set(files.map((file) => file.relativePath));
    const renameMap = new Map<string, string>();
    // Content hashes already represented by a binding. An unbound file that
    // shares one of these is a move/duplicate candidate for an established
    // document, not a fresh one — renaming it would fight B3 rename detection
    // and same-name governance, so the pairing tiers must handle it instead.
    const boundContentHashes = new Set(
      [...existingByPath.values()].map((binding) => binding.remoteContentHash).filter((hash): hash is string => Boolean(hash))
    );
    for (const file of files) {
      if (file.kind !== "document") { renamed.push(file); continue; }
      if (existingByPath.has(file.relativePath)) { renamed.push(file); continue; }
      if (file.contentHash && boundContentHashes.has(file.contentHash)) { renamed.push(file); continue; }
      const content = await local.readText(root, file.relativePath);
      // The H1 lives in the body; the envelope never becomes a title.
      const h1 = parseMarkdown(stripEnvelope(content)).title;
      if (!h1) { renamed.push(file); continue; }
      const dir = posix.dirname(file.relativePath);
      const baseName = posix.basename(file.relativePath).replace(/\.md$/i, "");
      const newBaseName = sanitizeLocalSegment(h1);
      if (normalizeForMatch(baseName) === normalizeForMatch(newBaseName)) { renamed.push(file); continue; }
      const newPath = posix.join(dir === "." ? "" : dir, `${newBaseName}.md`).replace(/^\.\//, "");
      if (newPath === file.relativePath) { renamed.push(file); continue; }
      // Destination already used by another document: leave this one alone so we
      // never overwrite a sibling; the four-tier pairing still handles it.
      if (takenPaths.has(newPath)) { renamed.push(file); continue; }
      // The whole raw file (identity envelope included) is carried to the new
      // path verbatim, so a rename can never lose a document its token.
      await this.renameFile(root, file.relativePath, newPath, content);
      takenPaths.delete(file.relativePath);
      takenPaths.add(newPath);
      renameMap.set(file.relativePath, newPath);
      renamed.push({ ...file, relativePath: newPath });
    }
    if (renameMap.size > 0) await this.rewriteLinks(root, renamed, renameMap);
    return renamed;
  }

  /** Move a local file's content to a new path. The plain write-then-delete
   *  order corrupts a case-only rename on case-insensitive filesystems (the new
   *  path aliases the old one, so the delete removes the fresh write), so those
   *  go through a temporary intermediate path. */
  private async renameFile(root: SyncRoot, oldPath: string, newPath: string, content: string): Promise<void> {
    const local = this.services.local;
    const caseOnly = oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();
    if (caseOnly) {
      const tempPath = `${newPath}.feishu-sync.tmp`;
      await local.writeText(root, tempPath, content);
      await local.delete(root, oldPath);
      await local.writeText(root, newPath, content);
      await local.delete(root, tempPath);
      return;
    }
    await local.writeText(root, newPath, content);
    await local.delete(root, oldPath);
  }

  /** Rewrite markdown/wiki links that pointed at a renamed document. Matches
   *  by normalized resolved path so `./a.md`, `a.md` and casing variants all
   *  resolve to the same rename entry; anchors and query suffixes are preserved. */
  private async rewriteLinks(root: SyncRoot, files: LocalFile[], renameMap: Map<string, string>): Promise<void> {
    const local = this.services.local;
    const byNormalized = new Map<string, string>();
    for (const [oldPath, newPath] of renameMap) byNormalized.set(normalizeForMatch(oldPath), newPath);
    for (const file of files) {
      if (file.kind !== "document") continue;
      const raw = await local.readText(root, file.relativePath);
      // Links are matched and rewritten inside the body only; the envelope is
      // re-joined verbatim on write-back so the identity survives the rewrite.
      const content = stripEnvelope(raw);
      const { links } = parseMarkdown(content);
      if (links.length === 0) continue;
      let modified = content;
      // Descending start offsets so an earlier edit never invalidates a later span.
      for (const link of [...links].sort((left, right) => right.start - left.start)) {
        if (/^https?:\/\//i.test(link.target)) continue;
        const pathTarget = link.target.split(/[?#]/, 1)[0] ?? link.target;
        if (!pathTarget) continue;
        const resolved = resolveRelativePath(file.relativePath, link.target);
        const newPath = byNormalized.get(normalizeForMatch(resolved));
        if (!newPath) continue;
        const anchor = link.target.slice(pathTarget.length);
        const relativeTarget = posix.relative(posix.dirname(file.relativePath), newPath).replace(/^\.\//, "") || posix.basename(newPath);
        const replacement = `${relativeTarget}${anchor}`;
        const span = modified.slice(link.start, link.end);
        let newSpan = span.replace(`(${link.target}`, `(${replacement}`);
        if (newSpan === span) newSpan = span.replace(`[[${link.target}]]`, `[[${replacement}]]`);
        if (newSpan === span) newSpan = span.replace(`[[${link.target}|`, `[[${replacement}|`);
        if (newSpan === span) continue;
        modified = `${modified.slice(0, link.start)}${newSpan}${modified.slice(link.end)}`;
      }
      if (modified !== content) {
        await local.writeText(root, file.relativePath, withBody(raw, modified));
        file.contentHash = sha256(modified);
      }
    }
  }
}
