import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FilesystemProvider, SyncEngine, parseMarkdown } from "@feishu-sync/core";
import type { DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, SyncRoot } from "@feishu-sync/core";
import { SqliteStateStore } from "@feishu-sync/storage";

class MemoryRemote implements RemoteProvider {
  readonly name = "memory";
  readonly capabilities: ProviderCapabilities = { blockPatch: true, revisionGuard: true, assetUpload: true, remoteEvents: false };
  readonly documents = new Map<string, RemoteDocument>();
  private revision = 0;

  async listTree(root: SyncRoot): Promise<RemoteTree> {
    return { root: { token: root.remoteToken, name: "root", type: "folder", parentToken: "" }, nodes: [...this.documents.values()] };
  }
  async getDocument(token: string): Promise<RemoteDocument> { const document = this.documents.get(token); if (!document) throw new Error("missing document"); return structuredClone(document); }
  async createFolder(parentToken: string, name: string): Promise<RemoteNode> { return { token: `${parentToken}/${name}`, name, type: "folder", parentToken }; }
  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const document = this.makeDocument(`${parentToken}/${name}`, parentToken, name, content);
    this.documents.set(document.token, document);
    return structuredClone(document);
  }
  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    const document = await this.getDocument(token);
    if (patch.expectedRevisionId !== undefined && patch.expectedRevisionId !== document.revisionId) throw new Error("revision mismatch");
    let content = document.content;
    for (const operation of patch.operations) {
      if (operation.type === "overwrite") content = operation.content;
      else if (operation.type === "replace") content = replaceBlock(content, document.blocks, operation.blockId, operation.content);
    }
    const next = this.makeDocument(document.token, document.parentToken, document.name, content);
    this.documents.set(token, next);
    return { document: structuredClone(next), applied: patch.operations };
  }
  async uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> { return { token: `${parentToken}/${name}`, name, type: "asset", parentToken, mimeType, size: content.byteLength }; }
  async downloadAsset(): Promise<Uint8Array> { return new Uint8Array(); }
  async softDelete(token: string): Promise<void> { this.documents.delete(token); }

  edit(token: string, content: string): void {
    const current = this.documents.get(token);
    if (!current) throw new Error("missing document");
    this.documents.set(token, this.makeDocument(token, current.parentToken, current.name, content));
  }

  private makeDocument(token: string, parentToken: string, name: string, content: string): RemoteDocument {
    const parsed = parseMarkdown(content);
    return { token, name, type: "document", parentToken, content, contentHash: parsed.contentHash, revisionId: ++this.revision, blocks: parsed.blocks.map((block, position) => ({ id: `${token}:${position}`, kind: block.kind, content: block.content, contentHash: block.contentHash, position })) };
  }
}

test("sync engine creates once, pulls remote changes, and records conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-"));
  const path = join(directory, "notes.md");
  await writeFile(path, "# Notes\n\noriginal", "utf8");
  const store = new SqliteStateStore();
  const remote = new MemoryRemote();
  const root = await store.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  const engine = new SyncEngine(store, new FilesystemProvider(), remote);

  let scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  let entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  const token = entry.remoteToken!;
  assert.equal((await engine.scan(root)).entries[0]?.status, "clean");

  remote.edit(token, "# Notes\n\nremote change");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  entry = await engine.syncEntry(scan.entries[0]!, root);
  assert.equal(entry.status, "clean");
  assert.match(await readFile(path, "utf8"), /remote change/);

  await writeFile(path, "# Notes\n\nlocal change", "utf8");
  await engine.scan(root);
  remote.edit(token, "# Notes\n\nremote again");
  scan = await engine.scan(root);
  assert.equal(scan.entries[0]?.status, "pending");
  await engine.syncEntry(scan.entries[0]!, root);
  assert.equal((await store.listConflicts("open")).length, 1);
  remote.edit(token, "# Notes\n\nremote after conflict");
  await engine.scan(root);
  assert.equal((await store.listConflicts("open"))[0]?.remoteContent, "# Notes\n\nremote after conflict");
  store.close();
});

test("imports a remote-only document into the local tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feishu-sync-remote-"));
  const store = new SqliteStateStore();
  const remote = new MemoryRemote();
  await remote.createDocument("root", "remote-notes", "# Remote\n\nCreated in Feishu");
  const root = await store.createRoot({ localPath: directory, remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60000 });
  const engine = new SyncEngine(store, new FilesystemProvider(), remote);

  const result = await engine.scan(root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.status, "clean");
  assert.equal(await readFile(join(directory, "remote-notes.md"), "utf8"), "# Remote\n\nCreated in Feishu");
  store.close();
});

function replaceBlock(content: string, blocks: RemoteDocument["blocks"], blockId: string, replacement: string): string {
  const block = blocks.find((item) => item.id === blockId);
  if (!block) return content;
  return content.replace(block.content, replacement);
}
