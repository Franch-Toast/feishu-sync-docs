/**
 * Per-root serial task queue.
 *
 * Every root gets one logical lane: a scheduled callback only starts after the
 * previously queued callback for the same root settles, so two sync rounds can
 * never interleave their read/modify/write against the same tree. Different
 * roots have independent lanes and still run concurrently.
 *
 * Two entry points share the same lane map:
 * - {@link enqueue} is fire-and-forget (watcher/poll tasks): the lane promise
 *   swallows errors and reports them through the injected `onError` handler, so
 *   a failing task never wedges the lane for the tasks queued behind it.
 * - {@link enqueueResult} is for API routes that await a value: the caller gets
 *   the result or the thrown error, while the stored lane promise still absorbs
 *   the rejection to preserve fire-and-forget semantics for later tasks.
 */
export class TaskQueue {
  private readonly queues = new Map<string, Promise<void>>();

  /** `onError` reports a fire-and-forget task failure (log + broadcast). */
  constructor(private readonly onError: (id: string, error: unknown) => void) {}

  enqueue(id: string, callback: () => Promise<unknown>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(() => callback()).then(() => undefined).catch((error) => {
      this.onError(id, error);
    });
    this.queues.set(id, next);
    return next;
  }

  enqueueResult<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(() => callback());
    this.queues.set(id, result.then(() => undefined).catch((error) => {
      this.onError(id, error);
    }));
    return result;
  }
}
