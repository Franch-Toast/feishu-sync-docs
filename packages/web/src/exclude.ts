/**
 * Glob exclude-list editing helpers (B6.5).
 *
 * The server stores `SyncRoot.exclude` as a string array; the UI edits it as
 * one free-form text field. These pure functions bridge the two so the
 * round-trip is testable without rendering anything.
 */

/** Separators accepted between patterns: newline, comma or semicolon. */
const SEPARATOR = /[\n,;]+/;

/**
 * Split a raw text field into glob patterns: trimmed, de-duplicated
 * (first occurrence wins) and with empty entries dropped.
 */
export function parseExcludePatterns(text: string): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(SEPARATOR)) {
    const pattern = part.trim();
    if (pattern === "" || seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

/** Render stored patterns back into the text field, one pattern per line. */
export function formatExcludePatterns(patterns?: string[]): string {
  return (patterns ?? []).join("\n");
}

/** Human summary used next to the field and in the detail-page disclosure. */
export function describeExcludePatterns(patterns?: string[]): string {
  const count = patterns?.length ?? 0;
  if (count === 0) return "未设置，同步目录下全部 Markdown 与图片";
  if (count === 1) return `1 条规则生效：${patterns![0]}`;
  return `${count} 条规则生效：${patterns!.slice(0, 3).join("、")}${count > 3 ? ` 等 ${count} 条` : ""}`;
}
