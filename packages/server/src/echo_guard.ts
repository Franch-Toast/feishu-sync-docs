import { join } from "node:path";
import type { SyncRoot } from "@feishu-sync/core";

/**
 * Echo guards (TTL 5s) that stop the runtime from looping its own writes back
 * into another sync round.
 *
 * Two independent sets of short-lived markers:
 * - local paths we just pulled, so the chokidar watcher ignores the file-change
 *   event our own write emits (watcher → sync → write → watcher loop);
 * - remote tokens we just pushed, so a drive-event on our own edit is dropped
 *   instead of re-triggering a pull that would conflict with the push.
 *
 * Each marker is a `key → expiryTimestamp` entry; every insert opportunistically
 * prunes expired keys so the maps stay bounded without a dedicated timer.
 */
export class EchoGuard {
  private readonly recentLocalWrites = new Map<string, number>();
  private readonly recentRemotePushes = new Map<string, number>();
  private static readonly ECHO_TTL_MS = 5_000;

  /** Remember a local path we just pulled so the watcher ignores our own write. */
  registerLocalWrite(root: SyncRoot, relativePath: string): void {
    this.pruneEchoMap(this.recentLocalWrites);
    this.recentLocalWrites.set(join(root.localPath, relativePath), Date.now() + EchoGuard.ECHO_TTL_MS);
  }

  /** Remember a remote token we just pushed so drive events ignore the echo. */
  registerRemotePush(remoteToken: string): void {
    this.pruneEchoMap(this.recentRemotePushes);
    this.recentRemotePushes.set(remoteToken, Date.now() + EchoGuard.ECHO_TTL_MS);
  }

  isRecentLocalWrite(absolutePath: string): boolean {
    const expiry = this.recentLocalWrites.get(absolutePath);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) { this.recentLocalWrites.delete(absolutePath); return false; }
    return true;
  }

  isRecentRemotePush(remoteToken: string): boolean {
    const expiry = this.recentRemotePushes.get(remoteToken);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) { this.recentRemotePushes.delete(remoteToken); return false; }
    return true;
  }

  private pruneEchoMap(map: Map<string, number>): void {
    const now = Date.now();
    for (const [key, expiry] of map) if (expiry < now) map.delete(key);
  }
}
