import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  AssetBinding, BlockMapping, ConflictRecord, ConflictStatus, OperationRecord, StateStore, SyncEntry,
  SyncRoot, SyncSnapshot
} from "@feishu-sync/core";

type Row = Record<string, unknown>;

export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async createRoot(input: Omit<SyncRoot, "id">): Promise<SyncRoot> {
    const root = { id: randomUUID(), ...input };
    this.db.prepare(`INSERT INTO roots (id, local_path, remote_token, remote_type, enabled, poll_interval_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(root.id, root.localPath, root.remoteToken, root.remoteType, root.enabled ? 1 : 0, root.pollIntervalMs);
    return root;
  }

  async listRoots(): Promise<SyncRoot[]> {
    return (this.db.prepare("SELECT * FROM roots ORDER BY local_path").all() as Row[]).map(readRoot);
  }

  async getRoot(id: string): Promise<SyncRoot | undefined> {
    const row = this.db.prepare("SELECT * FROM roots WHERE id = ?").get(id) as Row | undefined;
    return row ? readRoot(row) : undefined;
  }

  async updateRoot(id: string, patch: Partial<Omit<SyncRoot, "id">>): Promise<SyncRoot> {
    const current = await this.getRoot(id);
    if (!current) throw new Error(`Root not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE roots SET local_path=?, remote_token=?, remote_type=?, enabled=?, poll_interval_ms=? WHERE id=?`)
      .run(next.localPath, next.remoteToken, next.remoteType, next.enabled ? 1 : 0, next.pollIntervalMs, id);
    return next;
  }

  async deleteRoot(id: string): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM blocks WHERE entry_id IN (SELECT id FROM entries WHERE root_id=?)").run(id);
      this.db.prepare("DELETE FROM snapshots WHERE entry_id IN (SELECT id FROM entries WHERE root_id=?)").run(id);
      this.db.prepare("DELETE FROM asset_bindings WHERE document_entry_id IN (SELECT id FROM entries WHERE root_id=?) OR asset_entry_id IN (SELECT id FROM entries WHERE root_id=?)").run(id, id);
      this.db.prepare("DELETE FROM conflicts WHERE entry_id IN (SELECT id FROM entries WHERE root_id=?)").run(id);
      this.db.prepare("DELETE FROM operations WHERE entry_id IN (SELECT id FROM entries WHERE root_id=?)").run(id);
      this.db.prepare("DELETE FROM asset_references WHERE root_id=?").run(id);
      this.db.prepare("DELETE FROM entries WHERE root_id=?").run(id);
      this.db.prepare("DELETE FROM roots WHERE id=?").run(id);
    });
    transaction();
  }

  async upsertEntry(entry: SyncEntry): Promise<void> {
    this.db.prepare(`INSERT INTO entries (id, root_id, relative_path, kind, remote_token, remote_parent_token, status, local_hash, remote_hash, base_hash, local_revision, remote_revision, updated_at)
      VALUES (@id,@rootId,@relativePath,@kind,@remoteToken,@remoteParentToken,@status,@localHash,@remoteHash,@baseHash,@localRevision,@remoteRevision,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id, relative_path=excluded.relative_path, kind=excluded.kind, remote_token=excluded.remote_token, remote_parent_token=excluded.remote_parent_token, status=excluded.status, local_hash=excluded.local_hash, remote_hash=excluded.remote_hash, base_hash=excluded.base_hash, local_revision=excluded.local_revision, remote_revision=excluded.remote_revision, updated_at=excluded.updated_at`)
      .run({
        id: entry.id,
        rootId: entry.rootId,
        relativePath: entry.relativePath,
        kind: entry.kind,
        remoteToken: entry.remoteToken ?? null,
        remoteParentToken: entry.remoteParentToken ?? null,
        status: entry.status,
        localHash: entry.localHash ?? null,
        remoteHash: entry.remoteHash ?? null,
        baseHash: entry.baseHash ?? null,
        localRevision: entry.localRevision ?? null,
        remoteRevision: entry.remoteRevision ?? null,
        updatedAt: entry.updatedAt
      });
  }

  async getEntry(id: string): Promise<SyncEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Row | undefined;
    return row ? readEntry(row) : undefined;
  }

  async findEntry(rootId: string, relativePath: string): Promise<SyncEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM entries WHERE root_id = ? AND relative_path = ?").get(rootId, relativePath) as Row | undefined;
    return row ? readEntry(row) : undefined;
  }

  async listEntries(rootId: string): Promise<SyncEntry[]> {
    return (this.db.prepare("SELECT * FROM entries WHERE root_id = ? ORDER BY relative_path").all(rootId) as Row[]).map(readEntry);
  }

  async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    this.db.prepare(`INSERT INTO snapshots (entry_id, base_content, local_content, remote_content, base_hash, local_hash, remote_hash, created_at)
      VALUES (@entryId,@baseContent,@localContent,@remoteContent,@baseHash,@localHash,@remoteHash,@createdAt)
      ON CONFLICT(entry_id) DO UPDATE SET base_content=excluded.base_content, local_content=excluded.local_content, remote_content=excluded.remote_content, base_hash=excluded.base_hash, local_hash=excluded.local_hash, remote_hash=excluded.remote_hash, created_at=excluded.created_at`)
      .run(snapshot);
  }

  async getSnapshot(entryId: string): Promise<SyncSnapshot | undefined> {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE entry_id = ?").get(entryId) as Row | undefined;
    return row ? readSnapshot(row) : undefined;
  }

  async saveBlocks(entryId: string, blocks: BlockMapping[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM blocks WHERE entry_id = ?").run(entryId);
      const insert = this.db.prepare("INSERT INTO blocks (entry_id, stable_id, block_id, kind, content_hash, position) VALUES (?, ?, ?, ?, ?, ?)");
      for (const block of blocks) insert.run(entryId, block.stableId, block.blockId, block.kind, block.contentHash, block.position);
    });
    transaction();
  }

  async getBlocks(entryId: string): Promise<BlockMapping[]> {
    return (this.db.prepare("SELECT * FROM blocks WHERE entry_id = ? ORDER BY position").all(entryId) as Row[]).map((row) => ({
      entryId: String(row.entry_id), stableId: String(row.stable_id), blockId: String(row.block_id), kind: String(row.kind), contentHash: String(row.content_hash), position: Number(row.position)
    }));
  }

  async createConflict(input: Omit<ConflictRecord, "id" | "createdAt" | "status">): Promise<ConflictRecord> {
    const conflict: ConflictRecord = { ...input, id: randomUUID(), status: "open", createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO conflicts (id, entry_id, status, base_content, local_content, remote_content, merged_content, resolution, remote_revision, remote_content_hash, created_at, resolved_at)
      VALUES (@id,@entryId,@status,@baseContent,@localContent,@remoteContent,@mergedContent,@resolution,@remoteRevision,@remoteContentHash,@createdAt,@resolvedAt)`).run({
        id: conflict.id,
        entryId: conflict.entryId,
        status: conflict.status,
        baseContent: conflict.baseContent,
        localContent: conflict.localContent,
        remoteContent: conflict.remoteContent,
        mergedContent: conflict.mergedContent ?? null,
        resolution: conflict.resolution ?? null,
        remoteRevision: conflict.remoteRevision ?? null,
        remoteContentHash: conflict.remoteContentHash ?? null,
        createdAt: conflict.createdAt,
        resolvedAt: conflict.resolvedAt ?? null
      });
    return conflict;
  }

  async getConflict(id: string): Promise<ConflictRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM conflicts WHERE id = ?").get(id) as Row | undefined;
    return row ? readConflict(row) : undefined;
  }

  async listConflicts(status?: ConflictStatus): Promise<ConflictRecord[]> {
    const rows = (status
      ? this.db.prepare("SELECT * FROM conflicts WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM conflicts ORDER BY created_at DESC").all()) as Row[];
    return rows.map(readConflict);
  }

  async updateConflict(id: string, patch: Partial<Pick<ConflictRecord, "baseContent" | "localContent" | "remoteContent" | "mergedContent" | "remoteRevision" | "remoteContentHash">>): Promise<ConflictRecord> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const updates: Array<[keyof typeof patch, string]> = [
      ["baseContent", "base_content"],
      ["localContent", "local_content"],
      ["remoteContent", "remote_content"],
      ["mergedContent", "merged_content"],
      ["remoteRevision", "remote_revision"],
      ["remoteContentHash", "remote_content_hash"]
    ];
    for (const [property, column] of updates) {
      if (!(property in patch)) continue;
      fields.push(`${column}=?`);
      values.push(patch[property] ?? null);
    }
    if (fields.length > 0) this.db.prepare(`UPDATE conflicts SET ${fields.join(", ")} WHERE id=?`).run(...values, id);
    const result = await this.getConflict(id);
    if (!result) throw new Error(`Conflict not found: ${id}`);
    return result;
  }

  async resolveConflict(id: string, resolution: ConflictRecord["resolution"], mergedContent?: string): Promise<ConflictRecord> {
    const status: ConflictStatus = resolution === "abort" ? "aborted" : "resolved";
    const resolvedAt = new Date().toISOString();
    this.db.prepare("UPDATE conflicts SET status=?, resolution=?, merged_content=?, resolved_at=? WHERE id=?")
      .run(status, resolution, mergedContent ?? null, resolvedAt, id);
    const result = await this.getConflict(id);
    if (!result) throw new Error(`Conflict not found: ${id}`);
    return result;
  }

  async addOperation(input: Omit<OperationRecord, "id" | "createdAt" | "retryCount" | "status">): Promise<OperationRecord> {
    const operation: OperationRecord = { ...input, id: randomUUID(), retryCount: 0, status: "queued", createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO operations (id, entry_id, direction, operation, status, retry_count, error, created_at, completed_at)
      VALUES (@id,@entryId,@direction,@operation,@status,@retryCount,@error,@createdAt,@completedAt)`).run({
        id: operation.id,
        entryId: operation.entryId ?? null,
        direction: operation.direction,
        operation: operation.operation,
        status: operation.status,
        retryCount: operation.retryCount,
        error: operation.error ?? null,
        createdAt: operation.createdAt,
        completedAt: operation.completedAt ?? null
      });
    return operation;
  }

  async updateOperation(id: string, patch: Partial<Pick<OperationRecord, "status" | "error" | "completedAt" | "retryCount">>): Promise<OperationRecord> {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Operation not found: ${id}`);
    const current = readOperation(row);
    const next = { ...current, ...patch };
    this.db.prepare("UPDATE operations SET status=?, retry_count=?, error=?, completed_at=? WHERE id=?")
      .run(next.status, next.retryCount, next.error ?? null, next.completedAt ?? null, id);
    return next;
  }

  async listOperations(limit = 100): Promise<OperationRecord[]> {
    return (this.db.prepare("SELECT * FROM operations ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(readOperation);
  }

  async saveAssetReferences(rootId: string, assetPath: string, entryIds: string[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM asset_references WHERE root_id=? AND asset_path=?").run(rootId, assetPath);
      const insert = this.db.prepare("INSERT OR IGNORE INTO asset_references (root_id, asset_path, entry_id) VALUES (?, ?, ?)");
      for (const entryId of entryIds) insert.run(rootId, assetPath, entryId);
    });
    transaction();
  }

  async listAssetReferences(rootId: string, assetPath: string): Promise<string[]> {
    return (this.db.prepare("SELECT entry_id FROM asset_references WHERE root_id=? AND asset_path=? ORDER BY entry_id").all(rootId, assetPath) as Row[])
      .map((row) => String(row.entry_id));
  }

  async saveAssetBindings(documentEntryId: string, bindings: AssetBinding[]): Promise<void> {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM asset_bindings WHERE document_entry_id=?").run(documentEntryId);
      const insert = this.db.prepare("INSERT INTO asset_bindings (document_entry_id, asset_entry_id, token, content_hash) VALUES (?, ?, ?, ?)");
      for (const binding of bindings) insert.run(documentEntryId, binding.assetEntryId, binding.token, binding.contentHash);
    });
    transaction();
  }

  async getAssetBindings(documentEntryId: string): Promise<AssetBinding[]> {
    return (this.db.prepare("SELECT * FROM asset_bindings WHERE document_entry_id=? ORDER BY asset_entry_id").all(documentEntryId) as Row[])
      .map((row) => ({ documentEntryId: String(row.document_entry_id), assetEntryId: String(row.asset_entry_id), token: String(row.token), contentHash: String(row.content_hash) }));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roots (
        id TEXT PRIMARY KEY, local_path TEXT NOT NULL, remote_token TEXT NOT NULL,
        remote_type TEXT NOT NULL, enabled INTEGER NOT NULL, poll_interval_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL,
        remote_token TEXT, remote_parent_token TEXT, status TEXT NOT NULL, local_hash TEXT,
        remote_hash TEXT, base_hash TEXT, local_revision INTEGER, remote_revision INTEGER,
        updated_at TEXT NOT NULL, UNIQUE(root_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS blocks (
        entry_id TEXT NOT NULL, stable_id TEXT NOT NULL, block_id TEXT NOT NULL,
        kind TEXT NOT NULL, content_hash TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(entry_id, stable_id)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        entry_id TEXT PRIMARY KEY, base_content TEXT NOT NULL, local_content TEXT NOT NULL,
        remote_content TEXT NOT NULL, base_hash TEXT NOT NULL, local_hash TEXT NOT NULL,
        remote_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, status TEXT NOT NULL,
        base_content TEXT NOT NULL, local_content TEXT NOT NULL, remote_content TEXT NOT NULL,
        merged_content TEXT, resolution TEXT, remote_revision INTEGER, remote_content_hash TEXT, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, entry_id TEXT, direction TEXT NOT NULL, operation TEXT NOT NULL,
        status TEXT NOT NULL, retry_count INTEGER NOT NULL, error TEXT,
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS conflicts_status_idx ON conflicts(status);
      CREATE INDEX IF NOT EXISTS entries_root_idx ON entries(root_id);
      CREATE TABLE IF NOT EXISTS asset_references (
        root_id TEXT NOT NULL, asset_path TEXT NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(root_id, asset_path, entry_id)
      );
      CREATE TABLE IF NOT EXISTS asset_bindings (
        document_entry_id TEXT NOT NULL, asset_entry_id TEXT NOT NULL, token TEXT NOT NULL,
        content_hash TEXT NOT NULL, PRIMARY KEY(document_entry_id, asset_entry_id)
      );
    `);
    try { this.db.exec("ALTER TABLE conflicts ADD COLUMN remote_revision INTEGER"); } catch { /* existing schema already migrated */ }
    try { this.db.exec("ALTER TABLE conflicts ADD COLUMN remote_content_hash TEXT"); } catch { /* existing schema already migrated */ }
  }
}

function readRoot(row: Row): SyncRoot {
  return { id: String(row.id), localPath: String(row.local_path), remoteToken: String(row.remote_token), remoteType: row.remote_type as SyncRoot["remoteType"], enabled: Boolean(row.enabled), pollIntervalMs: Number(row.poll_interval_ms) };
}

function readEntry(row: Row): SyncEntry {
  return { id: String(row.id), rootId: String(row.root_id), relativePath: String(row.relative_path), kind: row.kind as SyncEntry["kind"], remoteToken: optionalString(row.remote_token), remoteParentToken: optionalString(row.remote_parent_token), status: row.status as SyncEntry["status"], localHash: optionalString(row.local_hash), remoteHash: optionalString(row.remote_hash), baseHash: optionalString(row.base_hash), localRevision: optionalNumber(row.local_revision), remoteRevision: optionalNumber(row.remote_revision), updatedAt: String(row.updated_at) };
}

function readSnapshot(row: Row): SyncSnapshot {
  return { entryId: String(row.entry_id), baseContent: String(row.base_content), localContent: String(row.local_content), remoteContent: String(row.remote_content), baseHash: String(row.base_hash), localHash: String(row.local_hash), remoteHash: String(row.remote_hash), createdAt: String(row.created_at) };
}

function readConflict(row: Row): ConflictRecord {
  return { id: String(row.id), entryId: String(row.entry_id), status: row.status as ConflictStatus, baseContent: String(row.base_content), localContent: String(row.local_content), remoteContent: String(row.remote_content), mergedContent: optionalString(row.merged_content), resolution: row.resolution as ConflictRecord["resolution"], remoteRevision: optionalNumber(row.remote_revision), remoteContentHash: optionalString(row.remote_content_hash), createdAt: String(row.created_at), resolvedAt: optionalString(row.resolved_at) };
}

function readOperation(row: Row): OperationRecord {
  return { id: String(row.id), entryId: optionalString(row.entry_id), direction: row.direction as OperationRecord["direction"], operation: String(row.operation), status: row.status as OperationRecord["status"], retryCount: Number(row.retry_count), error: optionalString(row.error), createdAt: String(row.created_at), completedAt: optionalString(row.completed_at) };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
