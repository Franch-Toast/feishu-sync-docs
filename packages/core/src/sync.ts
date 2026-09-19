import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { buildBlockPatch, decideSync } from "./merge.js";
import { parseMarkdown, restoreAssetReferences, restoreInternalLinks } from "./markdown.js";
import { sha256 } from "./hash.js";
import { titleToLocalSegmentKey } from "./names.js";
import { matchesAnyGlob } from "./glob.js";
import { documentTitle, isRemoteNotFound, mimeType, resolveRelativePath } from "./sync_paths.js";
import { LocalNameAligner } from "./name_align.js";
import { RemoteImporter } from "./importer.js";
import { RemoteTreeCache } from "./remote_tree.js";
import { RenameDetector } from "./rename.js";
import type { SyncServices } from "./sync_services.js";
import type {
  EntryBinding, GitStorage, LocalFile, LocalProvider, MetaStorage, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, SyncDirection, SyncMode, SyncRoot, SyncScope, SyncTrigger
} from "./types.js";

export class SyncEngine {
  /** Direction taken by the most recent syncEntry/syncAsset per entry; the
   *  runtime consumes it via takeDirection() to label operation records. */
  private readonly lastDirections = new Map<string, SyncDirection>();
  /** Collaborators each own one focused responsibility; `SyncEngine` stays the
   *  orchestrator (`scan` + `syncEntry`) and delegates the remote-tree cache,
   *  remote import / asset handling, rename & duplicate governance, and
   *  first-binding name alignment to them. They share one injected service set
   *  so they never import each other. */
  private readonly services: SyncServices;
  private readonly tree: RemoteTreeCache;
  private readonly importer: RemoteImporter;
  private readonly rename: RenameDetector;
  private readonly nameAlign: LocalNameAligner;

  constructor(
    private readonly gitStorage: GitStorage,
    private readonly metaStorage: MetaStorage,
    private readonly local: LocalProvider,
    private readonly remote: RemoteProvider
  ) {
    this.services = { gitStorage, metaStorage, local, remote };
    this.tree = new RemoteTreeCache(this.services);
    this.importer = new RemoteImporter(this.services);
    this.rename = new RenameDetector(this.services);
    this.nameAlign = new LocalNameAligner(this.services);
  }

  /** Consume the direction recorded by the last sync for this entry. */
  takeDirection(entryId: string): SyncDirection | undefined {
    const direction = this.lastDirections.get(entryId);
    this.lastDirections.delete(entryId);
    return direction;
  }

  private setDirection(entryId: string, direction: SyncDirection): void {
    this.lastDirections.set(entryId, direction);
  }

  /** One sync round: refresh both sides, pair them, and arm EntryBindings.
   *
   *  Matching priority is deliberately two-tier and must stay that way:
   *  1. token 1:1 (authoritative) — a binding that already owns a remoteToken is
   *     probed directly against that token below (getDocument + canonical hash
   *     diff) and NEVER re-enters the fuzzy pairing loop; the drive token is the
   *     stable identity, so path/name churn can never re-point an established
   *     pair.
   *  2. the four-tier fallback (path → title → content-hash → import/push) runs
   *     ONLY over documents that are still unbound, to recover lost bindings.
   *  Never add content/title matching for already-token-bound entries: it would
   *  let a duplicate drive copy steal a live binding. */
  async scan(root: SyncRoot, trigger: SyncTrigger = 'manual', scope?: SyncScope): Promise<{ entries: EntryBinding[]; conflicts: number }> {
    const mode: SyncMode = root.mode ?? "bidirectional";
    // Incremental scope is honored only for event/watch triggers: the costly
    // per-entry loops below are restricted to the changed paths/tokens, and
    // both sides try a scoped fast path (partial stat + single-document reads)
    // before falling back to the full scans. poll/manual always scan fully.
    const scopedPaths = scope?.relativePaths?.length ? new Set(scope.relativePaths) : undefined;
    const scopedTokens = scope?.remoteTokens?.length ? new Set(scope.remoteTokens) : undefined;
    const scopedParentTokens = scope?.remoteParentTokens ?? [];
    const incremental = (trigger === 'event' || trigger === 'watch') && Boolean(scopedPaths || scopedTokens);
    const inScope = (relativePath: string, remoteToken?: string): boolean =>
      !incremental || (scopedPaths?.has(relativePath) ?? false) || (remoteToken !== undefined && (scopedTokens?.has(remoteToken) ?? false));
    // Local fast path: hash only the announced paths when the provider can;
    // anything unexpected falls back to the full scan below.
    let files: LocalFile[];
    if (incremental && scopedPaths && this.local.scanEntries) {
      try {
        files = await this.local.scanEntries(root, [...scopedPaths]);
      } catch {
        files = await this.local.scan(root);
      }
    } else {
      files = await this.local.scan(root);
    }
    const initialBindings = await this.metaStorage.listBindings(root.id);
    const existingByPath = new Map(initialBindings.map((binding) => [binding.relativePath, binding]));
    let localByPath = new Map(files.map((file) => [file.relativePath, file]));
    // First-binding name alignment (see normalizeLocalNames): Feishu derives the
    // drive document name from the markdown H1, so freshly-seen local documents
    // are renamed to make `file name == H1 == remote name` hold from the start.
    // Only run on full rounds — an incremental round keys its scope off the old
    // paths, and a new file left un-normalized this round is fixed by the next
    // poll/manual round, so keeping the fast path stable is the safer trade-off.
    if (!incremental) {
      files = await this.normalizeLocalNames(root, files, existingByPath);
      localByPath = new Map(files.map((file) => [file.relativePath, file]));
    }
    const changedAssets: string[] = [];

    // B6.5: a previously bound path now covered by an exclude pattern is frozen
    // as ignored (local.scan already skipped it), so it is neither flagged
    // local-missing nor re-synced until the user removes the pattern.
    const isExcluded = (relativePath: string): boolean => matchesAnyGlob(relativePath, root.exclude);
    for (const binding of initialBindings) {
      if (!binding.ignoredAt && isExcluded(binding.relativePath)) {
        await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, ignoredAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    }

    for (const file of files) {
      // Incremental local scope: only the changed paths are re-hashed/re-armed.
      if (incremental && !(scopedPaths?.has(file.relativePath) ?? false)) continue;
      const existing = existingByPath.get(file.relativePath);
      // Ignored entries keep their single-side state: neither hashes nor
      // status are re-evaluated until the user restores them.
      if (existing?.ignoredAt) continue;
      const changed = existing?.remoteContentHash !== file.contentHash;
      // An "error" entry stays in error until its content changes or the user
      // retries: resurrecting it unconditionally turned every round into an
      // unbounded retry loop for permanently failing entries (the failed task
      // also stays visible in the task center for manual retry/ignore).
      const status = existing?.status === "conflict"
        ? "conflict"
        : changed
          ? "pending"
          : existing?.status ?? "pending";
      const binding: EntryBinding = {
        entryId: existing?.entryId ?? randomUUID(),
        rootId: root.id,
        relativePath: file.relativePath,
        kind: file.kind,
        remoteToken: existing?.remoteToken,
        remoteParentToken: existing?.remoteParentToken,
        status,
        remoteRevision: existing?.remoteRevision,
        remoteContentHash: file.contentHash,
        ignoredAt: existing?.ignoredAt,
        lastSyncCommit: existing?.lastSyncCommit,
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, file.relativePath, binding);
      if (file.kind === "asset" && changed && existing?.remoteToken) changedAssets.push(file.relativePath);
    }

    // Remote fast path: read only the announced tokens (plus the tokens of the
    // scoped local bindings) as a minimal tree; an unbound token must be
    // locatable in one of the announced parent folders, otherwise fall back to
    // the full drive walk so no remote change is missed.
    let remoteTree: RemoteTree | undefined;
    // Documents already fetched for the minimal tree; the binding loop below
    // reuses them so a scoped round reads each document exactly once.
    const documentCache = new Map<string, RemoteDocument>();
    if (incremental) {
      const fastTokens = new Set(scopedTokens ?? []);
      if (scopedPaths) {
        for (const binding of initialBindings) {
          if (binding.remoteToken && scopedPaths.has(binding.relativePath)) fastTokens.add(binding.remoteToken);
        }
      }
      if (fastTokens.size > 0) remoteTree = await this.buildScopedRemoteTree(root, fastTokens, scopedParentTokens, documentCache);
    }
    if (!remoteTree) remoteTree = await this.refreshRemoteTree(root);
    // Same-name duplicate governance: only on full rounds, where the tree is
    // complete and the pairing loops below can rely on a deduplicated listing.
    if (!incremental) await this.governRemoteDuplicates(root, remoteTree, mode);
    const remotePathMaps = this.buildRemotePathMaps(root.remoteToken, remoteTree);
    const remoteDocumentPaths = remotePathMaps.documents;
    const remoteAssetPaths = remotePathMaps.assets;
    const remoteAssetParents = remotePathMaps.assetParents;
    // Local documents still pairable with an unbound remote token, keyed by
    // NFC-normalized base name for the title-based pairing below; the flat
    // list feeds the content-hash pairing after it.
    const unboundTitlePaths = new Map<string, string[]>();
    const unboundLocalFiles: Array<{ relativePath: string; contentHash: string }> = [];
    for (const file of files) {
      if (file.kind !== "document") continue;
      const binding = existingByPath.get(file.relativePath);
      if (binding?.remoteToken || binding?.ignoredAt) continue;
      unboundLocalFiles.push({ relativePath: file.relativePath, contentHash: file.contentHash });
      const baseName = titleToLocalSegmentKey(posix.basename(file.relativePath).replace(/\.md$/i, ""));
      if (!baseName) continue;
      const bucket = unboundTitlePaths.get(baseName);
      if (bucket) bucket.push(file.relativePath); else unboundTitlePaths.set(baseName, [file.relativePath]);
    }
    // Lazily built for the content-hash pairing; empty link maps make the
    // canonicalization identical to the raw comparison, so it is skipped.
    let scanReverseMap: Map<string, string> | undefined;
    const importedPaths = new Set<string>();
    for (const node of remoteTree.nodes.filter((item) => item.type === "document")) {
      const relativePath = remoteDocumentPaths.get(node.token);
      if (!relativePath) continue;
      if (isExcluded(relativePath)) continue;
      if (!inScope(relativePath, node.token)) continue;
      const alreadyBound = initialBindings.some((binding) => binding.remoteToken === node.token);
      if (alreadyBound) continue;
      const existing = await this.metaStorage.getBinding(root.id, relativePath);
      if (existing?.remoteToken && existing.remoteToken !== node.token) continue;
      if (existing && existing.kind === "document" && localByPath.has(relativePath)) {
        if (!existing.remoteToken) await this.recordRemoteCollision(root, existing, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
        else await this.metaStorage.setBinding(root.id, relativePath, { ...existing, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, status: "pending", updatedAt: new Date().toISOString() });
        continue;
      }
      // Title pairing: a document whose drive title equals the local base name
      // (NFC-normalized) re-binds even when the drive path differs from the
      // local path. This recovers bindings lost to metadata resets without
      // re-importing the document under its title-derived path — which used
      // to duplicate the document and block the next push of the original.
      if (!localByPath.has(relativePath)) {
        const candidates = unboundTitlePaths.get(titleToLocalSegmentKey(node.name));
        if (candidates && candidates.length === 1) {
          const targetPath = candidates[0]!;
          const target = await this.metaStorage.getBinding(root.id, targetPath);
          if (!target?.remoteToken) {
            await this.metaStorage.setBinding(root.id, targetPath, {
              entryId: target?.entryId ?? randomUUID(),
              rootId: root.id,
              relativePath: targetPath,
              kind: "document",
              remoteToken: node.token,
              remoteParentToken: node.parentToken || root.remoteToken,
              status: "pending",
              remoteContentHash: localByPath.get(targetPath)?.contentHash,
              lastSyncCommit: target?.lastSyncCommit,
              updatedAt: new Date().toISOString()
            });
            continue;
          }
        }
      }
      // Content-hash pairing (4th tier): after a successful push the stored
      // remoteContentHash equals the canonicalized remote content, so an
      // unbound remote document whose content matches exactly one unbound
      // local file is that file's own earlier copy — the recovery path when
      // bindings are lost and the drive title is the markdown H1, which pairs
      // with neither the path nor the base name. Adopting it here keeps the
      // later push from tripping the same-name duplicate guard on itself.
      if (!localByPath.has(relativePath) && unboundLocalFiles.length > 0) {
        let targets = node.contentHash ? unboundLocalFiles.filter((file) => file.contentHash === node.contentHash) : [];
        if (targets.length !== 1) {
          if (scanReverseMap === undefined) scanReverseMap = (await this.buildLinkMaps(root.id)).reverseMap;
          if (scanReverseMap.size > 0 && unboundLocalFiles.length <= 200) {
            let document: RemoteDocument | undefined;
            try {
              document = await this.remote.getDocument(node.token);
            } catch (error) {
              if (!isRemoteNotFound(error)) throw error;
            }
            if (document) {
              const matched: Array<{ relativePath: string; contentHash: string }> = [];
              for (const file of unboundLocalFiles) {
                // Asset references have no reverse map at pairing time and
                // keep their token form, which only ever weakens the match.
                const canonical = restoreAssetReferences(restoreInternalLinks(document.content, scanReverseMap, file.relativePath), new Map(), file.relativePath);
                if (sha256(canonical) === file.contentHash) matched.push(file);
              }
              targets = matched;
            }
          }
        }
        if (targets.length === 1) {
          const target = targets[0]!;
          const targetBinding = await this.metaStorage.getBinding(root.id, target.relativePath);
          if (!targetBinding?.remoteToken) {
            await this.metaStorage.setBinding(root.id, target.relativePath, {
              entryId: targetBinding?.entryId ?? randomUUID(),
              rootId: root.id,
              relativePath: target.relativePath,
              kind: "document",
              remoteToken: node.token,
              remoteParentToken: node.parentToken || root.remoteToken,
              status: "pending",
              remoteContentHash: target.contentHash,
              lastSyncCommit: targetBinding?.lastSyncCommit,
              updatedAt: new Date().toISOString()
            });
            continue;
          }
        }
      }
      if (!localByPath.has(relativePath) && mode !== "push-only") {
        // Duplicate-import guard: a remote document whose body already equals
        // a local document file is almost certainly a stale copy created
        // before drive titles were aligned with local file names (same
        // content, different name). Importing it would materialise a second
        // local file for the same document, so leave it untouched — the
        // user removes the remote copy by hand.
        if (scanReverseMap === undefined) scanReverseMap = (await this.buildLinkMaps(root.id)).reverseMap;
        if (await this.findDuplicateLocalDocument(node, localByPath, scanReverseMap)) continue;
        importedPaths.add(relativePath);
        await this.importRemoteDocument(root, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
      }
    }
    if (remoteTree.nodes.some((node) => node.type === "document" && remoteDocumentPaths.has(node.token) && !localByPath.has(remoteDocumentPaths.get(node.token)!))) {
      // Rescan after imports; stay scoped during incremental rounds so a
      // single new remote document does not force a full local walk.
      const rescanPaths = [...(scopedPaths ?? []), ...importedPaths];
      files = this.local.scanEntries && rescanPaths.length > 0
        ? await this.local.scanEntries(root, rescanPaths)
        : await this.local.scan(root);
      localByPath = new Map(files.map((file) => [file.relativePath, file]));
    }

    // Paths that already own a remote token; rename detection must never
    // steal a file that legitimately backs its own document.
    const boundPaths = new Set(initialBindings.filter((item) => item.remoteToken).map((item) => item.relativePath));
    for (const binding of initialBindings) {
      // Ignored entries are frozen as-is; legacy "orphan" entries get
      // reclassified here into local-missing when their local file is gone.
      if (binding.ignoredAt) continue;
      if (isExcluded(binding.relativePath)) continue;
      if (!inScope(binding.relativePath, binding.remoteToken)) continue;
      if (!localByPath.has(binding.relativePath) && binding.remoteToken) {
        // B3 rename/move detection: the bound local path vanished. When the
        // same content resurfaces at exactly one new, still-unbound path we
        // re-point the binding (the remote document follows) instead of
        // flagging local-missing and later pushing a duplicate copy.
        const outcome = await this.detectRename(root, binding, localByPath, boundPaths);
        if (outcome !== "none") continue;
        await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "local-missing", updatedAt: new Date().toISOString() });
      }
    }

    const bindingsAfterFiles = await this.metaStorage.listBindings(root.id);
    const bindingByPath = new Map(bindingsAfterFiles.map((binding) => [binding.relativePath, binding]));
    const referencesByAsset = new Map<string, string[]>();
    for (const file of files.filter((item) => item.kind === "document")) {
      // Incremental rounds only rebuild references for the scoped documents;
      // unscoped assets keep their stored references untouched below.
      if (incremental && !(scopedPaths?.has(file.relativePath) ?? false)) continue;
      const content = await this.local.readText(root, file.relativePath);
      const documentBinding = bindingByPath.get(file.relativePath);
      if (!documentBinding) continue;
      for (const reference of parseMarkdown(content).assets) {
        const assetPath = resolveRelativePath(file.relativePath, reference.target);
        const asset = bindingByPath.get(assetPath);
        if (asset?.kind === "asset") referencesByAsset.set(assetPath, [...(referencesByAsset.get(assetPath) ?? []), documentBinding.entryId]);
      }
    }
    for (const asset of bindingsAfterFiles.filter((binding) => binding.kind === "asset")) {
      // Guard the incremental fast path: assets outside the scope were not
      // scanned, so their reference lists must not be overwritten with an
      // (empty) default.
      if (incremental && !(scopedPaths?.has(asset.relativePath) ?? false)) continue;
      await this.metaStorage.saveAssetReferences(root.id, asset.relativePath, referencesByAsset.get(asset.relativePath) ?? []);
    }

    for (const assetPath of changedAssets) {
      for (const entryId of await this.metaStorage.listAssetReferences(root.id, assetPath)) {
        const binding = await this.metaStorage.findBindingById(entryId);
        if (binding && !binding.ignoredAt && binding.status !== "conflict") {
          await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "pending", updatedAt: new Date().toISOString() });
        }
      }
    }

    const { reverseMap } = await this.buildLinkMaps(root.id);
    // Load open conflicts once for the whole loop instead of querying per entry.
    const openConflicts = await this.metaStorage.listConflicts("open");
    for (const binding of await this.metaStorage.listBindings(root.id)) {
      // Ignored entries are never probed against the remote side.
      if (binding.ignoredAt) continue;
      if (!inScope(binding.relativePath, binding.remoteToken)) continue;
      if (binding.kind !== "document" || !binding.remoteToken || !localByPath.has(binding.relativePath)) continue;
      let remote = documentCache.get(binding.remoteToken);
      if (!remote) {
        try {
          remote = await this.remote.getDocument(binding.remoteToken);
        } catch (error) {
          if (!isRemoteNotFound(error)) throw error;
          // The remote document is gone: the local copy is the only survivor.
          await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "remote-missing", updatedAt: new Date().toISOString() });
          continue;
        }
      }
      const assetReverseMap = new Map<string, string>();
      for (const assetBinding of await this.metaStorage.getAssetBindings(binding.entryId)) {
        const asset = await this.metaStorage.findBindingById(assetBinding.assetEntryId);
        if (asset) assetReverseMap.set(assetBinding.token, asset.relativePath);
      }
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetReverseMap, binding.relativePath);
      const remoteHash = sha256(canonicalRemote);
      const remoteChanged = binding.remoteContentHash !== undefined && remoteHash !== binding.remoteContentHash;
      const localContent = binding.status === "conflict" ? await this.local.readText(root, binding.relativePath) : undefined;
      const openConflict = binding.status === "conflict"
        ? openConflicts.find((conflict) => conflict.entryId === binding.entryId)
        : undefined;
      if (openConflict && (remoteChanged || openConflict.remoteRevision !== remote.revisionId || openConflict.localContent !== localContent)) {
        await this.metaStorage.updateConflict(openConflict.id, { localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      }
      await this.metaStorage.setBinding(root.id, binding.relativePath, {
        ...binding,
        // Legacy "orphan" entries whose local file and remote document both
        // exist are re-armed for a fresh evaluation instead of staying stuck.
        status: binding.status === "conflict" ? "conflict" : binding.status === "orphan" || remoteChanged ? "pending" : binding.status,
        remoteContentHash: remoteHash,
        remoteRevision: remote.revisionId,
        updatedAt: new Date().toISOString()
      });
    }

    const entries = await this.metaStorage.listBindings(root.id);
    return {
      entries,
      conflicts: (await this.metaStorage.listConflicts("open")).filter((conflict) => entries.some((entry) => entry.entryId === conflict.entryId)).length
    };
  }

  /** Rename freshly-seen local documents so the file name equals the document's
   *  own H1 (sanitized), aligning `file name == H1 == remote name` at first
   *  binding. Delegated to {@link LocalNameAligner}; only run on full rounds. */
  private async normalizeLocalNames(root: SyncRoot, files: LocalFile[], existingByPath: Map<string, EntryBinding>): Promise<LocalFile[]> {
    return this.nameAlign.normalize(root, files, existingByPath);
  }

  async syncEntry(binding: EntryBinding, root: SyncRoot): Promise<EntryBinding> {
    // Ignored entries are never evaluated until the user restores them.
    if (binding.ignoredAt) return binding;
    if (binding.kind === "asset") return this.syncAsset(binding, root);
    const mode: SyncMode = root.mode ?? "bidirectional";

    const localContent = await this.local.readText(root, binding.relativePath);
    const { forwardMap, reverseMap } = await this.buildLinkMaps(root.id);
    let remote;
    if (binding.remoteToken) {
      try {
        remote = await this.remote.getDocument(binding.remoteToken);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        // Remote 404 while a local file exists: the remote side is missing.
        const missing: EntryBinding = { ...binding, status: "remote-missing", updatedAt: new Date().toISOString() };
        await this.metaStorage.setBinding(root.id, binding.relativePath, missing);
        return missing;
      }
    }
    let assetMaps = await this.prepareAssets(root, binding, localContent, remote?.token, false);
    if (!remote) {
      // pull-only never creates a remote document: there is nothing to pull
      // down, so a local-only file is left untouched instead of being pushed.
      if (mode === "pull-only") return binding;
      const parent = await this.ensureRemoteParent(root, binding.relativePath);
      // The drive-visible title is the local file name (createDocument passes
      // it explicitly), so the same-name guard matches on the file-derived
      // title only. Adopt an unbound same-name document (e.g. this entry's
      // own earlier creation after a partial failure) instead of creating
      // another copy; block on same-name documents that are already bound
      // elsewhere.
      const tree = await this.loadRemoteTree(root);
      const expectedName = titleToLocalSegmentKey(documentTitle(binding.relativePath));
      const duplicate = tree.nodes.find((node) => node.type === "document" && node.parentToken === parent && expectedName === titleToLocalSegmentKey(node.name));
      if (duplicate) {
        const bound = await this.metaStorage.findBindingByToken(root.id, duplicate.token);
        // A binding on the very same relative path is this entry's own earlier
        // record (entryId changes when metadata is rebuilt); treating it as a
        // foreign duplicate made the first rebind after a metadata reset
        // impossible. Fall through to the adopt/conflict logic below instead.
        if (bound && bound.entryId !== binding.entryId && bound.relativePath !== binding.relativePath) {
          throw new Error(`Remote folder already has a document named "${duplicate.name}" bound to ${bound.relativePath}; rename one side, then retry sync`);
        }
        remote = await this.remote.getDocument(duplicate.token);
        const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
        // An empty document under our own title is a half-finished creation
        // (created, then the content write failed before the binding was
        // saved): take it over and let the push path fill it, instead of
        // raising a conflict against our own stub.
        if (remote.content.trim() === "" || sha256(canonicalRemote) === sha256(localContent) || sha256(remote.content) === sha256(localContent)) {
          // The existing copy matches the local file (most likely this
          // entry's own earlier creation); rebind and sync as usual.
          const adopted: EntryBinding = { ...binding, remoteToken: remote.token, remoteParentToken: parent, status: "pending", updatedAt: new Date().toISOString() };
          await this.metaStorage.setBinding(root.id, binding.relativePath, adopted);
          return this.syncEntry(adopted, root);
        }
        // Same name but different content: let the user decide instead of
        // silently overwriting either side.
        const conflicting: EntryBinding = { ...binding, remoteToken: remote.token, remoteParentToken: parent, remoteContentHash: sha256(canonicalRemote), remoteRevision: remote.revisionId, status: "conflict", updatedAt: new Date().toISOString() };
        await this.metaStorage.setBinding(root.id, binding.relativePath, conflicting);
        const baselineContent = await this.gitStorage.getBaseline(root.id, binding.relativePath);
        await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent: baselineContent ?? "", localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
        return conflicting;
      }
      let remoteContent = this.renderRemoteContent(localContent, binding.relativePath, forwardMap, assetMaps.forwardMap);
      let created = await this.remote.createDocument(parent, documentTitle(binding.relativePath), remoteContent);
      if (assetMaps.hasLocalAssets && this.remote.uploadInlineAsset) {
        const inlineAssets = await this.prepareAssets(root, binding, localContent, created.token, true);
        assetMaps = inlineAssets;
        remoteContent = this.renderRemoteContent(localContent, binding.relativePath, forwardMap, inlineAssets.forwardMap);
        if (remoteContent !== created.content) created = (await this.remote.applyPatch(created.token, { operations: [{ type: "overwrite", content: remoteContent }], expectedRevisionId: created.revisionId })).document;
      }
      // The markdown import can re-derive the title from the first H1; pin
      // it back to the local file name so the drive name stays reversible.
      created = await this.ensureRemoteTitle(created, documentTitle(binding.relativePath));
      this.cacheRemoteNode(root, created);
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(created.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
      const hash = sha256(localContent);
      const next: EntryBinding = {
        ...binding,
        remoteToken: created.token,
        remoteParentToken: parent,
        remoteContentHash: sha256(canonicalRemote),
        status: "clean",
        remoteRevision: created.revisionId,
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, binding.relativePath, next);
      await this.saveBlockMapping(binding.entryId, localContent, created);
      await this.markDocumentReferences(root, binding.relativePath);
      this.setDirection(binding.entryId, "push");
      return next;
    }

    const assetConflict = await this.hydrateChangedRemoteAssets(root, binding, localContent, remote.content);
    assetMaps = await this.prepareAssets(root, binding, localContent, remote.token, false);
    if (assetConflict) {
      const baselineContent = await this.gitStorage.getBaseline(root.id, binding.relativePath);
      const base = baselineContent ?? localContent;
      const remoteConflictContent = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
      const open = (await this.metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
      if (open) await this.metaStorage.updateConflict(open.id, { localContent, remoteContent: remoteConflictContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      else await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent: base, localContent, remoteContent: remoteConflictContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      const next: EntryBinding = { ...binding, status: "conflict", remoteRevision: remote.revisionId, updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, next);
      return next;
    }
    const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
    const baselineContent = await this.gitStorage.getBaseline(root.id, binding.relativePath);
    // An empty remote document is an unpopulated container (this entry's own
    // half-finished creation adopted above, or a title-paired stub): with no
    // baseline the three-way decision would read the empty body as a remote
    // edit and pull it over the local file, so anchor the merge at the empty
    // baseline and let the decision become a plain push.
    const base = baselineContent ?? (canonicalRemote.trim() === "" ? "" : localContent);
    const decision = decideSync(base, localContent, canonicalRemote);
    let action = decision.action === "noop" && assetMaps.changed ? "push" as const : decision.action;
    // One-way modes override the three-way decision so the authoritative side
    // always wins and no conflict is raised: pull-only never pushes, push-only
    // never pulls.
    if (mode === "pull-only" && action !== "noop" && action !== "pull") action = "pull";
    if (mode === "push-only" && action !== "noop" && action !== "push") action = "push";
    if (action === "conflict") {
      const open = (await this.metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
      if (open) await this.metaStorage.updateConflict(open.id, { localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      else await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent: base, localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      const next: EntryBinding = { ...binding, status: "conflict", remoteContentHash: sha256(canonicalRemote), remoteRevision: remote.revisionId, updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, next);
      return next;
    }

    this.setDirection(binding.entryId, action === "pull" ? "pull" : action === "push" ? "push" : "merge");
    const content = action === "pull" ? canonicalRemote : action === "merge" ? decision.mergedContent ?? localContent : localContent;
    if (action === "pull") await this.local.writeText(root, binding.relativePath, content);

    let remoteAfter = remote;
    if (action === "push" || action === "merge") {
      assetMaps = await this.prepareAssets(root, binding, content, remote.token, true);
      const remoteContent = this.renderRemoteContent(content, binding.relativePath, forwardMap, assetMaps.forwardMap);
      const patch = this.remote.capabilities.blockPatch && remote.blocks.length > 0
        ? buildBlockPatch(base, remoteContent, remote.blocks, remote.rootBlockId).operations
        : [{ type: "overwrite" as const, content: remoteContent }];
      remoteAfter = (await this.remote.applyPatch(remote.token, { operations: patch, expectedRevisionId: remote.revisionId, expectedContentHash: remote.contentHash })).document;
      // Same title pin: an overwrite carrying the first H1 must not rename
      // the document away from the local file name.
      remoteAfter = await this.ensureRemoteTitle(remoteAfter, documentTitle(binding.relativePath));
    }

    const hash = sha256(content);
    const canonicalRemoteAfter = restoreAssetReferences(restoreInternalLinks(remoteAfter.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
    const next: EntryBinding = {
      ...binding,
      status: "clean",
      remoteContentHash: sha256(canonicalRemoteAfter),
      remoteRevision: remoteAfter.revisionId,
      updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    await this.saveBlockMapping(binding.entryId, content, remoteAfter);
    return next;
  }

  async applyResolvedContent(binding: EntryBinding, root: SyncRoot, content: string, expectedRemote?: RemoteDocument): Promise<EntryBinding> {
    if (!binding.remoteToken) throw new Error("Resolved content requires a bound remote document");
    const remote = expectedRemote ?? await this.remote.getDocument(binding.remoteToken);
    const { forwardMap, reverseMap } = await this.buildLinkMaps(root.id);
    const assetMaps = await this.prepareAssets(root, binding, content, remote.token, true);
    const remoteContent = this.renderRemoteContent(content, binding.relativePath, forwardMap, assetMaps.forwardMap);
    const remoteAfter = (await this.remote.applyPatch(remote.token, {
      operations: [{ type: "overwrite", content: remoteContent }],
      expectedRevisionId: remote.revisionId,
      expectedContentHash: remote.contentHash
    })).document;
    const hash = sha256(content);
    const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remoteAfter.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
    const next: EntryBinding = { ...binding, status: "clean", remoteContentHash: sha256(canonicalRemote), remoteRevision: remoteAfter.revisionId, updatedAt: new Date().toISOString() };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    await this.saveBlockMapping(binding.entryId, content, remoteAfter);
    return next;
  }

  private async syncAsset(binding: EntryBinding, root: SyncRoot): Promise<EntryBinding> {
    if (binding.ignoredAt) return binding;
    if (!this.remote.capabilities.assetUpload) {
      const error: EntryBinding = { ...binding, status: "error", updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, error);
      return error;
    }
    const content = await this.local.readBinary(root, binding.relativePath);
    const parent = await this.ensureRemoteParent(root, binding.relativePath);
    let remoteToken = binding.remoteToken;
    const contentHash = sha256(content);
    if (!remoteToken || binding.remoteContentHash !== contentHash) {
      const uploaded = await this.remote.uploadAsset(parent, posix.basename(binding.relativePath), content, mimeType(binding.relativePath));
      if (remoteToken && remoteToken !== uploaded.token) await this.remote.softDelete(remoteToken, "file");
      remoteToken = uploaded.token;
    }
    const next: EntryBinding = { ...binding, remoteToken, remoteParentToken: parent, remoteContentHash: contentHash, status: "clean", updatedAt: new Date().toISOString() };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    if (binding.remoteToken !== remoteToken) await this.markDocumentReferences(root, binding.relativePath);
    this.setDirection(binding.entryId, "push");
    return next;
  }

  /** Re-pull a remote resource whose local file disappeared (local-missing).
   *  Documents go through the same import path as a fresh remote import;
   *  assets are simply downloaded back into place. When the remote side is
   *  also gone the entry is reclassified as remote-missing. */
  async pullRemoteEntry(binding: EntryBinding, root: SyncRoot): Promise<EntryBinding | undefined> {
    if (binding.ignoredAt) throw Object.assign(new Error("Entry is ignored; restore it before syncing"), { statusCode: 400 });
    if (!binding.remoteToken) throw Object.assign(new Error("Entry is not bound to a remote resource"), { statusCode: 400 });
    if (binding.kind === "asset") {
      let binary: Uint8Array;
      try {
        binary = await this.remote.downloadAsset(binding.remoteToken);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        const missing: EntryBinding = { ...binding, status: "remote-missing", updatedAt: new Date().toISOString() };
        await this.metaStorage.setBinding(root.id, binding.relativePath, missing);
        return missing;
      }
      await this.local.writeBinary(root, binding.relativePath, binary);
      const restored: EntryBinding = { ...binding, status: "clean", updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, restored);
      return restored;
    }
    // Force a fresh listing: the cached tree may predate a remote rename/delete.
    const tree = await this.refreshRemoteTree(root);
    const node = tree.nodes.find((item) => item.token === binding.remoteToken);
    if (!node || node.type !== "document") {
      const missing: EntryBinding = { ...binding, status: "remote-missing", updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, missing);
      return missing;
    }
    const maps = this.buildRemotePathMaps(root.remoteToken, tree);
    await this.importRemoteDocument(root, node, binding.relativePath, maps.documents, maps.assets, maps.assetParents);
    return this.metaStorage.getBinding(root.id, binding.relativePath);
  }

  /** Re-create the remote side of an entry whose remote resource disappeared
   *  (remote-missing): the binding is cleared so syncEntry walks the creation
   *  branch and pushes the surviving local content as a new remote document. */
  async recreateRemoteEntry(binding: EntryBinding, root: SyncRoot): Promise<EntryBinding> {
    if (binding.ignoredAt) throw Object.assign(new Error("Entry is ignored; restore it before syncing"), { statusCode: 400 });
    const rearmed: EntryBinding = {
      ...binding,
      remoteToken: undefined,
      remoteParentToken: undefined,
      remoteContentHash: undefined,
      remoteRevision: undefined,
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, binding.relativePath, rearmed);
    return this.syncEntry(rearmed, root);
  }

  /** Same-name duplicate governance (delegated to {@link RenameDetector}). */
  private async governRemoteDuplicates(root: SyncRoot, tree: RemoteTree, mode: SyncMode): Promise<void> {
    return this.rename.governDuplicates(root, tree, mode);
  }

  /** Minimal remote tree for the incremental fast path (delegated to
   *  {@link RemoteTreeCache}); returns undefined so the caller falls back to a
   *  full drive walk when preconditions fail. */
  private async buildScopedRemoteTree(root: SyncRoot, tokens: ReadonlySet<string>, parentTokens: readonly string[], documents?: Map<string, RemoteDocument>): Promise<RemoteTree | undefined> {
    return this.tree.buildScoped(root, tokens, parentTokens, documents);
  }

  /** Token→relative-path maps for one remote tree snapshot (delegated to
   *  {@link RemoteTreeCache.buildPathMaps}). */
  private buildRemotePathMaps(rootToken: string, tree: RemoteTree): { documents: Map<string, string>; assets: Map<string, string>; assetParents: Map<string, string> } {
    return this.tree.buildPathMaps(rootToken, tree);
  }

  /** Import a remote-only document and its images (delegated to {@link RemoteImporter}). */
  private async importRemoteDocument(root: SyncRoot, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, knownFiles?: Map<string, LocalFile>): Promise<void> {
    return this.importer.importRemoteDocument(root, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, knownFiles);
  }

  /** Record a foreign-token/path divergence as a conflict (delegated to {@link RemoteImporter}). */
  private async recordRemoteCollision(root: SyncRoot, binding: EntryBinding, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, knownFiles?: Map<string, LocalFile>): Promise<void> {
    return this.importer.recordRemoteCollision(root, binding, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, knownFiles);
  }

  /** Sync changed inline assets down from a remote edit (delegated to {@link RemoteImporter}). */
  private async hydrateChangedRemoteAssets(root: SyncRoot, documentBinding: EntryBinding, localContent: string, remoteContent: string): Promise<boolean> {
    return this.importer.hydrateChangedRemoteAssets(root, documentBinding, localContent, remoteContent);
  }

  /** Render local markdown for a remote write (delegated to {@link RemoteImporter}). */
  private renderRemoteContent(content: string, currentPath: string, linkMap: Map<string, { token: string; url?: string }>, assetMap: Map<string, string>): string {
    return this.importer.renderRemoteContent(content, currentPath, linkMap, assetMap);
  }

  /** Resolve a document's asset maps and optionally upload changed images
   *  (delegated to {@link RemoteImporter}). */
  private async prepareAssets(root: SyncRoot, documentBinding: EntryBinding, content: string, documentToken?: string, uploadInline = false): Promise<{ forwardMap: Map<string, string>; reverseMap: Map<string, string>; hasLocalAssets: boolean; changed: boolean }> {
    return this.importer.prepareAssets(root, documentBinding, content, documentToken, uploadInline);
  }

  /** Binding-derived document link maps for internal-link rewriting
   *  (delegated to {@link RemoteImporter}). */
  private async buildLinkMaps(rootId: string): Promise<{ forwardMap: Map<string, { token: string; url?: string }>; reverseMap: Map<string, string> }> {
    return this.importer.buildLinkMaps(rootId);
  }

  /** Drop the cached remote tree so the next guard lookup observes documents
   *  created after the snapshot was taken (delegated to {@link RemoteTreeCache}). */
  invalidateRemoteTree(rootId: string): void {
    this.tree.invalidate(rootId);
  }

  /** Pin the drive-visible title back to the local file name after a content
   *  write (delegated to {@link RenameDetector}). */
  private async ensureRemoteTitle(doc: RemoteDocument, expected: string): Promise<RemoteDocument> {
    return this.rename.ensureRemoteTitle(doc, expected);
  }

  /** Return the local document path whose content equals a remote duplicate
   *  (delegated to {@link RenameDetector}). */
  private async findDuplicateLocalDocument(node: RemoteNode, localByPath: Map<string, LocalFile>, scanReverseMap: Map<string, string>): Promise<string | undefined> {
    return this.rename.findDuplicateLocalDocument(node, localByPath, scanReverseMap);
  }

  /** Force-refresh the cached remote tree for a root (delegated to {@link RemoteTreeCache}). */
  private async refreshRemoteTree(root: SyncRoot): Promise<RemoteTree> {
    return this.tree.refresh(root);
  }

  /** Return the cached remote tree, fetching once per TTL window (delegated to
   *  {@link RemoteTreeCache}). */
  private async loadRemoteTree(root: SyncRoot): Promise<RemoteTree> {
    return this.tree.load(root);
  }

  /** Register a newly created remote node in the cached tree (delegated to
   *  {@link RemoteTreeCache}). */
  private cacheRemoteNode(root: SyncRoot, node: RemoteNode): void {
    this.tree.cacheNode(root, node);
  }

  private async ensureRemoteParent(root: SyncRoot, relativePath: string): Promise<string> {
    // `posix.dirname("a.md")` is "." — a root-level document has no remote
    // folder to create, so the placeholder segments must be dropped.
    const directories = posix.dirname(relativePath).split("/").filter((part) => part !== "" && part !== "." && part !== "..");
    let parentToken = root.remoteToken;
    let folderPath = "";
    // The remote tree is loaded lazily: a path whose folders are all persisted
    // in folders.json never triggers a drive listing, so a restart reuses the
    // stored tokens and cannot re-create folders that already exist remotely.
    let tree: RemoteTree | undefined;
    for (const name of directories) {
      folderPath = folderPath ? `${folderPath}/${name}` : name;
      const bound = await this.metaStorage.getFolderBinding(root.id, folderPath);
      if (bound?.remoteToken) {
        parentToken = bound.remoteToken;
        continue;
      }
      if (!tree) tree = await this.loadRemoteTree(root);
      const existing = tree.nodes.find((node) => node.type === "folder" && node.parentToken === parentToken && node.name === name);
      if (existing) {
        parentToken = existing.token;
      } else {
        const created = await this.remote.createFolder(parentToken, name);
        // Register before returning: drive listings may lag behind creation
        // and a retry in that window would otherwise create a duplicate folder.
        tree.nodes.push(created);
        parentToken = created.token;
      }
      // Persist the resolved token so the next document in this folder — or a
      // process restart — skips the remote walk instead of duplicating it.
      await this.metaStorage.setFolderBinding(root.id, folderPath, { relativePath: folderPath, remoteToken: parentToken, createdAt: new Date().toISOString() });
    }
    return parentToken;
  }

  /** Decide whether a vanished binding was actually renamed/moved locally
   *  (delegated to {@link RenameDetector}). */
  private async detectRename(root: SyncRoot, binding: EntryBinding, localByPath: Map<string, LocalFile>, boundPaths: Set<string>): Promise<"moved" | "conflict" | "none"> {
    return this.rename.detectRename(root, binding, localByPath, boundPaths);
  }

  /** Persist the local-block↔remote-block mapping (delegated to {@link RemoteImporter}). */
  private async saveBlockMapping(entryId: string, content: string, remote: RemoteDocument): Promise<void> {
    return this.importer.saveBlockMapping(entryId, content, remote);
  }

  private async markDocumentReferences(root: SyncRoot, targetPath: string): Promise<void> {
    for (const binding of await this.metaStorage.listBindings(root.id)) {
      if (binding.kind !== "document" || binding.relativePath === targetPath || binding.ignoredAt) continue;
      // local-missing entries have no local file to inspect; tolerate other
      // transient read failures (e.g. the file vanished mid-sync) as well.
      if (binding.status === "local-missing") continue;
      let content: string;
      try {
        content = await this.local.readText(root, binding.relativePath);
      } catch {
        continue;
      }
      const references = parseMarkdown(content).links.map((link) => resolveRelativePath(binding.relativePath, link.target));
      if (references.includes(targetPath) && binding.status !== "conflict") {
        await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "pending", updatedAt: new Date().toISOString() });
      }
    }
  }
}

