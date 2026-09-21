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

export function isSafeRewrite(original, rewritten) {
  // Never rewrite inline script commands — RTK can't transform arbitrary code
  if (isEvalCommand(original) || isEvalCommand(rewritten)) return false;
  const oTokens = original.trim().split(/\s+/);
  const rTokens = rewritten.trim().split(/\s+/);
  // RTK prepends "rtk" as the first token; compare against the original's first token
  const rtkIdx = rTokens[0] === "rtk" ? 1 : 0;
  const o = oTokens[0], n = rTokens[rtkIdx] ?? "";
  return o === n && !/[|><;&`]/.test(rewritten);
}
