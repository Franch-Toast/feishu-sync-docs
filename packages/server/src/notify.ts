/**
 * Notification hook for the sync runtime: conflicts, repeated task failures
 * and credential problems are announced through this interface. The default
 * notifier is a no-op — the web UI already surfaces the same events in the
 * task center and the conflict workbench, so nothing is pushed externally
 * today. A Feishu-bot notifier can be dropped in later without touching the
 * runtime (see the commented stub at the bottom).
 */

export interface NotificationEvent {
  category: "conflict" | "failure" | "credential";
  title: string;
  body: string;
  rootId?: string;
  entryId?: string;
  at: string;
}

export interface Notifier {
  send(event: NotificationEvent): Promise<void>;
}

/** Current default: events stay in-app, no external notification is sent. */
export class NoopNotifier implements Notifier {
  async send(_event: NotificationEvent): Promise<void> {}
}

// Future replacement, kept as a sketch: forward events to a Feishu custom
// bot webhook configured in the target group.
// export class FeishuWebhookNotifier implements Notifier {
//   constructor(private readonly webhookUrl: string) {}
//   async send(event: NotificationEvent): Promise<void> {
//     await fetch(this.webhookUrl, {
//       method: "POST",
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify({ msg_type: "text", content: { text: `[${event.category}] ${event.title}\n${event.body}` } })
//     });
//   }
// }
