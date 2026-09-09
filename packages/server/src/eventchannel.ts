import type { FastifyBaseLogger } from "fastify";
import { Domain, EventDispatcher, LoggerLevel, WSClient } from "@feishu-sync/feishu";
import type { StateStore, SyncRoot } from "@feishu-sync/core";
import type { CredentialStore } from "./credentials.js";
import type { SyncRuntime } from "./runtime.js";

export type EventChannelStatus = "disabled" | "connecting" | "connected" | "error";

export interface EventChannelState {
  status: EventChannelStatus;
  /** Last failure reason, present when status === "error". */
  error?: string;
}

/** Trailing debounce: a burst of drive events (bulk edits) coalesces into a
 *  single queued sync round per root. */
const EVENT_SYNC_DEBOUNCE_MS = 1_500;

/** Feishu drive event subscription over the official SDK's WebSocket long
 *  connection (no public callback URL needed). Folder/file changes matching a
 *  bound root enqueue an immediate sync round; polling stays enabled as the
 *  safety net. Degrades gracefully: without app credentials the channel stays
 *  "disabled", connection failures surface as "error" without blocking sync.
 *
 *  Requires the app to have event subscription and cloud-document event
 *  permissions enabled on the Feishu open platform. */
export class EventChannelService {
  private client?: WSClient;
  private state: EventChannelState = { status: "disabled" };
  /** Bumps on every rebuild/stop; events from stale clients are dropped. */
  private generation = 0;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly store: StateStore,
    private readonly runtime: SyncRuntime,
    private readonly logger?: FastifyBaseLogger
  ) {}

  getState(): EventChannelState {
    return this.state;
  }

  /** Start once at boot; credential changes later go through rebuild(). */
  async start(): Promise<void> {
    await this.rebuild();
  }

  /** (Re)build the subscription from the currently stored credentials. Safe
   *  to call repeatedly: the previous client is closed first. */
  async rebuild(): Promise<void> {
    const generation = ++this.generation;
    this.closeClient();
    const config = await this.credentials.load();
    if (config.mode === "cli" || !config.appId || !config.appSecret) {
      this.state = { status: "disabled" };
      return;
    }
    this.state = { status: "connecting" };
    this.log("info", "event channel starting", { appId: config.appId });
    // Event keys and payload shapes verified against the installed
    // @larksuiteoapi/node-sdk types: drive.*_v1 events carry flat
    // { file_token, folder_token } fields.
    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
      "drive.file.created_in_folder_v1": (data) => this.handleDriveEvent(generation, "created_in_folder", data.file_token, data.folder_token),
      "drive.file.edit_v1": (data) => this.handleDriveEvent(generation, "edit", data.file_token),
      "drive.file.title_updated_v1": (data) => this.handleDriveEvent(generation, "title_updated", data.file_token),
      "drive.file.trashed_v1": (data) => this.handleDriveEvent(generation, "trashed", data.file_token),
      "drive.file.deleted_v1": (data) => this.handleDriveEvent(generation, "deleted", data.file_token)
    });
    const client = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: domainFor(config.baseUrl),
      loggerLevel: LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => {
        if (generation !== this.generation) return;
        this.state = { status: "connected" };
        this.log("info", "event channel connected");
      },
      onError: (error) => {
        if (generation !== this.generation) return;
        this.state = { status: "error", error: error instanceof Error ? error.message : String(error) };
        this.log("warn", "event channel failed", { error: this.state.error });
      }
    });
    this.client = client;
    // Fire-and-forget: the connection lifecycle is tracked via onReady/onError
    // and a hung handshake must never block startup or settings saves.
    void client.start({ eventDispatcher: dispatcher }).catch((error) => {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.state = { status: "error", error: message };
      this.log("warn", "event channel start rejected", { error: message });
    });
  }

  stop(): void {
    this.generation++;
    this.closeClient();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.state = { status: "disabled" };
  }

  private closeClient(): void {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try { client.close({ force: true }); } catch (error) {
      this.log("warn", "event channel close failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolve the affected roots and debounce-trigger a sync round for each. */
  private async handleDriveEvent(generation: number, kind: string, fileToken?: string, folderToken?: string): Promise<void> {
    if (generation !== this.generation) return;
    if (!fileToken && !folderToken) return;
    try {
      const roots = await this.matchRoots(fileToken, folderToken);
      if (roots.length === 0) {
        this.log("debug", "drive event ignored: no matching root", { kind, fileToken, folderToken });
        return;
      }
      for (const root of roots) this.scheduleSync(root, kind);
    } catch (error) {
      this.log("warn", "drive event handling failed", { kind, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Folder tokens hit bound roots directly; file tokens resolve through the
   *  entry table (covers folder and wiki bindings alike). */
  private async matchRoots(fileToken?: string, folderToken?: string): Promise<SyncRoot[]> {
    const roots = await this.store.listRoots();
    const hits = new Map<string, SyncRoot>();
    if (folderToken) {
      for (const root of roots) if (root.remoteToken === folderToken) hits.set(root.id, root);
    }
    if (fileToken) {
      const entry = await this.store.findEntryByRemoteToken(fileToken);
      if (entry) {
        const root = roots.find((candidate) => candidate.id === entry.rootId);
        if (root) hits.set(root.id, root);
      }
    }
    return [...hits.values()];
  }

  private scheduleSync(root: SyncRoot, kind: string): void {
    if (!root.enabled || this.pending.has(root.id)) return;
    this.log("info", "drive event scheduled sync", { rootId: root.id, kind, debounceMs: EVENT_SYNC_DEBOUNCE_MS });
    const timer = setTimeout(() => {
      this.pending.delete(root.id);
      void this.runtime.requestSync(root.id);
    }, EVENT_SYNC_DEBOUNCE_MS);
    timer.unref();
    this.pending.set(root.id, timer);
  }

  private log(level: "debug" | "info" | "warn", message: string, data?: Record<string, unknown>): void {
    this.logger?.[level](data ?? {}, message);
  }
}

/** Map the configured API base URL onto the SDK domain. */
function domainFor(baseUrl: string): string | Domain {
  if (baseUrl.includes("feishu.cn")) return Domain.Feishu;
  if (baseUrl.includes("larksuite.com")) return Domain.Lark;
  return baseUrl.replace(/\/+$/, "");
}
