const UNSUPPORTED_RTK_FIND_TOKENS = new Set([
  "-not", "!", "-or", "-o", "-and", "-a", "-exec", "-execdir", "-delete", "-print0", "-newer", "-perm", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-empty", "-link", "-regex", "-iregex", "(", ")",
]);
const SHELL_SEPARATORS = new Set(["|", "&&", "||", ";"]);

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

export function hasUnsupportedRtkFind(command) {
  const tokens = tokenizeShellWords(command);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] !== "rtk" || tokens[i + 1] !== "find") continue;
    for (let j = i + 2; j < tokens.length && !SHELL_SEPARATORS.has(tokens[j]); j += 1) {
      if (UNSUPPORTED_RTK_FIND_TOKENS.has(tokens[j])) return true;
    }
  }
  return false;
}
