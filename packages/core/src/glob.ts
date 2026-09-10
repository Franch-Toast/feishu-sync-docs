/** Minimal gitignore-style glob matcher used for per-root exclude patterns
 *  (B6.5). Supports `*` (within a path segment), `**` (across segments) and
 *  `?` (a single non-separator character). A bare pattern with no slash matches
 *  at any depth, and a pattern naming a directory also covers its contents. */

/** Translate a single glob pattern into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          // `**/` collapses to zero or more leading directories.
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.+()[]{}|".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `relativePath` is matched by a single glob `pattern`. */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  const trimmed = pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return false;
  const path = relativePath.replace(/^\/+/, "");
  const variants = trimmed.includes("/")
    ? [trimmed, `${trimmed}/**`]
    : [trimmed, `**/${trimmed}`, `${trimmed}/**`, `**/${trimmed}/**`];
  return variants.some((variant) => globToRegExp(variant).test(path));
}

/** True when `relativePath` matches any of the given glob patterns. An empty
 *  or absent pattern list never matches. */
export function matchesAnyGlob(relativePath: string, patterns?: readonly string[]): boolean {
  if (!patterns?.length) return false;
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}
