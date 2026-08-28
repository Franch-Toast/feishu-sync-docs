import assert from "node:assert/strict";
import test from "node:test";
import { FeishuOpenApiProvider } from "../src/index.js";
import type { SyncRoot } from "@feishu-sync/core";

const root: SyncRoot = { id: "root", localPath: "/tmp/docs", remoteToken: "folder", remoteType: "folder", enabled: true, pollIntervalMs: 1000 };

test("OpenAPI provider uses docs_ai fetch and revision-guarded block updates", async () => {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  let revision = 3;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : String(init.body);
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/fetch")) return json({ code: 0, data: { document: { document_id: "doc-1", title: "Notes", revision_id: revision, content: "one\n\ntwo" } } });
    if (url.pathname === "/open-apis/docx/v1/documents/doc-1/blocks") return json({ code: 0, data: { items: [{ block_id: "root", block_type: 1 }, { block_id: "b1", block_type: 2 }, { block_id: "b2", block_type: 2 }], has_more: false } });
    if (url.pathname === "/open-apis/docs_ai/v1/documents/doc-1") {
      revision += 1;
      return json({ code: 0, data: { document: { document_id: "doc-1", title: "Notes", revision_id: revision, content: "one\n\ntwo changed" } } });
    }
    if (url.pathname === "/open-apis/drive/v1/files") return json({ code: 0, data: { files: [], has_more: false } });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl });
  const document = await provider.getDocument("doc-1");
  assert.equal(document.revisionId, 3);
  assert.deepEqual(document.blocks?.map((block) => block.id), ["b1", "b2"]);
  await provider.applyPatch("doc-1", { operations: [{ type: "overwrite", content: "one\n\ntwo changed" }], expectedRevisionId: 3 });
  assert.equal(calls[0]?.path, "/open-apis/docs_ai/v1/documents/doc-1/fetch");
  assert.equal(calls[0]?.method, "POST");
  const update = calls.find((call) => call.path === "/open-apis/docs_ai/v1/documents/doc-1" && call.method === "PUT");
  assert.ok(update);
  assert.match(update.body ?? "", /"revision_id":3/);
  assert.equal(calls.filter((call) => call.path === "/open-apis/docs_ai/v1/documents/doc-1/fetch").length, 3);
  void root;
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
