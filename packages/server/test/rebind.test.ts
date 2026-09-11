import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fs from "node:fs";
import { GitStorageImpl, JsonMetaStorage } from "@feishu-sync/storage";
import { buildApp } from "../src/app.js";
import { AppConfigStore } from "../src/appconfig.js";
import { FakeRemote } from "./helpers/fake-remote.js";

/**
 * G: re-binding a directory must never corrupt the metadata it owns.
 *
 * The `.feishu-sync/` directory belongs to the *directory*, not to one record, so
 * binding the same path twice used to create two roots that overwrote each
 * other's bindings, unbinding deleted a user's history, and a directory left over
 * from a deleted root restarted from zero next to a stale copy. Every one of
 * those is exercised here through the HTTP surface the workbench actually calls.
 */

interface Harness {
  app: ReturnType<typeof buildApp>;
  directory: string;
  globalDir: string;
  gitStorage: GitStorageImpl;
  metaStorage: JsonMetaStorage;
  remote: FakeRemote;
}

async function harness(): Promise<Harness> {
  const parent = await mkdtemp(join(tmpdir(), "feishu-sync-rebind-"));
  const globalDir = await mkdtemp(join(tmpdir(), "feishu-sync-rebind-global-"));
  const configDir = await mkdtemp(join(tmpdir(), "feishu-sync-rebind-config-"));
  const gitStorage = new GitStorageImpl();
  const metaStorage = new JsonMetaStorage(globalDir);
  const remote = new FakeRemote();
  const app = buildApp({ remote, gitStorage, metaStorage, appConfig: new AppConfigStore(join(configDir, "config.json")) });
  return { app, directory: join(parent, "docs"), globalDir, gitStorage, metaStorage, remote };
}

/** Create the candidate directory lazily so the temp parent stays per-test. */
async function prepare(scenario: Harness, files: Record<string, string> = {}): Promise<string> {
  await mkdir(scenario.directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(scenario.directory, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return scenario.directory;
}

async function teardown(scenario: Harness): Promise<void> {
  await scenario.app.close();
  await rm(join(scenario.directory, ".."), { recursive: true, force: true });
  await rm(scenario.globalDir, { recursive: true, force: true });
}

async function bind(scenario: Harness, payload: Record<string, unknown> = {}) {
  return scenario.app.inject({
    method: "POST",
    url: "/api/roots",
    payload: { localPath: scenario.directory, remoteToken: "root-token", ...payload }
  });
}

function backups(metaDir: string): string[] {
  return existsSync(metaDir) ? fs.readdirSync(metaDir).filter((name) => name.startsWith("backup-")) : [];
}

/** The repositories under test are seeded with the real `git` so they look like
 *  what a user actually hands us (the sync itself still uses isomorphic-git). */
const exec = promisify(execFile);
async function runGit(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function commitAsUser(dir: string, message: string): Promise<string> {
  await exec("git", ["-C", dir, "-c", "user.name=User", "-c", "user.email=user@example.com", "commit", "-m", message], { encoding: "utf8" });
  return runGit(dir, "rev-parse", "HEAD");
}

async function validatePath(scenario: Harness, path: string) {
  const response = await scenario.app.inject({ method: "GET", url: `/api/roots/validate-path?path=${encodeURIComponent(path)}` });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json()));
  return response.json() as {
    ok: boolean; documents: number; total: number; writable: boolean;
    hasGit: boolean; gitBranch?: string; hasMeta: boolean; metaRootId?: string; metaIgnored: boolean;
    orphanMeta: boolean; boundRootId?: string;
  };
}

test("G1: binding the same directory again reuses the root and its metadata", async () => {
  const scenario = await harness();
  try {
    await prepare(scenario, { "notes.md": "# Notes\n\nshared\n" });
    const created = await bind(scenario);
    assert.equal(created.statusCode, 201);
    const rootId = created.json().id as string;
    await scenario.app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(scenario.remote.documents.size, 1);
    const before = await scenario.metaStorage.listBindings(rootId);
    assert.equal(before.length, 1);

    // The same directory reached with a trailing `/.` is the same directory.
    const again = await bind(scenario, { localPath: `${scenario.directory}/.`, remoteToken: "root-token", pollIntervalMs: 30_000 });
    assert.equal(again.statusCode, 200, "a reused binding is not a creation");
    assert.equal(again.json().reused, true, "and the caller is told so");
    assert.equal(again.json().root.id, rootId);
    assert.equal(again.json().root.pollIntervalMs, 30_000, "the new intent still wins");
    assert.equal((await scenario.app.inject({ method: "GET", url: "/api/roots" })).json().length, 1, "no second record");

    // …so the metadata directory is untouched: no takeover, no migration backup,
    // and the first round's binding is still the only one.
    assert.deepEqual(backups(join(scenario.directory, ".feishu-sync")), []);
    assert.deepEqual((await scenario.metaStorage.listBindings(rootId)).map((entry) => entry.remoteToken), before.map((entry) => entry.remoteToken));

    // A round after the re-bind must not produce a second remote document.
    await scenario.app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(scenario.remote.documents.size, 1);
    assert.equal((await scenario.metaStorage.listBindings(rootId)).length, 1);
  } finally {
    await teardown(scenario);
  }
});

test("G1: moving a root onto another root's directory is refused with the occupant", async () => {
  const scenario = await harness();
  const other = await mkdtemp(join(tmpdir(), "feishu-sync-rebind-other-"));
  try {
    await prepare(scenario, { "notes.md": "# Notes\n" });
    const first = (await bind(scenario)).json();
    const second = await scenario.app.inject({ method: "POST", url: "/api/roots", payload: { localPath: other, remoteToken: "root-token-b" } });
    assert.equal(second.statusCode, 201);

    const clash = await scenario.app.inject({ method: "PATCH", url: `/api/roots/${second.json().id}`, payload: { localPath: scenario.directory } });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().error, "该目录已被另一个同步根绑定");
    assert.equal(clash.json().boundRootId, first.id, "the UI has to be able to name the occupant");

    // Re-stating a root's own path is not a clash.
    const same = await scenario.app.inject({ method: "PATCH", url: `/api/roots/${first.id}`, payload: { localPath: scenario.directory, enabled: false } });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().enabled, false);
  } finally {
    await rm(other, { recursive: true, force: true });
    await teardown(scenario);
  }
});

test("G6: validate-path reports what a directory already carries", async () => {
  const scenario = await harness();
  try {
    const directory = await prepare(scenario, { "notes.md": "# Notes\n" });

    const fresh = await validatePath(scenario, directory);
    assert.deepEqual(
      { hasGit: fresh.hasGit, hasMeta: fresh.hasMeta, orphanMeta: fresh.orphanMeta, metaIgnored: fresh.metaIgnored, boundRootId: fresh.boundRootId, documents: fresh.documents },
      { hasGit: false, hasMeta: false, orphanMeta: false, metaIgnored: false, boundRootId: undefined, documents: 1 }
    );
    assert.equal(fresh.writable, true);
    assert.equal(fresh.total, 1);

    const rootId = (await bind(scenario)).json().id as string;
    const bound = await validatePath(scenario, directory);
    assert.equal(bound.hasGit, true, "binding created the repository");
    assert.equal(bound.gitBranch, "main");
    assert.equal(bound.hasMeta, true);
    assert.equal(bound.metaIgnored, true, "and ignored it straight away");
    assert.equal(bound.boundRootId, rootId);
    assert.equal(bound.orphanMeta, false);

    // A directory that is somebody else's repository is reported as such, so the
    // form can warn before it touches anything.
    const foreign = await mkdtemp(join(tmpdir(), "feishu-sync-rebind-foreign-"));
    await runGit(foreign, "init", "-b", "master");
    const probe = await validatePath(scenario, foreign);
    assert.deepEqual({ hasGit: probe.hasGit, gitBranch: probe.gitBranch, hasMeta: probe.hasMeta }, { hasGit: true, gitBranch: "master", hasMeta: false });
    await rm(foreign, { recursive: true, force: true });
  } finally {
    await teardown(scenario);
  }
});

test("G5: unbinding backs the metadata up and leaves the user's data alone", async () => {
  const scenario = await harness();
  try {
    await prepare(scenario, { "notes.md": "# Notes\n\nkept\n" });
    const rootId = (await bind(scenario)).json().id as string;
    const sync = await scenario.app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal((sync.json().entries as Array<{ status: string }>)[0]?.status, "clean");

    const removed = await scenario.app.inject({ method: "DELETE", url: `/api/roots/${rootId}` });
    assert.equal(removed.statusCode, 204);
    assert.equal((await scenario.app.inject({ method: "GET", url: "/api/roots" })).json().length, 0);

    // Nothing was destroyed: the working tree, the repository and a readable copy
    // of the sync state are all still there.
    assert.equal(await readFile(join(scenario.directory, "notes.md"), "utf8"), "# Notes\n\nkept\n");
    assert.ok(existsSync(join(scenario.directory, ".git")), "the git history is never deleted");
    const metaDir = join(scenario.directory, ".feishu-sync");
    const archived = backups(metaDir);
    assert.equal(archived.length, 1, archived.join(","));
    const bindings = JSON.parse(await readFile(join(metaDir, archived[0]!, "bindings.json"), "utf8")) as Record<string, { remoteToken: string }>;
    assert.equal(Object.values(bindings)[0]?.remoteToken, "root-token/notes", "the binding is recoverable from the backup");
    assert.equal(existsSync(join(metaDir, "bindings.json")), false, "the live copy moved away, it was not deleted");
  } finally {
    await teardown(scenario);
  }
});

test("G2/G3: taking over an orphan .feishu-sync keeps bindings and pairs without duplicating", async () => {
  const scenario = await harness();
  try {
    await prepare(scenario, { "notes.md": "# Notes\n\nshared\n" });
    const oldRootId = (await bind(scenario)).json().id as string;
    await scenario.app.inject({ method: "POST", url: `/api/roots/${oldRootId}/sync` });
    const token = (await scenario.metaStorage.listBindings(oldRootId))[0]?.remoteToken;
    assert.ok(token);

    // The pre-G1 world: the record is gone but its metadata directory survived.
    await rm(join(scenario.globalDir, "roots.json"), { force: true });
    const orphan = await validatePath(scenario, scenario.directory);
    assert.equal(orphan.orphanMeta, true, "the bind form must see the orphan");
    assert.equal(orphan.metaRootId, oldRootId);
    assert.equal(orphan.boundRootId, undefined);

    const taken = await bind(scenario);
    assert.equal(taken.statusCode, 201);
    const newRootId = taken.json().id as string;
    assert.notEqual(newRootId, oldRootId);

    // 接管: the history is rewritten onto the new root instead of being rebuilt.
    const inherited = await scenario.metaStorage.listBindings(newRootId);
    assert.equal(inherited.length, 1);
    assert.equal(inherited[0]?.remoteToken, token);
    assert.equal(inherited[0]?.rootId, newRootId, "every record points at the living root now");
    const metaDir = join(scenario.directory, ".feishu-sync");
    assert.equal(backups(metaDir).length, 1, "the originals were copied, not moved");
    assert.equal((await validatePath(scenario, scenario.directory)).orphanMeta, false);

    // The first round after the takeover must pair with the existing document —
    // the bug this whole section exists to close was a second, orphaned copy.
    await scenario.app.inject({ method: "POST", url: `/api/roots/${newRootId}/sync` });
    assert.equal(scenario.remote.documents.size, 1);
    assert.deepEqual([...scenario.remote.documents.keys()], [token]);
    assert.equal((await scenario.metaStorage.listBindings(newRootId))[0]?.status, "clean");
    assert.equal(
      (await scenario.metaStorage.listOperations({ rootId: newRootId })).some((record) => record.rootId === newRootId),
      true,
      "operation history is readable too"
    );
  } finally {
    await teardown(scenario);
  }
});

test("G3: choosing 重新绑定 archives the orphan and starts from an empty slate", async () => {
  const scenario = await harness();
  try {
    await prepare(scenario, { "notes.md": "# Notes\n\nshared\n" });
    const oldRootId = (await bind(scenario)).json().id as string;
    await scenario.app.inject({ method: "POST", url: `/api/roots/${oldRootId}/sync` });
    await rm(join(scenario.globalDir, "roots.json"), { force: true });

    const rebound = await bind(scenario, { metadataAction: "reset" });
    assert.equal(rebound.statusCode, 201);
    assert.equal(rebound.json().metadataArchived, true);
    const rootId = rebound.json().id as string;
    assert.equal((await scenario.metaStorage.listBindings(rootId)).length, 0, "the stale bindings were not adopted");
    assert.equal(backups(join(scenario.directory, ".feishu-sync")).length, 1);

    // Starting from zero still must not create a second document: the unbound
    // remote copy is paired instead (B3 scenario 3).
    await scenario.app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    assert.equal(scenario.remote.documents.size, 1);
    assert.equal((await scenario.metaStorage.listBindings(rootId))[0]?.remoteToken, "root-token/notes");
  } finally {
    await teardown(scenario);
  }
});

test("G3: an invalid metadataAction is a client error, not a silent adopt", async () => {
  const scenario = await harness();
  try {
    await prepare(scenario);
    const rejected = await bind(scenario, { metadataAction: "yolo" });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error, "metadataAction must be one of adopt, reset");
    assert.equal((await scenario.app.inject({ method: "GET", url: "/api/roots" })).json().length, 0);
  } finally {
    await teardown(scenario);
  }
});

test("G4: binding a repository the user brought keeps their branch and untracks the metadata", async () => {
  const scenario = await harness();
  try {
    const directory = await prepare(scenario, { "notes.md": "# Notes\n\nmine\n" });
    // A pre-existing repository on `master`, with its own ignore rules and the
    // metadata committed by an older build.
    await runGit(directory, "init", "-b", "master");
    await writeFile(join(directory, ".gitignore"), "# mine\nbuild/\n", "utf8");
    await mkdir(join(directory, ".feishu-sync"), { recursive: true });
    await writeFile(join(directory, ".feishu-sync", "bindings.json"), JSON.stringify({ "stale.md": { entryId: "x" } }), "utf8");
    await runGit(directory, "add", ".gitignore", "notes.md", ".feishu-sync/bindings.json");
    const userCommit = await commitAsUser(directory, "user commit");

    const rootId = (await bind(scenario)).json().id as string;
    const ignore = await readFile(join(directory, ".gitignore"), "utf8");
    assert.ok(ignore.includes("# mine") && ignore.includes("build/"), "the user's rules are intact");
    assert.ok(ignore.includes(".feishu-sync/"), "ours were appended");

    const tracked = (await runGit(directory, "ls-files")).split("\n");
    assert.equal(tracked.some((file) => file.startsWith(".feishu-sync/")), false, "the tracked metadata was untracked");
    assert.ok(tracked.includes("notes.md"), "user files stay tracked");
    const subject = await runGit(directory, "log", "-1", "--format=%s");
    assert.equal(subject, "chore: untrack feishu-sync metadata");
    assert.equal(await runGit(directory, "rev-parse", "HEAD^"), userCommit, "on top of the user's own history");
    const head = await runGit(directory, "rev-parse", "HEAD");
    assert.equal(await scenario.gitStorage.getBaselineCommit(rootId), head, "and the baseline still resolves on master");
    await assert.rejects(() => runGit(directory, "rev-parse", "--verify", "refs/heads/main"), "no phantom main branch");

    // A local edit has to land in a commit on the user's own branch; without a
    // change there is nothing to commit and HEAD must not move at all.
    await writeFile(join(directory, "notes.md"), "# Notes\n\nmine\n\na new line\n", "utf8");
    await scenario.app.inject({ method: "POST", url: `/api/roots/${rootId}/sync` });
    const committed = await scenario.gitStorage.getBaselineCommit(rootId);
    assert.notEqual(committed, undefined);
    assert.notEqual(committed, head, "the sync committed on the same line the user works on");
    assert.equal(await runGit(directory, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    assert.equal(await readFile(join(directory, "notes.md"), "utf8"), "# Notes\n\nmine\n\na new line\n");
  } finally {
    await teardown(scenario);
  }
});
