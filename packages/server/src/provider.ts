import { LarkCliProvider, FeishuOpenApiProvider } from "@feishu-sync/feishu";
import type {
  DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument,
  RemoteNode, RemoteProvider, RemoteTree, SyncRoot
} from "@feishu-sync/core";
import type { CredentialStore } from "./credentials.js";

/** Legacy env-only factory kept for direct embedding scenarios. */
export function createRemoteProvider(): RemoteProvider {
  if ((process.env.FEISHU_PROVIDER ?? "openapi") === "cli") return new LarkCliProvider({ executable: process.env.LARK_CLI_BIN ?? process.env.LARK_CLI_PATH, apiVersion: process.env.LARK_CLI_API_VERSION === "v2" ? "v2" : "v1" });
  return new FeishuOpenApiProvider({ accessToken: process.env.FEISHU_ACCESS_TOKEN, appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, baseUrl: process.env.FEISHU_BASE_URL });
}

/** Delegating provider whose delegate can be rebuilt at runtime without
 *  restarting watchers or the sync engine. Every call resolves the current
 *  delegate, so saving new credentials takes effect on the next operation. */
export class ProviderRegistry implements RemoteProvider {
  private current?: RemoteProvider;

  constructor(private readonly credentials: CredentialStore) {}

  get initialized(): boolean {
    return this.current !== undefined;
  }

  /** Build a provider from the latest stored credentials. */
  async rebuild(): Promise<RemoteProvider> {
    this.current = await this.credentials.buildProvider();
    return this.current;
  }

  private get remote(): RemoteProvider {
    if (!this.current) throw new Error("Remote provider is not initialized yet");
    return this.current;
  }

  get name(): string {
    return this.remote.name;
  }

  get capabilities(): ProviderCapabilities {
    return this.remote.capabilities;
  }

  listTree(root: SyncRoot): Promise<RemoteTree> {
    return this.remote.listTree(root);
  }

  getDocument(token: string): Promise<RemoteDocument> {
    return this.remote.getDocument(token);
  }

  createFolder(parentToken: string, name: string): Promise<RemoteNode> {
    return this.remote.createFolder(parentToken, name);
  }

  createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    return this.remote.createDocument(parentToken, name, content);
  }

  applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    return this.remote.applyPatch(token, patch);
  }

  uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> {
    return this.remote.uploadAsset(parentToken, name, content, mimeType);
  }

  uploadInlineAsset?(documentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> {
    const delegate = this.remote.uploadInlineAsset;
    if (!delegate) return Promise.reject(new Error("The active remote provider does not support inline asset upload"));
    return delegate.call(this.remote, documentToken, name, content, mimeType);
  }

  downloadAsset(token: string): Promise<Uint8Array> {
    return this.remote.downloadAsset(token);
  }

  softDelete(token: string, type?: "docx" | "folder" | "file"): Promise<void> {
    return this.remote.softDelete(token, type);
  }
}
