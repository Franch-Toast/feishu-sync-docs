import assert from "node:assert/strict";
import test from "node:test";
import { buildBlockPatch, decideSync } from "../src/index.js";

test("detects a local-only change", () => {
  assert.deepEqual(decideSync("# A\n\nbase", "# A\n\nlocal", "# A\n\nbase"), { action: "push", reason: "only local changed" });
});

test("merges independent top-level blocks", () => {
  const decision = decideSync("one\n\ntwo", "local one\n\ntwo", "one\n\nremote two");
  assert.equal(decision.action, "merge");
  assert.match(decision.mergedContent ?? "", /local one/);
  assert.match(decision.mergedContent ?? "", /remote two/);
});

test("creates a conflict for the same block", () => {
  assert.equal(decideSync("same", "local", "remote").action, "conflict");
});

test("merges non-overlapping edits inside one block", () => {
  const decision = decideSync("alpha\nbeta\ngamma", "local alpha\nbeta\ngamma", "alpha\nbeta\nremote gamma");
  assert.equal(decision.action, "merge");
  assert.match(decision.mergedContent ?? "", /local alpha/);
  assert.match(decision.mergedContent ?? "", /remote gamma/);
});

test("falls back to a conflict for overlapping line edits", () => {
  assert.equal(decideSync("one\ntwo", "local\ntwo", "remote\ntwo").action, "conflict");
});

test("builds block replacement operations", () => {
  const patch = buildBlockPatch("one\n\ntwo", "one\n\nchanged", [
    { id: "b1", kind: "paragraph", contentHash: "x" },
    { id: "b2", kind: "paragraph", contentHash: "y" }
  ]);
  assert.equal(patch.safe, true);
  assert.deepEqual(patch.operations, [{ type: "replace", blockId: "b2", content: "changed" }]);
});

test("builds a safe single block insertion", () => {
  const patch = buildBlockPatch("one\n\ntwo", "one\n\ninserted\n\ntwo", [
    { id: "b1", kind: "paragraph", contentHash: "x" },
    { id: "b2", kind: "paragraph", contentHash: "y" }
  ]);
  assert.equal(patch.safe, true);
  assert.deepEqual(patch.operations, [{ type: "insertAfter", blockId: "b1", content: "inserted" }]);
});

test("does not invent a root block id for a first-block insertion", () => {
  const patch = buildBlockPatch("one", "inserted\n\none", [{ id: "b1", kind: "paragraph", contentHash: "x" }]);
  assert.equal(patch.safe, false);
  assert.deepEqual(patch.operations, [{ type: "overwrite", content: "inserted\n\none" }]);
});
