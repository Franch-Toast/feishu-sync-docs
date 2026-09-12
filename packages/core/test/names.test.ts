import assert from "node:assert/strict";
import test from "node:test";
import { normalizeForMatch, sanitizeLocalSegment } from "../src/index.js";

test("sanitizeLocalSegment replaces filesystem-illegal characters", () => {
  assert.equal(sanitizeLocalSegment('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(sanitizeLocalSegment("note\u0000name"), "note-name");
  assert.equal(sanitizeLocalSegment("tabs\tand\nnewlines"), "tabs-and-newlines");
});

test("sanitizeLocalSegment decodes common HTML entities and normalizes Unicode", () => {
  assert.equal(sanitizeLocalSegment("a &amp; b"), "a & b");
  // Entities decode before illegal-character replacement, so an escaped
  // `<`/`"` lands as a dash exactly like the literal character would.
  assert.equal(sanitizeLocalSegment("x &lt;y&gt; &quot;z&quot; &#39;w&#39; &apos;v&apos;"), "x -y- -z- 'w' 'v'");
  // Decomposed form (NFD, as produced by macOS) composes to NFC.
  assert.equal(sanitizeLocalSegment("e\u0301tude"), "\u00e9tude");
});

test("sanitizeLocalSegment strips leading/trailing dots and spaces", () => {
  assert.equal(sanitizeLocalSegment("  name . "), "name");
  assert.equal(sanitizeLocalSegment("...hidden..."), "hidden");
  assert.equal(sanitizeLocalSegment("."), "Untitled");
  assert.equal(sanitizeLocalSegment(""), "Untitled");
});

test("sanitizeLocalSegment guards Windows reserved device names", () => {
  assert.equal(sanitizeLocalSegment("CON"), "_CON");
  assert.equal(sanitizeLocalSegment("nul.txt"), "_nul.txt");
  assert.equal(sanitizeLocalSegment("com1"), "_com1");
  assert.equal(sanitizeLocalSegment("constant.md"), "constant.md", "reserved match is whole-segment only");
});

test("sanitizeLocalSegment caps the byte length without splitting code points", () => {
  const long = "\u4e2d\u6587".repeat(200); // 800 bytes of UTF-8
  const result = sanitizeLocalSegment(long);
  assert.ok(Buffer.byteLength(result, "utf8") <= 240, "segment must stay within the byte budget");
  assert.ok(!result.includes("\uFFFD"), "no replacement characters may remain");
});

test("normalizeForMatch compares composed forms and ignores outer whitespace", () => {
  assert.equal(normalizeForMatch("sensor\u2014radar"), normalizeForMatch("sensor—radar"));
  assert.equal(normalizeForMatch("  Data Flow  "), normalizeForMatch("Data Flow"));
  // Decomposed vs composed CJK accents must pair.
  assert.equal(normalizeForMatch("\u00e9"), normalizeForMatch("e\u0301"));
  assert.equal(normalizeForMatch("a"), "a");
});
