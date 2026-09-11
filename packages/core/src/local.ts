import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { matchesAnyGlob } from "./glob.js";
import type { LocalFile, LocalProvider, LocalScanOptions, SyncRoot } from "./types.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export class FilesystemProvider implements LocalProvider {
  async scan(root: SyncRoot, options?: LocalScanOptions): Promise<LocalFile[]> {
    // E1: `onlyPaths` turns a whole-tree walk into a per-file stat+read. Missing
    // paths are simply absent from the result; the caller decides whether that
    // means `local-missing`.
    if (options?.onlyPaths) {
      const files: LocalFile[] = [];
      for (const relativePath of new Set(options.onlyPaths)) {
        const file = await this.statOne(root, relativePath);
        if (file) files.push(file);
      }
      return files;
    }
    const files: LocalFile[] = [];
    await this.walk(resolve(root.localPath), resolve(root.localPath), files, root.exclude ?? []);
    return files;
  }

  /** Describe a single path, or undefined when it is gone, not a file, or a
   *  type the sync does not track. Never throws for a missing file. */
  private async statOne(root: SyncRoot, relativePath: string): Promise<LocalFile | undefined> {
    let absolutePath: string;
    let metadata;
    try {
      absolutePath = this.safePath(root, relativePath);
      metadata = await stat(absolutePath);
    } catch {
      return undefined;
    }
    if (!metadata.isFile()) return undefined;
    const extension = extname(relativePath).toLowerCase();
    if (extension !== ".md" && !imageExtensions.has(extension)) return undefined;
    const data = await readFile(absolutePath);
    return {
      relativePath,
      absolutePath,
      kind: extension === ".md" ? "document" : "asset",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      contentHash: sha256(data)
    };
  }

  async readText(root: SyncRoot, relativePath: string): Promise<string> {
    return readFile(this.safePath(root, relativePath), "utf8");
  }

  async writeText(root: SyncRoot, relativePath: string, content: string): Promise<void> {
    await this.atomicWrite(this.safePath(root, relativePath), Buffer.from(content, "utf8"));
  }

  async readBinary(root: SyncRoot, relativePath: string): Promise<Uint8Array> {
    return readFile(this.safePath(root, relativePath));
  }

  async writeBinary(root: SyncRoot, relativePath: string, content: Uint8Array): Promise<void> {
    await this.atomicWrite(this.safePath(root, relativePath), content);
  }

  async delete(root: SyncRoot, relativePath: string): Promise<void> {
    await rm(this.safePath(root, relativePath), { force: true });
  }

  private async walk(base: string, directory: string, output: LocalFile[], exclude: readonly string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(base, absolutePath).replaceAll("\\", "/");
      // B6.5: prune user-excluded globs. Directories are skipped wholesale so
      // an excluded subtree is never descended into, hashed, or synced.
      if (matchesAnyGlob(relativePath, exclude)) continue;
      if (entry.isDirectory()) await this.walk(base, absolutePath, output, exclude);
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (extension !== ".md" && !imageExtensions.has(extension)) continue;
        const data = await readFile(absolutePath);
        const metadata = await stat(absolutePath);
        output.push({
          relativePath,
          absolutePath,
          kind: extension === ".md" ? "document" : "asset",
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          contentHash: sha256(data)
        });
      }
    }
  }

  private safePath(root: SyncRoot, relativePath: string): string {
    const base = resolve(root.localPath);
    const target = resolve(base, relativePath);
    if (target !== base && !target.startsWith(`${base}/`)) throw new Error(`Path escapes sync root: ${relativePath}`);
    return target;
  }

  private async atomicWrite(path: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.feishu-sync-${process.pid}-${Date.now()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
