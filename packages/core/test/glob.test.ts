import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, matchesAnyGlob, matchesGlob } from "../src/glob.js";

test("a bare pattern matches at any depth and a directory covers its contents", () => {
  assert.equal(matchesGlob("drafts/notes.md", "drafts"), true, "a directory name covers its whole subtree");
  assert.equal(matchesGlob("deep/nested/drafts/notes.md", "drafts"), true, "bare patterns match at any depth");
  assert.equal(matchesGlob("drafts", "drafts"), true);
  assert.equal(matchesGlob("keep/notes.md", "drafts"), false);
  assert.equal(matchesGlob("my-drafts/notes.md", "drafts"), false, "no substring matching");
});

test("star wildcards stay inside a path segment while double-star crosses segments", () => {
  assert.equal(matchesGlob("tmp-notes.md", "tmp-*.md"), true);
  assert.equal(matchesGlob("notes/tmp-notes.md", "tmp-*.md"), true, "bare star patterns still match at any depth");
  assert.equal(matchesGlob("a/b.md", "a/*"), true);
  assert.equal(matchesGlob("a/b/c.md", "a/*"), true, "excluding a/b also excludes everything under it");
  assert.ok(!globToRegExp("a/*").test("a/b/c.md"), "a single `*` never crosses a slash");
  assert.equal(matchesGlob("a/b/c.md", "a/**"), true, "`**` crosses slashes");
  assert.ok(globToRegExp("a/**/c.md").test("a/c.md"), "`**/` collapses to zero directories");
  assert.ok(globToRegExp("a/**/c.md").test("a/x/y/c.md"), "`**/` collapses to many directories");
  assert.equal(matchesGlob("a.md", "?.md"), true);
  assert.equal(matchesGlob("ab.md", "?.md"), false);
});

test("anchored patterns with a slash only match from the root", () => {
  assert.equal(matchesGlob("build/output.md", "build/output.md"), true);
  assert.equal(matchesGlob("src/build/output.md", "src/build/output.md"), true);
  assert.equal(matchesGlob("deep/src/build/output.md", "src/build/output.md"), false, "a slash anchors the pattern");
  assert.equal(matchesGlob("src/build/deep/output.md", "src/build/**"), true);
});

test("regex metacharacters in patterns are escaped rather than interpreted", () => {
  assert.equal(matchesGlob("a+b.md", "a+b.md"), true);
  assert.equal(matchesGlob("aab.md", "a+b.md"), false, "`+` is a literal, not a quantifier");
  assert.equal(matchesGlob("notes(1).md", "notes(1).md"), true);
  assert.ok(globToRegExp("a.b").test("a.b"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("blank patterns and empty pattern lists never match", () => {
  assert.equal(matchesAnyGlob("notes.md", undefined), false);
  assert.equal(matchesAnyGlob("notes.md", []), false);
  assert.equal(matchesGlob("notes.md", "   "), false);
  assert.equal(matchesGlob("notes.md", "/"), false);
  assert.equal(matchesAnyGlob("notes.md", [""]), false);
});

test("matchesAnyGlob reports the first matching pattern only", () => {
  assert.equal(matchesAnyGlob("drafts/a.md", ["keep", "drafts"]), true);
  assert.equal(matchesAnyGlob("drafts/a.md", ["keep", "other"]), false);
  assert.equal(matchesAnyGlob("notes.md", ["*.log", "drafts"]), false);
});
