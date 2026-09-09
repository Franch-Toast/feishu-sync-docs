import { describe, expect, it } from "vitest";
import { assetProxyUrl, isRelativeAssetPath, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, lists and inline styles", () => {
    const html = renderMarkdown("# 标题\n\n- 项目 **加粗**");
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>加粗</strong>");
  });

  it("highlights fenced code blocks with hljs classes", () => {
    const html = renderMarkdown("```ts\nconst value: number = 1;\n```");
    expect(html).toContain('<pre><code class="hljs">');
    expect(html).toContain("hljs-keyword");
  });

  it("escapes raw html so injected markup stays inert", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <img src=x onerror="a()">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rewrites relative image paths to the file proxy", () => {
    const html = renderMarkdown("![图](images/pic.png)", { rootId: "root-1" });
    expect(html).toContain(`src="${assetProxyUrl("root-1", "images/pic.png")}"`);
  });

  it("leaves absolute, data and already-proxied urls untouched", () => {
    const sources = [
      "![外链](https://example.com/a.png)",
      "![协议相对](//cdn.example.com/a.png)",
      "![数据](data:image/png;base64,AAAA)",
      "![代理](/api/roots/root-1/file?path=a.png)"
    ];
    for (const source of sources) {
      expect(renderMarkdown(source, { rootId: "root-1" })).toBe(renderMarkdown(source));
    }
  });

  it("does not rewrite images without a rootId", () => {
    expect(renderMarkdown("![图](images/pic.png)")).toContain('src="images/pic.png"');
  });

  it("encodes special characters in proxied paths", () => {
    expect(assetProxyUrl("r1", "a b/图.png")).toBe(`/api/roots/r1/file?path=${encodeURIComponent("a b/图.png")}`);
  });
});

describe("isRelativeAssetPath", () => {
  it("classifies relative and absolute targets", () => {
    expect(isRelativeAssetPath("images/a.png")).toBe(true);
    expect(isRelativeAssetPath("./a.png")).toBe(true);
    expect(isRelativeAssetPath("../a.png")).toBe(true);
    expect(isRelativeAssetPath("https://x.com/a.png")).toBe(false);
    expect(isRelativeAssetPath("data:image/png;base64,AA")).toBe(false);
    expect(isRelativeAssetPath("/api/roots/r/file?path=a")).toBe(false);
    expect(isRelativeAssetPath("")).toBe(false);
  });
});
