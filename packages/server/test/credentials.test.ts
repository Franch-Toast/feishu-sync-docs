import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../src/credentials.js";
import { SqliteStateStore } from "@feishu-sync/storage";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

/** Snapshot the env keys a test touches and restore them afterwards. */
class EnvGuard {
  private readonly saved = new Map<string, string | undefined>();
  set(key: string, value: string | undefined): void {
    if (!this.saved.has(key)) this.saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restore(): void {
    for (const [key, value] of this.saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.saved.clear();
  }
}

test("redacted() masks short tokens fully and long tokens first6…last4", async () => {
  const store = new SqliteStateStore();
  const credentials = new CredentialStore(store);
  await credentials.save({ mode: "user", accessToken: "short-token" }); // 11 chars → ≤12 rule
  let view = await credentials.redacted();
  assert.equal(view.hasAccessToken, true);
  assert.ok(view.accessToken && !view.accessToken.includes("short-token"), "short token must never appear");
  assert.ok(view.accessToken.startsWith("•"), "short token must be fully masked");

  await credentials.save({ accessToken: "user-token-abc-1234567890" }); // 27 chars
  view = await credentials.redacted();
  assert.equal(view.accessToken, "user-t…7890");
  assert.ok(!String(view.accessToken).includes("1234567890"), "long token must only reveal first 6 / last 4");
  store.close();
});

test("save() semantics: undefined keeps values, empty strings clear, refresh token resets expiry", async () => {
  const store = new SqliteStateStore();
  const credentials = new CredentialStore(store);
  await credentials.save({ mode: "tenant", appId: "cli_a", appSecret: "secret-1" });
  await store.setSetting("feishu.refreshTokenExpiresAt", String(Date.now()));

  // undefined fields leave stored values untouched.
  await credentials.save({ accessToken: "tok-1" });
  assert.equal(await store.getSetting("feishu.appId"), "cli_a");
  assert.equal(await store.getSetting("feishu.appSecret"), "secret-1");

  // An empty string clears the stored value.
  await credentials.save({ appSecret: "" });
  assert.equal(await store.getSetting("feishu.appSecret"), "");

  // Manually supplying a refresh token clears any previous expiry record.
  await credentials.save({ refreshToken: "rt-1" });
  assert.equal(await store.getSetting("feishu.refreshToken"), "rt-1");
  assert.equal(await store.getSetting("feishu.refreshTokenExpiresAt"), "");
  store.close();
});

test("database settings take precedence over environment variables", async () => {
  const store = new SqliteStateStore();
  const credentials = new CredentialStore(store);
  const guard = new EnvGuard();
  try {
    guard.set("FEISHU_ACCESS_TOKEN", "env-token");
    guard.set("FEISHU_APP_ID", "env-app-id");
    guard.set("FEISHU_APP_SECRET", "env-secret");

    // Env-only configuration: app credentials imply the tenant mode.
    let config = await credentials.load();
    assert.equal(config.mode, "tenant");
    assert.equal(config.accessToken, "env-token");
    assert.equal(config.appId, "env-app-id");

    // Saved settings win over env vars per key.
    await credentials.save({ mode: "user", appId: "db-app-id" });
    config = await credentials.load();
    assert.equal(config.mode, "user");
    assert.equal(config.appId, "db-app-id");
    assert.equal(config.appSecret, "env-secret", "env fallback still applies for unsaved keys");
    assert.equal(config.accessToken, "env-token");
  } finally {
    guard.restore();
    store.close();
  }
});

test("LARK_CLI_BIN wins over the legacy LARK_CLI_PATH name", async () => {
  const store = new SqliteStateStore();
  const credentials = new CredentialStore(store);
  const guard = new EnvGuard();
  try {
    guard.set("LARK_CLI_BIN", "/usr/bin/lark-cli");
    guard.set("LARK_CLI_PATH", "/legacy/lark-cli");
    assert.equal((await credentials.load()).larkCliBin, "/usr/bin/lark-cli");
    guard.set("LARK_CLI_BIN", undefined);
    assert.equal((await credentials.load()).larkCliBin, "/legacy/lark-cli");
  } finally {
    guard.restore();
    store.close();
  }
});

test("cli connection test probes the executable and reports failures", async () => {
  const store = new SqliteStateStore();
  try {
    const credentials = new CredentialStore(store);
    await credentials.save({ mode: "cli", larkCliBin: "lark-cli" });

    const failing = new CredentialStore(store, undefined, async () => {
      throw new Error("ENOENT: no such file or directory");
    });
    const bad = await failing.testConnection();
    assert.equal(bad.ok, false);
    assert.equal(bad.mode, "cli");
    assert.match(bad.error ?? "", /lark-cli/);
    assert.match(bad.error ?? "", /ENOENT/);

    const passing = new CredentialStore(store, undefined, async () => undefined);
    const good = await passing.testConnection();
    assert.equal(good.ok, true);
    assert.equal(good.identity, "lark-cli");
  } finally {
    store.close();
  }
});

test("tenant connection test verifies the token and the drive permission", async () => {
  const store = new SqliteStateStore();
  const guard = new EnvGuard();
  try {
    guard.set("FEISHU_APP_ID", undefined);
    guard.set("FEISHU_APP_SECRET", undefined);
    const probe = (metaCode: number): CredentialStore => new CredentialStore(store, async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") return jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
      if (url.pathname === "/open-apis/drive/explorer/v2/root_folder/meta") return jsonResponse({ code: metaCode, msg: "permission denied" });
      throw new Error(`unexpected request ${url.pathname}`);
    });

    const denied = await probe(99991672).testConnection({ mode: "tenant", appId: "cli_a", appSecret: "s3cret" });
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /云盘权限校验失败/);

    const ok = await probe(0).testConnection({ mode: "tenant", appId: "cli_a", appSecret: "s3cret" });
    assert.equal(ok.ok, true);
    assert.equal(ok.identity, "cli_a");
  } finally {
    guard.restore();
    store.close();
  }
});

test("user connection test reports a missing token without leaking secrets", async () => {
  const store = new SqliteStateStore();
  const guard = new EnvGuard();
  try {
    guard.set("FEISHU_ACCESS_TOKEN", undefined);
    guard.set("FEISHU_APP_ID", undefined);
    guard.set("FEISHU_APP_SECRET", undefined);
    const credentials = new CredentialStore(store);
    const result = await credentials.testConnection({ mode: "user" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /缺少 user access token/);
  } finally {
    guard.restore();
    store.close();
  }
});
