import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemProvider } from "@feishu-sync/core";
import type { SyncRoot } from "@feishu-sync/core";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { AppConfigStore } from "../src/appconfig.js";
import { LogSink, NoopSink, shouldNotify } from "../src/notify.js";
import type { NotificationCategory, NotificationEvent, NotificationSink } from "../src/notify.js";
import { FeishuBotSink } from "../src/notify-feishu-bot.js";
import { SyncRuntime } from "../src/runtime.js";
import type { NotificationSettings } from "../src/runtime.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/**
 * D: notifications are a server-side, opt-in port.
 *
 * The browser used to raise `Notification` pop-ups straight from the React app,
 * which could not be silenced as a preference and could not be tested. The
 * runtime now emits events into a `NotificationSink`; these cases pin both the
 * gating (channel + per-category switch) and the promise that a broken sink can
 * never break a sync round.
 */

class RecordingSink implements NotificationSink {
  readonly events: NotificationEvent[] = [];

  async notify(event: NotificationEvent): Promise<void> {
    this.events.push(event);
  }
}

/** A sink that fails the way a real network delivery does. */
class ExplodingSink implements NotificationSink {
  attempts = 0;

  async notify(): Promise<void> {
    this.attempts += 1;
    throw new Error("webhook unreachable");
  }
}

interface NotifyScenario {
  runtime: SyncRuntime;
  gitStorage: GitStorageImpl;
  remote: FakeRemote;
  metaStorage: JsonMetaStorage;
  config: AppConfigStore;
  sink: RecordingSink;
  directory: string;
  globalDir: string;
}

function notifyScenario(options: {
  channel: NotificationSettings["channel"];
  enabled?: Partial<Record<NotificationCategory, boolean>>;
  sink?: NotificationSink;
}): NotifyScenario {
  const directory = mkdtempSync(join(tmpdir(), "feishu-sync-notify-"));
  const globalDir = mkdtempSync(join(tmpdir(), "feishu-sync-notify-config-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const config = new AppConfigStore(join(globalDir, "config.json"));
  const sink = (options.sink ?? new RecordingSink()) as RecordingSink;
  const runtime = new SyncRuntime(
    gitStorage, metaStorage, new FilesystemProvider(), remote, undefined, undefined, undefined, config, { sleep: async () => {} },
    { sink, settings: () => ({ channel: options.channel, enabled: options.enabled ?? {} }) }
  );
  writeFileSync(join(directory, "notes.md"), "# Notes\n\nlocal body", "utf8");
  return { runtime, gitStorage, remote, metaStorage, config, sink, directory, globalDir };
}

async function bindRoot(scenario: NotifyScenario): Promise<SyncRoot> {
  const root = await scenario.metaStorage.createRoot({ localPath: scenario.directory, remoteToken: "root-token", remoteType: "folder", enabled: false, pollIntervalMs: 60_000 });
  await scenario.gitStorage.initRoot(root);
  await scenario.metaStorage.initRootMeta(root.id, root.localPath);
  return root;
}

function cleanup(scenario: NotifyScenario): void {
  scenario.runtime.stop();
  rmSync(scenario.directory, { recursive: true, force: true });
  rmSync(scenario.globalDir, { recursive: true, force: true });
}

test("shouldNotify gates on the channel first and then on the category switch", () => {
  // The default channel answers for everything: no channel, no delivery.
  assert.equal(shouldNotify("none", { conflict: true, failure: true, credential: true }, "failure"), false);
  assert.equal(shouldNotify("", {}, "failure"), false);
  // An enabled channel still delivers nothing a switch has not opted into —
  // including categories missing from an older config file.
  assert.equal(shouldNotify("browser", {}, "failure"), false);
  assert.equal(shouldNotify("browser", { failure: false }, "failure"), false);
  assert.equal(shouldNotify("browser", { failure: true }, "failure"), true);
  assert.equal(shouldNotify("feishu-bot", { conflict: true }, "conflict"), true);
  assert.equal(shouldNotify("browser", { conflict: true }, "failure"), false, "one switch per category");
});

test("the default wiring is silent: NoopSink and channel none", async () => {
  const scenario = notifyScenario({ channel: "none", enabled: { failure: true } });
  try {
    const root = await bindRoot(scenario);
    // Sync once so the entry is bound, then break writes and retry: the failure
    // path is reached, but the channel gate keeps the sink empty.
    await scenario.runtime.syncRoot(root.id);
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nsecond edit", "utf8");
    scenario.remote.failWrites = true;
    await scenario.runtime.syncRoot(root.id);
    assert.equal(scenario.sink.events.length, 0, "notificationChannel: none must deliver nothing at all");
    // A runtime built without notification options behaves the same (NoopSink).
    const bare = new SyncRuntime(new GitStorageImpl(), new JsonMetaStorage(scenario.globalDir), new FilesystemProvider(), new FakeRemote());
    assert.ok(bare, "the sink and the settings are both optional");
    bare.stop();
  } finally {
    cleanup(scenario);
  }
});

test("an enabled channel delivers one field-complete failure event", async () => {
  const scenario = notifyScenario({ channel: "browser", enabled: { failure: true } });
  try {
    const root = await bindRoot(scenario);
    await scenario.runtime.syncRoot(root.id);
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nsecond edit", "utf8");
    scenario.remote.failWrites = true;
    await scenario.runtime.syncRoot(root.id);

    assert.equal(scenario.sink.events.length, 1, "one failure event for the one broken entry");
    const [event] = scenario.sink.events;
    assert.equal(event?.category, "failure");
    assert.match(event?.title ?? "", /notes\.md/, "the title names the file in Chinese the user can act on");
    assert.match(event?.body ?? "", /persistent/);
    assert.equal(event?.rootId, root.id);
    assert.ok(event?.entryId);
    assert.ok(event?.at && !Number.isNaN(Date.parse(event.at)), "every event carries an ISO timestamp");

    // A later round that does not touch the entry must not re-announce it: A1
    // keeps the entry terminal, so the failure event stays a single row too.
    await scenario.runtime.syncRoot(root.id);
    assert.equal(scenario.sink.events.length, 1);
  } finally {
    cleanup(scenario);
  }
});

test("a category switch left off keeps that event type undelivered", async () => {
  const scenario = notifyScenario({ channel: "browser", enabled: { conflict: true } });
  try {
    const root = await bindRoot(scenario);
    await scenario.runtime.syncRoot(root.id);
    const token = (await scenario.metaStorage.listBindings(root.id))[0]!.remoteToken!;
    // Diverge both sides: the round ends with a conflict and a credential-free
    // failure path, so only the conflict switch is on.
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nlocal edit", "utf8");
    scenario.remote.edit(token, "# Notes\n\nremote edit");
    await scenario.runtime.syncRoot(root.id);
    assert.ok(scenario.sink.events.length >= 1, "the conflict switch is on, so the conflict is announced");
    assert.deepEqual([...new Set(scenario.sink.events.map((event) => event.category))], ["conflict"]);
    assert.match(scenario.sink.events[0]?.title ?? "", /冲突/);
  } finally {
    cleanup(scenario);
  }
});

test("one conflict is announced once, not on every round", async () => {
  const scenario = notifyScenario({ channel: "browser", enabled: { conflict: true } });
  try {
    const root = await bindRoot(scenario);
    await scenario.runtime.syncRoot(root.id);
    const token = (await scenario.metaStorage.listBindings(root.id))[0]!.remoteToken!;
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nlocal edit", "utf8");
    scenario.remote.edit(token, "# Notes\n\nremote edit");
    await scenario.runtime.syncRoot(root.id);
    const announced = scenario.sink.events.length;
    assert.equal(announced, 1);
    await scenario.runtime.syncRoot(root.id);
    await scenario.runtime.syncRoot(root.id);
    assert.equal(scenario.sink.events.length, announced, "a long-running conflict must not spam the channel");
  } finally {
    cleanup(scenario);
  }
});

test("credential loss and recovery each announce once through the sink", async () => {
  const scenario = notifyScenario({ channel: "browser", enabled: { credential: true } });
  try {
    const root = await bindRoot(scenario);
    await scenario.runtime.syncRoot(root.id);
    scenario.remote.failWritesAuth = true;
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nsecond edit", "utf8");
    await scenario.runtime.syncRoot(root.id);
    const credential = scenario.sink.events.filter((event) => event.category === "credential");
    assert.equal(credential.length, 1);
    assert.match(credential[0]?.title ?? "", /已失效/);
    assert.equal((await scenario.config.getAuthFlag()).status, "invalid");

    // A repeated failure stays quiet: the flag was already raised.
    await scenario.runtime.syncRoot(root.id);
    assert.equal(scenario.sink.events.filter((event) => event.category === "credential").length, 1);

    scenario.remote.failWritesAuth = false;
    await scenario.runtime.syncRoot(root.id);
    const restored = scenario.sink.events.filter((event) => event.category === "credential").map((event) => event.title);
    assert.deepEqual(restored, ["飞书凭证已失效", "飞书凭证已恢复"]);
    assert.equal((await scenario.config.getAuthFlag()).status, "ok");
  } finally {
    cleanup(scenario);
  }
});

test("a failing sink never breaks a sync round", async () => {
  const exploding = new ExplodingSink();
  const scenario = notifyScenario({ channel: "browser", enabled: { failure: true }, sink: exploding });
  try {
    const root = await bindRoot(scenario);
    await scenario.runtime.syncRoot(root.id);
    writeFileSync(join(scenario.directory, "notes.md"), "# Notes\n\nsecond edit", "utf8");
    scenario.remote.failWrites = true;
    const result = (await scenario.runtime.syncRoot(root.id)) as { entries: Array<{ status: string }> };
    assert.equal(result.entries[0]?.status, "error", "the round completes and records the failure normally");
    assert.ok(exploding.attempts > 0, "the sink was still attempted");
  } finally {
    cleanup(scenario);
  }
});

test("LogSink maps a conflict to warn and everything else to info", async () => {
  const lines: Array<{ level: string; message: string }> = [];
  const sink = new LogSink((level, message) => lines.push({ level, message }));
  await sink.notify({ category: "conflict", title: "同步冲突：a.md", body: "b", at: "2026-01-01T00:00:00.000Z" });
  await sink.notify({ category: "failure", title: "同步失败：a.md", body: "b", at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(lines.map((line) => line.level), ["warn", "info"]);
  assert.match(lines[0]?.message ?? "", /notification\[conflict\]: 同步冲突：a\.md/);
  // NoopSink is the safe default and resolves without doing anything.
  await new NoopSink().notify({ category: "failure", title: "t", body: "b", at: "2026-01-01T00:00:00.000Z" });
});

test("the Feishu bot sink stays an explicit placeholder", async () => {
  const sink = new FeishuBotSink({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x" });
  await assert.rejects(sink.notify({ category: "failure", title: "t", body: "b", at: "2026-01-01T00:00:00.000Z" }), /placeholder/);
});
