import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AssetBinding, BlockMapping, ConflictRecord, ConflictStatus, EntryBinding,
  FolderBinding, ListOperationsOptions, MetaStorage, OperationRecord, PruneHistoryOptions,
  PruneHistoryResult, RootState, SyncRoot
} from '@feishu-sync/core';

const MAX_OPERATIONS = 1000;
const GLOBAL_CONFIG_DIR = '.feishu-sync-docs';
const ROOTS_FILE = 'roots.json';
const SETTINGS_FILE = 'settings.json';

/**
 * JSON-based metadata storage implementation.
 * Stores bindings, folders, blocks, operations, conflicts in .feishu-sync directory.
 * Global config (roots, settings) stored in ~/.feishu-sync-docs/
 */
export class JsonMetaStorage implements MetaStorage {
  private readonly metaDirs: Map<string, string> = new Map();
  private readonly globalConfigDir: string;

  constructor(globalConfigPath?: string) {
    this.globalConfigDir = globalConfigPath ?? path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
      GLOBAL_CONFIG_DIR
    );
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.globalConfigDir, { recursive: true });
    const rootsPath = path.join(this.globalConfigDir, ROOTS_FILE);
    if (!await this.fileExists(rootsPath)) {
      await this.writeJson(rootsPath, []);
    }
    const settingsPath = path.join(this.globalConfigDir, SETTINGS_FILE);
    if (!await this.fileExists(settingsPath)) {
      await this.writeJson(settingsPath, {});
    }
  }

  // ============================================================================
  // Root Management (global config)
  // ============================================================================

  async createRoot(input: Omit<SyncRoot, 'id'>): Promise<SyncRoot> {
    const roots = await this.listRoots();
    const localPath = await canonicalLocalPath(input.localPath);
    // G1: one directory can only have one root. Metadata lives in
    // `<localPath>/.feishu-sync`, so a second record for the same directory
    // would silently share and overwrite the first one's bindings. Re-binding
    // the same path therefore reuses the existing record.
    const existing = roots.find((r) => r.localPath === localPath);
    if (existing) {
      return this.updateRoot(existing.id, { ...input, localPath });
    }
    const root: SyncRoot = { id: randomUUID(), ...input, localPath };
    roots.push(root);
    await this.writeJson(this.getRootsPath(), roots);
    return root;
  }

  /** The root already bound to this directory, if any (G1/G6). */
  async findRootByLocalPath(localPath: string): Promise<SyncRoot | undefined> {
    const resolved = await canonicalLocalPath(localPath);
    const roots = await this.listRoots();
    for (const root of roots) {
      if (root.localPath === resolved || (await canonicalLocalPath(root.localPath)) === resolved) return root;
    }
    return undefined;
  }

  /** The retired root id recorded inside `<localPath>/.feishu-sync/state.json`
   *  when no live root owns it any more — an orphan metadata directory (G3). */
  async findOrphanMetaOwner(localPath: string): Promise<string | undefined> {
    const state = await this.readJson<Partial<RootState>>(path.join(await canonicalLocalPath(localPath), '.feishu-sync', 'state.json'), {});
    if (!state?.rootId) return undefined;
    const roots = await this.listRoots();
    return roots.some((r) => r.id === state.rootId) ? undefined : state.rootId;
  }

  async listRoots(): Promise<SyncRoot[]> {
    return this.readJson<SyncRoot[]>(this.getRootsPath(), []);
  }

  async getRoot(id: string): Promise<SyncRoot | undefined> {
    const roots = await this.listRoots();
    return roots.find((r) => r.id === id);
  }

  async updateRoot(id: string, patch: Partial<Omit<SyncRoot, 'id'>>): Promise<SyncRoot> {
    const roots = await this.listRoots();
    const index = roots.findIndex((r) => r.id === id);
    if (index === -1) throw new Error(`Root not found: ${id}`);
    const existing = roots[index]!;
    const updated: SyncRoot = { ...existing, ...patch };
    roots[index] = updated;
    await this.writeJson(this.getRootsPath(), roots);
    return updated;
  }

  async deleteRoot(id: string): Promise<void> {
    const roots = await this.listRoots();
    const target = roots.find((r) => r.id === id);
    const filtered = roots.filter((r) => r.id !== id);
    await this.writeJson(this.getRootsPath(), filtered);
    if (target) {
      const resolved = await canonicalLocalPath(target.localPath);
      const stillClaimed = filtered.some((r) => r.localPath === resolved || r.localPath === target.localPath);
      if (stillClaimed) {
        // Another root still owns the directory's metadata; forget it, never wipe it.
        this.metaDirs.delete(id);
        return;
      }
    }
    await this.deleteRootMeta(id);
  }

  // ============================================================================
  // Per-Root Meta Initialization
  // ============================================================================

  async initRootMeta(rootId: string, localPath: string): Promise<void> {
    const metaDir = path.join(localPath, '.feishu-sync');
    this.metaDirs.set(rootId, metaDir);

    await fsp.mkdir(metaDir, { recursive: true });
    await fsp.mkdir(path.join(metaDir, 'blocks'), { recursive: true });
    await fsp.mkdir(path.join(metaDir, 'conflicts'), { recursive: true });

    // Initialize empty files if they don't exist
    const files = [
      { name: 'bindings.json', default: {} },
      { name: 'folders.json', default: {} },
      { name: 'operations.json', default: [] },
      { name: 'assets.json', default: {} },
      { name: 'state.json', default: { initialized: true } },
    ];

    for (const file of files) {
      const filePath = path.join(metaDir, file.name);
      if (!await this.fileExists(filePath)) {
        await this.writeJson(filePath, file.default);
      }
    }

    // G2: the metadata belongs to the directory, not to one record. `state.json`
    // names its owner; when that differs from the root being initialised the
    // previous record was deleted and this one takes the history over instead of
    // starting from scratch next to a stale copy.
    const state = await this.readJson<Partial<RootState>>(path.join(metaDir, 'state.json'), {});
    if (state.rootId && state.rootId !== rootId) {
      await this.migrateMetaOwnership(state.rootId, rootId, metaDir);
    }
    if (state.rootId !== rootId || state.localPath !== localPath) {
      await this.writeJson(path.join(metaDir, 'state.json'), { ...state, rootId, localPath, initialized: true });
    }
  }

  /** G2: rewrite every persisted `rootId` from the retired root to the new one,
   *  after copying the originals into `backup-<timestamp>/`. Bindings are keyed
   *  by relative path but carry a `rootId` field, and operations/records carry
   *  theirs; conflicts and blocks are keyed by entryId and therefore survive
   *  untouched. */
  private async migrateMetaOwnership(fromRootId: string, toRootId: string, metaDir: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(metaDir, `backup-${stamp}`);
    await fsp.mkdir(backupDir, { recursive: true });
    const rewrite = async (name: string, visit: (record: unknown) => unknown) => {
      const filePath = path.join(metaDir, name);
      if (!await this.fileExists(filePath)) return;
      await fsp.copyFile(filePath, path.join(backupDir, name));
      await this.writeJson(filePath, visit(await this.readJson<unknown>(filePath, null)));
    };
    await rewrite('bindings.json', (raw) => {
      const map = (raw ?? {}) as Record<string, EntryBinding>;
      return Object.fromEntries(Object.entries(map).map(([key, binding]) =>
        [key, binding && binding.rootId === fromRootId ? { ...binding, rootId: toRootId } : binding]));
    });
    await rewrite('operations.json', (raw) => {
      const list = Array.isArray(raw) ? (raw as Array<OperationRecord>) : [];
      return list.map((item) => (item && item.rootId === fromRootId ? { ...item, rootId: toRootId } : item));
    });
  }

  /** G5: retiring a root never destroys user data. The metadata is moved into a
   *  timestamped backup inside its own directory, and `.git` is untouched. */
  async deleteRootMeta(rootId: string): Promise<void> {
    const metaDir = this.metaDirs.get(rootId);
    if (!metaDir) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${stamp}`;
    try {
      await fsp.mkdir(path.join(metaDir, backupName), { recursive: true });
      for (const entry of await fsp.readdir(metaDir)) {
        if (entry.startsWith('backup-')) continue;
        await fsp.rename(path.join(metaDir, entry), path.join(metaDir, backupName, entry));
      }
    } catch {
      // Directory may not exist; nothing to retire.
    }
    this.metaDirs.delete(rootId);
  }

  /** G3: the bind form's「重新绑定」choice. Everything currently in the directory's
   *  `.feishu-sync/` (including a state.json owned by a deleted root) is moved
   *  into `backup-<timestamp>/`, so the next `initRootMeta` starts from a clean
   *  slate instead of adopting history the user just rejected. Nothing is
   *  deleted and `.git` is never touched. */
  async archiveRootMeta(localPath: string): Promise<boolean> {
    const metaDir = path.join(localPath, '.feishu-sync');
    if (!await this.fileExists(metaDir)) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${stamp}`;
    await fsp.mkdir(path.join(metaDir, backupName), { recursive: true });
    for (const entry of await fsp.readdir(metaDir)) {
      if (entry === backupName || entry.startsWith('backup-')) continue;
      await fsp.rename(path.join(metaDir, entry), path.join(metaDir, backupName, entry));
    }
    return true;
  }

  // ============================================================================
  // Bindings (bindings.json)
  // ============================================================================

  async getBinding(rootId: string, relativePath: string): Promise<EntryBinding | undefined> {
    const bindings = await this.readJson<Record<string, EntryBinding>>(this.getBindingsPath(rootId), {});
    return bindings[relativePath];
  }

  async setBinding(rootId: string, relativePath: string, binding: EntryBinding): Promise<void> {
    const bindingsPath = this.getBindingsPath(rootId);
    const bindings = await this.readJson<Record<string, EntryBinding>>(bindingsPath, {});
    bindings[relativePath] = binding;
    await this.writeJson(bindingsPath, bindings);
  }

  async deleteBinding(rootId: string, relativePath: string): Promise<void> {
    const bindingsPath = this.getBindingsPath(rootId);
    const bindings = await this.readJson<Record<string, EntryBinding>>(bindingsPath, {});
    delete bindings[relativePath];
    await this.writeJson(bindingsPath, bindings);
  }

  async listBindings(rootId: string): Promise<EntryBinding[]> {
    const bindings = await this.readJson<Record<string, EntryBinding>>(this.getBindingsPath(rootId), {});
    return Object.values(bindings);
  }

  async findBindingByToken(rootId: string, remoteToken: string): Promise<EntryBinding | undefined> {
    const bindings = await this.listBindings(rootId);
    return bindings.find((b) => b.remoteToken === remoteToken);
  }

  async findBindingById(entryId: string): Promise<EntryBinding | undefined> {
    for (const metaDir of this.metaDirs.values()) {
      const bindingsPath = path.join(metaDir, 'bindings.json');
      const bindings = await this.readJson<Record<string, EntryBinding>>(bindingsPath, {});
      const found = Object.values(bindings).find((b) => b.entryId === entryId);
      if (found) return found;
    }
    return undefined;
  }

  // ============================================================================
  // Folder Bindings (folders.json)
  // ============================================================================

  async getFolderBinding(rootId: string, relativePath: string): Promise<FolderBinding | undefined> {
    const folders = await this.readJson<Record<string, FolderBinding>>(this.getFoldersPath(rootId), {});
    return folders[relativePath];
  }

  async setFolderBinding(rootId: string, relativePath: string, binding: FolderBinding): Promise<void> {
    const foldersPath = this.getFoldersPath(rootId);
    const folders = await this.readJson<Record<string, FolderBinding>>(foldersPath, {});
    folders[relativePath] = binding;
    await this.writeJson(foldersPath, folders);
  }

  async deleteFolderBinding(rootId: string, relativePath: string): Promise<void> {
    const foldersPath = this.getFoldersPath(rootId);
    const folders = await this.readJson<Record<string, FolderBinding>>(foldersPath, {});
    delete folders[relativePath];
    await this.writeJson(foldersPath, folders);
  }

  async listFolderBindings(rootId: string): Promise<FolderBinding[]> {
    const folders = await this.readJson<Record<string, FolderBinding>>(this.getFoldersPath(rootId), {});
    return Object.values(folders);
  }

  // ============================================================================
  // Block Mappings (blocks/<entryId>.json)
  // ============================================================================

  async getBlocks(entryId: string): Promise<BlockMapping[]> {
    const blocksPath = this.getBlocksPath(entryId);
    if (!blocksPath) return [];
    return this.readJson<BlockMapping[]>(blocksPath, []);
  }

  async saveBlocks(entryId: string, blocks: BlockMapping[]): Promise<void> {
    // Find the metaDir that contains this entry
    for (const [rootId, metaDir] of this.metaDirs) {
      const bindingsPath = path.join(metaDir, 'bindings.json');
      const bindings = await this.readJson<Record<string, EntryBinding>>(bindingsPath, {});
      const hasEntry = Object.values(bindings).some((b) => b.entryId === entryId);
      if (hasEntry) {
        const blocksPath = path.join(metaDir, 'blocks', `${entryId}.json`);
        await this.writeJson(blocksPath, blocks);
        return;
      }
    }
  }

  // ============================================================================
  // Operations (operations.json - ring buffer)
  // ============================================================================

  async addOperation(input: Omit<OperationRecord, 'id' | 'createdAt' | 'retryCount' | 'status'>): Promise<OperationRecord> {
    const operation: OperationRecord = {
      maxRetries: 3,
      ...input,
      id: randomUUID(),
      retryCount: 0,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };

    // Find the root's operations file
    for (const metaDir of this.metaDirs.values()) {
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);

      // Only add to the correct root's operations
      if (input.rootId && this.metaDirs.get(input.rootId) === metaDir) {
        ops.unshift(operation);
        // Ring buffer: keep only MAX_OPERATIONS
        if (ops.length > MAX_OPERATIONS) {
          ops.length = MAX_OPERATIONS;
        }
        await this.writeJson(opsPath, ops);
        return operation;
      }
    }

    // Fallback: add to first available metaDir
    const firstMetaDir = this.metaDirs.values().next().value;
    if (firstMetaDir) {
      const opsPath = path.join(firstMetaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      ops.unshift(operation);
      if (ops.length > MAX_OPERATIONS) {
        ops.length = MAX_OPERATIONS;
      }
      await this.writeJson(opsPath, ops);
    }

    return operation;
  }

  async updateOperation(id: string, patch: Partial<Pick<OperationRecord, 'status' | 'error' | 'errorCategory' | 'completedAt' | 'startedAt' | 'retryCount' | 'maxRetries' | 'direction' | 'trigger' | 'needsAction' | 'summary'>>): Promise<OperationRecord> {
    for (const metaDir of this.metaDirs.values()) {
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      const index = ops.findIndex((o) => o.id === id);
      if (index !== -1) {
        const existing = ops[index]!;
        const updated: OperationRecord = { ...existing, ...patch };
        ops[index] = updated;
        await this.writeJson(opsPath, ops);
        return updated;
      }
    }
    throw new Error(`Operation not found: ${id}`);
  }

  async listOperations(options: number | ListOperationsOptions = {}): Promise<OperationRecord[]> {
    const opts: ListOperationsOptions = typeof options === 'number' ? { limit: options } : options;
    const { rootId, limit = 100, cursor, status, trigger, errorCategory, needsAction } = opts;
    const allOps: OperationRecord[] = [];
    for (const [rid, metaDir] of this.metaDirs) {
      // Scope to a single root's ring buffer when the caller filters by root.
      if (rootId !== undefined && rid !== rootId) continue;
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      allOps.push(...ops);
    }
    const filtered = allOps.filter((op) =>
      (status === undefined || op.status === status)
      && (trigger === undefined || op.trigger === trigger)
      && (errorCategory === undefined || op.errorCategory === errorCategory)
      // Records written before `needsAction` existed are treated as awaiting a
      // human, so an upgrade never empties the「失败待处理」queue.
      && (needsAction === undefined || (op.needsAction ?? true) === needsAction));
    // Newest first; tie-break on id so cursor paging is stable across equal timestamps.
    const sorted = filtered.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    let start = 0;
    if (cursor !== undefined) {
      const cursorIndex = sorted.findIndex((op) => op.id === cursor);
      // Unknown cursor (e.g. the record was pruned): fall back to the first page.
      if (cursorIndex !== -1) start = cursorIndex + 1;
    }
    return sorted.slice(start, start + limit);
  }

  async getOperation(id: string): Promise<OperationRecord | undefined> {
    for (const metaDir of this.metaDirs.values()) {
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      const found = ops.find((o) => o.id === id);
      if (found) return found;
    }
    return undefined;
  }

  // ============================================================================
  // Conflicts (conflicts/<conflictId>.json)
  // ============================================================================

  async createConflict(input: Omit<ConflictRecord, 'id' | 'createdAt' | 'status'>): Promise<ConflictRecord> {
    const conflict: ConflictRecord = {
      ...input,
      id: randomUUID(),
      status: 'open',
      createdAt: new Date().toISOString(),
    };

    // Find the root's conflicts directory
    for (const [rootId, metaDir] of this.metaDirs) {
      const bindingsPath = path.join(metaDir, 'bindings.json');
      const bindings = await this.readJson<Record<string, EntryBinding>>(bindingsPath, {});
      const hasEntry = Object.values(bindings).some((b) => b.entryId === input.entryId);
      if (hasEntry) {
        const conflictPath = path.join(metaDir, 'conflicts', `${conflict.id}.json`);
        await this.writeJson(conflictPath, conflict);
        return conflict;
      }
    }

    // Fallback: save to first available metaDir
    const firstMetaDir = this.metaDirs.values().next().value;
    if (firstMetaDir) {
      const conflictPath = path.join(firstMetaDir, 'conflicts', `${conflict.id}.json`);
      await this.writeJson(conflictPath, conflict);
    }

    return conflict;
  }

  async getConflict(id: string): Promise<ConflictRecord | undefined> {
    for (const metaDir of this.metaDirs.values()) {
      const conflictPath = path.join(metaDir, 'conflicts', `${id}.json`);
      if (await this.fileExists(conflictPath)) {
        return this.readJson<ConflictRecord>(conflictPath, undefined as unknown as ConflictRecord);
      }
    }
    return undefined;
  }

  async listConflicts(status?: ConflictStatus): Promise<ConflictRecord[]> {
    const allConflicts: ConflictRecord[] = [];
    for (const metaDir of this.metaDirs.values()) {
      const conflictsDir = path.join(metaDir, 'conflicts');
      if (!await this.fileExists(conflictsDir)) continue;

      const files = await fsp.readdir(conflictsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const conflict = await this.readJson<ConflictRecord>(path.join(conflictsDir, file), undefined as unknown as ConflictRecord);
          if (conflict) allConflicts.push(conflict);
        }
      }
    }

    const filtered = status ? allConflicts.filter((c) => c.status === status) : allConflicts;
    return filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async updateConflict(id: string, patch: Partial<Pick<ConflictRecord, 'baseContent' | 'localContent' | 'remoteContent' | 'mergedContent' | 'remoteRevision' | 'remoteContentHash' | 'reason' | 'collidingToken' | 'collidingOwnerPath'>>): Promise<ConflictRecord> {
    for (const metaDir of this.metaDirs.values()) {
      const conflictPath = path.join(metaDir, 'conflicts', `${id}.json`);
      if (await this.fileExists(conflictPath)) {
        const conflict = await this.readJson<ConflictRecord>(conflictPath, undefined as unknown as ConflictRecord);
        if (conflict) {
          const updated = { ...conflict, ...patch };
          await this.writeJson(conflictPath, updated);
          return updated;
        }
      }
    }
    throw new Error(`Conflict not found: ${id}`);
  }

  async resolveConflict(id: string, resolution: ConflictRecord['resolution'], mergedContent?: string): Promise<ConflictRecord> {
    for (const metaDir of this.metaDirs.values()) {
      const conflictPath = path.join(metaDir, 'conflicts', `${id}.json`);
      if (await this.fileExists(conflictPath)) {
        const conflict = await this.readJson<ConflictRecord>(conflictPath, undefined as unknown as ConflictRecord);
        if (conflict) {
          const status: ConflictStatus = resolution === 'abort' ? 'aborted' : 'resolved';
          const updated: ConflictRecord = {
            ...conflict,
            status,
            resolution,
            mergedContent,
            resolvedAt: new Date().toISOString(),
          };
          await this.writeJson(conflictPath, updated);
          return updated;
        }
      }
    }
    throw new Error(`Conflict not found: ${id}`);
  }

  // ============================================================================
  // Asset References (assets.json)
  // ============================================================================

  async saveAssetReferences(rootId: string, assetPath: string, entryIds: string[]): Promise<void> {
    const assetsPath = this.getAssetsPath(rootId);
    const assets = await this.readJson<Record<string, string[]>>(assetsPath, {});
    assets[assetPath] = entryIds;
    await this.writeJson(assetsPath, assets);
  }

  async listAssetReferences(rootId: string, assetPath: string): Promise<string[]> {
    const assets = await this.readJson<Record<string, string[]>>(this.getAssetsPath(rootId), {});
    return assets[assetPath] ?? [];
  }

  async saveAssetBindings(documentEntryId: string, bindings: AssetBinding[]): Promise<void> {
    // Find the root that contains this document
    for (const metaDir of this.metaDirs.values()) {
      const assetBindingsPath = path.join(metaDir, 'asset-bindings.json');
      const allBindings = await this.readJson<Record<string, AssetBinding[]>>(assetBindingsPath, {});
      allBindings[documentEntryId] = bindings;
      await this.writeJson(assetBindingsPath, allBindings);
      return;
    }
  }

  async getAssetBindings(documentEntryId: string): Promise<AssetBinding[]> {
    for (const metaDir of this.metaDirs.values()) {
      const assetBindingsPath = path.join(metaDir, 'asset-bindings.json');
      const allBindings = await this.readJson<Record<string, AssetBinding[]>>(assetBindingsPath, {});
      if (allBindings[documentEntryId]) {
        return allBindings[documentEntryId];
      }
    }
    return [];
  }

  // ============================================================================
  // Settings (settings.json - global)
  // ============================================================================

  async getSetting(key: string): Promise<string | undefined> {
    const settings = await this.readJson<Record<string, string>>(this.getSettingsPath(), {});
    return settings[key];
  }

  async getSettings(): Promise<Record<string, string>> {
    return this.readJson<Record<string, string>>(this.getSettingsPath(), {});
  }

  async setSetting(key: string, value: string): Promise<void> {
    const settingsPath = this.getSettingsPath();
    const settings = await this.readJson<Record<string, string>>(settingsPath, {});
    settings[key] = value;
    await this.writeJson(settingsPath, settings);
  }

  // ============================================================================
  // State (state.json - per root)
  // ============================================================================

  async getState(rootId: string): Promise<RootState> {
    const statePath = this.getStatePath(rootId);
    return this.readJson<RootState>(statePath, { initialized: false });
  }

  async setState(rootId: string, state: Partial<RootState>): Promise<void> {
    const statePath = this.getStatePath(rootId);
    const current = await this.getState(rootId);
    const updated = { ...current, ...state };
    await this.writeJson(statePath, updated);
  }

  // ============================================================================
  // History Pruning
  // ============================================================================

  async pruneHistory(options: PruneHistoryOptions = {}): Promise<PruneHistoryResult> {
    const keepOperations = Math.max(0, options.keepOperations ?? MAX_OPERATIONS);
    const keepOperationHours = Math.max(0, options.keepOperationHours ?? 24);
    const resolvedConflictDays = Math.max(0, options.resolvedConflictDays ?? 30);

    let operationsPruned = 0;
    let conflictsPruned = 0;

    const operationCutoff = new Date(Date.now() - keepOperationHours * 3_600_000).toISOString();
    const conflictCutoff = new Date(Date.now() - resolvedConflictDays * 86_400_000).toISOString();

    for (const metaDir of this.metaDirs.values()) {
      // Prune operations
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      const originalOpsCount = ops.length;
      const filteredOps = ops.filter((op) => op.createdAt >= operationCutoff).slice(0, keepOperations);
      operationsPruned += originalOpsCount - filteredOps.length;
      await this.writeJson(opsPath, filteredOps);

      // Prune resolved conflicts
      const conflictsDir = path.join(metaDir, 'conflicts');
      if (await this.fileExists(conflictsDir)) {
        const files = await fsp.readdir(conflictsDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const conflictPath = path.join(conflictsDir, file);
          const conflict = await this.readJson<ConflictRecord>(conflictPath, undefined as unknown as ConflictRecord);
          if (conflict && (conflict.status === 'resolved' || conflict.status === 'aborted')) {
            if (conflict.resolvedAt && conflict.resolvedAt < conflictCutoff) {
              await fsp.unlink(conflictPath);
              conflictsPruned++;
            }
          }
        }
      }
    }

    return { operations: operationsPruned, conflicts: conflictsPruned, snapshots: 0 };
  }

  /**
   * Drop finished operation records across every root's ring buffer and report
   * how many went away. Defaults to the two terminal "done" statuses so the task
   * center's「清空已完成」never throws away a failure the user still has to act on.
   */
  async clearCompletedOperations(statuses: OperationRecord['status'][] = ['succeeded', 'cancelled']): Promise<number> {
    let cleared = 0;
    for (const metaDir of this.metaDirs.values()) {
      const opsPath = path.join(metaDir, 'operations.json');
      const ops = await this.readJson<OperationRecord[]>(opsPath, []);
      const kept = ops.filter((op) => !statuses.includes(op.status));
      if (kept.length === ops.length) continue;
      cleared += ops.length - kept.length;
      await this.writeJson(opsPath, kept);
    }
    return cleared;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private getRootsPath(): string {
    return path.join(this.globalConfigDir, ROOTS_FILE);
  }

  private getSettingsPath(): string {
    return path.join(this.globalConfigDir, SETTINGS_FILE);
  }

  private getBindingsPath(rootId: string): string {
    const metaDir = this.metaDirs.get(rootId);
    if (!metaDir) throw new Error(`Root meta not initialized: ${rootId}`);
    return path.join(metaDir, 'bindings.json');
  }

  private getFoldersPath(rootId: string): string {
    const metaDir = this.metaDirs.get(rootId);
    if (!metaDir) throw new Error(`Root meta not initialized: ${rootId}`);
    return path.join(metaDir, 'folders.json');
  }

  private getAssetsPath(rootId: string): string {
    const metaDir = this.metaDirs.get(rootId);
    if (!metaDir) throw new Error(`Root meta not initialized: ${rootId}`);
    return path.join(metaDir, 'assets.json');
  }

  private getStatePath(rootId: string): string {
    const metaDir = this.metaDirs.get(rootId);
    if (!metaDir) throw new Error(`Root meta not initialized: ${rootId}`);
    return path.join(metaDir, 'state.json');
  }

  private getBlocksPath(entryId: string): string | undefined {
    for (const metaDir of this.metaDirs.values()) {
      return path.join(metaDir, 'blocks', `${entryId}.json`);
    }
    return undefined;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readJson<T>(filePath: string, defaultValue: T): Promise<T> {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return defaultValue;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmpPath, filePath); // Atomic write
  }
}

/** Resolve a directory to the form roots.json should store: absolute, with
 *  symlinks followed, so `/tmp/x` and `/private/tmp/x` are one and the same
 *  directory and cannot host two roots. Falls back to the plain resolution for
 *  paths that do not exist yet. */
async function canonicalLocalPath(localPath: string): Promise<string> {
  const resolved = path.resolve(localPath);
  try {
    return await fsp.realpath(resolved);
  } catch {
    return resolved;
  }
}
