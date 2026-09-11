export type EntryKind = "document" | "asset";
/** "orphan" is kept for backward compatibility: entries stored before the
 *  local/remote-missing split get reclassified by the next scan round. */
export type EntryStatus = "clean" | "pending" | "conflict" | "orphan" | "error" | "local-missing" | "remote-missing";
export type ConflictStatus = "open" | "resolved" | "aborted";
export type SyncDirection = "push" | "pull" | "merge";
export type RemoteNodeType = "folder" | "document" | "asset";
/** One-way sync modes folded in from the read-only/upstream-only request:
 *  bidirectional keeps the three-way merge, pull-only makes the remote the
 *  source of truth (local edits are never pushed), push-only makes the local
 *  tree authoritative (remote edits are never pulled). Absent = bidirectional. */
export type SyncMode = "bidirectional" | "pull-only" | "push-only";
/** Incremental scan hint carried by event/watch triggers: only these local
 *  paths and/or remote tokens changed, so the engine can restrict the costly
 *  per-entry remote probing to the affected entries. */
export interface SyncScope {
  relativePaths?: string[];
  remoteTokens?: string[];
}

export interface SyncRoot {
  id: string;
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  enabled: boolean;
  pollIntervalMs: number;
  /** Sync direction policy; absent means bidirectional (backward compatible). */
  mode?: SyncMode;
  /** Glob patterns excluded from scanning/watching (B6.5). */
  exclude?: string[];
}

export interface LocalFile {
  relativePath: string;
  absolutePath: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  contentHash: string;
}

export interface RemoteNode {
  token: string;
  name: string;
  type: RemoteNodeType;
  parentToken: string;
  updatedAt?: string;
  revisionId?: number;
  contentHash?: string;
}

export interface RemoteDocument extends RemoteNode {
  type: "document";
  content: string;
  blocks: RemoteBlock[];
  revisionId?: number;
  rootBlockId?: string;
}

export interface RemoteAsset extends RemoteNode {
  type: "asset";
  mimeType: string;
  size: number;
}

export interface AssetBinding {
  documentEntryId: string;
  assetEntryId: string;
  token: string;
  contentHash: string;
}

export interface RemoteBlock {
  id: string;
  kind: string;
  content: string;
  contentHash: string;
  position: number;
}

export interface RemoteTree {
  root: RemoteNode;
  nodes: RemoteNode[];
}

export interface CanonicalBlock {
  stableId: string;
  kind: string;
  content: string;
  contentHash: string;
  position: number;
}

export interface CanonicalDocument {
  title?: string;
  content: string;
  contentHash: string;
  blocks: CanonicalBlock[];
  links: MarkdownLink[];
  assets: MarkdownAssetReference[];
  warnings: string[];
}

export interface MarkdownLink {
  target: string;
  label?: string;
  start: number;
  end: number;
}

export interface MarkdownAssetReference {
  target: string;
  start: number;
  end: number;
}

export interface DocumentPatch {
  operations: DocumentPatchOperation[];
  expectedRevisionId?: number;
  expectedContentHash?: string;
}

export type DocumentPatchOperation =
  | { type: "replace"; blockId: string; content: string }
  | { type: "insertAfter"; blockId: string; content: string }
  | { type: "delete"; blockId: string }
  | { type: "overwrite"; content: string };

export interface MutationResult {
  document: RemoteDocument;
  applied: DocumentPatchOperation[];
}

/** Options narrowing a local scan to the paths that actually changed (E1).
 *  Without it a watcher event still walked and hashed the whole tree. */
export interface LocalScanOptions {
  onlyPaths?: readonly string[];
}

export interface LocalProvider {
  scan(root: SyncRoot, options?: LocalScanOptions): Promise<LocalFile[]>;
  readText(root: SyncRoot, relativePath: string): Promise<string>;
  writeText(root: SyncRoot, relativePath: string, content: string): Promise<void>;
  readBinary(root: SyncRoot, relativePath: string): Promise<Uint8Array>;
  writeBinary(root: SyncRoot, relativePath: string, content: Uint8Array): Promise<void>;
  delete(root: SyncRoot, relativePath: string): Promise<void>;
}

export interface RemoteProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  listTree(root: SyncRoot): Promise<RemoteTree>;
  getDocument(token: string): Promise<RemoteDocument>;
  createFolder(parentToken: string, name: string): Promise<RemoteNode>;
  createDocument(parentToken: string, name: string, content: string): Promise<RemoteDocument>;
  applyPatch(token: string, patch: DocumentPatch): Promise<MutationResult>;
  uploadAsset(parentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset>;
  uploadInlineAsset?(documentToken: string, name: string, content: Uint8Array, mimeType: string): Promise<RemoteAsset>;
  downloadAsset(token: string): Promise<Uint8Array>;
  /** Move a remote file to the drive trash. The Feishu endpoint requires the
   *  file type as a query parameter (docx/folder/file). */
  softDelete(token: string, type?: "docx" | "folder" | "file"): Promise<void>;
}

export interface ProviderCapabilities {
  blockPatch: boolean;
  revisionGuard: boolean;
  assetUpload: boolean;
  remoteEvents: boolean;
}

export interface BlockMapping {
  entryId: string;
  stableId: string;
  blockId: string;
  kind: string;
  contentHash: string;
  position: number;
}

export interface ConflictRecord {
  id: string;
  entryId: string;
  status: ConflictStatus;
  baseContent: string;
  localContent: string;
  remoteContent: string;
  mergedContent?: string;
  resolution?: "local" | "remote" | "merged" | "abort";
  remoteRevision?: number;
  remoteContentHash?: string;
  /** Human-readable Chinese reason shown in the 异常工作台 when the engine
   *  could not decide on its own (e.g. a remote title already owned by another
   *  entry). Absent for the ordinary "both sides edited" conflict. */
  reason?: string;
  /** B4: for a remote-title collision, the token of the document that already
   *  backs another entry, and that entry's path. The 异常工作台 uses them to offer
   *  「采用该远端文档」, which transfers ownership to this entry. */
  collidingToken?: string;
  collidingOwnerPath?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** What one `scan` produced: the bindings after evaluation, how many open
 *  conflicts were found and how many local paths were considered (E1/E5 use
 *  `scanned` to tell an incremental round from a full one). */
export interface ScanResult {
  entries: EntryBinding[];
  conflicts: number;
  scanned: number;
}

export interface OperationRecord {
  id: string;
  entryId?: string;
  rootId?: string;
  direction: SyncDirection;
  /** `sync-round` marks a whole scan+sync round (no entryId); `sync-entry` and
   *  `sync-asset` are the per-file tasks it schedules. */
  operation: string;
  trigger?: SyncTrigger;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  retryCount: number;
  /** Auto-retry ceiling for this operation; absent records default to 3. */
  maxRetries?: number;
  error?: string;
  errorCategory?: ErrorCategory;
  /** A failed record waits for a human until they retry or ignore it. Absent
   *  means `true` so records written before this field still surface in the
   *  「失败待处理」queue. */
  needsAction?: boolean;
  /** Per-round outcome counters, written when a `sync-round` finishes. */
  summary?: RoundSummary;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/** Counts of what one sync round did, shown as badges on the round task. */
export interface RoundSummary {
  scanned: number;
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

/** Semantic bucket of a failed operation, driving the task-center guidance and
 *  the auto-retry policy (auth/permission never auto-retry). */
export type ErrorCategory = "auth" | "conflict" | "network" | "permission" | "not_found" | "rate_limit" | "unknown";

/** Cursor-paged, filterable operation query used by the task center/history. */
export interface ListOperationsOptions {
  rootId?: string;
  limit?: number;
  /** Id of the last seen operation; the next page starts strictly after it. */
  cursor?: string;
  status?: OperationRecord["status"];
  trigger?: SyncTrigger;
  errorCategory?: ErrorCategory;
  /** Narrow to the human-actionable failures (the「失败待处理」queue). Records
   *  predating the field are treated as `needsAction: true`. */
  needsAction?: boolean;
}

export interface SyncDecision {
  action: "noop" | "push" | "pull" | "merge" | "conflict";
  reason: string;
  mergedContent?: string;
}

export interface PruneHistoryOptions {
  /** Keep at most this many most-recent operation records. */
  keepOperations?: number;
  /** Delete operations created more than this many hours ago (time-based LRU). */
  keepOperationHours?: number;
  /** Delete resolved/aborted conflicts resolved more than this many days ago. */
  resolvedConflictDays?: number;
}

export interface PruneHistoryResult {
  operations: number;
  conflicts: number;
  snapshots: number;
}

// ============================================================================
// Git-backed storage layer interfaces (content, version history and metadata)
// ============================================================================

/** Represents a file change detected by git status */
export interface Change {
  relativePath: string;
  type: 'added' | 'modified' | 'deleted';
  localContent?: string;
  baselineContent?: string;
}

/** Represents a git commit in the sync history */
export interface Commit {
  hash: string;
  message: string;
  timestamp: string;
  trigger: SyncTrigger;
}

/** Trigger source for sync operations */
export type SyncTrigger = 'manual' | 'event' | 'poll' | 'watch';

/** Binding between a local file and its remote counterpart.
 *
 *  Identity contract: a pair is bound by `relativePath` ⟷ `remoteToken` and
 *  never re-decided by title once bound. `remoteName` records the title actually
 *  used on the drive when path sanitising had to de-duplicate it, so the reverse
 *  mapping stays exact. `localContentHash`/`lastErrorAt` carry just enough
 *  information to decide whether a failed (`error`) entry has anything new to
 *  try, instead of reviving it on every scan. */
export interface EntryBinding {
  entryId: string;
  rootId: string;
  relativePath: string;
  kind: EntryKind;
  remoteToken?: string;
  remoteParentToken?: string;
  /** Remote title in use; absent means `remoteTitle(relativePath)`. */
  remoteName?: string;
  status: EntryStatus;
  remoteRevision?: number;
  remoteContentHash?: string;
  /** Hash of the local file when this binding was last evaluated. */
  localContentHash?: string;
  /** When the entry last failed to sync; drives the 「new information」 check. */
  lastErrorAt?: string;
  ignoredAt?: string;
  lastSyncCommit?: string;
  updatedAt: string;
}

/** Binding between a local folder and its remote counterpart */
export interface FolderBinding {
  relativePath: string;
  remoteToken: string;
  createdAt: string;
}

/** Root-level sync state stored in state.json */
export interface RootState {
  lastSyncCommit?: string;
  lastSyncAt?: string;
  initialized: boolean;
  /** Owner of this metadata directory; lets a re-bind take the history over. */
  rootId?: string;
  localPath?: string;
}

/** Git-based storage interface for content and version history */
export interface GitStorage {
  // Repository lifecycle
  initRoot(root: SyncRoot): Promise<void>;
  deleteRoot(rootId: string): Promise<void>;
  isInitialized(rootId: string): Promise<boolean>;
  
  // Baseline management (replaces snapshots table)
  getBaseline(rootId: string, relativePath: string): Promise<string | undefined>;
  /** Commit the working tree as the new baseline. When `onlyPaths` is given,
   *  only those relative paths are staged, so entries that did not reach a
   *  clean state (conflict/error/missing) keep their previous baseline and are
   *  re-evaluated with correct three-way data on the next round.
   *  `expectedHashes` maps a path to the sha256 of the bytes the round actually
   *  reconciled. A save that lands *while* a round runs is not part of it: if the
   *  working tree no longer matches, the path is left out of the commit, so the
   *  next round still sees it as an unsynced local edit instead of reading it as
   *  `base === local` and pulling the remote over the user's work. */
  commitBaseline(rootId: string, message: string, trigger: SyncTrigger, onlyPaths?: ReadonlySet<string>, expectedHashes?: ReadonlyMap<string, string>): Promise<string>;
  /** Stage the exact bytes a sync action reconciled with the remote, ahead of the
   *  round-end commit. `git add --contents` writes the index only, so a file the
   *  user saves again before `commitBaseline` runs cannot push those unsynced
   *  bytes into the baseline: the committed copy stays the one the remote holds.
   *  Best-effort by design — the round-end commit still records the working tree. */
  stageReconciled(rootId: string, relativePath: string, content: string | Uint8Array): Promise<void>;
  getBaselineCommit(rootId: string): Promise<string | undefined>;
  
  // Content reading
  readWorkingTree(rootId: string, relativePath: string): Promise<string>;
  readWorkingTreeBinary(rootId: string, relativePath: string): Promise<Uint8Array>;
  writeWorkingTree(rootId: string, relativePath: string, content: string): Promise<void>;
  writeWorkingTreeBinary(rootId: string, relativePath: string, content: Uint8Array): Promise<void>;
  deleteFromWorkingTree(rootId: string, relativePath: string): Promise<void>;
  
  // Change detection (replaces hash comparison)
  detectChanges(rootId: string): Promise<Change[]>;
  
  // History (replaces operations table for sync history)
  getHistory(rootId: string, limit?: number): Promise<Commit[]>;
  /** Read a file's content at a specific commit (version-history diff/rollback).
   *  Returns undefined when the path did not exist at that commit. */
  readBlobAt(rootId: string, commit: string, relativePath: string): Promise<string | undefined>;
  /** List commits that touched a single relative path, newest first. Backs the
   *  per-document version timeline. */
  listCommitsForPath(rootId: string, relativePath: string, limit?: number): Promise<Commit[]>;
  
  // Root path management
  getRootPath(rootId: string): string | undefined;
  registerRootPath(rootId: string, localPath: string): void;
}

/** JSON-based metadata storage interface */
export interface MetaStorage {
  // Initialization
  initRootMeta(rootId: string, localPath: string): Promise<void>;
  deleteRootMeta(rootId: string): Promise<void>;
  
  // Root management (stored in global config, not per-root)
  createRoot(input: Omit<SyncRoot, "id">): Promise<SyncRoot>;
  listRoots(): Promise<SyncRoot[]>;
  getRoot(id: string): Promise<SyncRoot | undefined>;
  updateRoot(id: string, patch: Partial<Omit<SyncRoot, "id">>): Promise<SyncRoot>;
  deleteRoot(id: string): Promise<void>;
  
  // Bindings (bindings.json)
  getBinding(rootId: string, relativePath: string): Promise<EntryBinding | undefined>;
  setBinding(rootId: string, relativePath: string, binding: EntryBinding): Promise<void>;
  deleteBinding(rootId: string, relativePath: string): Promise<void>;
  listBindings(rootId: string): Promise<EntryBinding[]>;
  findBindingByToken(rootId: string, remoteToken: string): Promise<EntryBinding | undefined>;
  findBindingById(entryId: string): Promise<EntryBinding | undefined>;
  
  // Folder bindings (folders.json)
  getFolderBinding(rootId: string, relativePath: string): Promise<FolderBinding | undefined>;
  setFolderBinding(rootId: string, relativePath: string, binding: FolderBinding): Promise<void>;
  deleteFolderBinding(rootId: string, relativePath: string): Promise<void>;
  listFolderBindings(rootId: string): Promise<FolderBinding[]>;
  
  // Block mappings (blocks/<entryId>.json)
  getBlocks(entryId: string): Promise<BlockMapping[]>;
  saveBlocks(entryId: string, blocks: BlockMapping[]): Promise<void>;
  
  // Operations (operations.json - ring buffer)
  addOperation(input: Omit<OperationRecord, "id" | "createdAt" | "retryCount" | "status">): Promise<OperationRecord>;
  updateOperation(id: string, patch: Partial<Pick<OperationRecord, "status" | "error" | "errorCategory" | "completedAt" | "startedAt" | "retryCount" | "maxRetries" | "direction" | "trigger" | "needsAction" | "summary">>): Promise<OperationRecord>;
  listOperations(options?: number | ListOperationsOptions): Promise<OperationRecord[]>;
  getOperation(id: string): Promise<OperationRecord | undefined>;
  
  // Conflicts (conflicts/<conflictId>.json)
  createConflict(input: Omit<ConflictRecord, "id" | "createdAt" | "status">): Promise<ConflictRecord>;
  getConflict(id: string): Promise<ConflictRecord | undefined>;
  listConflicts(status?: ConflictStatus): Promise<ConflictRecord[]>;
  updateConflict(id: string, patch: Partial<Pick<ConflictRecord, "baseContent" | "localContent" | "remoteContent" | "mergedContent" | "remoteRevision" | "remoteContentHash" | "reason" | "collidingToken" | "collidingOwnerPath">>): Promise<ConflictRecord>;
  resolveConflict(id: string, resolution: ConflictRecord["resolution"], mergedContent?: string): Promise<ConflictRecord>;
  
  // Asset references (assets.json)
  saveAssetReferences(rootId: string, assetPath: string, entryIds: string[]): Promise<void>;
  listAssetReferences(rootId: string, assetPath: string): Promise<string[]>;
  saveAssetBindings(documentEntryId: string, bindings: AssetBinding[]): Promise<void>;
  getAssetBindings(documentEntryId: string): Promise<AssetBinding[]>;
  
  // Settings (settings.json)
  getSetting(key: string): Promise<string | undefined>;
  getSettings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
  
  // State (state.json)
  getState(rootId: string): Promise<RootState>;
  setState(rootId: string, state: Partial<RootState>): Promise<void>;

  /** Look up an existing root bound to the same directory (G1): one directory
   *  is at most one root, so re-binding reuses the record instead of forking a
   *  second root over the same metadata. */
  findRootByLocalPath(localPath: string): Promise<SyncRoot | undefined>;
  /** Name of the root owning `<localPath>/.feishu-sync`, when that metadata is
   *  orphaned (G3): the directory carries state no registered root points at. */
  findOrphanMetaOwner(localPath: string): Promise<string | undefined>;
  /** G3: move an existing `.feishu-sync/` payload into a timestamped backup so
   *  the next bind starts clean. Returns false when there was nothing to move;
   *  nothing is deleted and `.git` is never touched. */
  archiveRootMeta(localPath: string): Promise<boolean>;
  
  // History pruning
  pruneHistory(options?: PruneHistoryOptions): Promise<PruneHistoryResult>;
  /** Delete finished operation records on demand, backing the task center's
   *  「清空已完成」. The retention prune keeps ~1000 recent records, so it would
   *  report nothing cleared long before any record actually expires. */
  clearCompletedOperations(statuses?: OperationRecord["status"][]): Promise<number>;
}
