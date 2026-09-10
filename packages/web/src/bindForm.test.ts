import { afterEach, describe, expect, it, vi } from "vitest";
import { api, formatDurationMs, formatElapsed, type ValidateTokenResult } from "./api";
import { describePathCheck, describeTokenProblem, toCreateRootInput, validateBindForm, type BindFormValues } from "./components/BindRootForm";
import { describeExcludePatterns, formatExcludePatterns, parseExcludePatterns } from "./exclude";

function values(overrides: Partial<BindFormValues> = {}): BindFormValues {
  return { localPath: "/home/me/docs", remoteToken: "fldcnABC123", remoteType: "folder", intervalSec: "", mode: "bidirectional", exclude: "", ...overrides };
}

describe("validateBindForm", () => {
  it("accepts a complete, well-formed submission", () => {
    expect(validateBindForm(values())).toEqual({});
  });

  it("requires a local path and rejects relative paths", () => {
    expect(validateBindForm(values({ localPath: "" })).localPath).toBeTruthy();
    expect(validateBindForm(values({ localPath: "   " })).localPath).toBeTruthy();
    expect(validateBindForm(values({ localPath: "docs/notes" })).localPath).toBeTruthy();
  });

  it("accepts unix and windows absolute paths", () => {
    expect(validateBindForm(values({ localPath: "/var/data/docs" })).localPath).toBeUndefined();
    expect(validateBindForm(values({ localPath: "C:\\Users\\me\\docs" })).localPath).toBeUndefined();
  });

  it("requires a remote token and rejects tokens with whitespace", () => {
    expect(validateBindForm(values({ remoteToken: "" })).remoteToken).toBeTruthy();
    expect(validateBindForm(values({ remoteToken: "fld cnABC" })).remoteToken).toBeTruthy();
    expect(validateBindForm(values({ remoteToken: " fldcnABC " })).remoteToken).toBeUndefined();
  });

  it("treats an empty interval as valid (falls back to the global default)", () => {
    expect(validateBindForm(values({ intervalSec: "" })).intervalSec).toBeUndefined();
    expect(validateBindForm(values({ intervalSec: "   " })).intervalSec).toBeUndefined();
  });

  it("rejects a non-positive or non-numeric interval", () => {
    expect(validateBindForm(values({ intervalSec: "0" })).intervalSec).toBeTruthy();
    expect(validateBindForm(values({ intervalSec: "-5" })).intervalSec).toBeTruthy();
    expect(validateBindForm(values({ intervalSec: "abc" })).intervalSec).toBeTruthy();
    expect(validateBindForm(values({ intervalSec: "30" })).intervalSec).toBeUndefined();
  });
});

describe("toCreateRootInput", () => {
  it("trims text fields and passes the mode through", () => {
    const input = toCreateRootInput(values({ localPath: "  /data/docs  ", remoteToken: "  fldcnXYZ  ", mode: "pull-only" }));
    expect(input).toEqual({ localPath: "/data/docs", remoteToken: "fldcnXYZ", remoteType: "folder", pollIntervalMs: undefined, mode: "pull-only", exclude: undefined });
  });

  it("converts a valid interval to milliseconds and drops an invalid one", () => {
    expect(toCreateRootInput(values({ intervalSec: "30" })).pollIntervalMs).toBe(30000);
    expect(toCreateRootInput(values({ intervalSec: "" })).pollIntervalMs).toBeUndefined();
    expect(toCreateRootInput(values({ intervalSec: "0" })).pollIntervalMs).toBeUndefined();
  });

  it("parses the exclude textarea into globs and omits the field when empty (B6.5)", () => {
    expect(toCreateRootInput(values({ exclude: "" })).exclude).toBeUndefined();
    expect(toCreateRootInput(values({ exclude: "   \n  " })).exclude).toBeUndefined();
    expect(toCreateRootInput(values({ exclude: "drafts\ntmp-*.md" })).exclude).toEqual(["drafts", "tmp-*.md"]);
    expect(toCreateRootInput(values({ exclude: "drafts, tmp-*.md ; drafts" })).exclude).toEqual(["drafts", "tmp-*.md"]);
  });
});

describe("exclude pattern helpers", () => {
  it("round-trips patterns through the textarea", () => {
    expect(formatExcludePatterns(parseExcludePatterns("a\nb"))).toBe("a\nb");
    expect(formatExcludePatterns(undefined)).toBe("");
    expect(parseExcludePatterns(formatExcludePatterns(["x", "y/z"]))).toEqual(["x", "y/z"]);
  });

  it("summarizes the effective rule count", () => {
    expect(describeExcludePatterns([])).toContain("未设置");
    expect(describeExcludePatterns(["drafts"])).toBe("1 条规则生效：drafts");
    expect(describeExcludePatterns(["a", "b", "c", "d"])).toContain("等 4 条");
  });
});

describe("formatElapsed", () => {
  it("returns a dash when either timestamp is missing", () => {
    expect(formatElapsed(undefined, undefined)).toBe("—");
    expect(formatElapsed("2024-01-01T00:00:00.000Z", undefined)).toBe("—");
  });

  it("formats sub-second, second and minute durations", () => {
    expect(formatElapsed("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.250Z")).toBe("250 毫秒");
    expect(formatElapsed("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:02.500Z")).toBe("2.5 秒");
    expect(formatElapsed("2024-01-01T00:00:00.000Z", "2024-01-01T00:02:05.000Z")).toBe("2 分 5 秒");
  });

  it("returns a dash for a negative span (clock skew)", () => {
    expect(formatElapsed("2024-01-01T00:00:05.000Z", "2024-01-01T00:00:00.000Z")).toBe("—");
  });
});

describe("describePathCheck (B5 local directory probe)", () => {
  it("summarises a usable directory with its syncable file counts", () => {
    expect(describePathCheck({ ok: true, path: "/docs", documents: 3, assets: 0, total: 3, exclude: [], writable: true }))
      .toBe("✓ 目录可用 · 3 篇 Markdown");
    expect(describePathCheck({ ok: true, path: "/docs", documents: 3, assets: 2, total: 5, exclude: [], writable: true }))
      .toBe("✓ 目录可用 · 3 篇 Markdown、2 张图片");
  });

  it("mentions applied exclude rules and warns about a read-only directory", () => {
    expect(describePathCheck({ ok: true, path: "/docs", documents: 2, assets: 0, total: 2, exclude: ["drafts/**"], writable: true }))
      .toBe("✓ 目录可用 · 2 篇 Markdown，已按 1 条规则排除");
    expect(describePathCheck({ ok: true, path: "/docs", documents: 2, assets: 0, total: 2, exclude: [], writable: false }))
      .toContain("⚠ 不可写");
  });

  it("explains a rejected path in Chinese instead of leaking the raw Node error", () => {
    // The probe answers with structured flags plus an English error string; the
    // form must translate the flags so the whole UI stays one language.
    expect(describePathCheck({ ok: false, path: "/nope", exists: false, isDirectory: false, error: "directory does not exist" }))
      .toBe("✗ 无法使用：目录不存在，请检查路径");
    expect(describePathCheck({ ok: false, path: "/etc/hosts", exists: true, isDirectory: false, error: "path is not a directory" }))
      .toBe("✗ 无法使用：该路径不是目录");
    expect(describePathCheck({ ok: false, path: "/locked", exists: true, isDirectory: true, writable: false, error: "EACCES" }))
      .toBe("✗ 无法使用：目录不可写，同步将无法落盘");
    // No usable flag: fall back to whatever the server said, then to a default.
    expect(describePathCheck({ ok: false, path: "/odd", exists: true, isDirectory: true, error: "scan blew up" }))
      .toBe("✗ 无法使用：scan blew up");
    expect(describePathCheck({ ok: false })).toBe("✗ 无法使用：未知错误");
  });
});

describe("formatDurationMs (B6.6 durations, B6.2 tally)", () => {
  it("renders zero and sub-second spans in milliseconds", () => {
    expect(formatDurationMs(0)).toBe("0 毫秒");
    expect(formatDurationMs(1)).toBe("1 毫秒");
    expect(formatDurationMs(999)).toBe("999 毫秒");
  });

  it("switches to seconds with one decimal, then to minutes", () => {
    expect(formatDurationMs(1000)).toBe("1.0 秒");
    expect(formatDurationMs(1234)).toBe("1.2 秒");
    expect(formatDurationMs(59_999)).toBe("60.0 秒");
    expect(formatDurationMs(60_000)).toBe("1 分 0 秒");
    expect(formatDurationMs(125_000)).toBe("2 分 5 秒");
  });

  it("guards against negative and non-finite input", () => {
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(Number.NaN)).toBe("—");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

/** Answer a probe with an arbitrary status + JSON body, the way the server does
 *  when a path/token is rejected: the verdict lives in the body, not the status. */
function stubProbe(body: unknown, status: number, statusText = "") {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(body), { status, statusText, headers: { "content-type": "application/json" } })));
}

describe("bind-form probes keep their structured answer on HTTP 4xx (B5)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("localises a missing directory instead of leaking the raw Node error", async () => {
    // The server answers 404 + { exists:false }; the form must see that flag.
    stubProbe({ ok: false, path: "/tmp/definitely-not-here", exists: false, isDirectory: false, error: "directory does not exist" }, 404, "Not Found");
    const result = await api.validatePath("/tmp/definitely-not-here");
    expect(result.ok).toBe(false);
    expect(result.exists).toBe(false);
    expect(describePathCheck(result)).toBe("✗ 无法使用：目录不存在，请检查路径");
  });

  it("localises a path that exists but is not a directory", async () => {
    stubProbe({ ok: false, path: "/etc/hosts", exists: true, isDirectory: false, error: "path is not a directory" }, 400, "Bad Request");
    expect(describePathCheck(await api.validatePath("/etc/hosts"))).toBe("✗ 无法使用：该路径不是目录");
  });

  it("reports the document count of an accepted directory", async () => {
    stubProbe({ ok: true, path: "/tmp/notes", exists: true, isDirectory: true, documents: 5, assets: 0, total: 5, exclude: [], writable: true }, 200);
    expect(describePathCheck(await api.validatePath("/tmp/notes"))).toBe("✓ 目录可用 · 5 篇 Markdown");
  });

  it("maps an unreachable token onto the shared error-category vocabulary", async () => {
    stubProbe({ ok: false, token: "fldcnX", category: "auth", error: "app_access_token expired" }, 401, "Unauthorized");
    const result = await api.validateToken("fldcnX", "folder");
    expect(result.category).toBe("auth");
    expect(describeTokenProblem(result)).toBe("凭证失效");
  });

  it("falls back to the upstream message, then to a default, for tokens", () => {
    const rejected = (overrides: Partial<ValidateTokenResult> = {}): ValidateTokenResult =>
      ({ ok: false, type: "folder", token: "fldcnX", ...overrides });
    expect(describeTokenProblem(rejected({ category: "permission", error: "forbidden" }))).toBe("权限不足");
    expect(describeTokenProblem(rejected({ error: "upstream boom" }))).toBe("upstream boom");
    expect(describeTokenProblem(rejected())).toBe("未知错误");
  });

  it("still throws when the probe answers without a JSON body", async () => {
    // A gateway error page carries no verdict, so there is nothing to localise.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502, statusText: "Bad Gateway" })));
    await expect(api.validatePath("/tmp/notes")).rejects.toThrow("Bad Gateway");
  });
});
