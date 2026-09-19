import assert from "node:assert/strict";
import test from "node:test";
import { TaskQueue } from "../src/task_queue.js";

/**
 * Concurrency guarantees of the per-root serial lane (task_queue.ts):
 * - tasks sharing an id never overlap (a root's read/modify/write stays atomic);
 * - tasks under different ids run in parallel (one busy root never blocks another).
 */

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("tasks on the same lane run strictly serially, never interleaved", async () => {
  const queue = new TaskQueue(() => {});
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;

  const makeTask = (label: string) => async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${label}:start`);
    // Several awaits inside a task: a second task must NOT be able to slip in.
    await tick();
    await tick();
    order.push(`${label}:end`);
    active -= 1;
  };

  const lanes = ["a", "b", "c"].map((id) => queue.enqueue(`root`, makeTask(id)));
  await Promise.all(lanes);

  assert.equal(maxActive, 1, "only one task per lane is ever active");
  // Serialized in queue order: each start is immediately followed by its end.
  assert.deepEqual(order, [
    "a:start", "a:end",
    "b:start", "b:end",
    "c:start", "c:end"
  ]);
});

test("tasks on different lanes run concurrently and never block each other", async () => {
  const queue = new TaskQueue(() => {});
  const release: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;

  const blockingTask = (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => {
      release.push(() => { active -= 1; resolve(); });
    });
  };

  const first = queue.enqueue("root-1", blockingTask);
  const second = queue.enqueue("root-2", blockingTask);
  // Let both microtasks drain so each lane starts its blocking task.
  await tick();
  await tick();
  assert.equal(maxActive, 2, "two distinct roots run at the same time");

  release.forEach((done) => done());
  await Promise.all([first, second]);
});

test("a failing task is reported and does not wedge later tasks on the lane", async () => {
  const failures: Array<{ id: string; message: string }> = [];
  const queue = new TaskQueue((id, error) => {
    failures.push({ id, message: error instanceof Error ? error.message : String(error) });
  });

  const fired = queue.enqueue("root", async () => { throw new Error("boom"); });
  const after = await queue.enqueueResult("root", async () => "recovered");

  await fired;
  assert.equal(after, "recovered", "the next task still runs after a failure");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.id, "root");
  assert.equal(failures[0]?.message, "boom");
});
