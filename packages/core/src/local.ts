import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { matchesAnyGlob } from "./glob.js";
import type { LocalFile, LocalProvider, SyncRoot } from "./types.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export class FilesystemProvider implements LocalProvider {
  async scan(root: SyncRoot): Promise<LocalFile[]> {
    const files: LocalFile[] = [];
    await this.walk(resolve(root.localPath), resolve(root.localPath), files, root.exclude ?? []);
    return files;
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
