import { normalizeForMatch } from "./names.js";
import { isRemoteNotFound } from "./sync_paths.js";
import { restoreAssetReferences, restoreInternalLinks } from "./markdown.js";
import { sha256 } from "./hash.js";
import { stripEnvelope } from "./frontmatter.js";
import type { TokenIndex } from "./identity.js";
import type { SyncServices } from "./sync_services.js";
import type { EntryBinding, LocalFile, RemoteDocument, RemoteNode, RemoteTree, SyncMode, SyncRoot } from "./types.js";

/**
 * Rename / same-name-duplicate governance and the title-pinning no-op.
 *
 * These are the "identity churn" concerns layered on top of the token↔path
 * pairing: recovering a local file that moved, collapsing duplicate drive
 * copies that share a title, and pinning the drive-visible title back to the
 * local file name after a content write (the docs_ai markdown pipeline can
 * re-derive the title from the first H1).
 */
export class RenameDetector {
  constructor(private readonly services: SyncServices) {}

  /** Keep the drive-visible title equal to the local file name: the docs_ai
   *  markdown pipeline can re-derive the title from the document's first H1,
   *  so after any content write the title is compared and patched back when
   *  it drifted. A no-op for providers without block-level renames. */
  async ensureRemoteTitle(doc: RemoteDocument, expected: string): Promise<RemoteDocument> {
    const { remote } = this.services;
    if (doc.name === expected || !remote.renameDocument) return doc;
    await remote.renameDocument(doc.token, expected);
    return { ...doc, name: expected };
  }

  /** Decide whether a vanished binding was actually renamed/moved locally.
   *  Returns "moved" once the binding was re-pointed to the new path,
   *  "conflict" when several unbound files match and the target is ambiguous,
   *  or "none" when there is no rename evidence (a genuine local deletion).
   *  With a token index the search is exact first (R1): the moved file still
   *  declares `binding.remoteToken` in its envelope, so content hashing is
   *  only the fallback for unstamped files. */
  async detectRename(root: SyncRoot, binding: EntryBinding, localByPath: Map<string, LocalFile>, boundPaths: Set<string>, index?: TokenIndex): Promise<"moved" | "conflict" | "none"> {
    const { remote, metaStorage, gitStorage } = this.services;
    const hash = binding.remoteContentHash;
    if (!hash || !binding.remoteToken) return "none";
    if (index) {
      const claimPath = index.byToken.get(binding.remoteToken);
      if (claimPath && claimPath !== binding.relativePath && localByPath.has(claimPath) && !boundPaths.has(claimPath)) {
        await metaStorage.deleteBinding(root.id, binding.relativePath);
        await metaStorage.setBinding(root.id, claimPath, {
          ...binding,
          relativePath: claimPath,
          kind: "document",
          status: binding.status === "conflict" ? "conflict" : "clean",
          identitySource: "frontmatter",
          updatedAt: new Date().toISOString()
        });
        return "moved";
      }
    }
    const candidates = [...localByPath.values()].filter((file) =>
      file.relativePath !== binding.relativePath &&
      file.contentHash === hash &&
      !boundPaths.has(file.relativePath));
    if (candidates.length === 0) return "none";
    if (candidates.length > 1) {
      // Ambiguous: two or more unbound files carry identical content. Surface a
      // conflict so the user picks the real successor rather than the engine
      // guessing and silently orphaning the remote document.
      let remoteContent = "";
      try {
        remoteContent = (await remote.getDocument(binding.remoteToken)).content;
      } catch { /* a missing remote doc leaves the comparison empty */ }
      const baseContent = stripEnvelope(await gitStorage.getBaseline(root.id, binding.relativePath) ?? "");
      await metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "conflict", updatedAt: new Date().toISOString() });
      const open = (await metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
      if (!open) await metaStorage.createConflict({ entryId: binding.entryId, baseContent, localContent: "", remoteContent, remoteRevision: binding.remoteRevision, remoteContentHash: hash });
      return "conflict";
    }
    const target = candidates[0]!;
    // Re-point: drop the stale path and hand the entry's identity (and remote
    // token) to the new path. Content is unchanged, so the entry stays clean
    // and the next round neither re-pushes it nor creates a duplicate document.
    await metaStorage.deleteBinding(root.id, binding.relativePath);
    await metaStorage.setBinding(root.id, target.relativePath, {
      ...binding,
      relativePath: target.relativePath,
      kind: target.kind,
      remoteContentHash: target.contentHash,
      status: "clean",
      updatedAt: new Date().toISOString()
    });
    return "moved";
  }

  /** Same-name duplicate governance: within one remote parent folder, two or
   *  more documents sharing a normalized title are collapsed — the bound copy
   *  (else the earliest-updated one) wins, and every other copy whose content
   *  hash matches the winner is soft-deleted so the pairing loops below see a
   *  one-to-one listing. Divergent duplicates surface as a conflict on the
   *  winner's entry once it is bound; an unbound winner gets imported first
   *  and the conflict is raised on the next full round. */
  async governDuplicates(root: SyncRoot, tree: RemoteTree, mode: SyncMode): Promise<void> {
    const { remote, metaStorage, gitStorage, local } = this.services;
    const groups = new Map<string, RemoteNode[]>();
    for (const node of tree.nodes) {
      if (node.type !== "document") continue;
      const key = `${node.parentToken || root.remoteToken}|${normalizeForMatch(node.name)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(node); else groups.set(key, [node]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const bound = new Map<string, EntryBinding>();
      for (const node of group) {
        const binding = await metaStorage.findBindingByToken(root.id, node.token);
        if (binding && !binding.ignoredAt) bound.set(node.token, binding);
      }
      const winner = group.find((node) => bound.has(node.token))
        ?? [...group].sort((left, right) => (left.updatedAt ?? "").localeCompare(right.updatedAt ?? ""))[0]!;
      const documents = new Map<string, RemoteDocument>();
      for (const node of group) {
        try {
          documents.set(node.token, await remote.getDocument(node.token));
        } catch {
          // An unreadable copy is left alone rather than deleted blindly.
        }
      }
      const winnerDocument = documents.get(winner.token);
      if (!winnerDocument) continue;
      for (const loser of group) {
        if (loser.token === winner.token) continue;
        const loserDocument = documents.get(loser.token);
        if (!loserDocument) continue;
        if (loserDocument.contentHash === winnerDocument.contentHash) {
          await remote.softDelete(loser.token, "docx");
          const index = tree.nodes.indexOf(loser);
          if (index >= 0) tree.nodes.splice(index, 1);
          continue;
        }
        // Divergent duplicate: only surface a conflict once the winner is
        // bound — the conflict record needs an entry to attach to.
        const binding = bound.get(winner.token);
        if (!binding || mode === "push-only") continue;
        const open = (await metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
        if (open) continue;
        let localContent = "";
        try {
          localContent = stripEnvelope(await local.readText(root, binding.relativePath));
        } catch { /* local-missing entries contribute an empty side */ }
        const baselineContent = stripEnvelope(await gitStorage.getBaseline(root.id, binding.relativePath) ?? "");
        await metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "conflict", updatedAt: new Date().toISOString() });
        await metaStorage.createConflict({ entryId: binding.entryId, baseContent: baselineContent, localContent, remoteContent: loserDocument.content, remoteRevision: winnerDocument.revisionId, remoteContentHash: winnerDocument.contentHash });
      }
    }
  }

  /** Return the local document path whose content equals the remote document,
   *  comparing raw and canonicalized content hashes across every local file
   *  (bound or not — the original behind a stale duplicate is usually
   *  already bound). Undefined when nothing matches. */
  async findDuplicateLocalDocument(node: RemoteNode, localByPath: Map<string, LocalFile>, scanReverseMap: Map<string, string>): Promise<string | undefined> {
    const { remote } = this.services;
    const documents = [...localByPath.values()].filter((file) => file.kind === "document");
    if (documents.length === 0) return undefined;
    if (node.contentHash) {
      const fast = documents.find((file) => file.contentHash === node.contentHash);
      if (fast) return fast.relativePath;
    }
    let remoteDocument: RemoteDocument | undefined;
    try {
      remoteDocument = await remote.getDocument(node.token);
    } catch (error) {
      if (!isRemoteNotFound(error)) throw error;
      return undefined;
    }
    if (!remoteDocument) return undefined;
    const raw = sha256(remoteDocument.content);
    for (const file of documents) {
      if (file.contentHash === raw) return file.relativePath;
      // Asset references have no reverse map at pairing time and keep their
      // token form, which only ever weakens the match (same as above).
      const canonical = restoreAssetReferences(restoreInternalLinks(remoteDocument.content, scanReverseMap, file.relativePath), new Map(), file.relativePath);
      if (sha256(canonical) === file.contentHash) return file.relativePath;
    }
    return undefined;
  }
}
