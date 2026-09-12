/**
 * File-name normalization helpers shared by the sync engine.
 *
 * Two distinct concerns live here:
 * - `sanitizeLocalSegment` turns a remote drive title into a name that is safe
 *   to write to every supported local filesystem (Windows reserves `\/:*?"<>|`
 *   and device names, macOS hides leading dots, and titles may carry HTML
 *   entities or exceed filesystem byte limits).
 * - `normalizeForMatch` makes two names that *look* identical compare equal:
 *   Unicode composed/decomposed forms (NFD on macOS, NFC elsewhere) and stray
 *   whitespace otherwise break title-based pairing between local files and
 *   remote documents.
 */

/** Windows reserves these base names regardless of extension (case-insensitive). */
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);

/** File-name segments must stay well below common byte limits (255); the
 *  margin leaves room for callers to append an extension. */
const MAX_SEGMENT_BYTES = 240;

const entityDecoder = new TextDecoder("utf8", { fatal: false });
const entityEncoder = new TextEncoder();

/** Common HTML entities a drive title may carry after a round-trip through
 *  rich text; anything else is left untouched rather than guessed at. */
function decodeCommonEntities(value: string): string {
  if (!value.includes("&")) return value;
  const escapes: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (match, entity: string) => escapes[entity] ?? match);
}

/** Turn a remote title into a local file-name segment that is safe on
 *  Windows/macOS/Linux: NFC-normalized, entity-decoded, reserved characters
 *  replaced with `-`, byte-capped and stripped of illegal leading/trailing
 *  characters. Never returns an empty string. */
export function sanitizeLocalSegment(name: string): string {
  let result = decodeCommonEntities(name.normalize("NFC"));
  // Characters rejected by Windows (and dangerous in paths) become a dash;
  // control characters have no place in a file name at all.
  result = result.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-");
  // Byte-safe truncation: subarray may split a code point, so re-decode and
  // drop any replacement characters that leaves dangling.
  if (entityEncoder.encode(result).length > MAX_SEGMENT_BYTES) {
    result = entityDecoder
      .decode(entityEncoder.encode(result).subarray(0, MAX_SEGMENT_BYTES))
      .replaceAll("\uFFFD", "");
  }
  // Trailing dots/spaces are illegal on Windows; leading dots hide the file
  // on macOS/Linux and `.`/`..` are path segments, never file names.
  result = result.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  // Windows device names (CON, NUL, COM1…) must not become file names either.
  const base = result.split(".", 1)[0] ?? "";
  if (WINDOWS_RESERVED.has(base.toUpperCase())) result = `_${result}`;
  return result || "Untitled";
}

/** Canonical form for comparing a local file name with a remote node name:
 *  Unicode NFC so composed/decomposed sequences compare equal, trimmed so
 *  stray whitespace on either side does not break the pairing. */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFC").trim();
}
