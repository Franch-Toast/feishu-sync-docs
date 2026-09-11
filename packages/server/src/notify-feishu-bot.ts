import type { NotificationEvent, NotificationSink } from "./notify.js";

/**
 * Skeleton for Feishu bot notifications (D, deliberately not wired up).
 *
 * The port is `NotificationSink`; this is the implementation a future round
 * fills in. Nothing constructs it today and no channel value reaches it, so the
 * workbench stays silent by default while the extension point is real and
 * testable.
 *
 * To finish it:
 *   1. Create a custom bot in the target Feishu group and copy its webhook URL.
 *   2. If the group has 签名校验 enabled, keep the secret and sign each payload:
 *      `timestamp + "\n" + secret` as an HMAC-SHA256 *key*, signing the empty
 *      string, base64-encoded into the `sign` field.
 *   3. POST `{ msg_type: "text", content: { text } }` to the webhook and treat a
 *      non-zero `code` as a delivery failure (log it; never let a notification
 *      break a sync round).
 *   4. Register it in `buildServer` when `preferences.notificationChannel` is
 *      `"feishu-bot"`, and gate the per-category switches as the runtime already
 *      does for other channels.
 */
export interface FeishuBotSinkOptions {
  /** Group custom-bot webhook, e.g. https://open.feishu.cn/open-apis/bot/v2/hook/xxxx */
  webhookUrl: string;
  /** Signature secret configured on the bot, when 签名校验 is enabled. */
  secret?: string;
  /** Injectable fetch, so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export class FeishuBotSink implements NotificationSink {
  constructor(private readonly options: FeishuBotSinkOptions) {}

  async notify(event: NotificationEvent): Promise<void> {
    // TODO(feishu-bot): build the signed payload and POST it to
    // options.webhookUrl. Left unimplemented on purpose — the notification
    // channel is opt-in and out of scope for this round.
    void event;
    throw new Error("FeishuBotSink is a placeholder and is not enabled");
  }
}
