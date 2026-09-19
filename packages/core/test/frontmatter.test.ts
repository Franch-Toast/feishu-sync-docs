import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTMATTER_ROOT_KEY,
  FRONTMATTER_TOKEN_KEY,
  composeSyncDocument,
  readSyncDocument,
  splitDocument,
  stripEnvelope,
  withBody,
  writeSyncDocument
} from "../src/index.js";

const ID = { token: "doxcni6mOy7jLRWbEylaKKC7K88", rootId: "8f2c1a4e" };

test("writeSyncDocument creates an envelope for a file that has none", () => {
  const result = writeSyncDocument("# Title\n\nbody\n", ID);
  assert.equal(result.changed, true);
  assert.equal(result.text, `---\n${FRONTMATTER_TOKEN_KEY}: ${ID.token}\n${FRONTMATTER_ROOT_KEY}: ${ID.rootId}\n---\n# Title\n\nbody\n`);
});

test("writeSyncDocument appends the key to an existing frontmatter block without touching other lines", () => {
  const raw = [
    "---",
    "title: keep me",
    "# a comment the user wrote",
    "tags: [ai, sync]",
    "nested:",
    "  feishu_token: not-mine",
    "date: 2026-01-02",
    "quoted: \"hello, world\"",
    "---",
    "",
    "# Body",
    ""
  ].join("\n");
  const { text } = writeSyncDocument(raw, ID);
  const lines = text.split("\n");
  // Every pre-existing line survives byte-for-byte, in the same order.
  for (const line of raw.split("\n")) {
    assert.ok(lines.includes(line), `lost or rewrote user line: ${line}`);
  }
  // Only an unindented key is ours; the nested mapping is left alone.
  assert.equal(splitDocument(text).token, ID.token);
  assert.ok(raw.split("\n").includes("  feishu_token: not-mine"), "nested key must remain untouched");
  // Appended inside the block, before the closing delimiter.
  assert.ok(lines.indexOf(`${FRONTMATTER_TOKEN_KEY}: ${ID.token}`) < lines.lastIndexOf("---"));
});

test("writeSyncDocument replaces an existing token in place and stays idempotent", () => {
  const once = writeSyncDocument("# Body\n", { token: "oldToken" }).text;
  const twice = writeSyncDocument(once, { token: "newToken" }).text;
  assert.equal(splitDocument(twice).token, "newToken");
  // The key keeps its original position rather than drifting to the block end.
  assert.equal(twice.split("\n")[1], `${FRONTMATTER_TOKEN_KEY}: newToken`);
  assert.equal(writeSyncDocument(twice, { token: "newToken" }).changed, false, "re-stamping the same id must not rewrite the file");
  assert.equal(writeSyncDocument(twice, { token: "newToken" }).text, twice);
});

test("stamp adds the root key without rewriting the token when only rootId is new", () => {
  const stamped = writeSyncDocument("# Body\n", { token: ID.token }).text;
  const { text, changed } = writeSyncDocument(stamped, ID);
  assert.equal(changed, true);
  assert.equal(splitDocument(text).token, ID.token);
  assert.equal(splitDocument(text).rootId, ID.rootId);
});

test("a malformed (unterminated) envelope is never rewritten and reports a warning", () => {
  const raw = "---\nfeishu_token: orphan\n# this was supposed to be the body\n";
  const result = writeSyncDocument(raw, ID);
  assert.equal(result.changed, false);
  assert.equal(result.text, raw, "content must never be swallowed into metadata");
  assert.ok(result?.warning?.includes("not terminated"));
  assert.equal(stripEnvelope(raw), raw, "a malformed file hashes as a plain document");
  assert.equal(splitDocument(raw).malformed, true);
});

test("a body containing '---' is not mistaken for an envelope", () => {
  const raw = "# Title\n\n---\n\nsection\n";
  assert.equal(splitDocument(raw).meta, null);
  assert.equal(stripEnvelope(raw), raw);
  const stamped = writeSyncDocument(raw, ID).text;
  assert.equal(stripEnvelope(stamped), raw, "the second block must stay in the body");
});

test("the envelope is located only at the very start of the file", () => {
  const leadingBlank = `\n---\n${FRONTMATTER_TOKEN_KEY}: fake\n---\nbody\n`;
  assert.equal(splitDocument(leadingBlank).token, undefined, "a block after a blank line is content, not an envelope");
  assert.equal(stripEnvelope(leadingBlank), leadingBlank);
});

test("CRLF and BOM are preserved across a stamp", () => {
  const crlf = "# Title\r\n\r\nbody\r\n";
  const stampedCrlf = writeSyncDocument(crlf, ID).text;
  assert.ok(stampedCrlf.includes("\r\n"), "must keep the file's line ending style");
  assert.equal(stripEnvelope(stampedCrlf), crlf);
  assert.equal(splitDocument(stampedCrlf).token, ID.token);

  const bom = `\uFEFF# Title\nbody\n`;
  const stampedBom = writeSyncDocument(bom, ID).text;
  assert.ok(stampedBom.startsWith("\uFEFF"), "BOM must remain the first character");
  assert.equal(splitDocument(stampedBom).token, ID.token);
  // The BOM belongs to the envelope region, so stamping cannot shift the hash.
  assert.equal(stripEnvelope(bom), "# Title\nbody\n");
  assert.equal(stripEnvelope(stampedBom), stripEnvelope(bom));
  assert.equal(readSyncDocument(stampedBom, "a.md").bodyHash, readSyncDocument(bom, "a.md").bodyHash);
});

test("quoted, empty and non-bare values round-trip", () => {
  assert.equal(splitDocument(`---\n${FRONTMATTER_TOKEN_KEY}: "quotedToken"\n---\nx\n`).token, "quotedToken");
  assert.equal(splitDocument(`---\n${FRONTMATTER_TOKEN_KEY}: 'singleToken'\n---\nx\n`).token, "singleToken");
  assert.equal(splitDocument(`---\n${FRONTMATTER_TOKEN_KEY}:\n---\nx\n`).token, undefined, "an empty value is not an identity");
  // Characters that would break YAML quoting force a JSON-quoted write.
  const { text } = writeSyncDocument("x\n", { token: "has space" });
  assert.equal(splitDocument(text).token, "has space");
  assert.ok(text.includes(`${FRONTMATTER_TOKEN_KEY}: "has space"`));
});

test("readSyncDocument hashes the body and exposes the identity", () => {
  const unstamped = readSyncDocument("# Plain\n\ntext\n", "plain.md");
  assert.equal(unstamped.malformed, false);
  assert.equal(unstamped.token, undefined);
  assert.equal(unstamped.body, "# Plain\n\ntext\n");
  assert.equal(unstamped.bodyHash, readSyncDocument("# Plain\n\ntext\n", "other.md").bodyHash);

  const stamped = readSyncDocument(composeSyncDocument("# Plain\n\ntext\n", ID), "plain.md");
  assert.equal(stamped.body, unstamped.body, "stamping must not change the syncable body");
  assert.equal(stamped.bodyHash, unstamped.bodyHash, "stamping must not change the hash");
  assert.equal(stamped.token, ID.token);
  assert.equal(stamped.rootId, ID.rootId);
});

test("PROPERTY: strip(write(body, id)) === body for any body not opening with a block", () => {
  const samples = [
    "",
    "\n",
    "# Title",
    "# Title\n",
    "# Title\n\nbody\n",
    "a\n\n\n\nb\n",
    "body\nstarts\nwith\n---\n",
    "body\n\n---\n\nsection\n",
    "# emoji \u{1F600} and CJK \u4e2d\u6587\n",
    "trailing space   \n",
    "# crlf\r\nbody\r\n"
  ];
  for (const sample of samples) {
    for (const id of [{ token: "tok123" }, ID]) {
      assert.equal(stripEnvelope(writeSyncDocument(sample, id).text), sample, `round trip failed for ${JSON.stringify(sample)}`);
    }
  }
});

test("a file that already has frontmatter merges the id instead of round-tripping byte-for-byte", () => {
  // This is the intended exception: stacking a second block on the user's own
  // frontmatter would be worse than folding the key into their existing one.
  const raw = "---\nonly: meta\n---\n";
  const stamped = writeSyncDocument(raw, ID).text;
  assert.equal(splitDocument(stamped).token, ID.token);
  assert.equal(splitDocument(stamped).meta, "only: meta\nfeishu_token: doxcni6mOy7jLRWbEylaKKC7K88\nfeishu_root: 8f2c1a4e");
  assert.equal(stripEnvelope(stamped), "", "the user's body is preserved exactly");
});

test("PROPERTY: stamping is idempotent and the file is a fixed point", () => {
  const samples = ["# Title\n\nbody\n", "---\ntags: [x]\n---\n\n# Body\n", "no newline at eof", ""];
  for (const sample of samples) {
    const once = writeSyncDocument(sample, ID).text;
    const twice = writeSyncDocument(once, ID);
    assert.equal(twice.text, once, "second stamp must not alter the first result");
    assert.equal(twice.changed, false, "a correctly stamped file reports no change");
  }
});

test("PROPERTY: join(split(raw)) reproduces raw for an unstamped-change-free file", () => {
  const raw = composeSyncDocument("# Title\n\nbody\n", ID);
  const split = splitDocument(raw);
  const eol = "\n";
  assert.equal([ "---", ...(split.meta ?? "").split(eol), "---" ].join(eol) + eol + split.body, raw);
});

test("withBody swaps the content and keeps the envelope of the local file", () => {
  const stamped = composeSyncDocument("# Old\n", ID);
  const swapped = withBody(stamped, "# New\n");
  assert.equal(splitDocument(swapped).token, ID.token);
  assert.equal(splitDocument(swapped).rootId, ID.rootId);
  assert.equal(splitDocument(swapped).body, "# New\n");
  // User frontmatter keys survive a body swap.
  const userMeta = writeSyncDocument("---\ntags: [keep]\n---\n\n# Old\n", ID).text;
  const swappedUser = withBody(userMeta, "# New\n");
  assert.ok(swappedUser.includes("tags: [keep]"));
  assert.equal(splitDocument(swappedUser).body, "# New\n");
  // Unstamped and malformed files pass the body through untouched.
  assert.equal(withBody("# plain\n", "# new\n"), "# new\n");
  assert.equal(withBody("---\nunterminated\n", "# new\n"), "# new\n");
});
