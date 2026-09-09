import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 8787);
await app.runtime.start();
await app.eventChannel.start();
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
console.log(`Feishu Local Sync listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`);

// Graceful shutdown: close the HTTP server and stop watchers/timers.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await app.close(); } finally { process.exit(0); }
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
