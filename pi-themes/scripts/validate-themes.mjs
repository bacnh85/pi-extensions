// Validates every themes/*.json: color-token parity with dark.json (the
// upstream-maintained reference set), name presence, and that every value
// resolves to a var, 6-digit hex, 256-color index, or terminal default.
// Usage: node scripts/validate-themes.mjs [dir]   (dir defaults to ./themes)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2]
  ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "themes");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`no theme files found in ${dir}`);
  process.exit(1);
}

// Reference token set comes from this package's themes/dark.json, regardless
// of which dir is being validated, so alternate dirs can be checked too.
const reference = JSON.parse(
  readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "themes", "dark.json"), "utf8"),
);
const required = Object.keys(reference.colors).sort();

let failed = false;
const names = new Set();
const isColorValue = (v, vars) =>
  typeof v === "number" || v === "" || /^#[0-9A-Fa-f]{6}$/.test(v) || vars.has(v);

for (const file of files) {
  const theme = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const fail = (msg) => {
    console.error(`${file}: ${msg}`);
    failed = true;
  };

  if (!theme.name) fail("missing name");
  else if (names.has(theme.name)) fail(`duplicate theme name: ${theme.name}`);
  else names.add(theme.name);

  const keys = Object.keys(theme.colors ?? {}).sort();
  const missing = required.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !required.includes(k));
  if (missing.length) fail(`missing required tokens: ${missing.join(", ")}`);
  if (extra.length) fail(`unknown tokens: ${extra.join(", ")}`);

  const vars = new Set(Object.keys(theme.vars ?? {}));
  for (const [token, value] of Object.entries(theme.colors ?? {})) {
    if (!isColorValue(value, vars)) {
      fail(`colors.${token}: unresolved value ${JSON.stringify(value)}`);
    }
  }
  for (const [token, value] of Object.entries(theme.export ?? {})) {
    if (!isColorValue(value, vars)) {
      fail(`export.${token}: unresolved value ${JSON.stringify(value)}`);
    }
  }
}

if (failed) process.exit(1);
console.log(`validated ${files.length} themes: token parity, names, var refs OK`);
