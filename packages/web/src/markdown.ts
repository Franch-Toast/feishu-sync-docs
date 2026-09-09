import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, go, java, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

const ALIAS_LANGUAGES: Record<string, string> = { js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript", yml: "yaml", sh: "shell", zsh: "shell", html: "xml", md: "markdown" };

const md = new MarkdownIt({ html: false, linkify: true });

md.set({
  // Return a full <pre><code> block so markdown-it does not double-wrap it.
  highlight(code: string, lang: string): string {
    const language = ALIAS_LANGUAGES[lang] ?? lang;
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre><code class="hljs">${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through to escaped output */
      }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
  }
});

interface RenderEnv {
  rootId?: string;
}

/** Relative asset targets (./images/x.png, assets/x.png) are proxied through
 *  the server-side file endpoint; absolute/data URLs stay untouched. */
export function isRelativeAssetPath(src: string): boolean {
  if (!src) return false;
  if (/^(https?:)?\/\//i.test(src)) return false;
  if (/^(data|blob|mailto|tel):/i.test(src)) return false;
  if (src.startsWith("#") || src.startsWith("/api/")) return false;
  return true;
}

export function assetProxyUrl(rootId: string, src: string): string {
  return `/api/roots/${rootId}/file?path=${encodeURIComponent(src)}`;
}

const defaultImageRenderer = md.renderer.rules.image;
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const source = token.attrGet("src");
  const rootId = (env as RenderEnv | undefined)?.rootId;
  if (typeof source === "string" && rootId && isRelativeAssetPath(source)) {
    token.attrSet("src", assetProxyUrl(rootId, source));
  }
  if (defaultImageRenderer) return defaultImageRenderer(tokens, index, options, env, self);
  return self.renderToken(tokens, index, options);
};

export interface RenderOptions {
  /** Sync root id used to proxy relative images to GET /api/roots/:id/file. */
  rootId?: string;
}

/** Render Markdown to safe HTML (html:false escapes raw HTML by default). */
export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  return md.render(source, { rootId: options.rootId } satisfies RenderEnv);
}
