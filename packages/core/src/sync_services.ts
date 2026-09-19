import type { GitStorage, LocalProvider, MetaStorage, RemoteProvider } from "./types.js";

/**
 * The four injected boundaries a sync collaborator needs. `SyncEngine` owns one
 * instance and hands it to every collaborator (tree cache, importer, rename
 * detector, name aligner) so they all talk to the same storage/provider set
 * without importing each other.
 */
export interface SyncServices {
  gitStorage: GitStorage;
  metaStorage: MetaStorage;
  local: LocalProvider;
  remote: RemoteProvider;
}
