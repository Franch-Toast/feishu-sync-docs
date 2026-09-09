import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppConfigStore, DEFAULT_PREFERENCES, migrateLegacyDatabase, resolveDatabasePath } from "../src/appconfig.js";

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

test("preferences default, round-trip on disk and validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-appconfig-"));
  try {
    const configPath = join(dir, "config.json");
    const config = new AppConfigStore(configPath);
    assert.deepEqual(config.preferences, DEFAULT_PREFERENCES);
    assert.ok(!existsSync(configPath), "no file is written until the first save");

    const saved = await config.setPreferences({ defaultPollIntervalMs: 30000, logLevel: "debug" });
    assert.deepEqual(saved, { defaultPollIntervalMs: 30000, logLevel: "debug" });
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

test("migrateLegacyDatabase copies db+wal sidecars once and honors explicit paths", async () => {
  const guard = new EnvGuard();
  guard.set("SYNC_DB_PATH", undefined);
  const fakeCwd = mkdtempSync(join(tmpdir(), "feishu-migrate-cwd-"));
  const targetDir = mkdtempSync(join(tmpdir(), "feishu-migrate-target-"));
  const originalCwd = process.cwd();
  process.chdir(fakeCwd);
  try {
    mkdirSync(join(fakeCwd, ".data"));
    writeFileSync(join(fakeCwd, ".data", "sync.db"), "db-bytes", "utf8");
    writeFileSync(join(fakeCwd, ".data", "sync.db-wal"), "wal-bytes", "utf8");

    const target = join(targetDir, "sync.db");
    assert.equal(migrateLegacyDatabase(target), true);
    assert.equal(readFileSync(target, "utf8"), "db-bytes");
    assert.equal(readFileSync(`${target}-wal`, "utf8"), "wal-bytes");
    assert.ok(!existsSync(`${target}-shm`), "missing sidecars are not invented");

    // Target now exists: a second run must be a no-op.
    assert.equal(migrateLegacyDatabase(target), false);

    // With the legacy file removed, nothing can migrate anymore.
    rmSync(join(fakeCwd, ".data", "sync.db"));
    rmSync(join(fakeCwd, ".data", "sync.db-wal"));
    assert.equal(migrateLegacyDatabase(join(targetDir, "other.db")), false);
    assert.ok(!existsSync(join(targetDir, "other.db")));
  } finally {
    process.chdir(originalCwd);
    guard.restore();
    rmSync(fakeCwd, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test("migrateLegacyDatabase never runs when SYNC_DB_PATH is explicit", async () => {
  const guard = new EnvGuard();
  guard.set("SYNC_DB_PATH", join(tmpdir(), "feishu-explicit-sync.db"));
  const fakeCwd = mkdtempSync(join(tmpdir(), "feishu-migrate-explicit-"));
  const originalCwd = process.cwd();
  process.chdir(fakeCwd);
  try {
    mkdirSync(join(fakeCwd, ".data"));
    writeFileSync(join(fakeCwd, ".data", "sync.db"), "db-bytes", "utf8");
    assert.equal(migrateLegacyDatabase(join(tmpdir(), "should-not-be-created.db")), false);
    assert.ok(!existsSync(join(tmpdir(), "should-not-be-created.db")));
  } finally {
    process.chdir(originalCwd);
    guard.restore();
    rmSync(fakeCwd, { recursive: true, force: true });
  }
});

test("resolveDatabasePath prefers SYNC_DB_PATH and falls back to the data dir", async () => {
  const guard = new EnvGuard();
  try {
    guard.set("SYNC_DB_PATH", "/explicit/sync.db");
    assert.equal(resolveDatabasePath(), "/explicit/sync.db");
    guard.set("SYNC_DB_PATH", undefined);
    guard.set("SYNC_CONFIG_PATH", "/custom/dir/config.json");
    assert.equal(resolveDatabasePath(), join("/custom/dir", "sync.db"), "SYNC_CONFIG_PATH's directory hosts sync.db");
    guard.set("SYNC_CONFIG_PATH", undefined);
    assert.ok(resolveDatabasePath().endsWith("sync.db"));
  } finally {
    guard.restore();
  }
});
