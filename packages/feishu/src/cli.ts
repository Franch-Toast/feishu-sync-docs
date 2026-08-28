import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMarkdown } from "@feishu-sync/core";
import type { DocumentPatch, MutationResult, ProviderCapabilities, RemoteAsset, RemoteDocument, RemoteNode, RemoteProvider, RemoteTree, SyncRoot } from "@feishu-sync/core";

const execFileAsync = promisify(execFile);

export interface LarkCliOptions { executable?: string; env?: NodeJS.ProcessEnv; cwd?: string; apiVersion?: "v1" | "v2"; }

export class LarkCliProvider implements RemoteProvider {
  readonly name = "lark-cli";
  readonly capabilities: ProviderCapabilities;
  private readonly executable: string;
  private readonly apiVersion: "v1" | "v2";

  constructor(private readonly options: LarkCliOptions = {}) {
    this.executable = options.executable ?? "lark-cli";
    this.apiVersion = options.apiVersion ?? (options.env?.LARK_CLI_API_VERSION === "v2" ? "v2" : "v1");
    this.capabilities = { blockPatch: this.apiVersion === "v2", revisionGuard: this.apiVersion === "v2", assetUpload: false, remoteEvents: false };
  }

  async listTree(root: SyncRoot): Promise<RemoteTree> {
    if (root.remoteType === "wiki") throw new Error("Wiki roots are not supported by the CLI adapter yet; configure a Feishu Drive folder root");
    const result = await this.run(["docs", "+search", "--query", "", "--doc-types", "docx", "--folder-tokens", root.remoteToken, "--format", "json"]);
    const rows = Array.isArray(result.results) ? result.results : [];
    const nodes = rows.map((row: any) => ({ token: String(row.token ?? row.doc_token ?? ""), name: String(row.title ?? row.name ?? ""), type: "document" as const, parentToken: root.remoteToken, updatedAt: row.edit_time ?? row.modified_time })) .filter((node: RemoteNode) => node.token);
    return { root: { token: root.remoteToken, name: root.remoteToken, type: "folder", parentToken: "" }, nodes };
  }

  async getDocument(token: string): Promise<RemoteDocument> {
    const args = this.apiVersion === "v2"
      ? ["docs", "+fetch", "--api-version", "v2", "--doc", token, "--doc-format", "markdown", "--detail", "with-ids", "--format", "json"]
      : ["docs", "+fetch", "--doc", token, "--format", "json"];
    const result = await this.run(args);
    const content = String(result.document?.content ?? result.content ?? "");
    const sourceBlocks = Array.isArray(result.document?.blocks) ? result.document.blocks : [];
    const parsed = parseMarkdown(content);
    const blocks = sourceBlocks.length === parsed.blocks.length && sourceBlocks.every((block: any) => Boolean(block.block_id))
      ? parsed.blocks.map((block, index) => ({ id: String(sourceBlocks[index].block_id), kind: block.kind, content: block.content, contentHash: block.contentHash, position: index }))
      : [];
    return { token: String(result.document?.document_id ?? token), name: String(result.document?.title ?? token), type: "document", parentToken: "", content, contentHash: parsed.contentHash, blocks, revisionId: numberOrUndefined(result.document?.revision_id) };
  }

  async createFolder(_parentToken: string, _name: string): Promise<RemoteNode> { throw new Error("The installed lark-cli does not expose folder creation through this adapter"); }

  async createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument> {
    const args = this.apiVersion === "v2"
      ? ["docs", "+create", "--api-version", "v2", "--doc-format", "markdown", "--parent-token", parentToken, "--title", name, "--content", content]
      : ["docs", "+create", "--folder-token", parentToken, "--title", name, "--markdown", content];
    const result = await this.run(args);
    return this.getDocument(String(result.document?.document_id ?? result.document_id ?? result.token));
  }

  async applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult> {
    if (this.apiVersion === "v1") {
      if (patch.operations.some((operation) => operation.type !== "overwrite")) throw new Error("This lark-cli version cannot apply block patches; configure LARK_CLI_API_VERSION=v2 or use OpenAPI provider");
      const lastContent = [...patch.operations].reverse().find((operation) => operation.type === "overwrite");
      await this.run(["docs", "+update", "--doc", token, "--mode", "overwrite", "--markdown", lastContent?.content ?? ""]);
      return { document: await this.getDocument(token), applied: patch.operations };
    }
    let current = await this.getDocument(token);
    if (patch.expectedRevisionId !== undefined && current.revisionId !== undefined && patch.expectedRevisionId !== current.revisionId) throw new Error("Remote document revision changed since the sync snapshot");
    for (const operation of patch.operations) {
      const args = ["docs", "+update", "--api-version", "v2", "--doc", token, "--doc-format", "markdown", "--command", commandFor(operation), "--revision-id", String(current.revisionId ?? patch.expectedRevisionId ?? -1)];
      if ("content" in operation) args.push("--content", operation.content);
      if (operation.type !== "overwrite") args.push("--block-id", operation.blockId);
      await this.run(args);
      current = await this.getDocument(token);
    }
    return { document: current, applied: patch.operations };
  }

  async uploadAsset(_parentToken: string, _name: string, _content: Uint8Array, _mimeType: string): Promise<RemoteAsset> { throw new Error("The CLI adapter does not expose resource upload; use the OpenAPI provider"); }
  async downloadAsset(_token: string): Promise<Uint8Array> { throw new Error("Use the OpenAPI provider for asset download"); }
  async softDelete(_token: string): Promise<void> { throw new Error("Deletion is intentionally not hidden behind the CLI adapter"); }

  private async run(args: string[]): Promise<any> {
    const { stdout, stderr } = await execFileAsync(this.executable, args, { cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, maxBuffer: 32 * 1024 * 1024 });
    if (stderr && /error|failed/i.test(stderr)) throw new Error(stderr.trim());
    try {
      const envelope = JSON.parse(stdout) as { ok?: boolean; data?: unknown; error?: { message?: string } };
      if (envelope.ok === false) throw new Error(envelope.error?.message ?? "lark-cli request failed");
      return envelope.ok === true && "data" in envelope ? envelope.data : envelope;
    } catch (error) {
      if (error instanceof Error && /lark-cli request failed|CLI|API|failed/i.test(error.message)) throw error;
      throw new Error(`lark-cli returned non-JSON output: ${stdout.slice(0, 500)}`);
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }

function commandFor(operation: DocumentPatch["operations"][number]): string {
  if (operation.type === "replace") return "block_replace";
  if (operation.type === "insertAfter") return "block_insert_after";
  if (operation.type === "delete") return "block_delete";
  return "overwrite";
}
