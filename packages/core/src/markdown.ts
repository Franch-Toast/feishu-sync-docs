import { posix } from "node:path";
import { normalizeText, sha256 } from "./hash.js";
import type { CanonicalBlock, CanonicalDocument, MarkdownAssetReference, MarkdownLink } from "./types.js";

function blockKind(lines: string[]): string {
  const first = lines[0]?.trim() ?? "";
  if (/^```|^~~~/.test(first)) return "code";
  if (/^#{1,6}\s+/.test(first)) return "heading";
  if (/^>/.test(first)) return "blockquote";
  if (/^(?:[-+*]|\d+[.)])\s+/.test(first)) return "list";
  if (/^\|.*\|$/.test(first)) return "table";
  if (/^---+$/.test(first) || /^\*\*\*+$/.test(first)) return "thematicBreak";
  return "paragraph";
}

function splitBlocks(content: string): Array<{ kind: string; content: string }> {
  const lines = normalizeText(content).split("\n");
  const blocks: Array<{ kind: string; content: string }> = [];
  let current: string[] = [];
  let fenced = false;

  const flush = () => {
    while (current[0]?.trim() === "") current.shift();
    while (current.at(-1)?.trim() === "") current.pop();
    if (current.length > 0) {
      const value = current.join("\n");
      blocks.push({ kind: blockKind(current), content: value });
    }
    current = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function stableBlockId(kind: string, content: string, occurrence: number): string {
  return `${kind}:${occurrence}:${sha256(content).slice(0, 12)}`;
}

function extractTitle(content: string): string | undefined {
  return normalizeText(content).match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
}

function extractLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  // B6: `<...>` wrapped targets are legal CommonMark and the only way to write a
  // path containing spaces, so extraction has to accept them or the reference is
  // invisible to everything downstream (asset upload, back-link marking).
  const expression = /!?\[([^\]]*)\]\(\s*(?:<([^>]+)>(|\s[^)]*)|([^\s)]+)(?:\s+["'][^"']*["'])?)\s*\)/g;
  for (const match of content.matchAll(expression)) {
    if (match.index !== undefined && isInsideFence(content, match.index)) continue;
    if (match[0]?.startsWith("!")) continue;
    const target = match[2] ?? match[4];
    if (!target || match.index === undefined) continue;
    const link: MarkdownLink = { target, start: match.index, end: match.index + match[0].length };
    if (match[1] !== undefined) link.label = match[1];
    links.push(link);
  }
  const wiki = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of content.matchAll(wiki)) {
    if (match.index !== undefined && isInsideFence(content, match.index)) continue;
    const target = match[1];
    if (target && match.index !== undefined) {
      const link: MarkdownLink = { target, start: match.index, end: match.index + match[0].length };
      if (match[2] !== undefined) link.label = match[2];
      links.push(link);
    }
  }
  return links;
}

function extractAssets(content: string): MarkdownAssetReference[] {
  const assets: MarkdownAssetReference[] = [];
  const expression = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>(|\s[^)]*)|([^\s)]+)(?:\s+["'][^"']*["'])?)\s*\)/g;
  for (const match of content.matchAll(expression)) {
    if (match.index !== undefined && isInsideFence(content, match.index)) continue;
    const target = match[2] ?? match[4];
    if (target && match.index !== undefined && !/^https?:\/\//i.test(target)) {
      assets.push({ target, start: match.index, end: match.index + match[0].length });
    }
  }
  const wiki = /!\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  for (const match of content.matchAll(wiki)) {
    if (match.index !== undefined && isInsideFence(content, match.index)) continue;
    const target = match[1];
    if (target && match.index !== undefined) assets.push({ target, start: match.index, end: match.index + match[0].length });
  }
  return assets;
}

export function parseMarkdown(content: string): CanonicalDocument {
  const normalized = normalizeText(content);
  const occurrences = new Map<string, number>();
  const blocks: CanonicalBlock[] = splitBlocks(normalized).map((block, position) => {
    const occurrence = occurrences.get(block.kind) ?? 0;
    occurrences.set(block.kind, occurrence + 1);
    return {
      stableId: stableBlockId(block.kind, block.content, occurrence),
      kind: block.kind,
      content: block.content,
      contentHash: sha256(block.content),
      position
    };
  });
  const warnings: string[] = [];
  if (/^\s*```/m.test(normalized) && /\{\{/.test(normalized)) warnings.push("Template expressions inside code blocks are preserved as text.");
  const document: CanonicalDocument = {
    content: normalized,
    contentHash: sha256(normalized),
    blocks,
    links: extractLinks(normalized),
    assets: extractAssets(normalized),
    warnings
  };
  const title = extractTitle(normalized);
  if (title !== undefined) document.title = title;
  return document;
}

export function joinBlocks(blocks: Array<Pick<CanonicalBlock, "content">>): string {
  return blocks.map((block) => block.content).join("\n\n");
}

export function rewriteInternalLinks(
  content: string,
  currentPath: string,
  linkMap: Map<string, { token: string; url?: string }>
): string {
  const resolve = (rawTarget: string): string | undefined => {
    const target = rawTarget.split("#", 1)[0] ?? "";
    if (/^(?:https?:|mailto:|#)/i.test(target)) return undefined;
    const base = currentPath.split("/").slice(0, -1).join("/");
    const candidates = [target, target.replace(/\.md$/i, ""), `${base}/${target}`, `${base}/${target.replace(/\.md$/i, "")}`].map(normalizeReferencePath);
    for (const candidate of candidates) {
      const binding = linkMap.get(candidate) ?? linkMap.get(`${candidate}.md`);
      if (binding) return `<cite type="doc" doc-id="${escapeAttribute(binding.token)}"/>`;
    }
    return undefined;
  };
  return replaceOutsideFences(content, (line) => {
    // `<...>` wrapped targets are legal CommonMark and are the only way to
    // write a link whose path contains spaces or parentheses.
    let rewritten = line.replace(/(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))([^)]*)\)/g, (whole, image: string, label: string, angleTarget: string, bareTarget: string) => {
      if (image) return whole;
      const replacement = resolve(angleTarget ?? bareTarget);
      return replacement ?? whole;
    });
    rewritten = rewritten.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (whole, target: string) => resolve(target) ?? whole);
    return rewritten;
  });
}

export function restoreInternalLinks(content: string, reverseMap: Map<string, string>, currentPath?: string): string {
  return content.replace(/<cite\s+type="doc"\s+doc-id="([^"]+)"\s*(?:\/>|><\/cite>)/g, (whole, token: string) => {
    const path = reverseMap.get(token);
    if (!path) return whole;
    const relativePath = currentPath ? relativeReferencePath(currentPath, path) : path;
    return `[${sanitizeLabel(relativePath)}](${encodeReference(relativePath)})`;
  });
}

export function rewriteAssetReferences(
  content: string,
  currentPath: string,
  assetMap: Map<string, string>
): string {
  const resolve = (rawTarget: string): string | undefined => {
    if (/^(?:https?:|data:|file:)/i.test(rawTarget)) return undefined;
    const target = rawTarget.split("#", 1)[0]?.split("?", 1)[0] ?? rawTarget;
    const base = currentPath.split("/").slice(0, -1).join("/");
    const candidates = [target, `${base}/${target}`].map(normalizeReferencePath);
    for (const candidate of candidates) {
      const token = assetMap.get(candidate) ?? assetMap.get(`${candidate}.png`);
      if (token) return token;
    }
    return undefined;
  };
  return replaceOutsideFences(content, (line) => line.replace(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))([^)]*)\)/g, (whole, label: string, angleTarget: string, bareTarget: string) => {
    const token = resolve(angleTarget ?? bareTarget);
    return token ? `<img src="${escapeAttribute(token)}" caption="${escapeAttribute(label)}"/>` : whole;
  }));
}

export function restoreAssetReferences(content: string, reverseMap: Map<string, string>, currentPath?: string): string {
  return content.replace(/<img\s+([^>]*?)(?:\/>|>)/g, (whole, attributes: string) => {
    const token = attributes.match(/(?:src|token)="([^"]+)"/)?.[1];
    const path = token ? reverseMap.get(token) : undefined;
    if (!path) return whole;
    const label = attributes.match(/caption="([^"]*)"/)?.[1] ?? "";
    const relativePath = currentPath ? relativeReferencePath(currentPath, path) : path;
    return `![${sanitizeLabel(label)}](${encodeReference(relativePath)})`;
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Undo a percent-encoding that never survives a drive round trip unchanged.
 *  An invalid sequence (a lone `%`) is left as written rather than throwing. */
function decodeReference(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Turn a link target into the plain, NFC-normalised relative path used as the
 *  key of the link maps. Without the decode step a remote `my%20doc.md` or a
 *  percent-encoded CJK name could never find its entry. */
function normalizeReferencePath(value: string): string {
  const decoded = decodeReference(value).normalize("NFC");
  const normalized = posix.normalize(decoded.replace(/\\/g, "/").replace(/^\.\//, ""));
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

/** Escape a local relative path for use as a markdown link target. `encodeURI`
 *  covers spaces and non-ASCII; parentheses are escaped by hand because they
 *  terminate the link, and `[`/`]` because they terminate the label. */
function encodeReference(path: string): string {
  return encodeURI(path.normalize("NFC")).replace(/[()\[\]]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Strip characters that would break out of an inline link's label. */
function sanitizeLabel(label: string): string {
  return label.replace(/[\[\]\r\n]/g, " ").trim();
}

function relativeReferencePath(currentPath: string, targetPath: string): string {
  const relativePath = posix.relative(posix.dirname(currentPath), targetPath).replace(/\\/g, "/");
  return relativePath || posix.basename(targetPath);
}

/** Resolve a link/asset target written inside `currentPath` to the relative path
 *  of the file it points at. Percent-encoding and Unicode normalisation are
 *  undone first (B6), so a target that came back from the drive still finds the
 *  local file it names. The raw `MarkdownLink.target` stays as written. */
export function resolveReferencePath(currentPath: string, target: string): string {
  const cleanTarget = target.split("#", 1)[0]?.split("?", 1)[0] ?? target;
  const normalized = normalizeReferencePath(cleanTarget);
  const joined = posix.join(posix.dirname(currentPath), normalized);
  return posix.normalize(joined === "" ? "." : joined).replace(/^\.\//, "");
}

function isInsideFence(content: string, index: number): boolean {
  let fenced = false;
  let offset = 0;
  for (const line of content.split("\n")) {
    if (offset > index) break;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    offset += line.length + 1;
  }
  return fenced;
}

function replaceOutsideFences(content: string, replacer: (line: string) => string): string {
  let fenced = false;
  return content.split("\n").map((line) => {
    const fence = /^\s*(```|~~~)/.test(line);
    const result = fenced || fence ? line : replacer(line);
    if (fence) fenced = !fenced;
    return result;
  }).join("\n");
}
