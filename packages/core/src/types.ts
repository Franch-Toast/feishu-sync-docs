export type EntryKind = "document" | "asset";
/** "orphan" is kept for backward compatibility: entries stored before the
 *  local/remote-missing split get reclassified by the next scan round. */
export type EntryStatus = "clean" | "pending" | "conflict" | "orphan" | "error" | "local-missing" | "remote-missing";
export type ConflictStatus = "open" | "resolved" | "aborted";
export type SyncDirection = "push" | "pull" | "merge";
export type RemoteNodeType = "folder" | "document" | "asset";

export interface SyncRoot {
  id: string;
  localPath: string;
  remoteToken: string;
  remoteType: "folder" | "wiki";
  enabled: boolean;
  pollIntervalMs: number;
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

export interface LocalProvider {
  scan(root: SyncRoot): Promise<LocalFile[]>;
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
  createdAt: string;
  resolvedAt?: string;
}

export interface OperationRecord {
  id: string;
  entryId?: string;
  rootId?: string;
  direction: SyncDirection;
  operation: string;
  trigger?: SyncTrigger;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  retryCount: number;
  error?: string;
  errorCategory?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
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

/** Binding between a local file and its remote counterpart */
export interface EntryBinding {
  entryId: string;
  rootId: string;
  relativePath: string;
  kind: EntryKind;
  remoteToken?: string;
  remoteParentToken?: string;
  status: EntryStatus;
  remoteRevision?: number;
  remoteContentHash?: string;
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
   *  re-evaluated with correct three-way data on the next round. */
  commitBaseline(rootId: string, message: string, trigger: SyncTrigger, onlyPaths?: ReadonlySet<string>): Promise<string>;
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
  updateOperation(id: string, patch: Partial<Pick<OperationRecord, "status" | "error" | "completedAt" | "retryCount">>): Promise<OperationRecord>;
  listOperations(limit?: number): Promise<OperationRecord[]>;
  getOperation(id: string): Promise<OperationRecord | undefined>;
  
  // Conflicts (conflicts/<conflictId>.json)
  createConflict(input: Omit<ConflictRecord, "id" | "createdAt" | "status">): Promise<ConflictRecord>;
  getConflict(id: string): Promise<ConflictRecord | undefined>;
  listConflicts(status?: ConflictStatus): Promise<ConflictRecord[]>;
  updateConflict(id: string, patch: Partial<Pick<ConflictRecord, "baseContent" | "localContent" | "remoteContent" | "mergedContent" | "remoteRevision" | "remoteContentHash">>): Promise<ConflictRecord>;
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
  
  // History pruning
  pruneHistory(options?: PruneHistoryOptions): Promise<PruneHistoryResult>;
}
