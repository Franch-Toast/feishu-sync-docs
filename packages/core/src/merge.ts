import { parseMarkdown, joinBlocks } from "./markdown.js";
import { sha256 } from "./hash.js";
import type { CanonicalBlock, DocumentPatchOperation, SyncDecision } from "./types.js";

function equalBlocks(left: CanonicalBlock[], right: CanonicalBlock[]): boolean {
  return left.length === right.length && left.every((block, index) => block.contentHash === right[index]?.contentHash && block.kind === right[index]?.kind);
}

function mergeBlocks(base: CanonicalBlock[], local: CanonicalBlock[], remote: CanonicalBlock[]): { content?: string; conflict: boolean } {
  if (equalBlocks(local, remote)) return { content: joinBlocks(local), conflict: false };
  if (equalBlocks(local, base)) return { content: joinBlocks(remote), conflict: false };
  if (equalBlocks(remote, base)) return { content: joinBlocks(local), conflict: false };

  const max = Math.max(base.length, local.length, remote.length);
  const output: CanonicalBlock[] = [];
  for (let index = 0; index < max; index += 1) {
    const b = base[index];
    const l = local[index];
    const r = remote[index];
    const localChanged = !sameBlock(b, l);
    const remoteChanged = !sameBlock(b, r);
    if (localChanged && remoteChanged) {
      if (sameBlock(l, r)) {
        if (l) output.push(l);
      } else {
        const merged = l && r && b ? mergeText(b.content, l.content, r.content) : undefined;
        if (merged === undefined) return { conflict: true };
        output.push({
          stableId: `${l?.stableId ?? r?.stableId ?? b?.stableId}:merged`,
          kind: l?.kind ?? r?.kind ?? b?.kind ?? "paragraph",
          content: merged,
          contentHash: sha256(merged),
          position: output.length
        });
      }
    } else if (localChanged) {
      if (l) output.push(l);
    } else if (remoteChanged) {
      if (r) output.push(r);
    } else if (b) {
      output.push(b);
    }
  }
  return { content: joinBlocks(output), conflict: false };
}

function sameBlock(left: CanonicalBlock | undefined, right: CanonicalBlock | undefined): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.contentHash === right.contentHash;
}

export function decideSync(base: string, local: string, remote: string): SyncDecision {
  if (local === remote) return { action: "noop", reason: "local and remote are equal" };
  if (local === base) return { action: "pull", reason: "only remote changed" };
  if (remote === base) return { action: "push", reason: "only local changed" };
  const merged = mergeBlocks(parseMarkdown(base).blocks, parseMarkdown(local).blocks, parseMarkdown(remote).blocks);
  if (merged.conflict || merged.content === undefined) return { action: "conflict", reason: "both sides changed the same Markdown block" };
  return { action: "merge", reason: "both sides changed independent Markdown blocks", mergedContent: merged.content };
}

export function buildBlockPatch(base: string, next: string, remoteBlocks: Array<{ id: string; kind: string; contentHash: string }>, rootBlockId?: string): {
  operations: DocumentPatchOperation[];
  safe: boolean;
} {
  const previous = parseMarkdown(base).blocks;
  const current = parseMarkdown(next).blocks;
  if (previous.length !== remoteBlocks.length) return { operations: [{ type: "overwrite", content: next }], safe: false };
  if (previous.some((block, index) => block.kind !== remoteBlocks[index]?.kind)) return { operations: [{ type: "overwrite", content: next }], safe: false };
  if (previous.length !== current.length) return buildSimpleStructuralPatch(previous, current, remoteBlocks, next, rootBlockId);
  const operations: DocumentPatchOperation[] = [];
  const max = Math.max(previous.length, current.length);
  for (let index = 0; index < max; index += 1) {
    const before = previous[index];
    const after = current[index];
    const remote = remoteBlocks[index];
    if (!after && remote) operations.push({ type: "delete", blockId: remote.id });
    else if (after && !before) operations.push({ type: "insertAfter", blockId: remoteBlocks[index - 1]?.id ?? "-1", content: after.content });
    else if (after && before && after.contentHash !== before.contentHash && remote) operations.push({ type: "replace", blockId: remote.id, content: after.content });
  }
  return { operations, safe: true };
}

function buildSimpleStructuralPatch(
  previous: CanonicalBlock[],
  current: CanonicalBlock[],
  remoteBlocks: Array<{ id: string; kind: string; contentHash: string }>,
  fallback: string,
  rootBlockId?: string
): { operations: DocumentPatchOperation[]; safe: boolean } {
  const operations: DocumentPatchOperation[] = [];
  if (current.length === previous.length + 1) {
    const insertion = findSingleInsertion(previous, current);
    if (insertion !== undefined) {
      const blockId = insertion === 0 ? rootBlockId : remoteBlocks[insertion - 1]?.id;
      if (!blockId) return { operations: [{ type: "overwrite", content: fallback }], safe: false };
      operations.push({ type: "insertAfter", blockId, content: current[insertion]!.content });
      return { operations, safe: true };
    }
  }
  if (current.length === previous.length - 1) {
    const deletion = findSingleDeletion(previous, current);
    if (deletion !== undefined) {
      return { operations: [{ type: "delete", blockId: remoteBlocks[deletion]!.id }], safe: true };
    }
  }
  return { operations: [{ type: "overwrite", content: fallback }], safe: false };
}

function findSingleInsertion(previous: CanonicalBlock[], current: CanonicalBlock[]): number | undefined {
  for (let index = 0; index < current.length; index += 1) {
    if (sameBlock(previous[index], current[index])) continue;
    if (previous.slice(index).every((block, offset) => sameBlock(block, current[index + offset + 1]))) return index;
  }
  return undefined;
}

function findSingleDeletion(previous: CanonicalBlock[], current: CanonicalBlock[]): number | undefined {
  for (let index = 0; index < previous.length; index += 1) {
    if (sameBlock(previous[index], current[index])) continue;
    if (previous[index + 1] && current.slice(index).every((block, offset) => sameBlock(previous[index + offset + 1], block))) return index;
  }
  return undefined;
}

function mergeText(base: string, local: string, remote: string): string | undefined {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  const localChange = changedRange(base, local);
  const remoteChange = changedRange(base, remote);
  if (!localChange || !remoteChange) return undefined;
  if (localChange.end <= remoteChange.start) return applyTwoChanges(base, localChange, remoteChange);
  if (remoteChange.end <= localChange.start) return applyTwoChanges(base, remoteChange, localChange);
  return undefined;
}

interface TextChange { start: number; end: number; replacement: string[]; }

function changedRange(base: string, next: string): TextChange | undefined {
  const before = base.split("\n");
  const after = next.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let baseEnd = before.length;
  let nextEnd = after.length;
  while (baseEnd > start && nextEnd > start && before[baseEnd - 1] === after[nextEnd - 1]) {
    baseEnd -= 1;
    nextEnd -= 1;
  }
  return start === baseEnd && start === nextEnd ? undefined : { start, end: baseEnd, replacement: after.slice(start, nextEnd) };
}

function applyTwoChanges(base: string, first: TextChange, second: TextChange): string {
  const lines = base.split("\n");
  return [...lines.slice(0, first.start), ...first.replacement, ...lines.slice(first.end, second.start), ...second.replacement, ...lines.slice(second.end)].join("\n");
}
