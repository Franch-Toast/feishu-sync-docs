import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parseMarkdown, restoreAssetReferences, restoreInternalLinks, rewriteAssetReferences, rewriteInternalLinks } from "./markdown.js";
import { sha256 } from "./hash.js";
import { stripEnvelope, writeSyncDocument } from "./frontmatter.js";
import { isRemoteNotFound, mimeType, resolveRelativePath } from "./sync_paths.js";
import type { SyncServices } from "./sync_services.js";
import type { EntryBinding, LocalFile, RemoteDocument, RemoteNode, SyncRoot } from "./types.js";

/**
 * Remote document import, asset materialization and the content-render helpers
 * the push path shares with it.
 *
 * `SyncEngine` orchestrates *when* to import/pull/push; this collaborator owns
 * *how* a remote document (and the images it references) lands on disk, how
 * local content is rendered for the drive (link + asset rewriting), and how the
 * three-way merge's remote content is canonicalized back for hashing. It also
 * exposes the binding-derived link map and block-mapping persistence that the
 * engine's `scan`/`syncEntry` loops reuse.
 */
export class RemoteImporter {
  constructor(private readonly services: SyncServices) {}

  /** Local document path↔remote token maps for one root, used to rewrite and
   *  restore internal links during push/pull. */
  async buildLinkMaps(rootId: string): Promise<{ forwardMap: Map<string, { token: string; url?: string }>; reverseMap: Map<string, string> }> {
    const forwardMap = new Map<string, { token: string; url?: string }>();
    const reverseMap = new Map<string, string>();
    for (const binding of await this.services.metaStorage.listBindings(rootId)) {
      if (binding.kind !== "document" || !binding.remoteToken) continue;
      const path = binding.relativePath;
      forwardMap.set(path, { token: binding.remoteToken });
      forwardMap.set(path.replace(/\.md$/i, ""), { token: binding.remoteToken });
      reverseMap.set(binding.remoteToken, path);
    }
    return { forwardMap, reverseMap };
  }

  /** Render local markdown for a remote write: internal links become drive
   *  token/url references and local image paths become asset tokens. */
  renderRemoteContent(content: string, currentPath: string, linkMap: Map<string, { token: string; url?: string }>, assetMap: Map<string, string>): string {
    return rewriteAssetReferences(rewriteInternalLinks(content, currentPath, linkMap), currentPath, assetMap);
  }

  /** Persist the local-block↔remote-block mapping so a later patch can target
   *  blocks by stable id instead of overwriting the whole document. */
  async saveBlockMapping(entryId: string, content: string, remote: RemoteDocument): Promise<void> {
    const blocks = parseMarkdown(content).blocks;
    await this.services.metaStorage.saveBlocks(entryId, blocks.flatMap((block, position) => {
      const remoteBlock = remote.blocks[position];
      return remoteBlock ? [{ entryId, stableId: block.stableId, blockId: remoteBlock.id, kind: block.kind, contentHash: block.contentHash, position }] : [];
    }));
  }

  /** Resolve the asset forward/reverse maps for a document write (and, when
   *  `uploadInline`, push freshly-changed local images so their tokens can be
   *  embedded). `changed` signals the caller that asset bindings moved and a
   *  push is warranted even when the text body is otherwise a no-op. */
  async prepareAssets(root: SyncRoot, documentBinding: EntryBinding, content: string, documentToken?: string, uploadInline = false): Promise<{ forwardMap: Map<string, string>; reverseMap: Map<string, string>; hasLocalAssets: boolean; changed: boolean }> {
    const { local, remote, metaStorage } = this.services;
    const forwardMap = new Map<string, string>();
    const reverseMap = new Map<string, string>();
    for (const binding of await metaStorage.listBindings(root.id)) {
      if (binding.kind === "asset" && binding.remoteToken) {
        forwardMap.set(binding.relativePath, binding.remoteToken);
        reverseMap.set(binding.remoteToken, binding.relativePath);
      }
    }
    for (const assetBinding of await metaStorage.getAssetBindings(documentBinding.entryId)) {
      const asset = await metaStorage.findBindingById(assetBinding.assetEntryId);
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
      const assetBinding = await metaStorage.getBinding(root.id, assetPath);
      if (!assetBinding || assetBinding.kind !== "asset") continue;
      let token = assetBinding.remoteToken;
      const existingBinding = (await metaStorage.getAssetBindings(documentBinding.entryId)).find((b) => b.assetEntryId === assetBinding.entryId);
      const targetDocumentToken = documentToken ?? documentBinding.remoteToken;
      const bindingChanged = existingBinding !== undefined && existingBinding.contentHash !== assetBinding.remoteContentHash;
      if (bindingChanged) changed = true;
      if (uploadInline && targetDocumentToken && remote.uploadInlineAsset && (!existingBinding || bindingChanged)) {
        const binary = await local.readBinary(root, assetPath);
        if (existingBinding) reverseMap.set(existingBinding.token, assetPath);
        const uploaded = await remote.uploadInlineAsset(targetDocumentToken, posix.basename(assetPath), binary, mimeType(assetPath));
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
    await metaStorage.saveAssetBindings(documentBinding.entryId, bindings);
    return { forwardMap, reverseMap, hasLocalAssets: references.length > 0, changed };
  }

  /** Import a remote-only document (and its images) into a new local file, then
   *  arm a clean binding for it. */
  async importRemoteDocument(root: SyncRoot, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, knownFiles?: Map<string, LocalFile>): Promise<void> {
    const { local, remote, metaStorage } = this.services;
    let document: RemoteDocument;
    try {
      document = await remote.getDocument(node.token);
    } catch (error) {
      if (isRemoteNotFound(error)) return;
      throw error;
    }
    const existingBinding = await metaStorage.getBinding(root.id, relativePath);
    const entryId = existingBinding?.entryId ?? randomUUID();
    const assetImport = await this.importRemoteAssets(root, entryId, document.content, remoteAssetPaths, remoteAssetParents, knownFiles);
    const canonicalContent = restoreAssetReferences(restoreInternalLinks(document.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    // The imported file is stamped right away: the envelope exists only in the
    // bytes on disk, never in the hash below or in the block mapping, so the
    // block sequence stays aligned with the remote document.
    await local.writeText(root, relativePath, writeSyncDocument(canonicalContent, { token: document.token, rootId: root.id }).text);
    const hash = sha256(canonicalContent);
    const next: EntryBinding = {
      entryId,
      rootId: root.id,
      relativePath,
      kind: "document",
      remoteToken: document.token,
      remoteParentToken: node.parentToken || root.remoteToken,
      remoteContentHash: hash,
      remoteRevision: document.revisionId,
      status: "clean",
      identitySource: "frontmatter",
      updatedAt: new Date().toISOString()
    };
    await metaStorage.setBinding(root.id, relativePath, next);
    await metaStorage.saveAssetBindings(entryId, assetImport.bindings);
    await this.saveBlockMapping(entryId, canonicalContent, document);
  }

  /** A local file already owns this path but a *different* remote token turned
   *  up here: record the divergence as a conflict on the existing entry rather
   *  than silently overwriting either side. */
  async recordRemoteCollision(root: SyncRoot, binding: EntryBinding, node: RemoteNode, relativePath: string, remoteDocumentPaths: Map<string, string>, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, knownFiles?: Map<string, LocalFile>): Promise<void> {
    const { local, remote, metaStorage, gitStorage } = this.services;
    const localContent = stripEnvelope(await local.readText(root, relativePath));
    const document = await remote.getDocument(node.token);
    const assetImport = await this.importRemoteAssets(root, binding.entryId, document.content, remoteAssetPaths, remoteAssetParents, knownFiles);
    const remoteContent = restoreAssetReferences(restoreInternalLinks(document.content, remoteDocumentPaths, relativePath), assetImport.reverseMap, relativePath);
    const baselineContent = stripEnvelope(await gitStorage.getBaseline(root.id, relativePath) ?? "");
    const baseContent = baselineContent ?? "";
    await metaStorage.setBinding(root.id, relativePath, { ...binding, remoteToken: node.token, remoteParentToken: node.parentToken || root.remoteToken, remoteContentHash: sha256(remoteContent), remoteRevision: document.revisionId, status: "conflict", updatedAt: new Date().toISOString() });
    const open = (await metaStorage.listConflicts("open")).find((conflict) => conflict.entryId === binding.entryId);
    if (open) await metaStorage.updateConflict(open.id, { localContent, remoteContent, remoteRevision: document.revisionId, remoteContentHash: sha256(document.content) });
    else await metaStorage.createConflict({ entryId: binding.entryId, baseContent, localContent, remoteContent, remoteRevision: document.revisionId, remoteContentHash: sha256(document.content) });
    await metaStorage.saveAssetBindings(binding.entryId, assetImport.bindings);
  }

  /** Download every `<img>` token referenced by an imported body into local
   *  files and return the token↔path reverse map plus the asset bindings. */
  private async importRemoteAssets(root: SyncRoot, documentEntryId: string, content: string, remoteAssetPaths: Map<string, string>, remoteAssetParents: Map<string, string>, knownFiles?: Map<string, LocalFile>): Promise<{ reverseMap: Map<string, string>; bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> }> {
    const { local, remote, metaStorage } = this.services;
    const reverseMap = new Map<string, string>();
    const bindings: Array<{ documentEntryId: string; assetEntryId: string; token: string; contentHash: string }> = [];
    const tokens = [...content.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    // Reuse the caller's scan when available; per-token scans would walk the
    // whole tree for every image.
    const localFiles = knownFiles ?? new Map((await local.scan(root)).map((file) => [file.relativePath, file]));
    for (const token of tokens) {
      const relativePath = remoteAssetPaths.get(token);
      if (!relativePath || reverseMap.has(token)) continue;
      let binary: Uint8Array;
      try {
        binary = await remote.downloadAsset(token);
      } catch {
        continue;
      }
      const hash = sha256(binary);
      const existing = await metaStorage.getBinding(root.id, relativePath);
      const localFile = localFiles.get(relativePath);
      if (localFile && localFile.contentHash !== hash) continue;
      if (!localFile) await local.writeBinary(root, relativePath, binary);
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
      await metaStorage.setBinding(root.id, relativePath, assetBinding);
      reverseMap.set(token, relativePath);
      bindings.push({ documentEntryId, assetEntryId, token, contentHash: hash });
    }
    return { reverseMap, bindings };
  }

  /** A remote edit swapped an inline image while the local copy diverged: sync
   *  the changed assets down and report whether a conflict must be surfaced. */
  async hydrateChangedRemoteAssets(root: SyncRoot, documentBinding: EntryBinding, localContent: string, remoteContent: string): Promise<boolean> {
    const { local, remote, metaStorage } = this.services;
    const references = parseMarkdown(localContent).assets;
    if (references.length === 0) return false;
    const remoteTokens = [...remoteContent.matchAll(/<img\s+[^>]*?(?:src|token)="([^"]+)"/g)].map((match) => match[1]).filter((token): token is string => Boolean(token));
    if (remoteTokens.length === 0) return false;
    const bindings = await metaStorage.getAssetBindings(documentBinding.entryId);
    let conflict = false;
    for (let index = 0; index < Math.min(references.length, remoteTokens.length); index += 1) {
      const assetPath = resolveRelativePath(documentBinding.relativePath, references[index]!.target);
      const assetBinding = await metaStorage.getBinding(root.id, assetPath);
      const binding = assetBinding ? bindings.find((item) => item.assetEntryId === assetBinding.entryId) : undefined;
      const remoteToken = remoteTokens[index]!;
      if (!assetBinding || !binding || binding.token === remoteToken) continue;
      try {
        const binary = await remote.downloadAsset(remoteToken);
        const hash = sha256(binary);
        if (assetBinding.remoteContentHash !== binding.contentHash && assetBinding.remoteContentHash !== hash) {
          conflict = true;
          continue;
        }
        await local.writeBinary(root, assetPath, binary);
        await metaStorage.setBinding(root.id, assetPath, { ...assetBinding, remoteContentHash: hash, status: "clean", updatedAt: new Date().toISOString() });
        await metaStorage.saveAssetBindings(documentBinding.entryId, bindings.map((item) => item.assetEntryId === assetBinding.entryId ? { ...item, token: remoteToken, contentHash: hash } : item));
      } catch {
        conflict = true;
      }
    }
    return conflict;
  }
}
