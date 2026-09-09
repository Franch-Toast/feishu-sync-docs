import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { buildBlockPatch, decideSync } from "./merge.js";
import { parseMarkdown, restoreAssetReferences, restoreInternalLinks, rewriteAssetReferences, rewriteInternalLinks } from "./markdown.js";
import { sha256 } from "./hash.js";
import type {
  LocalProvider, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, StateStore, SyncEntry, SyncRoot
} from "./types.js";

export class SyncEngine {
  /** Remote-tree cache keyed by root id. A scan refreshes it once and the
   *  sync-entry loop it triggers reuses the same listing; repeated per-entry
   *  drive walks were slow and allowed duplicate-folder creation races. */
  private readonly remoteTreeCache = new Map<string, { tree: RemoteTree; at: number }>();
  private readonly remoteTreeJobs = new Map<string, Promise<RemoteTree>>();
  private static readonly REMOTE_TREE_TTL_MS = 60_000;

  constructor(
    private readonly store: StateStore,
    private readonly local: LocalProvider,
    private readonly remote: RemoteProvider
  ) {}

  async scan(root: SyncRoot): Promise<{ entries: SyncEntry[]; conflicts: number }> {
    let files = await this.local.scan(root);
    const initialEntries = await this.store.listEntries(root.id);
    const existingByPath = new Map(initialEntries.map((entry) => [entry.relativePath, entry]));
    let localByPath = new Map(files.map((file) => [file.relativePath, file]));
    const changedAssets: string[] = [];

    for (const file of files) {
      const existing = existingByPath.get(file.relativePath);
      const changed = existing?.localHash !== file.contentHash;
      const status = existing?.status === "conflict"
        ? "conflict"
        : changed || existing?.status === "error"
          ? "pending"
          : existing?.status ?? "pending";
      const entry: SyncEntry = {
        id: existing?.id ?? randomUUID(),
        rootId: root.id,
        relativePath: file.relativePath,
        kind: file.kind,
        remoteToken: existing?.remoteToken,
        remoteParentToken: existing?.remoteParentToken,
        status,
        localHash: file.contentHash,
        remoteHash: existing?.remoteHash,
        baseHash: existing?.baseHash,
        localRevision: existing?.localRevision,
        remoteRevision: existing?.remoteRevision,
        updatedAt: new Date().toISOString()
      };
      await this.store.upsertEntry(entry);
      if (file.kind === "asset" && changed && existing?.remoteToken) changedAssets.push(file.relativePath);
    }

    const remoteTree = await this.refreshRemoteTree(root);
    const remoteNodesByToken = new Map(remoteTree.nodes.map((node) => [node.token, node]));
    const remoteDocumentPaths = new Map<string, string>();
    const remoteAssetPaths = new Map<string, string>();
    const remoteAssetParents = new Map<string, string>();
    for (const node of remoteTree.nodes) {
      const path = remoteRelativePath(root.remoteToken, node, remoteNodesByToken);
      if (!path) continue;
      if (node.type === "document") remoteDocumentPaths.set(node.token, ensureMarkdownPath(path));
      if (node.type === "asset") {
        remoteAssetPaths.set(node.token, path);
        remoteAssetParents.set(node.token, node.parentToken);
      }
    }
    for (const node of remoteTree.nodes.filter((item) => item.type === "document")) {
      const relativePath = remoteDocumentPaths.get(node.token);
      if (!relativePath) continue;
      const alreadyBound = initialEntries.some((entry) => entry.remoteToken === node.token);
      if (alreadyBound) continue;
      const existing = await this.store.findEntry(root.id, relativePath);
      if (existing?.remoteToken && existing.remoteToken !== node.token) continue;
      if (existing && existing.kind === "document" && localByPath.has(relativePath)) {
        if (!existing.remoteToken) await this.recordRemoteCollision(root, existing, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents);
        else await this.store.upsertEntry({ ...existing, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, status: "pending", updatedAt: new Date().toISOString() });
        continue;
      }
      if (!localByPath.has(relativePath)) {
        await this.importRemoteDocument(root, node, relativePath, remoteDocumentPaths, remoteAssetPaths, remoteAssetParents);
      }
    }
    if (remoteTree.nodes.some((node) => node.type === "document" && remoteDocumentPaths.has(node.token) && !localByPath.has(remoteDocumentPaths.get(node.token)!))) {
      files = await this.local.scan(root);
      localByPath = new Map(files.map((file) => [file.relativePath, file]));
    }

    for (const entry of initialEntries) {
      if (!localByPath.has(entry.relativePath) && entry.remoteToken) {
        await this.store.upsertEntry({ ...entry, status: "orphan", updatedAt: new Date().toISOString() });
      }
    }

    const entriesAfterFiles = await this.store.listEntries(root.id);
    const entryByPath = new Map(entriesAfterFiles.map((entry) => [entry.relativePath, entry]));
    const referencesByAsset = new Map<string, string[]>();
    for (const file of files.filter((item) => item.kind === "document")) {
      const content = await this.local.readText(root, file.relativePath);
      const documentEntry = entryByPath.get(file.relativePath);
      if (!documentEntry) continue;
      for (const reference of parseMarkdown(content).assets) {
        const assetPath = resolveRelativePath(file.relativePath, reference.target);
        const asset = entryByPath.get(assetPath);
        if (asset?.kind === "asset") referencesByAsset.set(assetPath, [...(referencesByAsset.get(assetPath) ?? []), documentEntry.id]);
      }
    }
    for (const asset of entriesAfterFiles.filter((entry) => entry.kind === "asset")) {
      await this.store.saveAssetReferences(root.id, asset.relativePath, referencesByAsset.get(asset.relativePath) ?? []);
    }

    for (const assetPath of changedAssets) {
      for (const entryId of await this.store.listAssetReferences(root.id, assetPath)) {
        const entry = await this.store.getEntry(entryId);
        if (entry && entry.status !== "conflict") {
          await this.store.upsertEntry({ ...entry, status: "pending", updatedAt: new Date().toISOString() });
        }
      }
    }

    const { reverseMap } = await this.buildLinkMaps(root.id);
    // Load open conflicts once for the whole loop instead of querying per entry.
    const openConflicts = await this.store.listConflicts("open");
    for (const entry of await this.store.listEntries(root.id)) {
      if (entry.kind !== "document" || !entry.remoteToken || !localByPath.has(entry.relativePath)) continue;
      let remote;
      try {
        remote = await this.remote.getDocument(entry.remoteToken);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        await this.store.upsertEntry({ ...entry, status: "orphan", updatedAt: new Date().toISOString() });
        continue;
      }
      const assetReverseMap = new Map<string, string>();
      for (const binding of await this.store.getAssetBindings(entry.id)) {
        const asset = await this.store.getEntry(binding.assetEntryId);
        if (asset) assetReverseMap.set(binding.token, asset.relativePath);
      }
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, entry.relativePath), assetReverseMap, entry.relativePath);
      const remoteHash = sha256(canonicalRemote);
      const remoteChanged = entry.remoteHash !== undefined && remoteHash !== entry.remoteHash;
      const localContent = entry.status === "conflict" ? await this.local.readText(root, entry.relativePath) : undefined;
      const openConflict = entry.status === "conflict"
        ? openConflicts.find((conflict) => conflict.entryId === entry.id)
        : undefined;
      if (openConflict && (remoteChanged || openConflict.remoteRevision !== remote.revisionId || openConflict.localContent !== localContent)) {
        await this.store.updateConflict(openConflict.id, { localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      }
      await this.store.upsertEntry({
        ...entry,
        status: entry.status === "conflict" ? "conflict" : remoteChanged ? "pending" : entry.status,
        remoteHash,
        remoteRevision: remote.revisionId,
        updatedAt: new Date().toISOString()
      });
    }

    const entries = await this.store.listEntries(root.id);
    return {
      entries,
      conflicts: (await this.store.listConflicts("open")).filter((conflict) => entries.some((entry) => entry.id === conflict.entryId)).length
    };
  }

  async syncEntry(entry: SyncEntry, root: SyncRoot): Promise<SyncEntry> {
    if (entry.kind === "asset") return this.syncAsset(entry, root);

    const localContent = await this.local.readText(root, entry.relativePath);
    const { forwardMap, reverseMap } = await this.buildLinkMaps(root.id);
    let remote;
    if (entry.remoteToken) {
      try {
        remote = await this.remote.getDocument(entry.remoteToken);
      } catch (error) {
        if (!isRemoteNotFound(error)) throw error;
        const orphan = { ...entry, status: "orphan" as const, updatedAt: new Date().toISOString() };
        await this.store.upsertEntry(orphan);
        return orphan;
      }
    }
    let assetMaps = await this.prepareAssets(root, entry, localContent, remote?.token, false);
    if (!remote) {
      const parent = await this.ensureRemoteParent(root, entry.relativePath);
      // Feishu derives the drive-visible title from the markdown H1, so two
      // local files sharing a first heading would push two identically named
      // documents into the same folder. Adopt an unbound same-name document
      // (e.g. this entry's own earlier creation after a partial failure)
      // instead of creating another copy; block on same-name documents that
      // are already bound elsewhere.
      const tree = await this.loadRemoteTree(root);
      const expectedTitle = parseMarkdown(localContent).title ?? documentTitle(entry.relativePath);
      const duplicate = tree.nodes.find((node) => node.type === "document" && node.parentToken === parent && (node.name === expectedTitle || node.name === documentTitle(entry.relativePath)));
      if (duplicate) {
        const bound = await this.store.findEntryByRemoteToken(duplicate.token);
        if (bound && bound.id !== entry.id) {
          throw new Error(`Remote folder already has a document named "${duplicate.name}" bound to ${bound.relativePath}; rename one side, then retry sync`);
        }
        remote = await this.remote.getDocument(duplicate.token);
        const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
        if (sha256(canonicalRemote) === sha256(localContent) || sha256(remote.content) === sha256(localContent)) {
          // The existing copy matches the local file (most likely this
          // entry's own earlier creation); rebind and sync as usual.
          const adopted: SyncEntry = { ...entry, remoteToken: remote.token, remoteParentToken: parent, status: "pending", updatedAt: new Date().toISOString() };
          await this.store.upsertEntry(adopted);
          return this.syncEntry(adopted, root);
        }
        // Same name but different content: let the user decide instead of
        // silently overwriting either side.
        const conflicting: SyncEntry = { ...entry, remoteToken: remote.token, remoteParentToken: parent, remoteHash: sha256(canonicalRemote), remoteRevision: remote.revisionId, status: "conflict", updatedAt: new Date().toISOString() };
        await this.store.upsertEntry(conflicting);
        const snapshot = await this.store.getSnapshot(entry.id);
        await this.store.createConflict({ entryId: entry.id, baseContent: snapshot?.baseContent ?? "", localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
        return conflicting;
      }
      let remoteContent = this.renderRemoteContent(localContent, entry.relativePath, forwardMap, assetMaps.forwardMap);
      let created = await this.remote.createDocument(parent, documentTitle(entry.relativePath), remoteContent);
      this.cacheRemoteNode(root, created);
      if (assetMaps.hasLocalAssets && this.remote.uploadInlineAsset) {
        const inlineAssets = await this.prepareAssets(root, entry, localContent, created.token, true);
        assetMaps = inlineAssets;
        remoteContent = this.renderRemoteContent(localContent, entry.relativePath, forwardMap, inlineAssets.forwardMap);
        if (remoteContent !== created.content) created = (await this.remote.applyPatch(created.token, { operations: [{ type: "overwrite", content: remoteContent }], expectedRevisionId: created.revisionId })).document;
      }
      const canonicalRemote = restoreAssetReferences(restoreInternalLinks(created.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
      const hash = sha256(localContent);
      const next: SyncEntry = {
        ...entry,
        remoteToken: created.token,
        remoteParentToken: parent,
        localHash: hash,
        remoteHash: sha256(canonicalRemote),
        baseHash: hash,
        status: "clean",
        remoteRevision: created.revisionId,
        updatedAt: new Date().toISOString()
      };
      await this.store.upsertEntry(next);
      await this.store.saveSnapshot({ entryId: entry.id, baseContent: localContent, localContent, remoteContent: canonicalRemote, baseHash: hash, localHash: hash, remoteHash: sha256(canonicalRemote), createdAt: new Date().toISOString() });
      await this.saveBlockMapping(entry.id, localContent, created);
      await this.markDocumentReferences(root, entry.relativePath);
      return next;
    }

    const assetConflict = await this.hydrateChangedRemoteAssets(root, entry, localContent, remote.content);
    assetMaps = await this.prepareAssets(root, entry, localContent, remote.token, false);
    if (assetConflict) {
      const snapshot = await this.store.getSnapshot(entry.id);
      const base = snapshot?.baseContent ?? localContent;
      const remoteConflictContent = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
      const open = (await this.store.listConflicts("open")).find((conflict) => conflict.entryId === entry.id);
      if (open) await this.store.updateConflict(open.id, { localContent, remoteContent: remoteConflictContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      else await this.store.createConflict({ entryId: entry.id, baseContent: base, localContent, remoteContent: remoteConflictContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      const next = { ...entry, status: "conflict" as const, remoteRevision: remote.revisionId, updatedAt: new Date().toISOString() };
      await this.store.upsertEntry(next);
      return next;
    }
    const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remote.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
    const snapshot = await this.store.getSnapshot(entry.id);
    const base = snapshot?.baseContent ?? localContent;
    const decision = decideSync(base, localContent, canonicalRemote);
    const action = decision.action === "noop" && assetMaps.changed ? "push" as const : decision.action;
    if (action === "conflict") {
      const open = (await this.store.listConflicts("open")).find((conflict) => conflict.entryId === entry.id);
      if (open) await this.store.updateConflict(open.id, { localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      else await this.store.createConflict({ entryId: entry.id, baseContent: base, localContent, remoteContent: canonicalRemote, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
      const next = { ...entry, status: "conflict" as const, remoteHash: sha256(canonicalRemote), remoteRevision: remote.revisionId, updatedAt: new Date().toISOString() };
      await this.store.upsertEntry(next);
      return next;
    }

    const content = action === "pull" ? canonicalRemote : action === "merge" ? decision.mergedContent ?? localContent : localContent;
    if (action === "pull") await this.local.writeText(root, entry.relativePath, content);

    let remoteAfter = remote;
    if (action === "push" || action === "merge") {
      assetMaps = await this.prepareAssets(root, entry, content, remote.token, true);
      const remoteContent = this.renderRemoteContent(content, entry.relativePath, forwardMap, assetMaps.forwardMap);
      const patch = this.remote.capabilities.blockPatch && remote.blocks.length > 0
        ? buildBlockPatch(base, remoteContent, remote.blocks, remote.rootBlockId).operations
        : [{ type: "overwrite" as const, content: remoteContent }];
      remoteAfter = (await this.remote.applyPatch(remote.token, { operations: patch, expectedRevisionId: remote.revisionId, expectedContentHash: remote.contentHash })).document;
    }

    const hash = sha256(content);
    const canonicalRemoteAfter = restoreAssetReferences(restoreInternalLinks(remoteAfter.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
    const next: SyncEntry = {
      ...entry,
      status: "clean",
      localHash: hash,
      remoteHash: sha256(canonicalRemoteAfter),
      baseHash: hash,
      remoteRevision: remoteAfter.revisionId,
      updatedAt: new Date().toISOString()
    };
    await this.store.upsertEntry(next);
    await this.store.saveSnapshot({ entryId: entry.id, baseContent: content, localContent: content, remoteContent: canonicalRemoteAfter, baseHash: hash, localHash: hash, remoteHash: sha256(canonicalRemoteAfter), createdAt: new Date().toISOString() });
    await this.saveBlockMapping(entry.id, content, remoteAfter);
    return next;
  }

  async applyResolvedContent(entry: SyncEntry, root: SyncRoot, content: string, expectedRemote?: RemoteDocument): Promise<SyncEntry> {
    if (!entry.remoteToken) throw new Error("Resolved content requires a bound remote document");
    const remote = expectedRemote ?? await this.remote.getDocument(entry.remoteToken);
    const { forwardMap, reverseMap } = await this.buildLinkMaps(root.id);
    const assetMaps = await this.prepareAssets(root, entry, content, remote.token, true);
    const remoteContent = this.renderRemoteContent(content, entry.relativePath, forwardMap, assetMaps.forwardMap);
    const remoteAfter = (await this.remote.applyPatch(remote.token, {
      operations: [{ type: "overwrite", content: remoteContent }],
      expectedRevisionId: remote.revisionId,
      expectedContentHash: remote.contentHash
    })).document;
    const hash = sha256(content);
    const canonicalRemote = restoreAssetReferences(restoreInternalLinks(remoteAfter.content, reverseMap, entry.relativePath), assetMaps.reverseMap, entry.relativePath);
    const next = { ...entry, status: "clean" as const, localHash: hash, remoteHash: sha256(canonicalRemote), baseHash: hash, remoteRevision: remoteAfter.revisionId, updatedAt: new Date().toISOString() };
    await this.store.upsertEntry(next);
    await this.store.saveSnapshot({ entryId: entry.id, baseContent: content, localContent: content, remoteContent: canonicalRemote, baseHash: hash, localHash: hash, remoteHash: sha256(canonicalRemote), createdAt: new Date().toISOString() });
    await this.saveBlockMapping(entry.id, content, remoteAfter);
    return next;
  }

  private async syncAsset(entry: SyncEntry, root: SyncRoot): Promise<SyncEntry> {
    if (!this.remote.capabilities.assetUpload) {
      const error = { ...entry, status: "error" as const, updatedAt: new Date().toISOString() };
      await this.store.upsertEntry(error);
      return error;
    }
    const content = await this.local.readBinary(root, entry.relativePath);
    const parent = await this.ensureRemoteParent(root, entry.relativePath);
    let remoteToken = entry.remoteToken;
    if (!remoteToken || entry.remoteHash !== entry.localHash) {
      const uploaded = await this.remote.uploadAsset(parent, posix.basename(entry.relativePath), content, mimeType(entry.relativePath));
      if (remoteToken && remoteToken !== uploaded.token) await this.remote.softDelete(remoteToken, "file");
      remoteToken = uploaded.token;
    }
    const next = { ...entry, remoteToken, remoteParentToken: parent, remoteHash: entry.localHash, baseHash: entry.localHash, status: "clean" as const, updatedAt: new Date().toISOString() };
    await this.store.upsertEntry(next);
    if (entry.remoteToken !== remoteToken) await this.markDocumentReferences(root, entry.relativePath);
    return next;
  }

  private async importRemoteDocument(root: SyncRoot, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>): Promise<void> {
    let remote: RemoteDocument;
    try {
      remote = await this.remote.getDocument(node.token);
    } catch (error) {
      if (isRemoteNotFound(error)) return;
      throw error;
    }
    const entry = await this.store.findEntry(root.id, relativePath) ?? {
      id: randomUUID(), rootId: root.id, relativePath, kind: "document" as const, status: "pending" as const, updatedAt: new Date().toISOString()
    };
    const assetImport = await this.importRemoteAssets(root, entry.id, remote.content, remoteAssetPaths, remoteAssetParents);
    const canonicalContent = restoreAssetReferences(restoreInternalLinks(remote.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    await this.local.writeText(root, relativePath, canonicalContent);
    const hash = sha256(canonicalContent);
    const next: SyncEntry = {
      ...entry,
      kind: "document",
      remoteToken: remote.token,
      remoteParentToken: node.parentToken || root.remoteToken,
      localHash: hash,
      remoteHash: hash,
      baseHash: hash,
      remoteRevision: remote.revisionId,
      status: "clean",
      updatedAt: new Date().toISOString()
    };
    await this.store.upsertEntry(next);
    await this.store.saveAssetBindings(entry.id, assetImport.bindings);
    await this.store.saveSnapshot({ entryId: entry.id, baseContent: canonicalContent, localContent: canonicalContent, remoteContent: canonicalContent, baseHash: hash, localHash: hash, remoteHash: hash, createdAt: new Date().toISOString() });
    await this.saveBlockMapping(entry.id, canonicalContent, remote);
  }

  private async recordRemoteCollision(root: SyncRoot, entry: SyncEntry, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>): Promise<void> {
    const localContent = await this.local.readText(root, relativePath);
    const remote = await this.remote.getDocument(node.token);
    const assetImport = await this.importRemoteAssets(root, entry.id, remote.content, remoteAssetPaths, remoteAssetParents);
    const remoteContent = restoreAssetReferences(restoreInternalLinks(remote.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    const snapshot = await this.store.getSnapshot(entry.id);
    const baseContent = snapshot?.baseContent ?? "";
    await this.store.upsertEntry({ ...entry, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, remoteHash: sha256(remoteContent), remoteRevision: remote.revisionId, status: "conflict", updatedAt: new Date().toISOString() });
    const open = (await this.store.listConflicts("open")).find((conflict) => conflict.entryId === entry.id);
    if (open) await this.store.updateConflict(open.id, { localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
    else await this.store.createConflict({ entryId: entry.id, baseContent, localContent, remoteContent, remoteRevision: remote.revisionId, remoteContentHash: sha256(remote.content) });
    await this.store.saveAssetBindings(entry.id, assetImport.bindings);
  }

  private async importRemoteAssets(root: SyncRoot, documentEntryId: string, content: string, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>): Promise<{ reverseMap: Map<string, string>; bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> }> {
    const reverseMap = new Map<string, string>();
    const bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> = [];
    const tokens = [...content.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    // Scan the local directory once; per-token scans would walk the whole tree for every image.
    const localFiles = new Map((await this.local.scan(root)).map((file) => [file.relativePath, file]));
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
      const existing = await this.store.findEntry(root.id, relativePath);
      const localFile = localFiles.get(relativePath);
      if (localFile && localFile.contentHash !== hash) continue;
      if (!localFile) await this.local.writeBinary(root, relativePath, binary);
      const assetEntry = existing ?? { id: randomUUID(), rootId: root.id, relativePath, kind: "asset" as const, status: "clean" as const, updatedAt: new Date().toISOString() };
      await this.store.upsertEntry({ ...assetEntry, kind: "asset", remoteToken: token, remoteParentToken: remoteAssetParents.get(token) ?? root.remoteToken, localHash: hash, remoteHash: hash, baseHash: hash, status: "clean", updatedAt: new Date().toISOString() });
      reverseMap.set(token, relativePath);
      bindings.push({ documentEntryId, assetEntryId: assetEntry.id, token, contentHash: hash });
    }
    return { reverseMap, bindings };
  }

  private async hydrateChangedRemoteAssets(root: SyncRoot, documentEntry: SyncEntry, localContent: string, remoteContent: string): Promise<boolean> {
    const references = parseMarkdown(localContent).assets;
    if (references.length === 0) return false;
    const remoteTokens = [...remoteContent.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    if (remoteTokens.length === 0) return false;
    const bindings = await this.store.getAssetBindings(documentEntry.id);
    let conflict = false;
    for (let index = 0; index < Math.min(references.length, remoteTokens.length); index += 1) {
      const assetPath = resolveRelativePath(documentEntry.relativePath, references[index]!.target);
      const assetEntry = await this.store.findEntry(root.id, assetPath);
      const binding = assetEntry ? bindings.find((item) => item.assetEntryId === assetEntry.id) : undefined;
      const remoteToken = remoteTokens[index]!;
      if (!assetEntry || !binding || binding.token === remoteToken) continue;
      try {
        const binary = await this.remote.downloadAsset(remoteToken);
        const hash = sha256(binary);
        if (assetEntry.localHash !== binding.contentHash && assetEntry.localHash !== hash) {
          conflict = true;
          continue;
        }
        await this.local.writeBinary(root, assetPath, binary);
        await this.store.upsertEntry({ ...assetEntry, localHash: hash, remoteHash: hash, baseHash: hash, status: "clean", updatedAt: new Date().toISOString() });
        await this.store.saveAssetBindings(documentEntry.id, bindings.map((item) => item.assetEntryId === assetEntry.id ? { ...item, token: remoteToken, contentHash: hash } : item));
      } catch {
        conflict = true;
      }
    }
    return conflict;
  }

  private renderRemoteContent(content: string, currentPath: string, linkMap: Map<string, { token: string; url?: string }>, assetMap: Map<string, string>): string {
    return rewriteAssetReferences(rewriteInternalLinks(content, currentPath, linkMap), currentPath, assetMap);
  }

  private async prepareAssets(root: SyncRoot, documentEntry: SyncEntry, content: string, documentToken?: string, uploadInline = false): Promise<{ forwardMap: Map<string, string>; reverseMap: Map<string, string>; hasLocalAssets: boolean; changed: boolean }> {
    const forwardMap = new Map<string, string>();
    const reverseMap = new Map<string, string>();
    for (const asset of await this.store.listEntries(root.id)) {
      if (asset.kind === "asset" && asset.remoteToken) {
        forwardMap.set(asset.relativePath, asset.remoteToken);
        reverseMap.set(asset.remoteToken, asset.relativePath);
      }
    }
    for (const binding of await this.store.getAssetBindings(documentEntry.id)) {
      const asset = await this.store.getEntry(binding.assetEntryId);
      if (asset) {
        reverseMap.set(binding.token, asset.relativePath);
        forwardMap.set(asset.relativePath, binding.token);
      }
    }

    const bindings = [];
    let changed = false;
    const references = parseMarkdown(content).assets;
    for (const reference of references) {
      const assetPath = resolveRelativePath(documentEntry.relativePath, reference.target);
      const assetEntry = await this.store.findEntry(root.id, assetPath);
      if (!assetEntry || assetEntry.kind !== "asset") continue;
      let token = assetEntry.remoteToken;
      const existingBinding = (await this.store.getAssetBindings(documentEntry.id)).find((binding) => binding.assetEntryId === assetEntry.id);
      const targetDocumentToken = documentToken ?? documentEntry.remoteToken;
      const bindingChanged = existingBinding !== undefined && existingBinding.contentHash !== assetEntry.localHash;
      if (bindingChanged) changed = true;
      if (uploadInline && targetDocumentToken && this.remote.uploadInlineAsset && (!existingBinding || bindingChanged)) {
        const binary = await this.local.readBinary(root, assetPath);
        if (existingBinding) reverseMap.set(existingBinding.token, assetPath);
        const uploaded = await this.remote.uploadInlineAsset(targetDocumentToken, posix.basename(assetPath), binary, mimeType(assetPath));
        token = uploaded.token;
        changed = true;
      }
      if (existingBinding && (!uploadInline || existingBinding.contentHash === assetEntry.localHash)) token = existingBinding.token;
      if (token) {
        forwardMap.set(assetPath, token);
        reverseMap.set(token, assetPath);
        bindings.push({ documentEntryId: documentEntry.id, assetEntryId: assetEntry.id, token, contentHash: assetEntry.localHash ?? "" });
      }
    }
    await this.store.saveAssetBindings(documentEntry.id, bindings);
    return { forwardMap, reverseMap, hasLocalAssets: references.length > 0, changed };
  }

  private async buildLinkMaps(rootId: string): Promise<{ forwardMap: Map<string, { token: string; url?: string }>; reverseMap: Map<string, string> }> {
    const forwardMap = new Map<string, { token: string; url?: string }>();
    const reverseMap = new Map<string, string>();
    for (const entry of await this.store.listEntries(rootId)) {
      if (entry.kind !== "document" || !entry.remoteToken) continue;
      const path = entry.relativePath;
      forwardMap.set(path, { token: entry.remoteToken });
      forwardMap.set(path.replace(/\.md$/i, ""), { token: entry.remoteToken });
      reverseMap.set(entry.remoteToken, path);
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
    const directories = posix.dirname(relativePath).split("/").filter(Boolean);
    let parentToken = root.remoteToken;
    const tree = await this.loadRemoteTree(root);
    for (const name of directories) {
      const existing = tree.nodes.find((node) => node.type === "folder" && node.parentToken === parentToken && node.name === name);
      if (existing) {
        parentToken = existing.token;
        continue;
      }
      const created = await this.remote.createFolder(parentToken, name);
      // Register before returning: drive listings may lag behind creation
      // and a retry in that window would otherwise create a duplicate folder.
      tree.nodes.push(created);
      parentToken = created.token;
    }
    return parentToken;
  }

  private async saveBlockMapping(entryId: string, content: string, remote: RemoteDocument): Promise<void> {
    const blocks = parseMarkdown(content).blocks;
    await this.store.saveBlocks(entryId, blocks.flatMap((block, position) => {
      const remoteBlock = remote.blocks[position];
      return remoteBlock ? [{ entryId, stableId: block.stableId, blockId: remoteBlock.id, kind: block.kind, contentHash: block.contentHash, position }] : [];
    }));
  }

  private async markDocumentReferences(root: SyncRoot, targetPath: string): Promise<void> {
    for (const entry of await this.store.listEntries(root.id)) {
      if (entry.kind !== "document" || entry.relativePath === targetPath) continue;
      const content = await this.local.readText(root, entry.relativePath);
      const references = parseMarkdown(content).links.map((link) => resolveRelativePath(entry.relativePath, link.target));
      if (references.includes(targetPath) && entry.status !== "conflict") {
        await this.store.upsertEntry({ ...entry, status: "pending", updatedAt: new Date().toISOString() });
      }
    }
  }
}

function resolveRelativePath(currentPath: string, target: string): string {
  const cleanTarget = target.split("#", 1)[0]?.split("?", 1)[0] ?? target;
  return posix.normalize(posix.join(posix.dirname(currentPath), cleanTarget)).replace(/^\.\//, "");
}

function isRemoteNotFound(error: unknown): boolean {
  return /(?:HTTP\s+404|not[ -]?found|notexisted|deleted)/i.test(error instanceof Error ? error.message : String(error));
}

function documentTitle(relativePath: string): string {
  return posix.basename(relativePath).replace(/\.md$/i, "") || "Untitled";
}

function mimeType(relativePath: string): string {
  const extension = posix.extname(relativePath).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function remoteRelativePath(rootToken: string, node: RemoteNode, nodes: Map<string, RemoteNode>): string | undefined {
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
  const path = posix.normalize(posix.join(...segments));
  if (!path || path === "." || path.startsWith("../") || path.startsWith("/")) return undefined;
  return path;
}

function ensureMarkdownPath(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}
