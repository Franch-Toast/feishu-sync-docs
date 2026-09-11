import { createHash } from "node:crypto";
import { parseMarkdown } from "@feishu-sync/core";
import type {
  DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument,
  RemoteNode, RemoteProvider, RemoteTree, SyncRoot
} from "@feishu-sync/core";
import { FeishuApiError, FeishuOAuthError, PERMANENT_REFRESH_OAUTH_CODES, classifyFeishuFailure, networkError, parseRetryAfterMs } from "./errors.js";

/** Refresh the user access token this long before its advertised expiry. */
const USER_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** After a transient refresh failure, wait this long before retrying so that
 *  sequential calls during an outage do not hammer the token endpoint. */
const REFRESH_RETRY_COOLDOWN_MS = 60_000;

export interface UserTokenUpdate {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
}

export interface FeishuOpenApiOptions {
  baseUrl?: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  /** Refresh token obtained from the OAuth v3 flow; enables automatic renewal
   *  of the user access token when paired with appId/appSecret. */
  refreshToken?: string;
  /** Escape hatch for the two-step document creation (B2). When true, the
   *  legacy single `docs_ai` call is used, which lets Feishu derive the title
   *  from the markdown H1. Kept so the behaviour can be rolled back without a
   *  code change if the `docx` create endpoint turns out to be unavailable. */
  legacyCreateDocument?: boolean;
  fetchImpl?: typeof fetch;
  /** Invoked after a successful token rotation. Must persist the new refresh
   *  token promptly: the previous one is already invalidated server-side. */
  onTokenRefresh?: (update: UserTokenUpdate) => void | Promise<void>;
  /** Invoked when the refresh token becomes permanently unusable and the user
   *  must re-authorize the app. */
  onRefreshInvalid?: (reason: string) => void | Promise<void>;
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

/** The scope that makes a user token renewable instead of 2-hour disposable. */
export const OAUTH_DEFAULT_SCOPE = "offline_access";

/** C2: `POST /oauth/v3/token` with `grant_type=authorization_code`. */
interface AuthorizationCodeTokenResponse {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

/** Server-side failures of the code exchange, phrased for the settings page. */
export const AUTHORIZATION_CODE_ERROR_LABELS: Record<number, string> = {
  20002: "App Secret 不正确，请检查开发者后台的凭证",
  20003: "授权码无效，请重新获取（授权码只能使用一次）",
  20004: "授权码已过期，请重新点击「前往飞书授权」",
  20005: "grant_type 不受支持",
  20010: "当前用户没有该应用的使用权限，请在应用可用范围内添加自己",
  20049: "该应用要求 PKCE，本工具未使用 PKCE，请改用手工粘贴 refresh token",
  20065: "授权码已被使用过，请重新发起授权",
  20071: "回调地址与开发者后台登记的重定向 URL 不一致，请核对 http://127.0.0.1:<端口>/oauth/callback"
};

/** C2: the tokens a successful authorization-code exchange yields. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  scope?: string;
}

export class FeishuOpenApiProvider implements RemoteProvider {
  readonly name = "feishu-openapi";
  readonly capabilities: ProviderCapabilities = { blockPatch: true, revisionGuard: true, assetUpload: true, remoteEvents: false };
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token?: string;
  /** Epoch ms when the current token expires; Infinity for opaque tokens. */
  private tokenExpiresAt: number;
  private refreshToken?: string;
  private refreshTokenExpiresAt?: number;
  private refreshCooldownUntil = 0;
  private tokenRequest?: Promise<string>;

  constructor(private readonly options: FeishuOpenApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.tokenExpiresAt = options.accessToken ? parseJwtExpiresAt(options.accessToken) : 0;
  }

  /** Resolve a currently-valid access token, transparently refreshing the
   *  user token via its refresh token when it is about to expire. */
  async getAccessToken(): Promise<string> {
    return this.getToken();
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
      // Feishu expects extra_param as a JSON string; passing an object fails schema validation with code 9499.
      extra_param: JSON.stringify({ enable_user_cite_reference_map: true }),
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
    // The create_folder endpoint returns the token at data.token (data.file
    // does not exist despite what older docs suggested); parsing data.file
    // made every successful creation throw and retry, creating duplicates.
    const data = await this.request<{ file?: { token?: string; name?: string }; token?: string }>("POST", "/open-apis/drive/v1/files/create_folder", { name, folder_token: parentToken });
    const token = data.file?.token ?? data.token;
    if (!token) throw new Error("Feishu did not return the created folder token");
    return { token, name: data.file?.name ?? name, type: "folder", parentToken };
  }

  /**
   * Create a document with a *controlled* title (B2).
   *
   * The `docs_ai` import endpoint ignores the requested name and derives the
   * drive-visible title from the markdown H1, which breaks the identity
   * contract: two files sharing a first heading become two identically named
   * documents, and a title is no longer a reversible function of the file name.
   * So creation is split in two steps:
   *   1. `POST /open-apis/docx/v1/documents` with an explicit `title`;
   *   2. the existing `docs_ai` overwrite command writes the markdown body.
   * Step 1 succeeding is enough to hand the token back, so the caller can
   * persist the binding before the body is pushed and never orphans a document.
   */
  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    if (this.options.legacyCreateDocument) {
      return this.createDocumentViaImport(parentToken, name, content);
    }
    const created = await this.request<{ document?: { document_id?: string; revision_id?: number; title?: string } }>(
      "POST", "/open-apis/docx/v1/documents", { folder_token: parentToken, title: name }
    );
    const token = created.document?.document_id;
    if (!token) throw new Error("Feishu did not return the created document token");
    const stub: RemoteDocument = {
      token,
      name: created.document?.title ?? name,
      type: "document",
      parentToken,
      content: "",
      blocks: [],
      contentHash: createHash("sha256").update("").digest("hex"),
      revisionId: created.document?.revision_id
    };
    if (!content) return stub;
    try {
      await this.request("PUT", `/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}`, {
        format: "markdown",
        command: "overwrite",
        content,
        revision_id: stub.revisionId ?? -1
      });
    } catch {
      // The empty document exists and its title is right; return the stub so
      // the caller binds the token and retries the content push next round.
      return stub;
    }
    try {
      return await this.getDocument(token);
    } catch {
      return stub;
    }
  }

  /** The pre-B2 single-call creation, kept behind `legacyCreateDocument`. */
  private async createDocumentViaImport(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const data = await this.request<{ document?: { document_id?: string; revision_id?: number; title?: string } }>("POST", "/open-apis/docs_ai/v1/documents", { format: "markdown", content, parent_token: parentToken });
    const token = data.document?.document_id;
    if (!token) throw new Error("Feishu did not return the created document token");
    try {
      return await this.getDocument(token);
    } catch {
      // The document was created but the follow-up read failed (e.g. schema
      // errors like code 9499). Returning a stub lets the caller persist the
      // binding; throwing here would re-create the document on retry and
      // leave an orphaned duplicate in the drive. The next scan refreshes
      // the stub's content/hash through getDocument.
      return {
        token,
        name: data.document?.title ?? name,
        type: "document",
        parentToken,
        content: "",
        blocks: [],
        contentHash: createHash("sha256").update("").digest("hex"),
        revisionId: data.document?.revision_id
      };
    }
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

  async softDelete(token: string, type: "docx" | "folder" | "file" = "docx"): Promise<void> {
    await this.request("DELETE", `/open-apis/drive/v1/files/${encodeURIComponent(token)}?type=${encodeURIComponent(type)}`);
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
    if (envelope.code !== undefined && envelope.code !== 0) {
      throw new FeishuApiError(classifyFeishuFailure(envelope.code), `Feishu API ${envelope.code}: ${envelope.msg ?? "request failed"}`, envelope.code);
    }
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
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: requestBody });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) {
      // A 429 carries Retry-After; surface it so the runtime can honor the
      // server's rate-limit window instead of retrying on the fixed backoff.
      const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get("Retry-After")) : undefined;
      throw new FeishuApiError(classifyFeishuFailure(undefined, response.status), `Feishu HTTP ${response.status}: ${await response.text()}`, undefined, response.status, retryAfterMs);
    }
    return response;
  }

  private async getToken(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.tokenDeadline()) return this.token;
    if (!this.tokenRequest) this.tokenRequest = this.obtainToken().finally(() => { this.tokenRequest = undefined; });
    return this.tokenRequest;
  }

  /** Expiry minus the safety margin used to decide whether the token is usable.
   *  During the post-failure cooldown the still-valid token is kept in use. */
  private tokenDeadline(): number {
    if (this.tokenExpiresAt === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    const deadline = this.tokenExpiresAt - USER_TOKEN_REFRESH_MARGIN_MS;
    if (Date.now() < this.refreshCooldownUntil) return Math.max(deadline, this.tokenExpiresAt);
    return deadline;
  }

  /** Single-flight token acquisition: refresh user tokens when possible,
   *  fall back to the tenant token flow, or reuse a static token. */
  private async obtainToken(): Promise<string> {
    if (this.refreshToken && this.options.appId && this.options.appSecret) {
      try {
        return await this.refreshUserAccessToken();
      } catch (error) {
        if (error instanceof FeishuOAuthError && error.permanent) {
          this.refreshToken = undefined;
          await this.options.onRefreshInvalid?.(error.message);
          throw new FeishuApiError("auth", `Feishu refresh token is no longer usable, re-authorization required: ${error.message}`, error.code);
        }
        // Transient failure (network, 5xx): the old token may still be inside
        // its own validity window, so prefer it over failing the caller, and
        // back off before attempting the next refresh.
        if (this.token !== undefined && Date.now() < this.tokenExpiresAt) {
          this.refreshCooldownUntil = Date.now() + REFRESH_RETRY_COOLDOWN_MS;
          return this.token;
        }
        throw error;
      }
    }
    if (!this.options.appId || !this.options.appSecret) {
      // Static user access tokens carry no refresh capability; keep using the
      // supplied one until Feishu rejects it.
      if (this.token) return this.token;
      throw new FeishuApiError("auth", "No Feishu credentials configured: provide a user access token or app id/secret");
    }
    return this.requestTenantToken();
  }

  /** Rotate the user access token via the OAuth v3 refresh endpoint. The old
   *  refresh token dies server-side the moment this succeeds, so the new one
   *  is persisted through onTokenRefresh before the promise resolves. */
  private async refreshUserAccessToken(): Promise<string> {
    const previousRefreshToken = this.refreshToken!;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.accountsBaseUrl()}/oauth/v3/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.options.appId!,
          client_secret: this.options.appSecret!,
          refresh_token: previousRefreshToken
        })
      });
    } catch (error) {
      throw new FeishuOAuthError(networkError(error).message);
    }
    let body: { code?: number; access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string; error_description?: string };
    try {
      body = await response.json() as typeof body;
    } catch {
      body = { error: `HTTP ${response.status}` };
    }
    if (!response.ok || body.code !== 0 || !body.access_token) {
      const description = body.error_description ?? body.error ?? `HTTP ${response.status}`;
      const permanent = body.code !== undefined && PERMANENT_REFRESH_OAUTH_CODES.has(body.code);
      throw new FeishuOAuthError(description, body.code, permanent);
    }
    const tokenExpiresAt = Date.now() + Math.max(1, body.expires_in ?? 7200) * 1000;
    const nextRefreshToken = body.refresh_token ?? previousRefreshToken;
    const refreshTokenExpiresAt = body.refresh_token_expires_in !== undefined
      ? Date.now() + body.refresh_token_expires_in * 1000
      : this.refreshTokenExpiresAt;
    this.token = body.access_token;
    this.tokenExpiresAt = tokenExpiresAt;
    this.refreshToken = nextRefreshToken;
    this.refreshTokenExpiresAt = refreshTokenExpiresAt;
    await this.options.onTokenRefresh?.({
      accessToken: this.token,
      refreshToken: nextRefreshToken,
      tokenExpiresAt,
      refreshTokenExpiresAt
    });
    return this.token;
  }

  /** The OAuth v3 token endpoint lives on the accounts host, not the API host:
   *  open.feishu.cn -> accounts.feishu.cn, open.larksuite.com -> accounts.larksuite.com. */
  private accountsBaseUrl(): string {
    const mapped = this.baseUrl.replace(/^https:\/\/open\./, "https://accounts.");
    return mapped === this.baseUrl ? "https://accounts.feishu.cn" : mapped;
  }

  /** C2: authorization URL for the OAuth 2.0 authorization-code flow. The
   *  `offline_access` scope is what makes the returned refresh token usable
   *  for unlimited renewal, so it is always requested. */
  buildAuthorizeUrl(input: { appId: string; redirectUri: string; state: string; scope?: string }): string {
    const params = new URLSearchParams({
      client_id: input.appId,
      redirect_uri: input.redirectUri,
      scope: input.scope ?? OAUTH_DEFAULT_SCOPE,
      state: input.state
    });
    return `${this.accountsBaseUrl()}/open-apis/authen/v1/authorize?${params.toString()}`;
  }

  /** C2: turn a single-use authorization code into an access/refresh token pair.
   *  The caller supplies the same `redirectUri` that was authorized; Feishu
   *  rejects a mismatch with code 20071. */
  async exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    if (!this.options.appId || !this.options.appSecret) {
      throw new FeishuOAuthError("缺少 App ID 或 App Secret，无法换取授权码");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.accountsBaseUrl()}/oauth/v3/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          code: input.code,
          redirect_uri: input.redirectUri
        })
      });
    } catch (error) {
      throw new FeishuOAuthError(networkError(error).message);
    }
    let body: AuthorizationCodeTokenResponse;
    try {
      body = await response.json() as AuthorizationCodeTokenResponse;
    } catch {
      body = { error: `HTTP ${response.status}` };
    }
    if (!response.ok || (body.code !== undefined && body.code !== 0) || !body.access_token) {
      const code = body.code;
      const raw = body.error_description ?? body.error ?? body.msg ?? `HTTP ${response.status}`;
      const label = code !== undefined ? AUTHORIZATION_CODE_ERROR_LABELS[code] : undefined;
      throw new FeishuOAuthError(label ? `${label}（${raw}）` : raw, code);
    }
    const tokenExpiresAt = Date.now() + Math.max(1, body.expires_in ?? 7200) * 1000;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      tokenExpiresAt,
      refreshTokenExpiresAt: body.refresh_token_expires_in !== undefined
        ? Date.now() + body.refresh_token_expires_in * 1000
        : undefined,
      scope: body.scope
    };
  }

  private async requestTenantToken(): Promise<string> {
    // Callers guarantee appId/appSecret exist; this is the tenant-token flow.
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }) });
    } catch (error) {
      throw networkError(error);
    }
    const envelope = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!envelope.tenant_access_token) {
      throw new FeishuApiError(classifyFeishuFailure(envelope.code), `Feishu authentication failed: ${envelope.msg ?? "missing token"}`, envelope.code);
    }
    this.token = envelope.tenant_access_token;
    // Refresh five minutes before the advertised expiry instead of never.
    this.tokenExpiresAt = Date.now() + Math.max(0, envelope.expire ?? 7200) * 1000;
    return this.token;
  }
}

/** Derive the expiry of a JWT user access token from its `exp` claim; opaque
 *  (u-/t- style) tokens are treated as never expiring so the provider keeps
 *  the legacy "use until Feishu rejects it" behavior. */
function parseJwtExpiresAt(token: string): number {
  const parts = token.split(".");
  if (parts.length !== 3) return Number.POSITIVE_INFINITY;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
