import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { SqliteStateStore } from "@feishu-sync/storage";

test("serves health and root APIs without Feishu credentials", async () => {
  const app = buildApp({ store: new SqliteStateStore(), remote: {
    name: "fake", capabilities: { blockPatch: true, revisionGuard: true, assetUpload: true, remoteEvents: false },
    async listTree(root) { return { root: { token: root.remoteToken, name: "root", type: "folder", parentToken: "" }, nodes: [] }; },
    async getDocument(token) { return { token, name: token, type: "document", parentToken: "", content: "", blocks: [] }; },
    async createFolder(parentToken, name) { return { token: name, name, type: "folder", parentToken }; },
    async createDocument(parentToken, name, content) { return { token: name, name, type: "document", parentToken, content, blocks: [] }; },
    async applyPatch(token, patch) { return { document: { token, name: token, type: "document", parentToken: "", content: patch.operations.at(-1)?.content ?? "", blocks: [] }, applied: patch.operations }; },
    async uploadAsset(parentToken, name, content, mimeType) { return { token: name, name, type: "asset", parentToken, size: content.length, mimeType }; },
    async downloadAsset() { return new Uint8Array(); }, async softDelete() {}
  } });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  const events = await app.inject({ method: "GET", url: "/api/events" });
  assert.equal(events.statusCode, 426);
  assert.equal(events.json().error, "WebSocket upgrade required");
  await app.close();
});
