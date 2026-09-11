import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { buildBlockPatch, decideSync } from "./merge.js";
import { parseMarkdown, restoreAssetReferences, restoreInternalLinks, resolveReferencePath, rewriteAssetReferences, rewriteInternalLinks } from "./markdown.js";
import { sha256 } from "./hash.js";
import { matchesAnyGlob } from "./glob.js";
import { dedupeSegment, remoteTitle, safeRelativePath } from "./pathsafe.js";
import type {
  EntryBinding, GitStorage, LocalFile, LocalProvider, MetaStorage, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, ScanResult, SyncDirection, SyncMode, SyncRoot, SyncScope, SyncTrigger
} from "./types.js";

/**
 * Identity contract (B1)
 * ======================
 * A local document and its remote counterpart are the *same thing* iff
 * `EntryBinding.relativePath ⟷ EntryBinding.remoteToken` is persisted in
 * `bindings.json`. Once a pair is bound nothing ever re-decides its identity by
 * title — titles are content, and users are free to rename a document in Feishu.
 *
 * Titles are only a *discovery heuristic* for the first pairing, and for that
 * heuristic to be usable the remote title must be a deterministic, reversible
 * function of the file name (see pathsafe.ts):
 *     remoteTitle(p)        = NFC(basename(p) without `.md`), sanitised
 *     filenameFromTitle(t)  = NFC(sanitize(t)) + `.md`
 * When the heuristic is ambiguous — two candidates, a name already claimed by
 * another binding, content that differs on both sides — the engine never
 * guesses and never deletes anything remotely: it records a conflict and hands
 * the decision to the 异常工作台.
 */
export class SyncEngine {
  /** Remote-tree cache keyed by root id. A scan refreshes it once and the
   *  sync-entry loop it triggers reuses the same listing; repeated per-entry
   *  drive walks were slow and allowed duplicate-folder creation races. */
  private readonly remoteTreeCache = new Map<string, { tree: RemoteTree; at: number }>();
  private readonly remoteTreeJobs = new Map<string, Promise<RemoteTree>>();
  private static readonly REMOTE_TREE_TTL_MS = 60_000;
  /** Direction taken by the most recent syncEntry/syncAsset per entry; the
   *  runtime consumes it via takeDirection() to label operation records. */
  private readonly lastDirections = new Map<string, SyncDirection>();
  /** Non-fatal findings from the most recent scan (e.g. remote paths skipped by
   *  the file-name sanitiser). The runtime drains and logs them after a round. */
  private readonly warnings: string[] = [];

  /** Take the warnings recorded by the last scan; clears the buffer. */
  drainWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length);
  }

  constructor(
    private readonly gitStorage: GitStorage,
    private readonly metaStorage: MetaStorage,
    private readonly local: LocalProvider,
    private readonly remote: RemoteProvider
  ) {}

  /** Consume the direction recorded by the last sync for this entry. */
  takeDirection(entryId: string): SyncDirection | undefined {
    const direction = this.lastDirections.get(entryId);
    this.lastDirections.delete(entryId);
    return direction;
  }

  private setDirection(entryId: string, direction: SyncDirection): void {
    this.lastDirections.set(entryId, direction);
  }

  async scan(root: SyncRoot, trigger: SyncTrigger = 'manual', scope?: SyncScope): Promise<ScanResult> {
    const mode: SyncMode = root.mode ?? "bidirectional";
    // Incremental scope is honored only for event/watch triggers: the costly
    // per-entry loops below are restricted to the changed paths/tokens, the
    // local walk is narrowed to exactly those paths (E1) and the remote tree
    // comes from the TTL cache plus single-token fetches instead of a full
    // recursive listing (E2). poll/manual always scan fully.
    const scopedPaths = scope?.relativePaths?.length ? new Set(scope.relativePaths) : undefined;
    const scopedTokens = scope?.remoteTokens?.length ? new Set(scope.remoteTokens) : undefined;
    const incremental = (trigger === 'event' || trigger === 'watch') && Boolean(scopedPaths || scopedTokens);
    const inScope = (relativePath: string, remoteToken?: string): boolean =>
      !incremental || (scopedPaths?.has(relativePath) ?? false) || (remoteToken !== undefined && (scopedTokens?.has(remoteToken) ?? false));
    const initialBindings = await this.metaStorage.listBindings(root.id);
    const existingByPath = new Map(initialBindings.map((binding) => [binding.relativePath, binding]));
    // E1: the paths an incremental round may need to read locally are the
    // changed ones plus the local halves of any binding whose remote token
    // changed — dropping the latter would make a remote-only edit look like a
    // deleted local file.
    const onlyPaths = incremental
      ? [...new Set([
        ...(scopedPaths ?? []),
        ...(scopedTokens
          ? initialBindings.filter((binding) => binding.remoteToken && scopedTokens.has(binding.remoteToken)).map((binding) => binding.relativePath)
          : []),
      ])]
      : undefined;
    let files = onlyPaths ? await this.local.scan(root, { onlyPaths }) : await this.local.scan(root);
    let localByPath = new Map(files.map((file) => [file.relativePath, file]));
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
      const hashChanged = existing?.remoteContentHash !== file.contentHash;
      // A1: an `error` entry is only re-armed when there is something new to
      // try — the local file changed since the failed attempt. Reviving it on
      // every scan made a permanently failing file retry forever and hid the
      // fact that it is waiting for a human. Bindings written before
      // `localContentHash` existed are treated as "changed" once so they can
      // never be stuck in `error` forever.
      const localReArmed = existing?.localContentHash === undefined || existing.localContentHash !== file.contentHash;
      const status = existing?.status === "conflict"
        ? "conflict"
        : existing?.status === "error"
          ? localReArmed ? "pending" : "error"
          : hashChanged
            ? "pending"
            : existing?.status ?? "pending";
      const binding: EntryBinding = {
        entryId: existing?.entryId ?? randomUUID(),
        rootId: root.id,
        relativePath: file.relativePath,
        kind: file.kind,
        remoteToken: existing?.remoteToken,
        remoteParentToken: existing?.remoteParentToken,
        remoteName: existing?.remoteName,
        status,
        remoteRevision: existing?.remoteRevision,
        remoteContentHash: file.contentHash,
        localContentHash: file.contentHash,
        lastErrorAt: existing?.lastErrorAt,
        ignoredAt: existing?.ignoredAt,
        lastSyncCommit: existing?.lastSyncCommit,
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, file.relativePath, binding);
      if (file.kind === "asset" && hashChanged && existing?.remoteToken) changedAssets.push(file.relativePath);
    }

    // E2: only a full round pays for a recursive listing; an incremental round
    // reuses the cached tree and probes just the tokens that announced a change.
    const remoteTree = incremental
      ? await this.probeScopedRemoteTree(root, scopedTokens)
      : await this.refreshRemoteTree(root);
    const remotePathMaps = this.buildRemotePathMaps(root.remoteToken, remoteTree);
    const remoteDocumentPaths = remotePathMaps.documents;
    const remoteAssetPaths = remotePathMaps.assets;
    const remoteAssetParents = remotePathMaps.assetParents;
    const importedPaths: string[] = [];
    for (const node of remoteTree.nodes.filter((item) => item.type === "document")) {
      const relativePath = remoteDocumentPaths.get(node.token);
      if (!relativePath) continue;
      if (isExcluded(relativePath)) continue;
      if (!inScope(relativePath, node.token)) continue;
      const alreadyBound = initialBindings.some((binding) => binding.remoteToken === node.token);
      if (alreadyBound) continue;
      const existing = await this.metaStorage.getBinding(root.id, relativePath);
      if (existing?.remoteToken && existing.remoteToken !== node.token) {
        // B3 scenario (2): the derived path already belongs to a different
        // document. Land this one under a deterministic `-<token prefix>`
        // suffix rather than overwriting someone else's file.
        const fallback = posix.join(posix.dirname(relativePath), dedupeSegment(posix.basename(relativePath), node.token));
        if (mode !== "push-only" && !localByPath.has(fallback) && !existingByPath.has(fallback)) {
          await this.importRemoteDocument(root, node, fallback, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
          importedPaths.push(fallback);
        }
        continue;
      }
      if (existing && existing.kind === "document" && localByPath.has(relativePath)) {
        // B3 scenario (3): both sides exist and the remote document is still
        // unclaimed. Never let this fall through silently — that is how the
        // same file ends up with two documents on the drive.
        if (!existing.remoteToken) {
          await this.pairUnboundRemote(root, existing, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
        } else {
          await this.metaStorage.setBinding(root.id, relativePath, { ...existing, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, status: "pending", updatedAt: new Date().toISOString() });
        }
        continue;
      }
      if (!localByPath.has(relativePath) && mode !== "push-only") {
        await this.importRemoteDocument(root, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
        importedPaths.push(relativePath);
      }
    }
    if (importedPaths.length) {
      // Pull the freshly written files into this round's snapshot without
      // re-walking the whole tree (E1/E3).
      const added = await this.local.scan(root, { onlyPaths: importedPaths });
      for (const file of added) {
        files = [...files.filter((item) => item.relativePath !== file.relativePath), file];
        localByPath.set(file.relativePath, file);
      }
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
      let remote;
      try {
        remote = await this.remote.getDocument(binding.remoteToken);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        // The remote document is gone: the local copy is the only survivor.
        await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "remote-missing", updatedAt: new Date().toISOString() });
        continue;
      }
      const assetReverseMap = new Map<string, string>();
      for (const assetBinding of await this.metaStorage.getAssetBindings(binding.entryId)) {
        const asset = await this.metaStorage.findBindingById(assetBinding.assetEntryId);
        if (asset) assetReverseMap.set(assetBinding.token, asset.relativePath);
      }
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetReverseMap, binding.relativePath);
      const remoteHash = sha256(canonicalRemote);
      const remoteChanged = binding.remoteContentHash !== undefined && remoteHash !== binding.remoteContentHash;
      // A1: `binding.remoteContentHash` was just re-written by the local pass to
      // the *local* hash for every file, so for an entry whose push failed it now
      // differs from the remote hash by construction — comparing against it would
      // revive an `error` entry on every single round. The pre-round value from
      // `initialBindings` still remembers what the drive actually held, so a
      // remote edit is the only thing that can wake a terminal failure up here.
      const lastKnownRemoteHash = existingByPath.get(binding.relativePath)?.remoteContentHash;
      const remoteMoved = lastKnownRemoteHash !== undefined && remoteHash !== lastKnownRemoteHash;
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
        status: binding.status === "conflict"
          ? "conflict"
          : binding.status === "error"
            ? remoteMoved ? "pending" : "error"
            : binding.status === "orphan" || remoteChanged ? "pending" : binding.status,
        remoteContentHash: remoteHash,
        remoteRevision: remote.revisionId,
        updatedAt: new Date().toISOString()
      });
    }

    const entries = await this.metaStorage.listBindings(root.id);
    return {
      entries,
      conflicts: (await this.metaStorage.listConflicts("open")).filter((conflict) => entries.some((entry) => entry.entryId === conflict.entryId)).length,
      scanned: localByPath.size
    };
  }

  /** E2: serve the remote tree for an incremental round from the TTL cache,
   *  fetching only the announced tokens that the cache does not know yet.
   *  Any doubt (empty cache, a token that 404s) falls back to one full
   *  listing, because correctness outranks the API budget. */
  private async probeScopedRemoteTree(root: SyncRoot, scopedTokens?: Set<string>): Promise<RemoteTree> {
    const cached = this.remoteTreeCache.get(root.id);
    if (!cached || Date.now() - cached.at >= SyncEngine.REMOTE_TREE_TTL_MS) return this.refreshRemoteTree(root);
    const tree = cached.tree;
    const known = new Set(tree.nodes.map((node) => node.token));
    if (!scopedTokens) return tree;
    for (const token of scopedTokens) {
      if (known.has(token)) continue;
      try {
        const document = await this.remote.getDocument(token);
        this.cacheRemoteNode(root, document);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        // A token missing from the drive can mean a folder was removed upstream;
        // only a full listing can settle that, so degrade to one refresh.
        this.warnings.push(`远端对象 ${token} 无法单点获取，本轮已回退为全量列举`);
        return this.refreshRemoteTree(root);
      }
    }
    return tree;
  }

  /** B3 scenario (3): bind an unclaimed remote document whose derived path also
   *  exists locally. Identical content pairs silently as `pending` (the round's
   *  sync then records the baseline); differing content becomes a conflict. */
  private async pairUnboundRemote(
    root: SyncRoot,
    binding: EntryBinding,
    node: RemoteNode,
    relativePath: string,
    remoteDocumentPaths: Map<string, string>,
    remoteAssetPaths: Map<string, string>,
    remoteAssetParents: Map<string, string>,
    localByPath: Map<string, LocalFile>
  ): Promise<void> {
    const localContent = await this.local.readText(root, relativePath);
    let remote: RemoteDocument;
    try {
      remote = await this.remote.getDocument(node.token);
    } catch (error) {
      if (isRemoteNotFound(error)) return;
      throw error;
    }
    const assetImport = await this.importRemoteAssets(root, binding.entryId, remote.content, remoteAssetPaths, remoteAssetParents, localByPath);
    const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    if (sha256(canonicalRemote) === sha256(localContent)) {
      await this.metaStorage.setBinding(root.id, relativePath, {
        ...binding,
        remoteToken: node.token,
        remoteParentToken: node.parentToken || root.remoteToken,
        remoteName: node.name,
        remoteContentHash: sha256(canonicalRemote),
        remoteRevision: remote.revisionId,
        status: "pending",
        updatedAt: new Date().toISOString()
      });
      return;
    }
    await this.recordRemoteCollision(root, binding, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents, localByPath);
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
      // B4: the entry has no token yet but a same-titled document may already
      // sit in the target folder — from this entry's own earlier creation that
      // died half-way, from a document the user hand-created and renamed, or
      // from a local rename that landed on an occupied title. Adopt an unbound
      // copy, resolve a bound-but-identical copy, and otherwise leave the
      // decision to the 异常工作台; never create a second copy silently.
      const tree = await this.loadRemoteTree(root);
      // B4: the discovery key is the deterministic title of the file name — and
      // the title actually recorded on the binding when de-duplication changed
      // it. The document's H1 is content, never identity.
      const canonicalTitle = remoteTitle(binding.relativePath);
      const expectedTitle = binding.remoteName ?? canonicalTitle;
      const duplicate = tree.nodes.find((node) => node.type === "document" && node.parentToken === parent && (node.name === expectedTitle || node.name === canonicalTitle));
      if (duplicate) {
        const bound = await this.metaStorage.findBindingByToken(root.id, duplicate.token);
        if (bound && bound.entryId !== binding.entryId) {
          // B4: a same-name document already backs another entry. Throwing
          // here used to abort the whole round with an un-actionable message;
          // now the entry becomes a conflict the 异常工作台 can resolve.
          return this.recordTitleCollision(root, binding, duplicate, bound, parent, localContent, reverseMap, assetMaps.reverseMap);
        }
        remote = await this.remote.getDocument(duplicate.token);
        const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
        if (sha256(canonicalRemote) === sha256(localContent) || sha256(remote.content) === sha256(localContent)) {
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
      let created = await this.remote.createDocument(parent, remoteTitle(binding.relativePath), remoteContent);
      this.cacheRemoteNode(root, created);
      // B2: creation is two calls (create with an explicit title, then overwrite
      // the markdown). If the second one fails the document already exists on
      // the drive, so persist its token *before* pushing content — the next
      // round adopts it instead of leaving an owner-less empty document behind
      // and creating a second copy.
      const provisional: EntryBinding = {
        ...binding,
        remoteToken: created.token,
        remoteParentToken: parent,
        remoteName: created.name,
        status: "pending",
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, binding.relativePath, provisional);
      if (assetMaps.hasLocalAssets && this.remote.uploadInlineAsset) {
        const inlineAssets = await this.prepareAssets(root, binding, localContent, created.token, true);
        assetMaps = inlineAssets;
        remoteContent = this.renderRemoteContent(localContent, binding.relativePath, forwardMap, inlineAssets.forwardMap);
        if (remoteContent !== created.content) {
          created = (await this.remote.applyPatch(created.token, { operations: [{ type: "overwrite", content: remoteContent }], expectedRevisionId: created.revisionId })).document;
        }
      } else if (!created.content && remoteContent) {
        // B2: the document was created but its body never landed (the provider
        // returned a token-only stub). Push it now; the binding already owns the
        // token either way, so a failure here can never orphan a remote document.
        created = (await this.remote.applyPatch(created.token, { operations: [{ type: "overwrite", content: remoteContent }], expectedRevisionId: created.revisionId })).document;
      }
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(created.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
      const hash = sha256(localContent);
      const next: EntryBinding = {
        ...provisional,
        remoteContentHash: sha256(canonicalRemote),
        localContentHash: hash,
        status: "clean",
        remoteRevision: created.revisionId,
        lastErrorAt: undefined,
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, binding.relativePath, next);
      // The drive now holds `localContent`; record exactly that in the index. A
      // save that lands before the round-end commit would otherwise become this
      // creation's baseline, and the next round would pull the older revision
      // over the user's newest work (base === local, remote behind).
      await this.gitStorage.stageReconciled(root.id, binding.relativePath, localContent);
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
    const base = baselineContent ?? localContent;
    const decision = decideSync(base, localContent, canonicalRemote);
    let action = decision.action === "noop" && assetMaps.changed ? "push" as const : decision.action;
    // B2: the two-step create persists the token *before* the markdown body
    // lands, so a creation that died half-way leaves an empty remote shell. With
    // no baseline this entry has never completed a sync, and an empty remote can
    // only be our own shell — pulling it would delete the local file it was made
    // from. (A deliberate remote clear is still pulled, because a synced entry
    // always has a baseline by then.)
    if (action === "pull" && baselineContent === undefined && localContent.trim() !== "" && canonicalRemote.trim() === "") action = "push";
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
    }

    const hash = sha256(content);
    const canonicalRemoteAfter = restoreAssetReferences(restoreInternalLinks(remoteAfter.content, reverseMap, binding.relativePath), assetMaps.reverseMap, binding.relativePath);
    const next: EntryBinding = {
      ...binding,
      status: "clean",
      // Where the local file stands once this action is over: only a pull rewrote
      // it, so push/merge/noop keep the bytes this round read. Keeping a stale
      // value here would let `commitBaseline` absorb an edit the round never saw.
      localContentHash: action === "pull" ? hash : sha256(localContent),
      remoteContentHash: sha256(canonicalRemoteAfter),
      remoteRevision: remoteAfter.revisionId,
      updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    // The same bookkeeping as a creation: the baseline has to be the bytes this
    // action agreed with the drive — after a pull that is `content`, otherwise the
    // file this round read (a merge updates the remote and leaves the local file).
    await this.gitStorage.stageReconciled(root.id, binding.relativePath, action === "pull" ? content : localContent);
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
    // The caller writes `content` to the local file right after this, so the
    // binding has to carry its hash for the baseline guard to mean anything.
    const next: EntryBinding = { ...binding, status: "clean", localContentHash: hash, remoteContentHash: sha256(canonicalRemote), remoteRevision: remoteAfter.revisionId, updatedAt: new Date().toISOString() };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    await this.gitStorage.stageReconciled(root.id, binding.relativePath, content);
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
    const next: EntryBinding = { ...binding, remoteToken, remoteParentToken: parent, remoteContentHash: contentHash, localContentHash: contentHash, status: "clean", updatedAt: new Date().toISOString() };
    await this.metaStorage.setBinding(root.id, binding.relativePath, next);
    await this.gitStorage.stageReconciled(root.id, binding.relativePath, content);
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
      const restored: EntryBinding = { ...binding, status: "clean", localContentHash: sha256(binary), remoteContentHash: sha256(binary), updatedAt: new Date().toISOString() };
      await this.metaStorage.setBinding(root.id, binding.relativePath, restored);
      await this.gitStorage.stageReconciled(root.id, binding.relativePath, binary);
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
    // A single-entry pull has no round snapshot; seed one with the paths this
    // document may reference so E3 still avoids a full-tree walk.
    const snapshot = new Map<string, LocalFile>();
    await this.importRemoteDocument(root, node, binding.relativePath, maps.documents, maps.assets, maps.assetParents, snapshot);
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

  /** Token→relative-path maps for one remote tree snapshot, shared by scan
   *  and the single-entry pull path. Every segment passes through the file-name
   *  sanitiser (B5), so a hostile or over-long drive listing yields a skip plus
   *  a warning rather than a crashed round. */
  private buildRemotePathMaps(rootToken: string, tree: RemoteTree): { documents: Map<string, string>; assets: Map<string, string>; assetParents: Map<string, string> } {
    const nodesByToken = new Map(tree.nodes.map((node) => [node.token, node]));
    const documents = new Map<string, string>();
    const assets = new Map<string, string>();
    const assetParents = new Map<string, string>();
    for (const node of tree.nodes) {
      const path = remoteRelativePath(rootToken, node, nodesByToken, node.type === "document" ? "md" : "none");
      if (!path) {
        this.warnings.push(`远端对象「${node.name}」(${node.token}) 的路径无法安全映射到本地，本轮已跳过`);
        continue;
      }
      if (node.type === "document") documents.set(node.token, path);
      if (node.type === "asset") {
        assets.set(node.token, path);
        assetParents.set(node.token, node.parentToken);
      }
    }
    return { documents, assets, assetParents };
  }

  private async importRemoteDocument(root: SyncRoot, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, localByPath: Map<string, LocalFile>): Promise<void> {
    let remote: RemoteDocument;
    try {
      remote = await this.remote.getDocument(node.token);
    } catch (error) {
      if (isRemoteNotFound(error)) return;
      throw error;
    }
    const existingBinding = await this.metaStorage.getBinding(root.id, relativePath);
    const entryId = existingBinding?.entryId ?? randomUUID();
    const assetImport = await this.importRemoteAssets(root, entryId, remote.content, remoteAssetPaths, remoteAssetParents, localByPath);
    const canonicalContent = restoreAssetReferences(restoreInternalLinks(remote.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    await this.local.writeText(root, relativePath, canonicalContent);
    const hash = sha256(canonicalContent);
    const next: EntryBinding = {
      entryId,
      rootId: root.id,
      relativePath,
      kind: "document",
      remoteToken: remote.token,
      remoteParentToken: node.parentToken || root.remoteToken,
      remoteName: node.name,
      localContentHash: hash,
      remoteContentHash: hash,
      remoteRevision: remote.revisionId,
      status: "clean",
      updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, relativePath, next);
    // The imported bytes are both the local file and the remote document now, so
    // they are what the baseline has to record.
    await this.gitStorage.stageReconciled(root.id, relativePath, canonicalContent);
    await this.metaStorage.saveAssetBindings(entryId, assetImport.bindings);
    await this.saveBlockMapping(entryId, canonicalContent, remote);
    // The file we just wrote is part of this round's local snapshot.
    const written = await this.local.scan(root, { onlyPaths: [relativePath] });
    for (const file of written) localByPath.set(file.relativePath, file);
  }

  private async recordRemoteCollision(root: SyncRoot, binding: EntryBinding, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, localByPath: Map<string, LocalFile>): Promise<void> {
    const localContent = await this.local.readText(root, relativePath);
    const remote = await this.remote.getDocument(node.token);
    const assetImport = await this.importRemoteAssets(root, binding.entryId, remote.content, remoteAssetPaths, remoteAssetParents, localByPath);
    const remoteContent = restoreAssetReferences(restoreInternalLinks(remote.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    const baselineContent = await this.gitStorage.getBaseline(root.id, relativePath);
    const baseContent = baselineContent ?? "";
    await this.metaStorage.setBinding(root.id, relativePath, { ...binding, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, remoteContentHash: sha256(remoteContent), remoteRevision: remote.revisionId, status: "conflict", updatedAt: new Date().toISOString() });
    const open = (await this.metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
    if (open) await this.metaStorage.updateConflict(open.id, { localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
    else await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent, localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content), reason: "本地与远端已存在同名文档且内容不同，请选择采用哪一侧" });
    await this.metaStorage.saveAssetBindings(binding.entryId, assetImport.bindings);
  }

  /** B4: the drive folder we are about to push into already holds a document of
   *  this title and that document backs a *different* entry. Rather than
   *  aborting the round, arm this entry against the colliding document and
   *  raise a conflict that spells out the three ways out: rename the local
   *  file and re-push, adopt the remote document, or ignore this entry. */
  private async recordTitleCollision(
    root: SyncRoot,
    binding: EntryBinding,
    duplicate: RemoteNode,
    owner: EntryBinding,
    parent: string,
    localContent: string,
    reverseMap: Map<string, string>,
    assetReverseMap: Map<string, string>
  ): Promise<EntryBinding> {
    const remote = await this.remote.getDocument(duplicate.token);
    const remoteContent = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, binding.relativePath), assetReverseMap, binding.relativePath);
    const baselineContent = await this.gitStorage.getBaseline(root.id, binding.relativePath);
    const reason = `远端同名文档「${duplicate.name}」已绑定到 ${owner.relativePath}；可重命名本地文件后重新推送、采用该远端文档，或忽略本条目`;
    const conflicting: EntryBinding = {
      ...binding,
      remoteToken: undefined,
      remoteParentToken: parent,
      remoteContentHash: sha256(remoteContent),
      remoteRevision: remote.revisionId,
      status: "conflict",
      lastErrorAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, binding.relativePath, conflicting);
    const open = (await this.metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
    const collision = { reason, collidingToken: duplicate.token, collidingOwnerPath: owner.relativePath };
    if (open) await this.metaStorage.updateConflict(open.id, { localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content), ...collision });
    else await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent: baselineContent ?? "", localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content), ...collision });
    return conflicting;
  }

  /** B4「采用该远端文档」: transfer the colliding document to `binding` and
   *  release its previous owner, which re-pushes under its own deterministic
   *  title on the next round. Mirrors what the user did on the drive (a rename)
   *  instead of leaving two entries fighting for one token. */
  async adoptCollidingDocument(entryId: string, collidingToken: string): Promise<EntryBinding> {
    const binding = await this.metaStorage.findBindingById(entryId);
    if (!binding) throw new Error(`Entry not found: ${entryId}`);
    const root = await this.metaStorage.getRoot(binding.rootId);
    if (!root) throw new Error(`Root not found: ${binding.rootId}`);
    const owner = await this.metaStorage.findBindingByToken(root.id, collidingToken);
    if (owner && owner.entryId !== entryId) {
      await this.metaStorage.setBinding(root.id, owner.relativePath, {
        ...owner, remoteToken: undefined, remoteName: undefined, remoteContentHash: undefined, remoteRevision: undefined,
        localContentHash: undefined, status: "pending", updatedAt: new Date().toISOString()
      });
    }
    const remote = await this.remote.getDocument(collidingToken);
    const adopted: EntryBinding = {
      ...binding, remoteToken: remote.token, remoteParentToken: remote.parentToken, remoteName: remote.name,
      remoteContentHash: remote.contentHash, remoteRevision: remote.revisionId, lastErrorAt: undefined,
      status: "pending", updatedAt: new Date().toISOString()
    };
    await this.metaStorage.setBinding(root.id, binding.relativePath, adopted);
    this.cacheRemoteNode(root, remote);
    return adopted;
  }

  /** E3: reuse the round's local snapshot instead of re-walking the tree for
   *  every imported document; paths the snapshot has never seen (they were
   *  created after the snapshot) are probed individually, which is cheap once
   *  {@link LocalProvider.scan} supports `onlyPaths`. */
  private async importRemoteAssets(root: SyncRoot, documentEntryId: string, content: string, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, localFiles: Map<string, LocalFile>): Promise<{ reverseMap: Map<string, string>; bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> }> {
    const reverseMap = new Map<string, string>();
    const bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> = [];
    const tokens = [...content.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    for (const token of tokens) {
      const relativePath = remoteAssetPaths.get(token);
      if (!relativePath || reverseMap.has(token)) continue;
      let binary: Uint8Array;
      try {
        binary = await this.remote.downloadAsset(token);
      } catch {
        continue;
      }
      const hash = sha256(binary);
      const existing = await this.metaStorage.getBinding(root.id, relativePath);
      let localFile = localFiles.get(relativePath);
      if (!localFile) {
        const probed = await this.local.scan(root, { onlyPaths: [relativePath] });
        localFile = probed.find((file) => file.relativePath === relativePath);
        if (localFile) localFiles.set(relativePath, localFile);
      }
      if (localFile && localFile.contentHash !== hash) continue;
      if (!localFile) {
        await this.local.writeBinary(root, relativePath, binary);
        const written = await this.local.scan(root, { onlyPaths: [relativePath] });
        for (const file of written) localFiles.set(file.relativePath, file);
      }
      const assetEntryId = existing?.entryId ?? randomUUID();
      const assetBinding: EntryBinding = {
        entryId: assetEntryId,
        rootId: root.id,
        relativePath,
        kind: "asset",
        remoteToken: token,
        remoteParentToken: remoteAssetParents.get(token) ?? root.remoteToken,
        remoteContentHash: hash,
        status: "clean",
        updatedAt: new Date().toISOString()
      };
      await this.metaStorage.setBinding(root.id, relativePath, assetBinding);
      reverseMap.set(token, relativePath);
      bindings.push({ documentEntryId, assetEntryId, token, contentHash: hash });
    }
    return { reverseMap, bindings };
  }

  private async hydrateChangedRemoteAssets(root: SyncRoot, documentBinding: EntryBinding, localContent: string, remoteContent: string): Promise<boolean> {
    const references = parseMarkdown(localContent).assets;
    if (references.length === 0) return false;
    const remoteTokens = [...remoteContent.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    if (remoteTokens.length === 0) return false;
    const bindings = await this.metaStorage.getAssetBindings(documentBinding.entryId);
    let conflict = false;
    for (let index = 0; index < Math.min(references.length, remoteTokens.length); index += 1) {
      const assetPath = resolveRelativePath(documentBinding.relativePath, references[index]!.target);
      const assetBinding = await this.metaStorage.getBinding(root.id, assetPath);
      const binding = assetBinding ? bindings.find((item) => item.assetEntryId === assetBinding.entryId) : undefined;
      const remoteToken = remoteTokens[index]!;
      if (!assetBinding || !binding || binding.token === remoteToken) continue;
      try {
        const binary = await this.remote.downloadAsset(remoteToken);
        const hash = sha256(binary);
        if (assetBinding.remoteContentHash !== binding.contentHash && assetBinding.remoteContentHash !== hash) {
          conflict = true;
          continue;
        }
        await this.local.writeBinary(root, assetPath, binary);
        await this.metaStorage.setBinding(root.id, assetPath, { ...assetBinding, remoteContentHash: hash, status: "clean", updatedAt: new Date().toISOString() });
        await this.metaStorage.saveAssetBindings(documentBinding.entryId, bindings.map((item) => item.assetEntryId === assetBinding.entryId ? { ...item, token: remoteToken, contentHash: hash } : item));
      } catch {
        conflict = true;
      }
    }
    return conflict;
  }

  private renderRemoteContent(content: string, currentPath: string, linkMap: Map<string, { token: string; url?: string }>, assetMap: Map<string, string>): string {
    return rewriteAssetReferences(rewriteInternalLinks(content, currentPath, linkMap), currentPath, assetMap);
  }

  private async prepareAssets(root: SyncRoot, documentBinding: EntryBinding, content: string, documentToken?: string, uploadInline = false): Promise<{ forwardMap: Map<string, string>; reverseMap: Map<string, string>; hasLocalAssets: boolean; changed: boolean }> {
    const forwardMap = new Map<string, string>();
    const reverseMap = new Map<string, string>();
    for (const binding of await this.metaStorage.listBindings(root.id)) {
      if (binding.kind === "asset" && binding.remoteToken) {
        forwardMap.set(binding.relativePath, binding.remoteToken);
        reverseMap.set(binding.remoteToken, binding.relativePath);
      }
    }
    for (const assetBinding of await this.metaStorage.getAssetBindings(documentBinding.entryId)) {
      const asset = await this.metaStorage.findBindingById(assetBinding.assetEntryId);
      if (asset) {
        reverseMap.set(assetBinding.token, asset.relativePath);
        forwardMap.set(asset.relativePath, assetBinding.token);
      }
    }

    const bindings = [];
    let changed = false;
    const references = parseMarkdown(content).assets;
    for (const reference of references) {
      const assetPath = resolveRelativePath(documentBinding.relativePath, reference.target);
      const assetBinding = await this.metaStorage.getBinding(root.id, assetPath);
      if (!assetBinding || assetBinding.kind !== "asset") continue;
      let token = assetBinding.remoteToken;
      const existingBinding = (await this.metaStorage.getAssetBindings(documentBinding.entryId)).find((b) => b.assetEntryId === assetBinding.entryId);
      const targetDocumentToken = documentToken ?? documentBinding.remoteToken;
      const bindingChanged = existingBinding !== undefined && existingBinding.contentHash !== assetBinding.remoteContentHash;
      if (bindingChanged) changed = true;
      if (uploadInline && targetDocumentToken && this.remote.uploadInlineAsset && (!existingBinding || bindingChanged)) {
        const binary = await this.local.readBinary(root, assetPath);
        if (existingBinding) reverseMap.set(existingBinding.token, assetPath);
        const uploaded = await this.remote.uploadInlineAsset(targetDocumentToken, posix.basename(assetPath), binary, mimeType(assetPath));
        token = uploaded.token;
        changed = true;
      }
      if (existingBinding && (!uploadInline || existingBinding.contentHash === assetBinding.remoteContentHash)) token = existingBinding.token;
      if (token) {
        forwardMap.set(assetPath, token);
        reverseMap.set(token, assetPath);
        bindings.push({ documentEntryId: documentBinding.entryId, assetEntryId: assetBinding.entryId, token, contentHash: assetBinding.remoteContentHash ?? "" });
      }
    }
    await this.metaStorage.saveAssetBindings(documentBinding.entryId, bindings);
    return { forwardMap, reverseMap, hasLocalAssets: references.length > 0, changed };
  }

  private async buildLinkMaps(rootId: string): Promise<{ forwardMap: Map<string, { token: string; url?: string }>; reverseMap: Map<string, string> }> {
    const forwardMap = new Map<string, { token: string; url?: string }>();
    const reverseMap = new Map<string, string>();
    for (const binding of await this.metaStorage.listBindings(rootId)) {
      if (binding.kind !== "document" || !binding.remoteToken) continue;
      const path = binding.relativePath;
      forwardMap.set(path, { token: binding.remoteToken });
      forwardMap.set(path.replace(/\.md$/i, ""), { token: binding.remoteToken });
      reverseMap.set(binding.remoteToken, path);
    }
    return { forwardMap, reverseMap };
  }

  /** Force-refresh the cached remote tree for a root; used at scan start so
   *  the engine works on a consistent snapshot. */
  private async refreshRemoteTree(root: SyncRoot): Promise<RemoteTree> {
    this.remoteTreeCache.delete(root.id);
    return this.loadRemoteTree(root);
  }

  /** Return the cached remote tree, fetching it once per TTL window and
   *  de-duplicating concurrent fetches. */
  private async loadRemoteTree(root: SyncRoot): Promise<RemoteTree> {
    const cached = this.remoteTreeCache.get(root.id);
    if (cached && Date.now() - cached.at < SyncEngine.REMOTE_TREE_TTL_MS) return cached.tree;
    const pending = this.remoteTreeJobs.get(root.id);
    if (pending) return pending;
    const job = this.remote.listTree(root).then((tree) => {
      this.remoteTreeCache.set(root.id, { tree, at: Date.now() });
      return tree;
    }).finally(() => { this.remoteTreeJobs.delete(root.id); });
    this.remoteTreeJobs.set(root.id, job);
    return job;
  }

  /** Register a newly created remote node in the cached tree so subsequent
   *  lookups in this round see it even if the drive listing lags behind. */
  private cacheRemoteNode(root: SyncRoot, node: RemoteNode): void {
    const cached = this.remoteTreeCache.get(root.id);
    if (cached) cached.tree.nodes.push(node);
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

  /** Decide whether a vanished binding was actually renamed/moved locally.
   *  Returns "moved" once the binding was re-pointed to the new path,
   *  "conflict" when several unbound files match and the target is ambiguous,
   *  or "none" when there is no rename evidence (a genuine local deletion). */
  private async detectRename(root: SyncRoot, binding: EntryBinding, localByPath: Map<string, LocalFile>, boundPaths: Set<string>): Promise<"moved" | "conflict" | "none"> {
    const hash = binding.remoteContentHash;
    if (!hash || !binding.remoteToken) return "none";
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
        remoteContent = (await this.remote.getDocument(binding.remoteToken)).content;
      } catch { /* a missing remote doc leaves the comparison empty */ }
      const baseContent = await this.gitStorage.getBaseline(root.id, binding.relativePath) ?? "";
      await this.metaStorage.setBinding(root.id, binding.relativePath, { ...binding, status: "conflict", updatedAt: new Date().toISOString() });
      const open = (await this.metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
      if (!open) await this.metaStorage.createConflict({ entryId: binding.entryId, baseContent, localContent: "", remoteContent, remoteRevision: binding.remoteRevision, remoteContentHash: hash });
      return "conflict";
    }
    const target = candidates[0]!;
    // Re-point: drop the stale path and hand the entry's identity (and remote
    // token) to the new path. Content is unchanged, so the entry stays clean
    // and the next round neither re-pushes it nor creates a duplicate document.
    await this.metaStorage.deleteBinding(root.id, binding.relativePath);
    await this.metaStorage.setBinding(root.id, target.relativePath, {
      ...binding,
      relativePath: target.relativePath,
      kind: target.kind,
      remoteContentHash: target.contentHash,
      status: "clean",
      updatedAt: new Date().toISOString()
    });
    return "moved";
  }

  private async saveBlockMapping(entryId: string, content: string, remote: RemoteDocument): Promise<void> {
    const blocks = parseMarkdown(content).blocks;
    await this.metaStorage.saveBlocks(entryId, blocks.flatMap((block, position) => {
      const remoteBlock = remote.blocks[position];
      return remoteBlock ? [{ entryId, stableId: block.stableId, blockId: remoteBlock.id, kind: block.kind, contentHash: block.contentHash, position }] : [];
    }));
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

function resolveRelativePath(currentPath: string, target: string): string {
  // B6: one shared implementation, so a percent-encoded or NFD spelling that
  // came back from the drive resolves to the same local path the rewrite side
  // would have matched.
  return resolveReferencePath(currentPath, target);
}

function isRemoteNotFound(error: unknown): boolean {
  return /(?:HTTP\s+404|not[ -]?found|notexisted|deleted)/i.test(error instanceof Error ? error.message : String(error));
}

function mimeType(relativePath: string): string {
  const extension = posix.extname(relativePath).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

/** Rebuild a local relative path from a remote node's folder chain and title.
 *  B5: each segment is sanitised before joining, and the result is rejected
 *  (undefined) when it is absolute, escapes the root or cannot be represented —
 *  the caller skips it with a warning instead of writing outside the root. */
function remoteRelativePath(
  rootToken: string,
  node: RemoteNode,
  nodes: Map<string, RemoteNode>,
  extension: "md" | "none" = "none"
): string | undefined {
  const segments = [node.name];
  const visited = new Set<string>();
  let parentToken = node.parentToken;
  while (parentToken && parentToken !== rootToken) {
    if (visited.has(parentToken)) return undefined;
    visited.add(parentToken);
    const parent = nodes.get(parentToken);
    if (!parent || parent.type !== "folder") return undefined;
    segments.unshift(parent.name);
    parentToken = parent.parentToken;
  }
  return safeRelativePath(segments, extension);
}
