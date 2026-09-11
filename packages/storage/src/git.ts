import git from 'isomorphic-git';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  Change, Commit, GitStorage, SyncRoot, SyncTrigger
} from '@feishu-sync/core';

const GIT_AUTHOR = { name: 'Feishu Sync', email: 'sync@feishu.local' };
/** sha256 of a working-tree file, in the same form the engine stores in
 *  `localContentHash`; undefined once the file is gone. */
async function hashWorkingTreeFile(dir: string, filepath: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await fsp.readFile(path.join(dir, filepath))).digest('hex');
  } catch {
    return undefined;
  }
}
/** Lines the sync requires in `.gitignore`; the tmp pattern covers the atomic
 *  write helper in FilesystemProvider. */
const REQUIRED_IGNORES = ['.feishu-sync/', '*.feishu-sync-*.tmp'];
const METADATA_DIR = '.feishu-sync';

/**
 * Git-based storage implementation using isomorphic-git.
 * Manages document content and version history in .git directory.
 */
export class GitStorageImpl implements GitStorage {
  private readonly rootPaths: Map<string, string> = new Map();

  async initRoot(root: SyncRoot): Promise<void> {
    const dir = root.localPath;
    this.rootPaths.set(root.id, dir);

    // Ensure directory exists
    await fsp.mkdir(dir, { recursive: true });

    // G4: an existing user repository must be adopted, not skipped. `init` on a
    // path that already has `.git` would be a no-op, and returning early left
    // the metadata directory un-ignored (or worse, already committed).
    const isFresh = !fs.existsSync(path.join(dir, '.git'));
    if (isFresh) await git.init({ fs, dir, defaultBranch: 'main' });

    await this.ensureGitignore(dir);
    await this.untrackMetadata(dir);

    if (isFresh) {
      // Initial commit
      await git.add({ fs, dir, filepath: '.gitignore' });
      await git.commit({
        fs,
        dir,
        message: 'init: feishu-sync repository',
        author: GIT_AUTHOR,
      });
    }
  }

  /** Append the required ignore rules without ever rewriting what the user
   *  already put in `.gitignore`. */
  private async ensureGitignore(dir: string): Promise<void> {
    const gitignorePath = path.join(dir, '.gitignore');
    let current = '';
    try {
      current = await fsp.readFile(gitignorePath, 'utf-8');
    } catch {
      current = '';
    }
    const lines = current.split('\n').map((line) => line.trim());
    const missing = REQUIRED_IGNORES.filter((pattern) => !lines.includes(pattern));
    if (missing.length === 0) return;
    const suffix = current && !current.endsWith('\n') ? '\n' : '';
    await fsp.writeFile(gitignorePath, `${current}${suffix}${missing.join('\n')}\n`, 'utf-8');
  }

  /** Drop metadata that an earlier version (or a careless `git add .`) tracked,
   *  so the sync state never becomes part of the user's document history. */
  private async untrackMetadata(dir: string): Promise<void> {
    let tracked: string[];
    try {
      tracked = (await git.listFiles({ fs, dir })).filter((file) => file === METADATA_DIR || file.startsWith(`${METADATA_DIR}/`));
    } catch {
      return; // No HEAD yet: nothing can be tracked.
    }
    if (tracked.length === 0) return;
    for (const filepath of tracked) {
      try {
        await git.remove({ fs, dir, filepath });
      } catch {
        // Already gone from the index.
      }
    }
    await git.commit({
      fs,
      dir,
      message: 'chore: untrack feishu-sync metadata',
      author: GIT_AUTHOR,
    });
  }

  async deleteRoot(rootId: string): Promise<void> {
    this.rootPaths.delete(rootId);
    // Note: We don't delete the .git directory as it's part of user's local path
  }

  async isInitialized(rootId: string): Promise<boolean> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return false;
    const gitDir = path.join(dir, '.git');
    return fs.existsSync(gitDir);
  }

  registerRootPath(rootId: string, localPath: string): void {
    this.rootPaths.set(rootId, localPath);
  }

  getRootPath(rootId: string): string | undefined {
    return this.rootPaths.get(rootId);
  }

  async getBaseline(rootId: string, relativePath: string): Promise<string | undefined> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return undefined;

    const commitHash = await this.getBaselineCommit(rootId);
    if (!commitHash) return undefined;

    try {
      const { blob } = await git.readBlob({
        fs,
        dir,
        oid: commitHash,
        filepath: relativePath,
      });
      return Buffer.from(blob).toString('utf-8');
    } catch {
      return undefined; // File doesn't exist in baseline
    }
  }

  async getBaselineCommit(rootId: string): Promise<string | undefined> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return undefined;

    try {
      // Read from refs/heads/main
      const oid = await git.resolveRef({ fs, dir, ref: 'refs/heads/main' });
      return oid;
    } catch {
      // G4: the bound repository may be a user's own, on `master` or any other
      // branch. Every write below goes through HEAD, so resolving the baseline
      // from HEAD keeps read and write on the same line instead of silently
      // pretending the repository has no history.
      try {
        return await git.resolveRef({ fs, dir, ref: 'HEAD' });
      } catch {
        // Empty repository with no commits: treated as "no baseline".
        return undefined;
      }
    }
  }

  async commitBaseline(rootId: string, message: string, trigger: SyncTrigger, onlyPaths?: ReadonlySet<string>, expectedHashes?: ReadonlyMap<string, string>): Promise<string> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    // Get status matrix to find changes.
    // E4: with a known path set, `filter` keeps isomorphic-git from hashing
    // every file in the repository just to decide the status of a handful.
    const matrix = await this.statusMatrix(dir, onlyPaths);

    // Stage changes.
    // statusMatrix returns [filepath, head, workdir, stage] tuples.
    // When onlyPaths is provided, stage ONLY those paths. Entries that did not
    // reach a clean state (conflict/error/missing) are excluded so their local
    // edit is never absorbed into the baseline; otherwise the next evaluation
    // would see base === local and pull the remote instead of re-detecting the
    // disagreement (conflict) or re-pushing a failed change (error recovery).
    for (const row of matrix) {
      const filepath = row[0] as string;
      const head = row[1] as number;
      const workdir = row[2] as number;
      // When onlyPaths is provided, force-stage exactly those paths: git.add
      // re-hashes the real file content, so a same-size edit whose mtime
      // collides with the index cache is still detected (statusMatrix's workdir
      // flag alone can miss it). Without onlyPaths, stage every path whose
      // workdir differs from HEAD.
      const included = onlyPaths ? onlyPaths.has(filepath) : workdir !== head;
      if (!included) continue;
      // A save that lands while the round is still in flight belongs to the next
      // round: `git.add` below would absorb it into this baseline, and the next
      // evaluation would then see `base === local` and pull the remote over an
      // edit that was never pushed. Re-check the bytes against what the round
      // actually reconciled and leave drifted paths at their old baseline.
      const expected = expectedHashes?.get(filepath);
      if (expected !== undefined && workdir !== 0 && (await hashWorkingTreeFile(dir, filepath)) !== expected) continue;
      if (workdir === 0) {
        // File deleted from the working tree
        if (head !== 0) await git.remove({ fs, dir, filepath });
      } else {
        // File added or modified
        await git.add({ fs, dir, filepath });
      }
    }

    // Check if there are any staged changes
    const stagedMatrix = await this.statusMatrix(dir, onlyPaths);
    const hasChanges = stagedMatrix.some((row) => {
      const head = row[1] as number;
      const stage = row[3] as number;
      return stage !== head;
    });

    if (!hasChanges) {
      // No changes to commit, return current HEAD
      const currentCommit = await this.getBaselineCommit(rootId);
      return currentCommit ?? '';
    }

    // Commit with trigger info
    const commitMessage = `${message} [trigger=${trigger}]`;
    const oid = await git.commit({
      fs,
      dir,
      message: commitMessage,
      author: GIT_AUTHOR,
    });

    return oid;
  }

  async stageReconciled(rootId: string, relativePath: string, content: string | Uint8Array): Promise<void> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return;
    try {
      // Write the blob, then point the index at it (`git.add` can only stage what
      // the working tree holds). What lands in the next commit is therefore what
      // the remote was given, not whatever the file holds by then.
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const oid = await git.writeBlob({ fs, dir, blob: bytes });
      await git.updateIndex({ fs, dir, filepath: relativePath, oid, add: true });
    } catch {
      // Best-effort: a path the repository cannot hold (outside the root, a
      // vanished parent directory) is still reconciled remotely, and the
      // round-end commit records the working tree the usual way.
    }
  }

  /** Whole-repository status, narrowed to `onlyPaths` when the caller knows
   *  which files can have changed. isomorphic-git exposes no `filepaths` option
   *  on `statusMatrix`, so `filter` is the supported way to shrink the scope. */
  private statusMatrix(dir: string, onlyPaths?: ReadonlySet<string>): Promise<Array<[string, number, number, number]>> {
    return onlyPaths
      ? git.statusMatrix({ fs, dir, filter: (filepath) => onlyPaths.has(filepath) })
      : git.statusMatrix({ fs, dir });
  }

  async readWorkingTree(rootId: string, relativePath: string): Promise<string> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    const fullPath = path.join(dir, relativePath);
    return fsp.readFile(fullPath, 'utf-8');
  }

  async readWorkingTreeBinary(rootId: string, relativePath: string): Promise<Uint8Array> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    const fullPath = path.join(dir, relativePath);
    const buffer = await fsp.readFile(fullPath);
    return new Uint8Array(buffer);
  }

  async writeWorkingTree(rootId: string, relativePath: string, content: string): Promise<void> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    const fullPath = path.join(dir, relativePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content, 'utf-8');
  }

  async writeWorkingTreeBinary(rootId: string, relativePath: string, content: Uint8Array): Promise<void> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    const fullPath = path.join(dir, relativePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, Buffer.from(content));
  }

  async deleteFromWorkingTree(rootId: string, relativePath: string): Promise<void> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    const fullPath = path.join(dir, relativePath);
    try {
      await fsp.unlink(fullPath);
    } catch {
      // File may already be deleted
    }
  }

  async detectChanges(rootId: string): Promise<Change[]> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return [];

    const matrix = await git.statusMatrix({ fs, dir });
    const changes: Change[] = [];

    // statusMatrix returns [filepath, head, workdir, stage] tuples
    for (const row of matrix) {
      const filepath = row[0] as string;
      const head = row[1] as number;
      const workdir = row[2] as number;

      // Skip .gitignore and .feishu-sync
      if (filepath === '.gitignore' || filepath.startsWith('.feishu-sync/')) {
        continue;
      }

      if (head === 0 && workdir === 2) {
        // New file (not in HEAD, exists in workdir)
        changes.push({ relativePath: filepath, type: 'added' });
      } else if (head === 1 && workdir === 2) {
        // Modified file
        changes.push({ relativePath: filepath, type: 'modified' });
      } else if (head === 1 && workdir === 0) {
        // Deleted file
        changes.push({ relativePath: filepath, type: 'deleted' });
      }
    }

    return changes;
  }

  async getHistory(rootId: string, limit = 50): Promise<Commit[]> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return [];

    try {
      const commits = await git.log({ fs, dir, depth: limit });
      return commits.map((c) => ({
        hash: c.oid,
        message: c.commit.message,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
        trigger: this.parseTrigger(c.commit.message),
      }));
    } catch {
      return [];
    }
  }

  async readBlobAt(rootId: string, commit: string, relativePath: string): Promise<string | undefined> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return undefined;
    try {
      const { blob } = await git.readBlob({ fs, dir, oid: commit, filepath: relativePath });
      return Buffer.from(blob).toString('utf-8');
    } catch {
      return undefined; // Path did not exist at that commit
    }
  }

  async listCommitsForPath(rootId: string, relativePath: string, limit = 50): Promise<Commit[]> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) return [];
    try {
      // git.log({ filepath }) follows only commits that changed this path,
      // giving the per-document version timeline (newest first). isomorphic-git
      // applies `depth` to the DAG walk rather than the path-filtered result, so
      // walk the path history and slice to the most recent `limit` ourselves.
      const commits = await git.log({ fs, dir, filepath: relativePath });
      return commits.slice(0, limit).map((c) => ({
        hash: c.oid,
        message: c.commit.message,
        timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
        trigger: this.parseTrigger(c.commit.message),
      }));
    } catch {
      return [];
    }
  }

  private parseTrigger(message: string): SyncTrigger {
    if (message.includes('[trigger=manual]')) return 'manual';
    if (message.includes('[trigger=event]')) return 'event';
    if (message.includes('[trigger=poll]')) return 'poll';
    if (message.includes('[trigger=watch]')) return 'watch';
    return 'manual';
  }
}
