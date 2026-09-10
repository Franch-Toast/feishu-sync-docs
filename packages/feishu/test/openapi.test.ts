import assert from "node:assert/strict";
import test from "node:test";
import { FeishuOpenApiProvider, FeishuApiError, parseRetryAfterMs } from "../src/index.js";
import type { UserTokenUpdate } from "../src/index.js";
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

/** Build a minimal JWT whose `exp` claim can be controlled per test. */
function makeJwt(expiresInSeconds: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ exp: expiresInSeconds })}.signature`;
}

function documentResponse(): Response {
  return json({ code: 0, data: { document: { document_id: "doc-1", revision_id: 7, content: "hello" } } });
}

test("refreshes an expired user token via the OAuth refresh endpoint", async () => {
  const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
  const refreshed = makeJwt(Math.floor(Date.now() / 1000) + 7200);
  const tokenRequests: string[] = [];
  const apiAuthorizations: string[] = [];
  const updates: UserTokenUpdate[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/v3/token") {
      tokenRequests.push(String(init?.body ?? ""));
      return json({ code: 0, access_token: refreshed, expires_in: 7200, refresh_token: "rt-new", refresh_token_expires_in: 604800, token_type: "Bearer" });
    }
    if (url.pathname.endsWith("/fetch")) {
      apiAuthorizations.push(String(new Headers(init?.headers).get("authorization")));
      return documentResponse();
    }
    if (url.pathname === "/open-apis/docx/v1/documents/doc-1/blocks") return json({ code: 0, data: { items: [], has_more: false } });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({
    accessToken: expired,
    refreshToken: "rt-old",
    appId: "cli_x",
    appSecret: "secret",
    fetchImpl,
    onTokenRefresh: (update) => { updates.push(update); }
  });
  const document = await provider.getDocument("doc-1");
  assert.equal(document.revisionId, 7);
  assert.equal(tokenRequests.length, 1);
  assert.match(tokenRequests[0]!, /grant_type=refresh_token/);
  assert.match(tokenRequests[0]!, /client_id=cli_x/);
  assert.match(tokenRequests[0]!, /refresh_token=rt-old/);
  assert.equal(apiAuthorizations[0], `Bearer ${refreshed}`);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.accessToken, refreshed);
  assert.equal(updates[0]!.refreshToken, "rt-new");
  assert.ok(updates[0]!.tokenExpiresAt > Date.now());
  assert.ok(updates[0]!.refreshTokenExpiresAt !== undefined);
  // The rotated token stays in memory: a second call must not refresh again.
  await provider.getDocument("doc-1");
  assert.equal(tokenRequests.length, 1);
  assert.equal(apiAuthorizations.length, 2);
  assert.equal(apiAuthorizations[1], `Bearer ${refreshed}`);
});

test("reports permanent refresh failures and clears the refresh token", async () => {
  const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
  let invalidReason: string | undefined;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/v3/token") return json({ code: 20037, error: "invalid_grant", error_description: "refresh token expired" });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({
    accessToken: expired,
    refreshToken: "rt-old",
    appId: "cli_x",
    appSecret: "secret",
    fetchImpl,
    onRefreshInvalid: (reason) => { invalidReason = reason; }
  });
  await assert.rejects(provider.getDocument("doc-1"), (error: unknown) => error instanceof FeishuApiError && error.kind === "auth");
  assert.match(invalidReason ?? "", /expired/i);
});

test("falls back to the still-valid token when a refresh attempt fails transiently", async () => {
  // Inside the 5-minute refresh margin but not yet expired.
  const soon = makeJwt(Math.floor(Date.now() / 1000) + 120);
  let refreshAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/v3/token") {
      refreshAttempts += 1;
      throw new TypeError("fetch failed");
    }
    if (url.pathname.endsWith("/fetch")) return documentResponse();
    if (url.pathname === "/open-apis/docx/v1/documents/doc-1/blocks") return json({ code: 0, data: { items: [], has_more: false } });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({ accessToken: soon, refreshToken: "rt-old", appId: "cli_x", appSecret: "secret", fetchImpl });
  const document = await provider.getDocument("doc-1");
  assert.equal(document.revisionId, 7);
  assert.equal(refreshAttempts, 1);
});

test("parses the flat create_folder response and soft-deletes with a type", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}` });
    if (url.pathname === "/open-apis/drive/v1/files/create_folder") return json({ code: 0, data: { token: "fld-new", url: "https://example.feishu.cn/folder/fld-new" } });
    if (init?.method === "DELETE" && url.pathname === "/open-apis/drive/v1/files/fld-new") return json({ code: 0, data: {} });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl });
  // The endpoint returns the token at data.token (no file wrapper).
  const folder = await provider.createFolder("fld-parent", "Sub");
  assert.equal(folder.token, "fld-new");
  assert.equal(folder.name, "Sub");
  assert.equal(folder.type, "folder");
  await provider.softDelete("fld-new", "folder");
  const deleted = calls.find((call) => call.method === "DELETE");
  assert.ok(deleted);
  assert.match(deleted.path, /type=folder$/);
});

test("returns a stub document when the post-create read fails", async () => {
  let createCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/open-apis/docs_ai/v1/documents") {
      createCalls += 1;
      return json({ code: 0, data: { document: { document_id: "doc-new", revision_id: 1 } } });
    }
    if (url.pathname === "/open-apis/docs_ai/v1/documents/doc-new/fetch") {
      return json({ code: 9499, msg: "Invalid parameter type in json: ExtraParam" });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl });
  // The document exists remotely; a failed follow-up read must not throw or
  // the caller would re-create a duplicate on the next attempt.
  const created = await provider.createDocument("fld-parent", "notes", "# Notes\n\nbody");
  assert.equal(created.token, "doc-new");
  assert.equal(created.content, "");
  assert.equal(createCalls, 1);
});

test("classifies Feishu failures into semantic kinds", async () => {
  const cases: Array<{ status?: number; body?: unknown; kind: FeishuApiError["kind"] }> = [
    { body: { code: 99991663, msg: "invalid user access token" }, kind: "auth" },
    { body: { code: 99991668, msg: "token expired" }, kind: "auth" },
    { status: 401, kind: "auth" },
    { status: 403, kind: "permission" },
    { status: 429, kind: "rate_limit" },
    { status: 404, kind: "not_found" }
  ];
  for (const item of cases) {
    const provider = new FeishuOpenApiProvider({
      accessToken: "token",
      fetchImpl: async () => item.body !== undefined ? json(item.body) : new Response("boom", { status: item.status })
    });
    await assert.rejects(provider.getDocument("doc-1"), (error: unknown) => error instanceof FeishuApiError && error.kind === item.kind, `expected kind ${item.kind}`);
  }
  const network = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(network.getDocument("doc-1"), (error: unknown) => error instanceof FeishuApiError && error.kind === "network");
  const missing = new FeishuOpenApiProvider({ baseUrl: "https://open.feishu.cn", fetchImpl: async () => json({ code: 0 }) });
  await assert.rejects(missing.getDocument("doc-1"), (error: unknown) => error instanceof FeishuApiError && error.kind === "auth");
});

test("refreshes a single time under concurrent calls (single-flight)", async () => {
  const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
  const refreshed = makeJwt(Math.floor(Date.now() / 1000) + 7200);
  let tokenRequests = 0;
  const apiAuthorizations: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/v3/token") {
      tokenRequests += 1;
      // Simulate a slow token endpoint so concurrent callers truly overlap.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ code: 0, access_token: refreshed, expires_in: 7200, refresh_token: "rt-new", refresh_token_expires_in: 604800, token_type: "Bearer" });
    }
    if (url.pathname.endsWith("/fetch")) {
      apiAuthorizations.push(String(new Headers(init?.headers).get("authorization")));
      return documentResponse();
    }
    if (url.pathname === "/open-apis/docx/v1/documents/doc-1/blocks") return json({ code: 0, data: { items: [], has_more: false } });
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const provider = new FeishuOpenApiProvider({ accessToken: expired, refreshToken: "rt-old", appId: "cli_x", appSecret: "secret", fetchImpl });
  const documents = await Promise.all(Array.from({ length: 5 }, () => provider.getDocument("doc-1")));
  assert.equal(documents.length, 5);
  assert.equal(tokenRequests, 1, "concurrent callers must share one refresh request");
  assert.deepEqual(apiAuthorizations, Array.from({ length: 5 }, () => `Bearer ${refreshed}`));
});

test("routes the OAuth refresh endpoint to the accounts host", async () => {
  const expired = makeJwt(Math.floor(Date.now() / 1000) - 60);
  const refreshed = makeJwt(Math.floor(Date.now() / 1000) + 7200);
  const cases: Array<{ baseUrl: string; accountsHost: string; apiHost: string }> = [
    { baseUrl: "https://open.feishu.cn", accountsHost: "accounts.feishu.cn", apiHost: "open.feishu.cn" },
    { baseUrl: "https://open.larksuite.com", accountsHost: "accounts.larksuite.com", apiHost: "open.larksuite.com" }
  ];
  for (const item of cases) {
    const tokenHosts: string[] = [];
    const apiHosts: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth/v3/token") { tokenHosts.push(url.host); return json({ code: 0, access_token: refreshed, expires_in: 7200, token_type: "Bearer" }); }
      if (url.pathname.endsWith("/fetch")) { apiHosts.push(url.host); return documentResponse(); }
      if (url.pathname === "/open-apis/docx/v1/documents/doc-1/blocks") return json({ code: 0, data: { items: [], has_more: false } });
      throw new Error(`unexpected request: ${url.pathname}`);
    };
    const provider = new FeishuOpenApiProvider({ baseUrl: item.baseUrl, accessToken: expired, refreshToken: "rt-old", appId: "cli_x", appSecret: "secret", fetchImpl });
    await provider.getDocument("doc-1");
    assert.deepEqual(tokenHosts, [item.accountsHost], `${item.baseUrl} must refresh via ${item.accountsHost}`);
    assert.deepEqual(apiHosts, [item.apiHost], `${item.baseUrl} must keep calling the API host`);
  }
});

test("a 429 response carries Retry-After on the error for the runtime backoff (B6.2)", async () => {
  const limited: typeof fetch = async () => new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } });
  const provider = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl: limited });
  const error = await provider.getDocument("doc-1").then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof FeishuApiError);
  assert.equal(error.kind, "rate_limit");
  assert.equal(error.httpStatus, 429);
  assert.equal(error.retryAfterMs, 30000, "delta-seconds become milliseconds");

  // No header means no hint, so the runtime falls back to its scheduled backoff.
  const bare = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl: async () => new Response("slow down", { status: 429 }) });
  const bareError = await bare.getDocument("doc-1").then(() => undefined, (caught: unknown) => caught);
  assert.ok(bareError instanceof FeishuApiError);
  assert.equal(bareError.retryAfterMs, undefined);

  // A non-429 failure never invents a retry hint.
  const forbidden = new FeishuOpenApiProvider({ accessToken: "token", fetchImpl: async () => new Response("nope", { status: 403, headers: { "Retry-After": "30" } }) });
  const forbiddenError = await forbidden.getDocument("doc-1").then(() => undefined, (caught: unknown) => caught);
  assert.ok(forbiddenError instanceof FeishuApiError);
  assert.equal(forbiddenError.kind, "permission");
  assert.equal(forbiddenError.retryAfterMs, undefined);
});

test("parseRetryAfterMs accepts delta-seconds and HTTP dates and rejects junk", () => {
  assert.equal(parseRetryAfterMs("5"), 5000);
  assert.equal(parseRetryAfterMs("  12 "), 12000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("-3"), 0, "a negative hint never schedules a negative delay");
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  assert.equal(parseRetryAfterMs("not-a-number"), undefined);

  const future = new Date(Date.now() + 60_000).toUTCString();
  const parsed = parseRetryAfterMs(future)!;
  assert.ok(parsed > 55_000 && parsed <= 60_000, `an HTTP-date hint resolves to roughly 60s, got ${parsed}`);
  assert.equal(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0, "an elapsed date means retry immediately");
});
