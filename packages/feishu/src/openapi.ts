import { createHash } from "node:crypto";
import { parseMarkdown } from "@feishu-sync/core";
import type {
  DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument,
  RemoteNode, RemoteProvider, RemoteTree, SyncRoot
} from "@feishu-sync/core";

export interface FeishuOpenApiOptions {
  baseUrl?: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  fetchImpl?: typeof fetch;
}

interface FeishuEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface DocumentResponse {
  document?: {
    document_id?: string;
    revision_id?: number;
    title?: string;
    content?: string;
    root_block_id?: string;
    blocks?: Array<{ block_id?: string; block_type?: number; content?: string; block?: Record<string, unknown> }>;
  };
}

interface DocxBlock {
  block_id?: string;
  block_type?: number;
}

interface DocxBlockResponse {
  items?: DocxBlock[];
  page_token?: string;
  has_more?: boolean;
}

export class FeishuOpenApiProvider implements RemoteProvider {
  readonly name = "feishu-openapi";
  readonly capabilities: ProviderCapabilities = { blockPatch: true, revisionGuard: true, assetUpload: true, remoteEvents: false };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token?: string;
  private tokenExpiresAt = 0;
  private tokenRequest?: Promise<string>;

  constructor(private readonly options: FeishuOpenApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.accessToken;
  }

  async listTree(root: SyncRoot): Promise<RemoteTree> {
    if (root.remoteType === "wiki") throw new Error("Wiki roots are not supported by the OpenAPI adapter yet; configure a Feishu Drive folder root");
    const rootNode: RemoteNode = { token: root.remoteToken, name: root.remoteToken, type: "folder", parentToken: "" };
    const nodes: RemoteNode[] = [];
    await this.walkDrive(root.remoteToken, nodes);
    return { root: rootNode, nodes };
  }

  async getDocument(token: string): Promise<RemoteDocument> {
    const response = await this.request<DocumentResponse>("POST", `/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}/fetch`, {
      format: "markdown",
      extra_param: { enable_user_cite_reference_map: true },
      export_option: { export_block_id: true, export_cite_extra_data: true }
    });
    const document = response.document ?? { document_id: token };
    const content = document.content ?? "";
    const parsedBlocks = parseMarkdown(content).blocks;
    const sourceBlocks = document.blocks ?? [];
    const blocks = sourceBlocks.length === parsedBlocks.length && sourceBlocks.every((block) => Boolean(block.block_id))
      ? sourceBlocks.map((block, position) => ({
        id: block.block_id!,
        kind: parsedBlocks[position]!.kind,
        content: parsedBlocks[position]!.content,
        contentHash: parsedBlocks[position]!.contentHash,
        position
      }))
      : [];
    const documentId = document.document_id ?? token;
    const nativeBlocks = blocks.length > 0 ? { blocks } : await this.listNativeBlocks(documentId, parsedBlocks);
    return { token: documentId, name: document.title ?? token, type: "document", parentToken: "", content, blocks: nativeBlocks.blocks, contentHash: createHash("sha256").update(content).digest("hex"), revisionId: document.revision_id, rootBlockId: document.root_block_id ?? nativeBlocks.rootBlockId };
  }

  async createFolder(parentToken: string, name: string): Promise<RemoteNode> {
    const data = await this.request<{ file?: { token?: string; name?: string } }>("POST", "/open-apis/drive/v1/files/create_folder", { name, folder_token: parentToken });
    const token = data.file?.token;
    if (!token) throw new Error("Feishu did not return the created folder token");
    return { token, name: data.file?.name ?? name, type: "folder", parentToken };
  }

  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const data = await this.request<{ document?: { document_id?: string; revision_id?: number; title?: string } }>("POST", "/open-apis/docs_ai/v1/documents", { format: "markdown", content, parent_token: parentToken });
    const token = data.document?.document_id;
    if (!token) throw new Error("Feishu did not return the created document token");
    return this.getDocument(token);
  }

  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    let current = await this.getDocument(token);
    if (patch.expectedRevisionId !== undefined && current.revisionId !== patch.expectedRevisionId) {
      throw new Error("Remote document revision changed since the sync snapshot");
    }
    if (patch.expectedContentHash && current.contentHash && patch.expectedContentHash !== current.contentHash) {
      throw new Error("Remote document content changed since the sync snapshot");
    }
    for (const operation of patch.operations) {
      const body: Record<string, unknown> = {
        format: "markdown",
        command: operation.type === "insertAfter" ? "block_insert_after" : operation.type === "replace" ? "block_replace" : operation.type === "delete" ? "block_delete" : "overwrite",
        revision_id: current.revisionId ?? patch.expectedRevisionId ?? -1
      };
      if ("content" in operation) body.content = operation.content;
      if (operation.type !== "overwrite") body.block_id = operation.blockId;
      await this.request("PUT", `/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}`, body);
      current = await this.getDocument(token);
    }
    return { document: current, applied: patch.operations };
  }

  async uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> {
    const form = new FormData();
    form.append("file_name", name);
    form.append("parent_type", "explorer");
    form.append("parent_node", parentToken);
    form.append("size", String(content.byteLength));
    form.append("file", new Blob([Buffer.from(content)], { type: mimeType }), name);
    const response = await this.request<{ file_token?: string }>("POST", "/open-apis/drive/v1/medias/upload_all", form);
    if (!response.file_token) throw new Error("Feishu did not return the uploaded asset token");
    return { token: response.file_token, name, type: "asset", parentToken, mimeType, size: content.byteLength };
  }

  async uploadInlineAsset(documentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset> {
    const form = new FormData();
    form.append("file_name", name);
    form.append("parent_type", "docx_image");
    form.append("parent_node", documentToken);
    form.append("size", String(content.byteLength));
    form.append("file", new Blob([Buffer.from(content)], { type: mimeType }), name);
    const response = await this.request<{ file_token?: string }>("POST", "/open-apis/drive/v1/medias/upload_all", form);
    if (!response.file_token) throw new Error("Feishu did not return the inline image token");
    return { token: response.file_token, name, type: "asset", parentToken: documentToken, mimeType, size: content.byteLength };
  }

  async downloadAsset(token: string): Promise<Uint8Array> {
    const response = await this.rawRequest("GET", `/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async softDelete(token: string): Promise<void> {
    await this.request("DELETE", `/open-apis/drive/v1/files/${encodeURIComponent(token)}`);
  }

  private async walkDrive(folderToken: string, output: RemoteNode[]): Promise<void> {
    let pageToken = "";
    do {
      const query = new URLSearchParams({ folder_token: folderToken, page_size: "200" });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.request<{ files?: Array<{ token?: string; name?: string; type?: string; parent_token?: string; modified_time?: string }>; next_page_token?: string }>("GET", `/open-apis/drive/v1/files?${query}`);
      for (const file of data.files ?? []) {
        if (!file.token) continue;
        const type = file.type === "folder" ? "folder" : ["doc", "docx", "wiki"].includes(file.type ?? "") ? "document" : "asset";
        const node: RemoteNode = { token: file.token, name: file.name ?? file.token, type, parentToken: file.parent_token ?? folderToken, updatedAt: file.modified_time };
        output.push(node);
        if (type === "folder") await this.walkDrive(file.token, output);
      }
      pageToken = data.next_page_token ?? "";
    } while (pageToken);
  }

  private async listNativeBlocks(documentToken: string, parsedBlocks: ReturnType<typeof parseMarkdown>["blocks"]): Promise<{ blocks: RemoteDocument["blocks"]; rootBlockId?: string }> {
    const items: DocxBlock[] = [];
    let pageToken = "";
    try {
      do {
        const query = new URLSearchParams({ page_size: "500" });
        if (pageToken) query.set("page_token", pageToken);
        const data = await this.request<DocxBlockResponse>("GET", `/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/blocks?${query}`);
        items.push(...(data.items ?? []));
        pageToken = data.has_more ? data.page_token ?? "" : "";
      } while (pageToken);
    } catch {
      return { blocks: [] };
    }
    const root = items.find((item) => item.block_type === 1)?.block_id;
    const children = items.filter((item) => item.block_type !== 1 && item.block_id);
    if (children.length !== parsedBlocks.length) return { blocks: [], rootBlockId: root };
    return {
      rootBlockId: root,
      blocks: parsedBlocks.map((block, position) => ({ id: children[position]!.block_id!, kind: block.kind, content: block.content, contentHash: block.contentHash, position }))
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.rawRequest(method, path, body);
    const envelope = await response.json() as FeishuEnvelope<T>;
    if (envelope.code !== undefined && envelope.code !== 0) throw new Error(`Feishu API ${envelope.code}: ${envelope.msg ?? "request failed"}`);
    return envelope.data ?? (envelope as unknown as T);
  }

  private async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    let requestBody: BodyInit | undefined;
    if (body instanceof FormData) requestBody = body;
    else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: requestBody });
    if (!response.ok) throw new Error(`Feishu HTTP ${response.status}: ${await response.text()}`);
    return response;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.tokenRequest) this.tokenRequest = this.requestToken().finally(() => { this.tokenRequest = undefined; });
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    if (!this.options.appId || !this.options.appSecret) {
      // User access tokens carry no expiry metadata; keep using the supplied one.
      if (this.token) return this.token;
      throw new Error("Configure FEISHU_ACCESS_TOKEN or FEISHU_APP_ID/FEISHU_APP_SECRET");
    }
    const response = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }) });
    const envelope = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!envelope.tenant_access_token) throw new Error(`Feishu authentication failed: ${envelope.msg ?? "missing token"}`);
    this.token = envelope.tenant_access_token;
    // Refresh one minute before the advertised expiry instead of never.
    this.tokenExpiresAt = Date.now() + Math.max(0, envelope.expire ?? 7200) * 1000;
    return this.token;
  }
}
