import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import type { SyncRoot } from "@feishu-sync/core";
import { EchoGuard } from "../src/echo_guard.js";

const root: SyncRoot = { id: "root", localPath: "/tmp/tree", remoteToken: "root", remoteType: "folder", enabled: true, pollIntervalMs: 60_000 };

test("EchoGuard marks just-written local paths and just-pushed tokens as echoes", () => {
  const guard = new EchoGuard();
  const absolute = join(root.localPath, "notes.md");
  assert.equal(guard.isRecentLocalWrite(absolute), false, "unknown paths are not echoes");
  assert.equal(guard.isRecentRemotePush("tok-1"), false);

  guard.registerLocalWrite(root, "notes.md");
  guard.registerRemotePush("tok-1");

  assert.equal(guard.isRecentLocalWrite(absolute), true, "a fresh pull-write is remembered");
  assert.equal(guard.isRecentRemotePush("tok-1"), true, "a fresh push token is remembered");
  // The local marker is absolute-path keyed; a different path stays unaffected.
  assert.equal(guard.isRecentLocalWrite(join(root.localPath, "other.md")), false);
  assert.equal(guard.isRecentRemotePush("tok-2"), false);
});

test("EchoGuard drops an echo once its TTL has elapsed", async () => {
  const guard = new EchoGuard();
  guard.registerRemotePush("tok-1");
  assert.equal(guard.isRecentRemotePush("tok-1"), true);
  // The TTL is 5s; reach past it by pre-seeding a re-registration far in the
  // past rather than sleeping, keeping the test fast and deterministic.
  const internal = guard as unknown as { recentRemotePushes: Map<string, number> };
  internal.recentRemotePushes.set("tok-1", Date.now() - 1);
  assert.equal(guard.isRecentRemotePush("tok-1"), false, "an expired echo is treated as gone");
});
