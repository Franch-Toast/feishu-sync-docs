import { normalizeForMatch } from "./names.js";
import { ensureMarkdownPath, isRemoteNotFound, remoteRelativePath, uniqueLocalPath } from "./sync_paths.js";
import type { SyncServices } from "./sync_services.js";
import type { RemoteDocument, RemoteNode, RemoteTree, SyncRoot } from "./types.js";

/**
 * Remote-tree listing cache and the pure token→path projection built from it.
 *
 * A scan refreshes the drive listing once (or builds a minimal scoped tree for
 * an incremental round) and the sync-entry loop that follows reuses the same
 * snapshot; the previous per-entry drive walks were slow and allowed
 * duplicate-folder creation races. This class owns that cache plus the
 * node-caching helpers, so `SyncEngine` can treat the remote side as "give me a
 * consistent tree, then map it onto local paths".
 */
export class RemoteTreeCache {
  private readonly cache = new Map<string, { tree: RemoteTree; at: number }>();
  private readonly jobs = new Map<string, Promise<RemoteTree>>();
  private static readonly TTL_MS = 60_000;

  constructor(private readonly services: SyncServices) {}

  /** Force-refresh the cached remote tree for a root; used at scan start so
   *  the engine works on a consistent snapshot. */
  async refresh(root: SyncRoot): Promise<RemoteTree> {
    this.cache.delete(root.id);
    return this.load(root);
  }

  /** Return the cached remote tree, fetching it once per TTL window and
   *  de-duplicating concurrent fetches. */
  async load(root: SyncRoot): Promise<RemoteTree> {
    const cached = this.cache.get(root.id);
    if (cached && Date.now() - cached.at < RemoteTreeCache.TTL_MS) return cached.tree;
    const pending = this.jobs.get(root.id);
    if (pending) return pending;
    const job = this.services.remote.listTree(root).then((tree) => {
      this.cache.set(root.id, { tree, at: Date.now() });
      return tree;
    }).finally(() => { this.jobs.delete(root.id); });
    this.jobs.set(root.id, job);
    return job;
  }

  /** Drop the cached remote tree so the next guard lookup observes documents
   *  created after the snapshot was taken: the same-round auto-retry after
   *  "the API failed but the document was actually created" must find and
   *  adopt the half-finished document instead of creating it again. */
  invalidate(rootId: string): void {
    this.cache.delete(rootId);
  }

  /** Register a newly created remote node in the cached tree so subsequent
   *  lookups in this round see it even if the drive listing lags behind. */
  cacheNode(root: SyncRoot, node: RemoteNode): void {
    const cached = this.cache.get(root.id);
    if (cached) cached.tree.nodes.push(node);
  }

  /** Minimal remote tree for the incremental fast path: every announced token
   *  is read as a single document; unbound tokens must be locatable in one of
   *  the announced parent folders via listFolderChildren. Returns undefined
   *  whenever the preconditions fail so the caller falls back to the full
   *  drive walk (correctness first, speed second). */
  async buildScoped(root: SyncRoot, tokens: ReadonlySet<string>, parentTokens: readonly string[], documents?: Map<string, RemoteDocument>): Promise<RemoteTree | undefined> {
    const rootNode: RemoteNode = { token: root.remoteToken, name: root.remoteToken, type: "folder", parentToken: "" };
    const nodes: RemoteNode[] = [];
    for (const token of tokens) {
      const binding = await this.services.metaStorage.findBindingByToken(root.id, token);
      if (binding) {
        try {
          const document = await this.services.remote.getDocument(token);
          documents?.set(token, document);
          nodes.push({ ...document, parentToken: binding.remoteParentToken || root.remoteToken, name: document.name || binding.relativePath });
        } catch (error) {
          // A deleted document is simply absent from the minimal tree; the
          // full round reclassifies its binding. Network failures fall back.
          if (isRemoteNotFound(error)) continue;
          return undefined;
        }
        continue;
      }
      // Unbound token: a drive event announced it; look only inside the
      // folders the event named instead of walking the whole drive.
      let found: RemoteNode | undefined;
      for (const parentToken of parentTokens.length > 0 ? parentTokens : [root.remoteToken]) {
        if (!this.services.remote.listFolderChildren) return undefined;
        let children: RemoteNode[];
        try {
          children = await this.services.remote.listFolderChildren(parentToken);
        } catch {
          return undefined;
        }
        const hit = children.find((node) => node.token === token);
        if (hit) {
          found = hit;
          break;
        }
      }
      if (!found) return undefined;
      nodes.push(found);
    }
    return { root: rootNode, nodes };
  }

  /** Token→relative-path maps for one remote tree snapshot, shared by scan
   *  and the single-entry pull path. */
  buildPathMaps(rootToken: string, tree: RemoteTree): { documents: Map<string, string>; assets: Map<string, string>; assetParents: Map<string, string> } {
    const nodesByToken = new Map(tree.nodes.map((node) => [node.token, node]));
    const documents = new Map<string, string>();
    const assets = new Map<string, string>();
    const assetParents = new Map<string, string>();
    // DISTINCT drive titles can sanitize onto the same local path (`a/b` and
    // `a-b` both become `a-b`). Left un-disambiguated, the second document is
    // silently dropped by the binding loop's foreign-token guard and its
    // content never syncs, so each such collision gets a deterministic numeric
    // suffix on its own final segment (`a-b-2`). Identical titles are NOT
    // disambiguated: those are true same-name duplicates that
    // `governRemoteDuplicates` deliberately collapses onto one path, so they
    // must keep sharing it.
    const pathOwnerName = new Map<string, string>();
    const usedPaths = new Set<string>();
    for (const node of tree.nodes) {
      const rawPath = remoteRelativePath(rootToken, node, nodesByToken);
      if (!rawPath) continue;
      const isDocument = node.type === "document";
      let path = isDocument ? ensureMarkdownPath(rawPath) : rawPath;
      const ownerName = pathOwnerName.get(path);
      if (ownerName !== undefined && ownerName !== normalizeForMatch(node.name)) path = uniqueLocalPath(path, usedPaths);
      usedPaths.add(path);
      if (!pathOwnerName.has(path)) pathOwnerName.set(path, normalizeForMatch(node.name));
      if (isDocument) documents.set(node.token, path);
      else if (node.type === "asset") {
        assets.set(node.token, path);
        assetParents.set(node.token, node.parentToken);
      }
    }
    return { documents, assets, assetParents };
  }
}
