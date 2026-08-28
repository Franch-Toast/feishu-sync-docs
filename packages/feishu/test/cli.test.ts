import assert from "node:assert/strict";
import test from "node:test";
import { LarkCliProvider } from "../src/index.js";

test("CLI provider advertises safe capabilities", () => {
  const provider = new LarkCliProvider({ executable: "lark-cli" });
  assert.equal(provider.capabilities.blockPatch, false);
  assert.equal(provider.capabilities.revisionGuard, false);
  assert.equal(provider.capabilities.remoteEvents, false);
});

test("CLI v2 capability is opt-in", () => {
  const provider = new LarkCliProvider({ executable: "lark-cli", apiVersion: "v2" });
  assert.equal(provider.capabilities.blockPatch, true);
  assert.equal(provider.capabilities.revisionGuard, true);
});
