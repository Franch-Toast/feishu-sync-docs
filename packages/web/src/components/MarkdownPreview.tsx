import "highlight.js/styles/github-dark.css";
import { useMemo } from "react";
import { renderMarkdown } from "../markdown";

interface MarkdownPreviewProps {
  source: string;
  /** Sync root id: proxies relative images through the server file endpoint. */
  rootId?: string;
  className?: string;
}

/** Renders Markdown to safe HTML. Raw HTML is escaped by markdown-it
 *  (html:false), so dangerouslySetInnerHTML only sees generated markup. */
export function MarkdownPreview({ source, rootId, className }: MarkdownPreviewProps): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(source, { rootId }), [source, rootId]);
  return <div className={className ? `markdown-body ${className}` : "markdown-body"} dangerouslySetInnerHTML={{ __html: html }} />;
}
