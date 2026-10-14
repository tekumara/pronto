export type ExcludableFile = { path: string; previousPath?: string | null };

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] !== "*") source += "[^/]*";
      else if (glob[i += 2] === "/") source += "(?:.*/)?";
      else { i--; source += ".*"; }
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Compile --exclude patterns. Patterns are repository-relative: `*` and `?` stay within one path segment, `**` crosses
 * segments (`**` + `/` also matches no directory) and a pattern that matches a directory matches everything below it.
 */
export function compileExclusions(patterns: string[]): (file: ExcludableFile) => boolean {
  const matchers = patterns.map((pattern) => {
    const relative = pattern.trim().replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
    if (!relative || relative === ".") throw new Error(`Invalid --exclude path: ${JSON.stringify(pattern)}`);
    return globToRegExp(relative);
  });
  const matches = (path: string) => {
    const segments = path.split("/");
    return matchers.some((matcher) => segments.some((_, i) => matcher.test(segments.slice(0, i + 1).join("/"))));
  };
  // A rename across the boundary still changes reviewable code, so it is excluded only if both ends are.
  return (file) => matches(file.path) && (!file.previousPath || matches(file.previousPath));
}
