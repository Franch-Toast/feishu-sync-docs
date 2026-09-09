import git from 'isomorphic-git';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  Change, Commit, GitStorage, SyncRoot, SyncTrigger
} from '@feishu-sync/core';

const GIT_AUTHOR = { name: 'Feishu Sync', email: 'sync@feishu.local' };
const GITIGNORE_CONTENT = '.feishu-sync/\n';

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

    // Check if already a git repo
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) {
      return;
    }

    // Initialize git repo
    await git.init({ fs, dir, defaultBranch: 'main' });

    // Create .gitignore to exclude .feishu-sync directory
    const gitignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      await fsp.writeFile(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    }

    // Initial commit
    await git.add({ fs, dir, filepath: '.gitignore' });
    await git.commit({
      fs,
      dir,
      message: 'init: feishu-sync repository',
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
      return undefined;
    }
  }

  async commitBaseline(rootId: string, message: string, trigger: SyncTrigger, onlyPaths?: ReadonlySet<string>): Promise<string> {
    const dir = this.rootPaths.get(rootId);
    if (!dir) throw new Error(`Root not found: ${rootId}`);

    // Get status matrix to find changes
    const matrix = await git.statusMatrix({ fs, dir });

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
      if (workdir === 0) {
        // File deleted from the working tree
        if (head !== 0) await git.remove({ fs, dir, filepath });
      } else {
        // File added or modified
        await git.add({ fs, dir, filepath });
      }
    }

    // Check if there are any staged changes
    const stagedMatrix = await git.statusMatrix({ fs, dir });
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

  private parseTrigger(message: string): SyncTrigger {
    if (message.includes('[trigger=manual]')) return 'manual';
    if (message.includes('[trigger=event]')) return 'event';
    if (message.includes('[trigger=poll]')) return 'poll';
    if (message.includes('[trigger=watch]')) return 'watch';
    return 'manual';
  }
}
