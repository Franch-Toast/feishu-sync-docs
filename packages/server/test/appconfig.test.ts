import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppConfigStore, DEFAULT_NOTIFICATIONS, DEFAULT_PREFERENCES } from "../src/appconfig.js";

test("preferences default, round-trip on disk and validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    const config = new AppConfigStore(configPath);
    assert.deepEqual(config.preferences, DEFAULT_PREFERENCES);
    assert.ok(!existsSync(configPath), "no file is written until the first save");

    const saved = await config.setPreferences({ defaultPollIntervalMs: 30000, logLevel: "debug" });
    assert.deepEqual(saved, { defaultPollIntervalMs: 30000, logLevel: "debug", notifications: { ...DEFAULT_NOTIFICATIONS } });
    assert.ok(existsSync(configPath), "the first save must create config.json");

    // A second instance re-reads the file: persistence really happened.
    assert.deepEqual(new AppConfigStore(configPath).preferences, saved);

    // Unknown preference keys are rejected with a client error status.
    await assert.rejects(config.setPreferences({ defaultPollIntervalMs: 500 }), /at least 1000ms/);
    await assert.rejects(config.setPreferences({ logLevel: "verbose" as never }), /logLevel/);
    assert.deepEqual(config.preferences, saved, "failed saves must not mutate state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notification preferences default on, persist per category and survive a partial patch (B6.8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    const config = new AppConfigStore(configPath);
    assert.deepEqual(config.preferences.notifications, { conflict: true, failure: true, credential: true });

    // A partial patch only flips the named categories.
    const saved = await config.setPreferences({ notifications: { conflict: false } });
    assert.deepEqual(saved.notifications, { conflict: false, failure: true, credential: true });
    await config.setPreferences({ notifications: { credential: false } });
    assert.deepEqual(config.preferences.notifications, { conflict: false, failure: true, credential: false });

    // The toggles live server-side, so a second instance (another browser or a
    // restarted process) reads the same values instead of per-device defaults.
    const reopened = new AppConfigStore(configPath);
    assert.deepEqual(reopened.preferences.notifications, { conflict: false, failure: true, credential: false });
    const disk = JSON.parse(readFileSync(configPath, "utf8")) as { preferences: { notifications: Record<string, boolean> } };
    assert.deepEqual(disk.preferences.notifications, { conflict: false, failure: true, credential: false });

    // Turning one back on works, and an unrelated patch leaves them untouched.
    await config.setPreferences({ logLevel: "warn" });
    assert.deepEqual(config.preferences.notifications, { conflict: false, failure: true, credential: false });
    assert.equal((await config.setPreferences({ notifications: { conflict: true } })).notifications.conflict, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config.json written before notifications existed still yields all defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    // Legacy document: no `notifications` key at all (JSON-default compatible,
    // no migration step required).
    writeFileSync(configPath, JSON.stringify({ version: 1, credentials: {}, preferences: { defaultPollIntervalMs: 20000, logLevel: "error" } }), "utf8");
    const config = new AppConfigStore(configPath);
    assert.deepEqual(config.preferences, { defaultPollIntervalMs: 20000, logLevel: "error", notifications: { ...DEFAULT_NOTIFICATIONS } });
    // A partially written notifications object is merged over the defaults too.
    writeFileSync(configPath, JSON.stringify({ version: 1, credentials: {}, preferences: { notifications: { failure: false } } }), "utf8");
    assert.deepEqual(new AppConfigStore(configPath).preferences.notifications, { conflict: true, failure: false, credential: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential pairs persist; undefined deletes and empty string is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const config = new AppConfigStore(join(dir, "config.json"));
    await config.setCredentials([["feishu.appId", "cli_a"], ["feishu.appSecret", ""]]);
    assert.equal(await config.getCredential("feishu.appId"), "cli_a");
    assert.equal(await config.getCredential("feishu.appSecret"), "");

    await config.setCredentials([["feishu.appSecret", undefined]]);
    assert.equal(await config.getCredential("feishu.appSecret"), undefined);

    // No tmp leftover: writes are atomic via rename.
    assert.ok(!existsSync(`${config.configPath}.tmp`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth flags round-trip through the AuthStateStore interface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const config = new AppConfigStore(join(dir, "config.json"));
    assert.equal((await config.getAuthFlag()).status, undefined);
    await config.setAuthFlag("invalid", "2024-01-01T00:00:00.000Z");
    assert.deepEqual(await config.getAuthFlag(), { status: "invalid", checkedAt: "2024-01-01T00:00:00.000Z" });
    await config.setAuthFlag("ok", "2024-01-02T00:00:00.000Z");
    assert.equal((await config.getAuthFlag()).status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt config.json falls back to defaults instead of crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{ not valid json", "utf8");
    const config = new AppConfigStore(configPath);
    assert.deepEqual(config.preferences, DEFAULT_PREFERENCES);
    assert.equal(await config.getCredential("feishu.appId"), undefined);
    // The next save repairs the file.
    await config.setPreferences({ logLevel: "warn" });
    assert.deepEqual(new AppConfigStore(configPath).preferences.logLevel, "warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
