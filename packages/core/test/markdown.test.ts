import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown, restoreAssetReferences, restoreInternalLinks, rewriteAssetReferences, rewriteInternalLinks } from "../src/index.js";

test("parses blocks, links and relative assets", () => {
  const document = parseMarkdown("# Title\n\nSee [API](api.md).\n\n![diagram](../img/a.png)");
  assert.equal(document.blocks.length, 3);
  assert.equal(document.links[0]?.target, "api.md");
  assert.equal(document.assets[0]?.target, "../img/a.png");
});

test("rewrites only known internal links", () => {
  const result = rewriteInternalLinks("[API](api.md) [external](https://example.com)", "docs/index.md", new Map([
    ["docs/api.md", { token: "doc-api" }]
  ]));
  assert.match(result, /doc-id="doc-api"/);
  assert.match(result, /https:\/\/example.com/);
});

test("does not rewrite links or images inside fenced code", () => {
  const input = "[API](api.md)\n\n```md\n[API](api.md)\n![image](diagram.png)\n```";
  const linked = rewriteInternalLinks(input, "docs/index.md", new Map([["docs/api.md", { token: "doc-api" }]]));
  const rendered = rewriteAssetReferences(linked, "docs/index.md", new Map([["docs/diagram.png", "asset-1"]]));
  assert.equal((rendered.match(/doc-id="doc-api"/g) ?? []).length, 1);
  assert.match(rendered, /!\[image\]\(diagram\.png\)/);
  assert.equal(parseMarkdown(input).assets.length, 0);
});

test("restores references relative to the document file", () => {
  const content = '<cite type="doc" doc-id="doc-api"/>\n\n<img src="asset-1"/>';
  const restored = restoreInternalLinks(content, new Map([["doc-api", "docs/api.md"]]), "docs/guides/index.md");
  assert.equal(restored, '[../api.md](../api.md)\n\n<img src="asset-1"/>');
});

test("restores self-closing and normal image tags", () => {
  const restored = restoreAssetReferences('<img src="asset-1">\n<img src="asset-2"/>', new Map([["asset-1", "images/a.png"], ["asset-2", "images/b.png"]]), "docs/index.md");
  assert.equal(restored, '![](../images/a.png)\n![](../images/b.png)');
});
