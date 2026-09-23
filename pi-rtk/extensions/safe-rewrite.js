// Security gate for RTK rewrites — plain JS so node --test can exercise it
// without loading index.ts (which pulls the pi SDK peer dep).
// ponytail: kept in sync by index.ts import; do not inline copies back into index.ts.

// ponytail: reject RTK rewrites that change the first word or add shell operators
// Also reject rewrites of eval/script commands (node -e, python -c, etc.)
// because RTK cannot safely transform arbitrary inline scripts.
const SCRIPT_COMMAND_RE = /^(?:(?:\/[\w/.-]+)?\b(?:node|python|python3|ruby|perl|php|deno|bun|lua|perl6|raku|tclsh|groovy|julia|Rscript|ghci|dart|swift)\s+)(?:-\S+\s+)*(?:-[pecrE]{1,3}|--eval|--print|eval(?=\s|$))\b/;

export function isEvalCommand(command) {
  return SCRIPT_COMMAND_RE.test(command.trim());
}

// Classify each char of a shell command: "live" (unquoted, shell-active),
// "single" (inside '...'), "double" (inside "..."), "escaped" (after \).
// $, `, and escapes stay active inside double quotes; parens do not.
function shellCharKinds(s) {
  const kinds = new Array(s.length).fill("live");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { kinds[i] = kinds[i + 1] = "escaped"; i += 2; continue; }
    if (c === "'") {
      kinds[i] = "single";
      const j = s.indexOf("'", i + 1);
      if (j === -1) break; // unterminated single quote
      for (let k = i + 1; k < j; k++) kinds[k] = "single";
      i = j + 1;
      continue;
    }
    if (c === '"') {
      kinds[i] = "double";
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) { kinds[j] = kinds[j + 1] = "double"; j += 2; continue; }
        kinds[j] = "double";
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return kinds;
}

export function isSafeRewrite(original, rewritten) {
  // Never rewrite inline script commands — RTK can't transform arbitrary code
  if (isEvalCommand(original) || isEvalCommand(rewritten)) return false;
  const oTokens = original.trim().split(/\s+/);
  const rTokens = rewritten.trim().split(/\s+/);
  // RTK prepends "rtk" as the first token; compare against the original's first token
  const rtkIdx = rTokens[0] === "rtk" ? 1 : 0;
  const o = oTokens[0], n = rTokens[rtkIdx] ?? "";
  if (o !== n) return false;
  if (!/[|><;&`]/.test(rewritten)) {
    // Quoted-aware injection check: reject $-substitution and subshell parens
    // only where the shell would execute them. Quoted parens (git commit -m
    // "fix (bug)", rtk ≥0.46 find groups) and escaped \$ \( stay allowed.
    const kinds = shellCharKinds(rewritten);
    for (let i = 0; i < rewritten.length; i++) {
      const c = rewritten[i];
      if (c === "\n" || c === "\r") return false; // newline = command split, quoted or not
      if (kinds[i] === "single" || kinds[i] === "escaped") continue;
      if (c === "$" && rewritten[i + 1] === "(") return false;
      if ((c === "(" || c === ")") && kinds[i] === "live") return false;
    }
    return true;
  }
  return false;
}
