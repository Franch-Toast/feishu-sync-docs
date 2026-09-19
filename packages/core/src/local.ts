import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { matchesAnyGlob } from "./glob.js";
import { stripEnvelope } from "./frontmatter.js";
import type { LocalFile, LocalProvider, SyncRoot } from "./types.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export class FilesystemProvider implements LocalProvider {
  async scan(root: SyncRoot): Promise<LocalFile[]> {
    const files: LocalFile[] = [];
    await this.walk(resolve(root.localPath), resolve(root.localPath), files, root.exclude ?? []);
    return files;
  }

  /** Incremental counterpart of scan(): stat+hash only the requested paths.
   *  A directory path is walked with the same filters as scan(); paths that
   *  vanished between the event and this call are skipped so the binding loops
   *  reclassify them as local-missing, while anything that escapes the root
   *  still throws so the sync engine can fall back to a full scan. */
  async scanEntries(root: SyncRoot, relativePaths: readonly string[]): Promise<LocalFile[]> {
    const files: LocalFile[] = [];
    for (const rawPath of new Set(relativePaths)) {
      await this.visitEntry(root, rawPath.replaceAll("\\", "/"), files);
    }
    return files;
  }

  /** Recursive helper for scanEntries(): filters mirror walk() exactly (hidden
   *  segments, node_modules, exclude globs, markdown/image extensions) and a
   *  missing path is tolerated instead of failing the batch. */
  private async visitEntry(root: SyncRoot, relativePath: string, files: LocalFile[]): Promise<void> {
    // Hidden segments and node_modules are skipped exactly like walk(); `..`
    // deliberately falls through to safePath() so an escaping path throws
    // instead of being silently ignored.
    if (relativePath.split("/").some((segment) => (segment.startsWith(".") && segment !== "..") || segment === "node_modules")) return;
    const absolutePath = this.safePath(root, relativePath);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(absolutePath);
    } catch {
      return; // vanished after the event fired; deletion flows through the binding loop
    }
    if (metadata.isDirectory()) {
      if (matchesAnyGlob(relativePath, root.exclude ?? [])) return;
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await this.visitEntry(root, `${relativePath}/${entry.name}`, files);
      }
      return;
    }
    if (!metadata.isFile()) return;
    if (matchesAnyGlob(relativePath, root.exclude ?? [])) return;
    const extension = extname(relativePath).toLowerCase();
    if (extension !== ".md" && !imageExtensions.has(extension)) return;
    const data = await readFile(absolutePath);
    files.push(this.toLocalFile(relativePath, absolutePath, extension, metadata.size, metadata.mtimeMs, data));
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
        output.push(this.toLocalFile(relativePath, absolutePath, extension, metadata.size, metadata.mtimeMs, data));
      }
    }
  }

  /** One LocalFile projection shared by scan() and scanEntries(): markdown
   *  documents hash their *body* (the identity envelope is invisible to the
   *  sync pipeline, so stamping never looks like a user edit), while `rawHash`
   *  keeps the whole-file digest for change detection that must see the exact
   *  bytes. Assets keep the raw byte hash. Files without an envelope hash
   *  exactly as before: `body === raw`, so `sha256(body) === sha256(raw)`. */
  private toLocalFile(relativePath: string, absolutePath: string, extension: string, size: number, mtimeMs: number, data: Buffer): LocalFile {
    if (extension === ".md") {
      const text = data.toString("utf8");
      return {
        relativePath,
        absolutePath,
        kind: "document",
        size,
        mtimeMs,
        contentHash: sha256(stripEnvelope(text)),
        rawHash: sha256(data)
      };
    }
    return {
      relativePath,
      absolutePath,
      kind: "asset",
      size,
      mtimeMs,
      contentHash: sha256(data)
    };
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
