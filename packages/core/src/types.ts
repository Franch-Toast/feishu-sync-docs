export type EntryKind = "document" | "asset";
export type EntryStatus = "clean" | "pending" | "conflict" | "orphan" | "error";
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
  softDelete(token: string): Promise<void>;
}

export interface ProviderCapabilities {
  blockPatch: boolean;
  revisionGuard: boolean;
  assetUpload: boolean;
  remoteEvents: boolean;
}

export interface SyncEntry {
  id: string;
  rootId: string;
  relativePath: string;
  kind: EntryKind;
  remoteToken?: string;
  remoteParentToken?: string;
  status: EntryStatus;
  localHash?: string;
  remoteHash?: string;
  baseHash?: string;
  localRevision?: number;
  remoteRevision?: number;
  updatedAt: string;
}

export interface SyncSnapshot {
  entryId: string;
  baseContent: string;
  localContent: string;
  remoteContent: string;
  baseHash: string;
  localHash: string;
  remoteHash: string;
  createdAt: string;
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
  direction: SyncDirection;
  operation: string;
  status: "queued" | "running" | "succeeded" | "failed";
  retryCount: number;
  error?: string;
  createdAt: string;
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
  /** Delete resolved/aborted conflicts resolved more than this many days ago. */
  resolvedConflictDays?: number;
}

export interface PruneHistoryResult {
  operations: number;
  conflicts: number;
  snapshots: number;
}

export interface StateStore {
  createRoot(input: Omit<SyncRoot, "id">): Promise<SyncRoot>;
  listRoots(): Promise<SyncRoot[]>;
  getRoot(id: string): Promise<SyncRoot | undefined>;
  updateRoot(id: string, patch: Partial<Omit<SyncRoot, "id">>): Promise<SyncRoot>;
  deleteRoot(id: string): Promise<void>;
  upsertEntry(entry: SyncEntry): Promise<void>;
  getEntry(id: string): Promise<SyncEntry | undefined>;
  findEntry(rootId: string, relativePath: string): Promise<SyncEntry | undefined>;
  listEntries(rootId: string): Promise<SyncEntry[]>;
  saveSnapshot(snapshot: SyncSnapshot): Promise<void>;
  getSnapshot(entryId: string): Promise<SyncSnapshot | undefined>;
  saveBlocks(entryId: string, blocks: BlockMapping[]): Promise<void>;
  getBlocks(entryId: string): Promise<BlockMapping[]>;
  createConflict(input: Omit<ConflictRecord, "id" | "createdAt" | "status">): Promise<ConflictRecord>;
  getConflict(id: string): Promise<ConflictRecord | undefined>;
  listConflicts(status?: ConflictStatus): Promise<ConflictRecord[]>;
  updateConflict(id: string, patch: Partial<Pick<ConflictRecord, "baseContent" | "localContent" | "remoteContent" | "mergedContent" | "remoteRevision" | "remoteContentHash">>): Promise<ConflictRecord>;
  resolveConflict(id: string, resolution: ConflictRecord["resolution"], mergedContent?: string): Promise<ConflictRecord>;
  addOperation(input: Omit<OperationRecord, "id" | "createdAt" | "retryCount" | "status">): Promise<OperationRecord>;
  updateOperation(id: string, patch: Partial<Pick<OperationRecord, "status" | "error" | "completedAt" | "retryCount">>): Promise<OperationRecord>;
  listOperations(limit?: number): Promise<OperationRecord[]>;
  saveAssetReferences(rootId: string, assetPath: string, entryIds: string[]): Promise<void>;
  listAssetReferences(rootId: string, assetPath: string): Promise<string[]>;
  saveAssetBindings(documentEntryId: string, bindings: AssetBinding[]): Promise<void>;
  getAssetBindings(documentEntryId: string): Promise<AssetBinding[]>;
  /** Enforce retention policies on append-only history tables. */
  pruneHistory(options?: PruneHistoryOptions): Promise<PruneHistoryResult>;
}
