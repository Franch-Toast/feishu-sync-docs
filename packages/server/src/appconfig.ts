import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Log verbosity levels accepted for the global preference. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfigPreferences {
  /** Poll interval applied when a root is created without an explicit one. */
  defaultPollIntervalMs: number;
  logLevel: LogLevel;
  /** Which in-app notifications are enabled (B6.8). Stored server-side so the
   *  preference follows the user across browsers instead of per-device
   *  localStorage. No sound option is provided (explicitly out of scope). */
  notifications: NotificationPreferences;
}

/** Per-category notification toggles (B6.8). */
export interface NotificationPreferences {
  conflict: boolean;
  failure: boolean;
  credential: boolean;
}

/** Full config.json shape. Credentials live next to the global preferences so
 *  the config file stays the single source of truth (user decision: "并入 config.json"). */
export interface AppConfigDocument {
  version: 1;
  credentials: Record<string, string>;
  preferences: AppConfigPreferences;
}

export const DEFAULT_NOTIFICATIONS: NotificationPreferences = { conflict: true, failure: true, credential: true };
export const DEFAULT_PREFERENCES: AppConfigPreferences = { defaultPollIntervalMs: 15000, logLevel: "info", notifications: { ...DEFAULT_NOTIFICATIONS } };
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Auth lifecycle flags: shared literal keys so the runtime, the credential
 *  store and config.json stay in sync without a circular import. */
export const AUTH_FLAG_KEYS = { status: "feishu.authStatus", checkedAt: "feishu.authCheckedAt" } as const;

/** Data directory: the directory of SYNC_CONFIG_PATH when set, else ~/.feishu-sync-docs. */
export function resolveAppDataDir(): string {
  const configured = process.env.SYNC_CONFIG_PATH;
  if (configured) return dirname(resolve(configured));
  return join(homedir(), ".feishu-sync-docs");
}

/** Auth flag storage consumed by the runtime (previously the settings table;
 *  now part of config.json credentials). */
export interface AuthStateStore {
  getAuthFlag(): Promise<{ status?: string; checkedAt?: string }>;
  setAuthFlag(status: "ok" | "invalid", checkedAt: string): Promise<void>;
}

/** Read-write view over config.json: global preferences plus Feishu
 *  credentials. Writes are atomic (tmp file + rename) and the file is chmod
 *  0600 because it stores tokens in plain text, documented in the README. */
export class AppConfigStore implements AuthStateStore {
  readonly configPath: string;
  private cache: AppConfigDocument | undefined;

  constructor(configPath?: string) {
    this.configPath = configPath ?? process.env.SYNC_CONFIG_PATH ?? join(homedir(), ".feishu-sync-docs", "config.json");
  }

  get preferences(): AppConfigPreferences {
    const stored = this.doc().preferences;
    return { ...DEFAULT_PREFERENCES, ...stored, notifications: { ...DEFAULT_NOTIFICATIONS, ...stored.notifications } };
  }

  /** Validate and persist a preferences patch; returns the effective values. */
  async setPreferences(patch: { defaultPollIntervalMs?: number; logLevel?: LogLevel; notifications?: Partial<NotificationPreferences> }): Promise<AppConfigPreferences> {
    const doc = this.doc();
    if (patch.defaultPollIntervalMs !== undefined) {
      const value = patch.defaultPollIntervalMs;
      if (!Number.isFinite(value) || value < 1000) {
        throw Object.assign(new Error("defaultPollIntervalMs must be at least 1000ms"), { statusCode: 400 });
      }
      doc.preferences.defaultPollIntervalMs = Math.round(value);
    }
    if (patch.logLevel !== undefined) {
      if (!LOG_LEVELS.includes(patch.logLevel)) {
        throw Object.assign(new Error(`logLevel must be one of ${LOG_LEVELS.join(", ")}`), { statusCode: 400 });
      }
      doc.preferences.logLevel = patch.logLevel;
    }
    if (patch.notifications !== undefined) {
      doc.preferences.notifications = { ...DEFAULT_NOTIFICATIONS, ...doc.preferences.notifications, ...patch.notifications };
    }
    this.flush();
    return this.preferences;
  }

  /** All credential keys (feishu.* style) as a flat map. */
  async getCredentials(): Promise<Record<string, string>> {
    return { ...this.doc().credentials };
  }

  async getCredential(key: string): Promise<string | undefined> {
    return this.doc().credentials[key];
  }

  /** Persist credential key/value pairs. undefined deletes the key; an empty
   *  string is stored as-is (matching the previous setSetting semantics). */
  async setCredentials(pairs: Array<[string, string | undefined]>): Promise<void> {
    if (pairs.length === 0) return;
    const credentials = this.doc().credentials;
    for (const [key, value] of pairs) {
      if (value === undefined) delete credentials[key];
      else credentials[key] = value;
    }
    this.flush();
  }

  async getAuthFlag(): Promise<{ status?: string; checkedAt?: string }> {
    const credentials = this.doc().credentials;
    return { status: credentials[AUTH_FLAG_KEYS.status], checkedAt: credentials[AUTH_FLAG_KEYS.checkedAt] };
  }

  async setAuthFlag(status: "ok" | "invalid", checkedAt: string): Promise<void> {
    await this.setCredentials([[AUTH_FLAG_KEYS.status, status], [AUTH_FLAG_KEYS.checkedAt, checkedAt]]);
  }

  /** Parse config.json once per process; missing file means pure defaults. */
  private doc(): AppConfigDocument {
    if (this.cache) return this.cache;
    let doc: AppConfigDocument = { version: 1, credentials: {}, preferences: { ...DEFAULT_PREFERENCES, notifications: { ...DEFAULT_NOTIFICATIONS } } };
    try {
      if (existsSync(this.configPath)) {
        const raw = JSON.parse(readFileSync(this.configPath, "utf-8")) as Partial<AppConfigDocument>;
        doc = {
          version: 1,
          credentials: { ...raw.credentials },
          preferences: { ...DEFAULT_PREFERENCES, ...raw.preferences, notifications: { ...DEFAULT_NOTIFICATIONS, ...raw.preferences?.notifications } }
        };
      }
    } catch {
      // Corrupt file: fall back to defaults; the next save rewrites it.
    }
    this.cache = doc;
    return doc;
  }

  /** Atomic write: serialize to a sibling tmp file, then rename over the target. */
  private flush(): void {
    const doc = this.doc();
    mkdirSync(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    renameSync(tmp, this.configPath);
    try { chmodSync(this.configPath, 0o600); } catch { /* chmod is best-effort (e.g. Windows). */ }
  }
}
