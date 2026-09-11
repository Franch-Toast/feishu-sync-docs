import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PATH_BYTES,
  UNTITLED,
  dedupeSegment,
  filenameFromTitle,
  isSafeRelativePath,
  normalizeKey,
  remoteTitle,
  safeRelativePath,
  sanitizeSegment,
  tokenSuffix
} from "../src/index.js";

/** B1/B5: the remote title must be a deterministic, reversible function of the
 *  file name, and every name that comes out of a drive listing must be a legal
 *  local file name. These cases pin both directions of that contract. */

test("remoteTitle is derived from the file name, never from the content", () => {
  assert.equal(remoteTitle("a/b.md"), "b");
  assert.equal(remoteTitle("a/b.MD"), "b", "the .md suffix match is case-insensitive");
  assert.equal(remoteTitle("notes"), "notes", "extension-less names survive untouched");
  assert.equal(remoteTitle("deep/path/to/架构.md"), "架构");
  // Two files with the same H1 therefore keep two distinct titles — the whole
  // point of B2, and what makes re-pairing after a re-scan unambiguous.
  assert.notEqual(remoteTitle("one.md"), remoteTitle("two.md"));
});

test("the local ⟷ remote name mapping is idempotent in both directions", () => {
  const paths = ["a/sub-01.md", "notes.md", "架构设计.md", "café.md", "x.md"];
  for (const relativePath of paths) {
    const title = remoteTitle(relativePath);
    const file = filenameFromTitle(title);
    assert.equal(file, remoteTitle(relativePath) + ".md");
    assert.equal(filenameFromTitle(file), file, "filenameFromTitle must be stable");
    assert.equal(remoteTitle(file), title, "remoteTitle must be stable across a round trip");
  }
  const titles = ["b", "架构", "my doc", "CON"];
  for (const title of titles) {
    const file = filenameFromTitle(title);
    assert.equal(remoteTitle(file), sanitizeSegment(title));
    assert.equal(filenameFromTitle(remoteTitle(file)), file);
  }
});

test("NFC and NFD spellings of one name collapse to a single key", () => {
  const nfc = "café.md";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "the two byte sequences really differ");
  assert.equal(remoteTitle(nfd), remoteTitle(nfc));
  assert.equal(filenameFromTitle(remoteTitle(nfd)), filenameFromTitle(remoteTitle(nfc)));
  assert.equal(normalizeKey(nfd), nfc);
  assert.equal(normalizeKey(nfc), nfc, "normalizeKey is idempotent");
});

test("illegal characters, invisible edges and repeated separators are cleaned", () => {
  assert.equal(sanitizeSegment('a/b:c*?"<>|x.md'), "a_b_c_x.md");
  assert.equal(sanitizeSegment("name\twith\x00nul"), "name_with_nul");
  assert.equal(sanitizeSegment(".hidden"), "hidden", "a leading dot is stripped, not kept");
  assert.equal(sanitizeSegment("name.  "), "name", "trailing dots and spaces are traps");
  assert.equal(sanitizeSegment("a  b"), "a_b", "runs of separators collapse");
  assert.equal(sanitizeSegment(UNTITLED), UNTITLED);
  for (const value of ["", "...", "a".repeat(1)]) {
    assert.equal(sanitizeSegment(sanitizeSegment(value)), sanitizeSegment(value), `idempotent for ${JSON.stringify(value)}`);
  }
  assert.equal(sanitizeSegment(""), UNTITLED);
  assert.equal(sanitizeSegment("   "), UNTITLED, "whitespace is invisible, so it is not a name");
  assert.equal(sanitizeSegment("..."), UNTITLED);
  assert.equal(sanitizeSegment("_a_"), "_a_", "underscores alone are a legitimate name");
});

test("Windows reserved names get a leading underscore, real words do not", () => {
  assert.equal(sanitizeSegment("CON.md"), "_CON.md");
  assert.equal(sanitizeSegment("com1"), "_com1");
  assert.equal(sanitizeSegment("lpt9.md"), "_lpt9.md");
  assert.equal(sanitizeSegment("config.md"), "config.md");
  assert.equal(sanitizeSegment("contoso.md"), "contoso.md");
  assert.equal(filenameFromTitle("CON"), "_CON.md");
});

test("over-long segments are clipped by UTF-8 bytes while the extension survives", () => {
  const ascii = sanitizeSegment(`${"x".repeat(300)}.md`);
  assert.ok(Buffer.byteLength(ascii) <= 200, `got ${Buffer.byteLength(ascii)} bytes`);
  assert.ok(ascii.endsWith(".md"));

  // CJK is 3 bytes per character, so a character-count limit would be wrong.
  const cjk = sanitizeSegment(`${"文".repeat(100)}.md`);
  assert.ok(Buffer.byteLength(cjk) <= 200, `got ${Buffer.byteLength(cjk)} bytes`);
  assert.ok(cjk.endsWith(".md"), "the extension is never clipped");
  assert.ok(!/\uFFFD/.test(cjk), "clipping must not split a multi-byte character");
  assert.equal(sanitizeSegment(cjk), cjk, "an already-short name is unchanged");
});

test("safeRelativePath rejects escaping or unrepresentable listings", () => {
  assert.equal(safeRelativePath(["..", "evil.md"]), undefined);
  assert.equal(safeRelativePath(["a", "..", "b.md"]), undefined);
  assert.equal(safeRelativePath(["a", "", "b.md"]), undefined);
  assert.equal(safeRelativePath([]), undefined);
  assert.equal(safeRelativePath(["."]), undefined);
  // A leading separator is neutralised inside the segment, so no absolute path
  // can ever come back from a remote listing.
  const absolutish = safeRelativePath(["/abs", "x"]);
  assert.ok(absolutish);
  assert.ok(!absolutish.startsWith("/"));
  assert.equal(safeRelativePath(["a", "b"], "md"), "a/b.md");
  assert.equal(safeRelativePath(["a", "b.md"], "md"), "a/b.md", "no double extension");
  assert.equal(safeRelativePath(["CON", "x"], "md"), "_CON/x.md");
  assert.equal(safeRelativePath(["  ", "x"]), undefined, "a blank folder name is refused, not renamed");
  // Whole paths beyond the drive listing ceiling are dropped rather than truncated.
  assert.equal(safeRelativePath(Array.from({ length: 500 }, () => "seg")), undefined);
  const underLimit = safeRelativePath(Array.from({ length: Math.floor(MAX_PATH_BYTES / 4) }, () => "ab"));
  assert.ok(underLimit && Buffer.byteLength(underLimit) <= MAX_PATH_BYTES);
});

test("tokenSuffix and dedupeSegment keep two colliding titles apart", () => {
  assert.equal(tokenSuffix("abc-123_xyz"), "abc123");
  assert.equal(tokenSuffix("obj...cn_xxxx_1"), "objcnx");
  const first = dedupeSegment("notes.md", "tokenaaaa1");
  const second = dedupeSegment("notes.md", "tokenbbbb2");
  assert.equal(first, "notes-tokena.md");
  assert.notEqual(first, second);
  assert.ok(first.endsWith(".md"), "de-duplication keeps the extension");
  assert.equal(remoteTitle(first), "notes-tokena");
  assert.equal(filenameFromTitle(remoteTitle(first)), first, "a de-duplicated name still round-trips");
  assert.equal(dedupeSegment("notes", "tok1"), "notes-tok1");
});

test("isSafeRelativePath blocks every way a client could walk out of a root", () => {
  assert.equal(isSafeRelativePath("a/b.md"), true);
  assert.equal(isSafeRelativePath("架构/设计.md"), true);
  assert.equal(isSafeRelativePath(""), false);
  assert.equal(isSafeRelativePath("/etc/passwd"), false);
  assert.equal(isSafeRelativePath("C:\\windows\\x"), false);
  assert.equal(isSafeRelativePath("../escape.md"), false);
  assert.equal(isSafeRelativePath("a/../../escape.md"), false);
  assert.equal(isSafeRelativePath("a/....//b"), true, "a literal '....' segment is just a name");
});
