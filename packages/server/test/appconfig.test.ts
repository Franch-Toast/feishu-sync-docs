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
    assert.deepEqual(saved, { defaultPollIntervalMs: 30000, logLevel: "debug", notifications: { ...DEFAULT_NOTIFICATIONS }, notificationChannel: "none" });
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

test("notification preferences default off, persist per category and survive a partial patch (B6.8/D)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    const config = new AppConfigStore(configPath);
    // D: the workbench is silent out of the box.
    assert.deepEqual(config.preferences.notifications, { conflict: false, failure: false, credential: false });
    assert.equal(config.preferences.notificationChannel, "none");

    // A partial patch only flips the named categories.
    const saved = await config.setPreferences({ notifications: { conflict: true } });
    assert.deepEqual(saved.notifications, { conflict: true, failure: false, credential: false });
    await config.setPreferences({ notifications: { credential: true } });
    assert.deepEqual(config.preferences.notifications, { conflict: true, failure: false, credential: true });

    // The toggles live server-side, so a second instance (another browser or a
    // restarted process) reads the same values instead of per-device defaults.
    const reopened = new AppConfigStore(configPath);
    assert.deepEqual(reopened.preferences.notifications, { conflict: true, failure: false, credential: true });
    const disk = JSON.parse(readFileSync(configPath, "utf8")) as { preferences: { notifications: Record<string, boolean> } };
    assert.deepEqual(disk.preferences.notifications, { conflict: true, failure: false, credential: true });

    // Turning one back off works, and an unrelated patch leaves them untouched.
    await config.setPreferences({ logLevel: "warn" });
    assert.deepEqual(config.preferences.notifications, { conflict: true, failure: false, credential: true });
    assert.equal((await config.setPreferences({ notifications: { conflict: false } })).notifications.conflict, false);

    // The channel is a closed set: anything else is a client error, not a typo
    // that silently disables delivery.
    await assert.rejects(config.setPreferences({ notificationChannel: "email" as never }), /notificationChannel must be one of/);
    assert.equal((await config.setPreferences({ notificationChannel: "browser" })).notificationChannel, "browser");
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
    assert.deepEqual(config.preferences, { ...DEFAULT_PREFERENCES, defaultPollIntervalMs: 20000, logLevel: "error" });
    // A partially written notifications object is merged over the defaults too.
    writeFileSync(configPath, JSON.stringify({ version: 1, credentials: {}, preferences: { notifications: { failure: true } } }), "utf8");
    assert.deepEqual(new AppConfigStore(configPath).preferences.notifications, { conflict: false, failure: true, credential: false });
    // A legacy file that had the old "all on" switches still needs a channel;
    // without one nothing is delivered (D: no silent behaviour change on upgrade).
    assert.equal(new AppConfigStore(configPath).preferences.notificationChannel, "none");
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
