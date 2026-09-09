import { diffLines, diffWords } from "diff";

export type RowKind = "same" | "add" | "del";

export interface WordSpan {
  kind: RowKind;
  text: string;
}

/** One visual row of a split diff between base and target text. */
export interface DiffRow {
  kind: RowKind;
  text: string;
  /** 1-based line number in the base text. */
  oldNumber?: number;
  /** 1-based line number in the target text. */
  newNumber?: number;
  /** Word-level detail for paired modified rows. */
  words?: WordSpan[];
}

/** A change relative to the base line coordinate system (0-based, splice-ready). */
export interface Hunk {
  baseStart: number;
  baseCount: number;
  lines: string[];
  side: "local" | "remote";
}

function splitLinesKeepEmpty(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\n$/, "").split("\n");
}

/** jsdiff treats a missing trailing newline as a different token, which would
 *  split unrelated lines apart; normalize both inputs before diffing. */
function ensureNewline(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

function countLines(value: string): number {
  if (value === "") return 0;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value[index] === "\n") count += 1;
  return value.endsWith("\n") ? count : count + 1;
}

function wordSpans(oldLine: string, newLine: string): WordSpan[] {
  return diffWords(oldLine, newLine).map((part) => ({
    kind: part.added ? "add" : part.removed ? "del" : "same",
    text: part.value
  }));
}

/** Aligned rows for a side-by-side (split) view of base → target.
 *  Paired removed/added line blocks are zip-aligned and get word-level spans:
 *  removed rows keep only del/same spans, added rows only add/same spans. */
export function lineDiff(base: string, target: string): DiffRow[] {
  const changes = diffLines(ensureNewline(base), ensureNewline(target));
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (change.added) {
      for (const line of splitLinesKeepEmpty(change.value)) rows.push({ kind: "add", text: line, newNumber: newNo++ });
      continue;
    }
    if (change.removed) {
      const next = changes[index + 1];
      const removed = splitLinesKeepEmpty(change.value);
      if (next?.added) {
        const added = splitLinesKeepEmpty(next.value);
        const pairs = Math.max(removed.length, added.length);
        for (let pair = 0; pair < pairs; pair += 1) {
          const oldLine = removed[pair];
          const newLine = added[pair];
          const spans = oldLine !== undefined && newLine !== undefined ? wordSpans(oldLine, newLine) : undefined;
          if (oldLine !== undefined) rows.push({ kind: "del", text: oldLine, oldNumber: oldNo++, words: spans?.filter((span) => span.kind !== "add") });
          if (newLine !== undefined) rows.push({ kind: "add", text: newLine, newNumber: newNo++, words: spans?.filter((span) => span.kind !== "del") });
        }
        index += 1;
      } else {
        for (const line of removed) rows.push({ kind: "del", text: line, oldNumber: oldNo++ });
      }
      continue;
    }
    for (const line of splitLinesKeepEmpty(change.value)) rows.push({ kind: "same", text: line, oldNumber: oldNo++, newNumber: newNo++ });
  }
  return rows;
}

/** Compute the hunks that transform `base` into `target`, expressed against
 *  base line numbers so local/remote hunks share one coordinate system. */
export function computeHunks(base: string, target: string, side: "local" | "remote"): Hunk[] {
  const changes = diffLines(ensureNewline(base), ensureNewline(target));
  const hunks: Hunk[] = [];
  let baseLine = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (change.added) {
      hunks.push({ baseStart: baseLine, baseCount: 0, lines: splitLinesKeepEmpty(change.value), side });
      continue;
    }
    if (change.removed) {
      const next = changes[index + 1];
      const replaced = countLines(change.value);
      if (next?.added) {
        hunks.push({ baseStart: baseLine, baseCount: replaced, lines: splitLinesKeepEmpty(next.value), side });
        index += 1;
      } else {
        hunks.push({ baseStart: baseLine, baseCount: replaced, lines: [], side });
      }
      baseLine += replaced;
      continue;
    }
    baseLine += countLines(change.value);
  }
  return hunks;
}

/** Apply hunks against the base text. Hunks are applied bottom-up so the
 *  shared base coordinate system stays stable. */
export function applyHunks(base: string, hunks: Hunk[]): string {
  const sorted = [...hunks].sort((left, right) => right.baseStart - left.baseStart || right.baseCount - left.baseCount);
  const lines = base.split("\n");
  for (const hunk of sorted) {
    lines.splice(hunk.baseStart, hunk.baseCount, ...hunk.lines);
  }
  return lines.join("\n");
}

/** True when two hunks touch the same region of the base text. */
export function hunksOverlap(left: Hunk, right: Hunk): boolean {
  const leftEnd = left.baseStart + Math.max(left.baseCount, 1);
  const rightEnd = right.baseStart + Math.max(right.baseCount, 1);
  return left.baseStart < rightEnd && right.baseStart < leftEnd;
}

/** Hunks from `side` that clash with hunks of the other side. */
export function clashingHunkIndices(hunks: Hunk[]): Set<number> {
  const clashes = new Set<number>();
  for (let i = 0; i < hunks.length; i += 1) {
    for (let j = i + 1; j < hunks.length; j += 1) {
      if (hunks[i]!.side !== hunks[j]!.side && hunksOverlap(hunks[i]!, hunks[j]!)) {
        clashes.add(i);
        clashes.add(j);
      }
    }
  }
  return clashes;
}
