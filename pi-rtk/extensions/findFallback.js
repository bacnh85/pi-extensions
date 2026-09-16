// Blocklist of find predicates whose rtk rewrite is lossy or unsafe.
//
// rtk <0.46 mishandled most predicates; 0.46 dispatches on find's grammar and
// passes unmodeled predicates through to real find with a never-worse guard.
// PRE_046 tokens verified by round-trip diff against native find on rtk 0.46.0:
// -not ! -or -o -and -a -newer -perm -size -mtime -mmin -atime -amin -ctime
// -cmin -empty -link(s) and \( … -o … \) all produce output identical to
// native find (invalid predicates like -link pass through and error natively).
// Tokens below stay rejected: -exec/-execdir/-delete mutate, -print0/-fprint*
// feed xargs-style consumers where rtk's compact display would corrupt the
// contract, -regex/-iregex/-regextype were not validated. Add a token here if
// it round-trips badly; remove once validated against the installed rtk.
const UNSUPPORTED_RTK_FIND_TOKENS = new Set([
  "-exec", "-execdir", "-delete", "-print0", "-fprint0", "-fprintf", "-fprint",
  "-regex", "-iregex", "-regextype",
]);
// Tokens rejected only on rtk <0.46 (passthrough+guard handles them safely since 0.46).
const PRE_046_RTK_FIND_TOKENS = new Set([
  "-not", "!", "-or", "-o", "-and", "-a", "-newer", "-perm", "-size",
  "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-empty",
  "-link", "-links", "(", ")",
]);
const SHELL_SEPARATORS = new Set(["|", "&&", "||", ";"]);

// ponytail: keep this file's export surface to hasUnsupportedRtkFind only —
// pi's jiti loader can pair a reloaded index.ts with a stale cached copy of
// this module, so new exports here crash at import time. New helpers go in a
// NEW file (version-gate.js) instead.

function tokenizeShellWords(command) {
  const tokens = [];
  let token = "";
  let quote;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) tokens.push(token), token = "";
      continue;
    }
    if (char === "&" && command[i + 1] === "&") { if (token) tokens.push(token), token = ""; tokens.push("&&"); i += 1; continue; }
    if (char === "|" && command[i + 1] === "|") { if (token) tokens.push(token), token = ""; tokens.push("||"); i += 1; continue; }
    if (char === "|" || char === ";" || char === "(" || char === ")") { if (token) tokens.push(token), token = ""; tokens.push(char); continue; }
    if (char === "\\" && i + 1 < command.length) token += command[++i];
    else token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function hasUnsupportedRtkFind(command, rtkSupportsFindPassthrough = false) {
  const tokens = tokenizeShellWords(command);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] !== "rtk" || tokens[i + 1] !== "find") continue;
    for (let j = i + 2; j < tokens.length && !SHELL_SEPARATORS.has(tokens[j]); j += 1) {
      if (UNSUPPORTED_RTK_FIND_TOKENS.has(tokens[j])) return true;
      if (!rtkSupportsFindPassthrough && PRE_046_RTK_FIND_TOKENS.has(tokens[j])) return true;
    }
  }
  return false;
}
