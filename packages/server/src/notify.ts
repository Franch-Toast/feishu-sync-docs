/**
 * Notification delivery port (D).
 *
 * The runtime used to push browser Notification API pop-ups straight from the
 * React app. That coupled "something noteworthy happened" to one specific
 * delivery mechanism, could not be tested, and could not be turned off. The
 * runtime now emits a `NotificationEvent` into a `NotificationSink`; which sink
 * exists, and whether it fires at all, is a server-side preference
 * (`notificationChannel` in config.json, default `none`).
 *
 * The WebSocket broadcast used by the badges and the task centre is a separate
 * concern and is unchanged — it drives UI state, not user attention.
 */

export type NotificationCategory = "conflict" | "failure" | "credential";

export interface NotificationEvent {
  category: NotificationCategory;
  title: string;
  body: string;
  rootId?: string;
  entryId?: string;
  /** ISO timestamp of the underlying occurrence. */
  at: string;
}

export interface NotificationSink {
  notify(event: NotificationEvent): Promise<void>;
}

/** Discards everything. The default, and what the runtime uses when no sink is
 *  injected (tests, bare `SyncRuntime` construction). */
export class NoopSink implements NotificationSink {
  async notify(): Promise<void> {
    // Intentionally empty: notifications are opt-in.
  }
}

/** Writes events to the server log. Useful for headless deployments where a
 *  log is the only surface available. */
export class LogSink implements NotificationSink {
  constructor(private readonly write: (level: "info" | "warn", message: string, data: Record<string, unknown>) => void = () => undefined) {}

  async notify(event: NotificationEvent): Promise<void> {
    this.write(event.category === "conflict" ? "warn" : "info", `notification[${event.category}]: ${event.title}`, {
      body: event.body,
      rootId: event.rootId,
      entryId: event.entryId
    });
  }
}

/** Per-category switches plus the selected channel decide whether an event is
 *  delivered at all. Kept as a pure function so the gating is testable without
 *  a runtime. */
export function shouldNotify(
  channel: string,
  enabled: Partial<Record<NotificationCategory, boolean>>,
  category: NotificationCategory
): boolean {
  if (channel === "none" || !channel) return false;
  return enabled[category] === true;
}
