import { parseMarkdown } from "@feishu-sync/core";
import type {
  DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument,
  RemoteNode, RemoteProvider, RemoteTree, SyncRoot
} from "@feishu-sync/core";

/**
 * In-memory RemoteProvider shared by the server test-suite. Mirrors the
 * behaviour of the real provider (revision-guarded patches, block-level
 * replaces) and adds hooks for exercising failure paths:
 * - failNextWrite: make the next applyPatch call throw (one-shot).
 */
export class FakeRemote implements RemoteProvider {
  readonly name = "fake";
  readonly capabilities: ProviderCapabilities = { blockPatch: true, revisionGuard: true, assetUpload: true, remoteEvents: false };
  readonly documents = new Map<string, RemoteDocument>();
  private revision = 0;
  private pendingWriteError?: Error;

  /** Make the next applyPatch call fail to exercise runtime error handling. */
  failNextWrite(message = "simulated remote write failure"): void {
    this.pendingWriteError = new Error(message);
  }

  /** Simulate an out-of-band remote edit (as if done in Feishu). */
  edit(token: string, content: string): void {
    const current = this.documents.get(token);
    if (!current) throw new Error(`missing document: ${token}`);
    this.documents.set(token, this.makeDocument(token, current.parentToken, current.name, content));
  }

  async listTree(root: SyncRoot): Promise<RemoteTree> {
    return { root: { token: root.remoteToken, name: "root", type: "folder", parentToken: "" }, nodes: [...this.documents.values()] };
  }

  async getDocument(token: string): Promise<RemoteDocument> {
    const document = this.documents.get(token);
    if (!document) throw new Error(`HTTP 404 notfound: ${token}`);
    return structuredClone(document);
  }

  async createFolder(parentToken: string, name: string): Promise<RemoteNode> {
    return { token: `${parentToken}/${name}`, name, type: "folder", parentToken };
  }

  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const document = this.makeDocument(`${parentToken}/${name}`, parentToken, name, content);
    this.documents.set(document.token, document);
    return structuredClone(document);
  }

  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    if (this.pendingWriteError) {
      const error = this.pendingWriteError;
      this.pendingWriteError = undefined;
      throw error;
    }
    const document = await this.getDocument(token);
    if (patch.expectedRevisionId !== undefined && patch.expectedRevisionId !== document.revisionId) {
      throw new Error("revision mismatch");
    }
    let content = document.content;
    for (const operation of patch.operations) {
      if (operation.type === "overwrite") content = operation.content;
      else if (operation.type === "replace") content = replaceBlock(content, document.blocks, operation.blockId, operation.content);
    }
    const next = this.makeDocument(document.token, document.parentToken, document.name, content);
    this.documents.set(token, next);
    return { document: structuredClone(next), applied: patch.operations };
  }

  async uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> {
    return { token: `${parentToken}/${name}`, name, type: "asset", parentToken, mimeType, size: content.byteLength };
  }

  async downloadAsset(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async softDelete(token: string): Promise<void> {
    this.documents.delete(token);
  }

  private makeDocument(token: string, parentToken: string, name: string, content: string): RemoteDocument {
    const parsed = parseMarkdown(content);
    return {
      token,
      name,
      type: "document",
      parentToken,
      content,
      contentHash: parsed.contentHash,
      revisionId: ++this.revision,
      blocks: parsed.blocks.map((block, position) => ({
        id: `${token}:${position}`,
        kind: block.kind,
        content: block.content,
        contentHash: block.contentHash,
        position
      }))
    };
  }
}

function replaceBlock(content: string, blocks: RemoteDocument["blocks"], blockId: string, replacement: string): string {
  const block = blocks.find((item) => item.id === blockId);
  if (!block) return content;
  return content.replace(block.content, replacement);
}
