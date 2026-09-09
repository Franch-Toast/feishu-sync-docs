/** Re-export the official SDK building blocks used by the server's event
 *  channel (WebSocket long connection + drive event dispatching). The SDK
 *  dependency itself is owned by this package, so downstream packages import
 *  these through @feishu-sync/feishu instead of resolving it directly. */
export { Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
