import { buildApp } from "./app.js";

const app = buildApp();
const port = Number(process.env.PORT ?? 8787);
await app.runtime.start();
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
console.log(`Feishu Local Sync listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`);
