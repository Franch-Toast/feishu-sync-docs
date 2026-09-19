import { stripEnvelope } from "@feishu-sync/core";
import type { LocalProvider, SyncRoot } from "@feishu-sync/core";

/** Read a local document through the sync engine's own eyes: the file as it
 *  sits on disk carries the local-only identity envelope, while everything
 *  the pipeline hashes, merges and pushes is the body. Tests that assert on
 *  synced content compare bodies — asserting on raw bytes here would only
 *  re-test the envelope format (frontmatter.test.ts owns that). */
export async function readBody(provider: LocalProvider, root: SyncRoot, relativePath: string): Promise<string> {
  return stripEnvelope(await provider.readText(root, relativePath));
}
