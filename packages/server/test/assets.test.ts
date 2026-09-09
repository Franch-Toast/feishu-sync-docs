import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemProvider, SyncEngine } from "@feishu-sync/core";
import type { DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";

class InlineRemote implements RemoteProvider {
  readonly name = "inline-memory";
  readonly capabilities: ProviderCapabilities = { blockPatch: false, revisionGuard: true, assetUpload: true, remoteEvents: false };
  private readonly documents = new Map<string, RemoteDocument>();
  private sequence = 0;
  async listTree(root: SyncRoot): Promise<RemoteTree> { return { root: { token: root.remoteToken, name: "root", type: "folder", parentToken: "" }, nodes: [...this.documents.values()] }; }
  async getDocument(token: string): Promise<RemoteDocument> { const document = this.documents.get(token); if (!document) throw new Error("not found"); return structuredClone(document); }
  async createFolder(parentToken: string, name: string): Promise<RemoteNode> { return { token: `${parentToken}/${name}`, name, type: "folder", parentToken }; }
  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> { return this.save(`${parentToken}/${name}`, parentToken, name, content); }
  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> { const current = await this.getDocument(token); const content = patch.operations.find((operation) => operation.type === "overwrite")?.content ?? current.content; return { document: this.save(token, current.parentToken, current.name, content), applied: patch.operations }; }
  async uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> { return { token: `drive-${++this.sequence}`, name, type: "asset", parentToken, mimeType, size: content.byteLength }; }
  async uploadInlineAsset(documentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> { return { token: `inline-${++this.sequence}`, name, type: "asset", parentToken: documentToken, mimeType, size: content.byteLength }; }
  async downloadAsset(): Promise<Uint8Array> { return new Uint8Array(); }
  async softDelete(): Promise<void> {}
  get(token: string): RemoteDocument | undefined { return this.documents.get(token); }
  private save(token: string, parentToken: string, name: string, content: string): RemoteDocument { const document = { token, name, type: "document" as const, parentToken, content, blocks: [], revisionId: ++this.sequence }; this.documents.set(token, document); return structuredClone(document); }
}

test("uploads relative images as document resources and stores bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-assets-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-assets-global-"));
  await writeFile(join(directory, "image.png"), Buffer.from("image"));
  await writeFile(join(directory, "notes.md"), "# Notes\n\n![diagram](image.png)");
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new InlineRemote();
  const root = await metaStorage.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  await gitStorage.initRoot(root);
  await metaStorage.initRootMeta(root.id, root.localPath);
  const engine = new SyncEngine(gitStorage, metaStorage, new FilesystemProvider(), remote);
  const scan = await engine.scan(root);
  const documentEntry = scan.entries.find((entry) => entry.kind === "document")!;
  await engine.syncEntry(documentEntry, root);
  const bindings = await metaStorage.getAssetBindings(documentEntry.entryId);
  assert.equal(bindings.length, 1);
  const updatedBinding = await metaStorage.findBindingById(documentEntry.entryId);
  assert.match(remote.get(updatedBinding!.remoteToken!)?.content ?? "", /inline-/);
  await rm(directory, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});
