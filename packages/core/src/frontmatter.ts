import { sha256 } from "./hash.js";

/**
 * The local-only "envelope" that carries a document's remote identity.
 *
 * Feishu mints a `document_id` (token) when a document is created, and that
 * token never changes across renames or folder moves. Storing it in a YAML
 * frontmatter block makes a document self-identifying: it survives a local
 * rename or move, and it survives the whole `.feishu-sync` metadata directory
 * being deleted, which turns binding recovery from heuristic guessing into an
 * exact token lookup (see `identity.ts`).
 *
 * Two rules make this safe to combine with a content-addressed sync engine:
 *
 * 1. Only immutable identity lives in the envelope. Revision ids, content
 *    hashes and sync status stay in `bindings.json` — writing per-round mutable
 *    state into the file would dirty it on every sync and produce permanent
 *    false "local changed" detections.
 * 2. The envelope is invisible to the sync pipeline: hashing, three-way merge,
 *    remote rendering and block mapping all operate on `body`. `stripEnvelope`
 *    and `writeSyncDocument` are exact inverses, which is what keeps
 *    "stamp the file after creating the remote document" from looking like a
 *    user edit and re-triggering a push.
 *
 * Deliberately a pure string module with no dependencies: `core` must stay
 * dependency-free, and re-serializing the block through a YAML parser would
 * reorder keys, drop comments and reformat values in the user's own metadata.
 */

/** Key holding the remote document token — the authoritative document identity. */
export const FRONTMATTER_TOKEN_KEY = "feishu_token";
/** Key holding the sync root the token belongs to; guards against a file being
 *  copied into a different root and hijacking another account's document. */
export const FRONTMATTER_ROOT_KEY = "feishu_root";

const DELIMITER = "---";
/** Values matching this stay unquoted; anything else is JSON-quoted so the line
 *  stays a valid YAML scalar. */
const BARE_VALUE = /^[A-Za-z0-9_-]+$/;

export interface SplitDocument {
  /** Inner lines of the envelope block (without the `---` delimiters), or null
   *  when the file has no usable envelope. */
  meta: string | null;
  /** Everything after the envelope. Equals `raw` when there is no envelope, so
   *  unstamped files keep hashing exactly as they did before stamping. */
  body: string;
  /** A `---` opened the file but was never closed. The body is then the whole
   *  file and the file must not be rewritten: swallowing the rest of the
   *  document into "metadata" would destroy content. */
  malformed: boolean;
  token?: string;
  rootId?: string;
}

export interface SyncDocument {
  relativePath: string;
  /** The syncable content: hashing, merging and remote writes use this only. */
  body: string;
  /** `sha256(body)` — the counterpart of `sha256(canonicalRemote)`. */
  bodyHash: string;
  raw: string;
  token?: string;
  rootId?: string;
  malformed: boolean;
}

export interface StampResult {
  text: string;
  /** False when the file already carried the requested identity, so callers can
   *  avoid a pointless write (and avoid firing the file watcher). */
  changed: boolean;
  /** Set when the stamp was refused (malformed envelope). */
  warning?: string;
}

/** Split on newlines without losing a trailing newline: `"a\n"` yields
 *  `["a", ""]`, so `lines.join(eol)` reproduces the input exactly. */
function toLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).replace(/\\(["'])/g, "$1");
  }
  return trimmed;
}

function renderValue(value: string): string {
  return BARE_VALUE.test(value) ? value : JSON.stringify(value);
}

/** Match only an unindented `key:` line so a nested mapping that happens to use
 *  the same key inside the block is never mistaken for ours. */
function keyLine(key: string): RegExp {
  return new RegExp(`^${key}:[ \\t]*(.*)$`);
}

function readKey(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const match = keyLine(key).exec(line);
    if (match?.[1] !== undefined) {
      const value = unquote(match[1]);
      if (value) return value;
    }
  }
  return undefined;
}

/** Replace the key's line in place, or append it when absent. Every other line
 *  (comments, quoting style, key order) is left byte-for-byte untouched. */
function setKey(lines: string[], key: string, value: string): void {
  const rendered = `${key}: ${renderValue(value)}`;
  const index = lines.findIndex((line) => keyLine(key).test(line));
  if (index === -1) lines.push(rendered);
  else if (lines[index] !== rendered) lines[index] = rendered;
}

/** Separate the envelope from the body. The block owns the newline that follows
 *  its closing `---`, which makes this function and `writeSyncDocument` exact
 *  inverses for any body that does not itself open with a block:
 *  `stripEnvelope(writeSyncDocument(body, id).text) === body`.
 *
 *  A body never carries a leading byte-order mark (it is treated as part of the
 *  envelope region), so stamping a BOM'd file cannot shift its hash.
 *
 *  When the file already opens with a `---` block it is taken as the user's own
 *  frontmatter and the identity is merged into it rather than stacked on top.
 *  A remote body that genuinely starts with such a block is therefore read back
 *  as metadata; our own delimiter is always the first one found, so a body that
 *  merely *contains* a block round-trips correctly. */
export function splitDocument(raw: string): SplitDocument {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = toLines(text);
  if (lines[0] !== DELIMITER) return { meta: null, body: text, malformed: false };
  const close = lines.indexOf(DELIMITER, 1);
  // An unterminated block is never treated as an envelope: the whole file stays
  // the body, so a stray `---` can not delete the user's content.
  if (close === -1) return { meta: null, body: text, malformed: true };
  const metaLines = lines.slice(1, close);
  const eol = detectEol(text);
  const body = lines.slice(close + 1).join(eol);
  const document: SplitDocument = { meta: metaLines.join(eol), body, malformed: false };
  const token = readKey(metaLines, FRONTMATTER_TOKEN_KEY);
  const rootId = readKey(metaLines, FRONTMATTER_ROOT_KEY);
  if (token) document.token = token;
  if (rootId) document.rootId = rootId;
  return document;
}

/** The body alone, ready for hashing. An unstamped document is returned with
 *  only a byte-order mark removed, so its hash is identical whether or not the
 *  file carries an identity envelope. */
export function stripEnvelope(raw: string): string {
  return splitDocument(raw).body;
}

/** Parse a local file into the shape the engine syncs on. */
export function readSyncDocument(raw: string, relativePath: string): SyncDocument {
  const split = splitDocument(raw);
  const document: SyncDocument = {
    relativePath,
    body: split.body,
    bodyHash: sha256(split.body),
    raw,
    malformed: split.malformed
  };
  if (split.token) document.token = split.token;
  if (split.rootId) document.rootId = split.rootId;
  return document;
}

/** Write `token`/`rootId` into the file's envelope, preserving the body and any
 *  other frontmatter. Idempotent, and a no-op (with a warning) on a malformed
 *  block rather than risking content loss. */
export function writeSyncDocument(raw: string, id: { token: string; rootId?: string }): StampResult {
  const split = splitDocument(raw);
  if (split.malformed) {
    return { text: raw, changed: false, warning: "frontmatter block is not terminated; identity stamp skipped to avoid swallowing content" };
  }
  const eol = detectEol(raw);
  const bom = raw.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const metaLines = split.meta === null ? [] : toLines(split.meta);
  setKey(metaLines, FRONTMATTER_TOKEN_KEY, id.token);
  if (id.rootId !== undefined) setKey(metaLines, FRONTMATTER_ROOT_KEY, id.rootId);
  const block = [DELIMITER, ...metaLines, DELIMITER].join(eol);
  const text = `${bom}${block}${eol}${split.body}`;
  return { text, changed: text !== raw };
}

/** Build a document file from a remote body plus its identity. Used by the
 *  import path, where there is no pre-existing local file to merge into. */
export function composeSyncDocument(body: string, id: { token: string; rootId?: string }): string {
  return writeSyncDocument(body, id).text;
}

/** Swap a file's body while keeping its existing envelope (and every other
 *  frontmatter line) intact. Used by the pull path: the new content arrives
 *  from the remote side, but the local file owns the identity metadata. An
 *  unstamped or malformed file falls through to the plain body, which the
 *  caller then stamps with `writeSyncDocument`. */
export function withBody(raw: string, body: string): string {
  const split = splitDocument(raw);
  if (split.meta === null || split.malformed) return body;
  const eol = detectEol(raw);
  const bom = raw.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const block = [DELIMITER, ...toLines(split.meta), DELIMITER].join(eol);
  return `${bom}${block}${eol}${body}`;
}
