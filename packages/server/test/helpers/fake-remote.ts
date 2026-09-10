import { parseMarkdown } from "@feishu-sync/core";
import type {
  DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument,
  RemoteNode, RemoteProvider, RemoteTree, SyncRoot
} from "@feishu-sync/core";
import { FeishuApiError } from "@feishu-sync/feishu";

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
  readonly folders = new Map<string, RemoteNode>();
  /** Mirrors Feishu's behaviour of deriving the drive-visible title from the
   *  markdown H1 instead of keeping the file name passed to createDocument. */
  simulateH1Title = false;
  listTreeCalls = 0;
  createFolderCalls = 0;
  getDocumentCalls = 0;
  /** When set, getDocument throws it instead of resolving; exercises the
   *  validate-token permission/auth branches without a live Feishu call. */
  getDocumentError?: Error;
  /** When true every applyPatch throws until cleared; exercises the runtime's
   *  auto-retry exhaustion path (a one-shot failNextWrite is retried into
   *  success within the same round). */
  failWrites = false;
  /** When true applyPatch throws an auth FeishuApiError; auth failures must
   *  never be auto-retried (they fail fast and flag the credential state). */
  failWritesAuth = false;
  /** When > 0, that many applyPatch calls throw a 429 rate-limit error carrying
   *  a Retry-After hint (B6.2); the runtime must honour it as a backoff floor. */
  rateLimitRemaining = 0;
  rateLimitRetryAfterMs = 0;
  private writeFailuresRemaining = 0;
  private revision = 0;
  private pendingWriteError?: Error;

  /** Fail the next `count` applyPatch calls (transient), then recover; used to
   *  exercise the exponential-backoff auto-retry succeeding mid-round. */
  failWritesTimes(count: number): void {
    this.writeFailuresRemaining = count;
  }

  /** Simulate Feishu answering 429 with a Retry-After header for the next
   *  `count` writes (B6.2). */
  failWritesRateLimit(count: number, retryAfterMs: number): void {
    this.rateLimitRemaining = count;
    this.rateLimitRetryAfterMs = retryAfterMs;
  }

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
    this.listTreeCalls += 1;
    return { root: { token: root.remoteToken, name: "root", type: "folder", parentToken: "" }, nodes: [...this.folders.values(), ...this.documents.values()] };
  }

  async getDocument(token: string): Promise<RemoteDocument> {
    this.getDocumentCalls += 1;
    if (this.getDocumentError) throw this.getDocumentError;
    const document = this.documents.get(token);
    if (!document) throw new Error(`HTTP 404 notfound: ${token}`);
    return structuredClone(document);
  }

  async createFolder(parentToken: string, name: string): Promise<RemoteNode> {
    this.createFolderCalls += 1;
    const node = { token: `${parentToken}/${name}`, name, type: "folder" as const, parentToken };
    this.folders.set(node.token, node);
    return node;
  }

  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const document = this.makeDocument(`${parentToken}/${name}`, parentToken, name, content);
    this.documents.set(document.token, document);
    return structuredClone(document);
  }

  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    if (this.failWritesAuth) throw new FeishuApiError("auth", "simulated invalid token on write");
    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining -= 1;
      throw new FeishuApiError("rate_limit", "simulated rate limit", undefined, 429, this.rateLimitRetryAfterMs);
    }
    if (this.failWrites) throw new Error("simulated persistent remote write failure");
    if (this.writeFailuresRemaining > 0) {
      this.writeFailuresRemaining -= 1;
      throw new Error("simulated transient remote write failure");
    }
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
    const displayName = this.simulateH1Title ? parsed.title ?? name : name;
    return {
      token,
      name: displayName,
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
