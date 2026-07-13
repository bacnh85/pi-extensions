import path from "node:path";

export function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
    if (relative === "") return null;
    if (relative.split("/").some(s => s === "..") || path.isAbsolute(relative)) {
      throw new Error(
        `Path constraint must be relative to the workspace: ${pathConstraint}`,
      );
    }
    trimmed = relative;
  }

  if (trimmed.split("/").some(s => s === "..")) {
    throw new Error(
      `Path constraint must be relative to the workspace: ${pathConstraint}`,
    );
  }

  if (trimmed === "." || trimmed === "./") return null;
  // Strip a leading `./` so `./**/*.rs` and `**/*.rs` behave identically.
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // FFF's glob matcher can treat a hidden directory root glob such as
  // `.agents/**` as empty, while the tool contract says this means "inside
  // this directory". Collapse simple trailing recursive directory globs to the
  // directory-prefix constraint understood by the parser. Keep real file globs
  // such as `src/**/*.ts` unchanged.
  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  // Already signals path-constraint syntax to the parser.
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  // Globs (`*.ts`, `src/**/*.cc`, `{src,lib}`) are handled by the parser.
  if (/[*?[{]/.test(trimmed)) return trimmed;
  // Filename with extension (`main.rs`, `config.json`) → FilePath constraint.
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  // Bare directory prefix → append `/` so the parser sees a PathSegment.
  return `${trimmed}/`;
}

// Exclusions are emitted as `!<constraint>` tokens, which the Rust parser
// understands (crates/fff-query-parser/src/parser.rs). We normalize each one
// the same way as the include path so bare dirs become PathSegment excludes.
// Tolerate callers passing already-negated forms like `!src/` by stripping
// the leading `!` before normalizing so we never double-negate (`!!src/`).
export function normalizeExcludes(
  exclude: string | string[] | undefined,
  cwd = process.cwd(),
): string[] {
  if (!exclude) return [];
  const parts = Array.isArray(exclude)
    ? exclude
    : (() => {
        // Depth-aware split: ignores commas inside {…} groups (brace
        // patterns like `{src,lib}`) and inside […] character classes
        // (e.g. `[,a]`). Backslash-escaped characters are skipped.
        const result: string[] = [];
        let braceDepth = 0;
        let bracketDepth = 0;
        let start = 0;
        for (let i = 0; i < exclude.length; i++) {
          const ch = exclude[i];
          if (ch === "\\") {
            i++; // skip the escaped character
            continue;
          }
          if (ch === "{" && bracketDepth === 0) braceDepth++;
          else if (ch === "}" && bracketDepth === 0) braceDepth = Math.max(0, braceDepth - 1);
          else if (ch === "[") bracketDepth++;
          else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
          else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
            result.push(exclude.slice(start, i).trim());
            start = i + 1;
          }
        }
        const last = exclude.slice(start).trim();
        if (last) result.push(last);
        return result;
      })();
  return parts.flatMap((s) => {
    const normalized = normalizePathConstraint(s.trim().replace(/^!/, ""), cwd);
    return normalized ? [`!${normalized}`] : [];
  });
}

export function buildQuery(
  path: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
): string {
  const parts: string[] = [];
  if (path) {
    const pathConstraint = normalizePathConstraint(path, cwd);
    if (pathConstraint) parts.push(pathConstraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  parts.push(pattern);
  if (parts.length === 1 && !parts[0]) return "";
  return parts.filter(Boolean).join(" ");
}
