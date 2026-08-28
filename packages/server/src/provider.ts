import { FeishuOpenApiProvider, LarkCliProvider } from "@feishu-sync/feishu";
import type { RemoteProvider } from "@feishu-sync/core";

export function createRemoteProvider(): RemoteProvider {
  if ((process.env.FEISHU_PROVIDER ?? "openapi") === "cli") return new LarkCliProvider({ executable: process.env.LARK_CLI_PATH, apiVersion: process.env.LARK_CLI_API_VERSION === "v2" ? "v2" : "v1" });
  return new FeishuOpenApiProvider({ accessToken: process.env.FEISHU_ACCESS_TOKEN, appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, baseUrl: process.env.FEISHU_BASE_URL });
}
