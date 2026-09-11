import { posix } from "node:path";

/**
 * File-name safety and the local ⟷ remote identity mapping.
 *
 * Identity contract (see sync.ts): a pair is bound by `relativePath` ⟷
 * `remoteToken`, so the remote title must be a *deterministic function* of the
 * file name — otherwise the mapping is not reversible and a re-scan can never
 * find its own document again. Both directions below are idempotent:
 *   filenameFromTitle(remoteTitle("a/b.md")) === "b.md"
 *   remoteTitle(filenameFromTitle("b")) === "b"
 *
 * Everything that can make two "identical-looking" names differ (Unicode
 * normalisation, illegal characters, reserved names, over-long segments) is
 * resolved here once, so the sync engine compares and stores only normalised
 * keys.
 */

/** Characters a file system (or the drive listing) rejects or treats specially. */
const ILLEGAL_CHARACTERS = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;
/** Windows refuses to create these even with an extension (CON.md, LPT1.md…). */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** Runs of separators collapse so `a  b`, `a__b` and `a/\b` all agree. */
const REPEATED_SEPARATORS = /(?:[ _]){2,}/g;
/** A single segment is capped by bytes, not code units: CJK names are 3× UTF-8. */
const MAX_SEGMENT_BYTES = 200;
/** Whole-path ceiling; beyond this a drive listing may silently truncate. */
export const MAX_PATH_BYTES = 1000;
export const UNTITLED = "Untitled";

/** Unicode-normalise a whole relative path so NFC/NFD spellings share one key. */
export function normalizeKey(relativePath: string): string {
  return relativePath.normalize("NFC");
}

/** UTF-8 byte length, the limit file systems actually enforce. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Trim a string to at most `limit` UTF-8 bytes without splitting a character. */
function clipBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > limit) break;
    result += character;
    used += size;
  }
  return result;
}

/** Keep `name.ext` under `limit` bytes by clipping the base, never the suffix. */
function clipPreservingExtension(name: string, limit: number): string {
  if (byteLength(name) <= limit) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const budget = Math.max(1, limit - byteLength(extension));
  return `${clipBytes(name.slice(0, name.length - extension.length), budget)}${extension}`;
}

/**
 * Clean one path segment into something that is a legal, stable file name.
 * Deterministic and idempotent: `sanitizeSegment(sanitizeSegment(x))` equals
 * `sanitizeSegment(x)`.
 */
export function sanitizeSegment(name: string): string {
  const normalized = (name ?? "").normalize("NFC")
    .replace(ILLEGAL_CHARACTERS, "_")
    // Leading/trailing dots and spaces are invisible traps on Windows and macOS.
    // Strip them *before* collapsing separator runs, or `name.  ` would survive
    // as the literal `name._` and a whitespace-only name as a bare `_`.
    .replace(/^[ .]+/, "")
    .replace(/[ .]+$/, "")
    .replace(REPEATED_SEPARATORS, "_")
    .trim();
  if (!normalized) return UNTITLED;
  const guarded = RESERVED_NAMES.test(stripExtension(normalized)) ? `_${normalized}` : normalized;
  return clipPreservingExtension(guarded, MAX_SEGMENT_BYTES);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Deterministic de-duplication suffix so two titles colliding after cleaning
 *  still land on distinct, reproducible file names. */
export function tokenSuffix(token: string): string {
  const alphanumeric = token.replace(/[^A-Za-z0-9]/g, "");
  return (alphanumeric || token).slice(0, 6).toLowerCase() || "000000";
}

/** `name` + `-<token prefix>` when a sibling already claims the clean name. */
export function dedupeSegment(name: string, token: string): string {
  return `${stripExtension(name) || UNTITLED}-${tokenSuffix(token)}${dotExtension(name)}`;
}

function dotExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** Drive title for a local document: file name without `.md`, NFC-normalised. */
export function remoteTitle(relativePath: string): string {
  const base = posix.basename(normalizeKey(relativePath)).replace(/\.md$/i, "");
  return sanitizeSegment(base);
}

/** Local file name for a drive title; the inverse of {@link remoteTitle}. */
export function filenameFromTitle(title: string): string {
  const cleaned = sanitizeSegment(title);
  return /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
}

/** Sanitise every segment of a remote-derived relative path.
 *  Returns undefined when the path is absolute, escapes the root (`..`) or
 *  cannot be represented under the length ceiling — callers skip those with a
 *  warning instead of letting one hostile listing abort a whole scan. */
export function safeRelativePath(segments: readonly string[], extension: "md" | "none" = "none"): string | undefined {
  const cleaned: string[] = [];
  for (const segment of segments) {
    const value = (segment ?? "").normalize("NFC").trim();
    if (!value || value === "." || value === "..") return undefined;
    const safe = sanitizeSegment(value);
    if (safe === UNTITLED && !value.trim()) return undefined;
    cleaned.push(safe);
  }
  if (cleaned.length === 0) return undefined;
  if (extension === "md") {
    const last = cleaned[cleaned.length - 1]!;
    if (!/\.md$/i.test(last)) cleaned[cleaned.length - 1] = `${last}.md`;
  }
  const path = posix.normalize(posix.join(...cleaned));
  if (!path || path === "." || path.startsWith("../") || path.startsWith("/") || path.startsWith("\\")) return undefined;
  return byteLength(path) <= MAX_PATH_BYTES ? path : undefined;
}

/** Reject anything an untrusted client could use to walk out of a root. */
export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false;
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) return false;
  return !relativePath.split("/").some((segment) => segment === "..");
}
