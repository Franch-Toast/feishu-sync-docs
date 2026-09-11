import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMarkdown,
  resolveReferencePath,
  restoreAssetReferences,
  restoreInternalLinks,
  rewriteAssetReferences,
  rewriteInternalLinks
} from "../src/index.js";

/** B6: a link target survives the local ⟷ drive round trip only if both
 *  directions agree on percent-encoding. Feishu hands back `%E4%BC%A0…` for a
 *  CJK file name and `my%20doc.md` for a name with a space, while a local file
 *  is stored under its plain name — so the rewrite side must decode and the
 *  restore side must encode, and encoding must escape the characters that would
 *  otherwise terminate the link (`(`/`)`/`[`/`]`). */

test("resolves percent-encoded, space-bearing and angle-wrapped targets", () => {
  const linkMap = new Map<string, { token: string }>([
    ["docs/传感器.md", { token: "t-cjk" }],
    ["docs/a b.md", { token: "t-space" }],
    ["docs/café.md", { token: "t-nfd" }],
    ["docs/100%.md", { token: "t-percent" }]
  ]);
  const cases: Array<{ label: string; content: string; token: string }> = [
    { label: "percent-encoded CJK", content: "see [x](./%E4%BC%A0%E6%84%9F%E5%99%A8.md)", token: "t-cjk" },
    { label: "percent-encoded space", content: "[x](a%20b.md)", token: "t-space" },
    { label: "<> wrapped space", content: "[x](<a b.md>)", token: "t-space" },
    { label: "NFD decomposed name", content: "[x](%63%61f%65%CC%81.md)", token: "t-nfd" },
    { label: "lone percent sign", content: "[x](100%.md)", token: "t-percent" }
  ];
  for (const item of cases) {
    const rewritten = rewriteInternalLinks(item.content, "docs/index.md", linkMap);
    assert.match(rewritten, new RegExp(`doc-id="${item.token}"`), item.label);
  }
});

test("an invalid percent sequence degrades to the literal target instead of throwing", () => {
  // `%E4%zz` cannot be decoded; the rewrite must simply not match rather than
  // abort a whole scan with a URIError.
  assert.doesNotThrow(() => rewriteInternalLinks("[x](%E4%zz.md)", "docs/index.md", new Map()));
  // An undecodable target is compared exactly as written, so a file whose real
  // name contains a percent sequence still binds.
  assert.equal(
    rewriteInternalLinks("[x](%E4%zz.md)", "docs/index.md", new Map()),
    "[x](%E4%zz.md)"
  );
  assert.match(
    rewriteInternalLinks("[x](%E4%zz.md)", "docs/index.md", new Map([["%E4%zz.md", { token: "t" }]])),
    /doc-id="t"/
  );
});

test("a restored link can be rewritten back to the same token", () => {
  const linkMap = new Map<string, { token: string }>([
    ["报告 (final).md", { token: "t-round" }],
    ["a[b].md", { token: "t-bracket" }],
    ["my doc.md", { token: "t-blank" }]
  ]);
  for (const [path, binding] of linkMap) {
    const token = binding.token;
    const restored = restoreInternalLinks(`<cite type="doc" doc-id="${token}"/>`, new Map([[token, path]]), "docs/index.md");
    // Every restored target must be parseable as markdown again…
    assert.match(restored, /^\[\s*[^\]]*\]\(\S+\)$/, `restore shape for ${path}`);
    // …and must resolve back to the very same binding.
    assert.match(
      rewriteInternalLinks(restored, "docs/index.md", linkMap),
      new RegExp(`doc-id="${token}"`),
      `round trip for ${path}`
    );
  }
});

test("restored targets escape the characters that would end the link", () => {
  const restored = restoreInternalLinks('<cite type="doc" doc-id="t"/>\n<cite type="doc" doc-id="b"/>', new Map([
    ["t", "报告 (final).md"],
    ["b", "a[b].md"]
  ]), "docs/index.md");
  const lines = restored.split("\n");
  // The label keeps a human-readable name, the URL is percent-encoded so that a
  // space, parenthesis or bracket can never terminate it early.
  assert.equal(lines[0], "[../报告 (final).md](../%E6%8A%A5%E5%91%8A%20%28final%29.md)");
  assert.equal(lines[1], "[../a b .md](../a%5Bb%5D.md)");
  assert.ok(!/\]\([^)]*\(/.test(restored), "no URL may contain a raw parenthesis");
});

test("restore stays relative to the document being written", () => {
  const reverseMap = new Map([["t", "sub/n.md"]]);
  // No current path means the link is anchored at the root.
  assert.equal(restoreInternalLinks('<cite type="doc" doc-id="t"/>', reverseMap), "[sub/n.md](sub/n.md)");
  // Inside the same folder the link collapses to a bare sibling name.
  assert.equal(restoreInternalLinks('<cite type="doc" doc-id="t"/>', reverseMap, "sub/other.md"), "[n.md](n.md)");
  // The long `<cite …></cite>` form Feishu sometimes emits is equivalent.
  assert.equal(restoreInternalLinks('<cite type="doc" doc-id="t"></cite>', reverseMap, "sub/other.md"), "[n.md](n.md)");
});

test("unknown tokens, external links and fenced code are left alone", () => {
  const content = [
    '<p><cite type="doc" doc-id="unknown"/></p>',
    "[site](https://example.com/a%20b.md)",
    "[mail](mailto:me@example.com)",
    "```",
    "[x](传感器.md)",
    "```"
  ].join("\n");
  const result = rewriteInternalLinks(content, "docs/index.md", new Map([["docs/传感器.md", { token: "t" }]]));
  assert.equal(result, content, "nothing inside or outside a fence may change");
  assert.equal(restoreInternalLinks(content, new Map()), content);
});

test("asset references round trip through encoded paths", () => {
  const assetMap = new Map([["docs/a b.png", "img-token"]]);
  assert.equal(
    rewriteAssetReferences("![diagram](<a b.png>)", "docs/index.md", assetMap),
    '<img src="img-token" caption="diagram"/>'
  );
  assert.equal(
    rewriteAssetReferences("![diagram](a%20b.png)", "docs/index.md", assetMap),
    '<img src="img-token" caption="diagram"/>'
  );
  // Anchored at the root: the link keeps the folder it points into.
  const absolute = restoreAssetReferences('<img src="img-token" caption="diagram"/>', new Map([["img-token", "docs/a b.png"]]));
  assert.equal(absolute, "![diagram](docs/a%20b.png)");
  assert.equal(rewriteAssetReferences(absolute, "other/index.md", assetMap), '<img src="img-token" caption="diagram"/>');
  // Relative to the current document: the link climbs out of `docs/`.
  const relative = restoreAssetReferences('<img src="img-token" caption="diagram"/>', new Map([["img-token", "a b.png"]]), "docs/index.md");
  assert.equal(relative, "![diagram](../a%20b.png)");
  assert.equal(rewriteAssetReferences(relative, "docs/index.md", new Map([["a b.png", "img-token"]])), '<img src="img-token" caption="diagram"/>');
  // An unmapped token stays as written so the block hash does not drift.
  assert.equal(restoreAssetReferences('<img src="other" caption="x"/>', new Map([["img-token", "a b.png"]])), '<img src="other" caption="x"/>');
});

test("wiki-style links resolve through the same normalisation", () => {
  const result = rewriteInternalLinks("see [[a b|label]]", "docs/index.md", new Map([["docs/a b.md", { token: "t-wiki" }]]));
  assert.match(result, /doc-id="t-wiki"/);
  assert.match(result, /see /, "surrounding text is preserved");
});

test("extraction records every target form, encoded or angle-wrapped", () => {
  const document = parseMarkdown("[x](a%20b.md) ![i](<c d.png>) ![j](e.png) [y](<f g.md> \"title\")");
  assert.deepEqual(document.links.map((link) => link.target), ["a%20b.md", "f g.md"]);
  assert.deepEqual(document.assets.map((asset) => asset.target), ["c d.png", "e.png"]);
  // The raw target keeps its encoding; resolution undoes it exactly once.
  assert.equal(resolveReferencePath("docs/index.md", "a%20b.md"), "docs/a b.md");
  assert.equal(resolveReferencePath("docs/index.md", "./%E6%8A%A5%E5%91%8A.md"), "docs/报告.md");
  assert.equal(resolveReferencePath("docs/index.md", "../img/a.png#anchor"), "img/a.png");
  assert.equal(resolveReferencePath("index.md", "sub/n.md?x=1"), "sub/n.md");
});
