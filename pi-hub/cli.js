// pi-hub — interactive installer for Pi coding agent packages.
// Thin layer over the `pi` CLI: discovery + selection only; `pi install`/`pi remove` do the work.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// ponytail: static catalog regenerated from monorepo package.json files; query npm live if curation drifts
const catalog = require("./catalog.json");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};
const noColor = !process.stdout.isTTY;
const paint = Object.fromEntries(Object.entries(C).map(([k, fn]) => [k, noColor ? (s) => s : fn]));

// ---------- helpers ----------

// ponytail: Windows npm shims are pi.cmd — spawnSync can't PATHEXT-resolve them without a
// shell, and an args array + shell triggers DEP0190, so win32 passes one joined command
// string instead (install/remove/update args are ours: npm:/git: refs, -l — no spaces).
const spawnPi = (args, opts) =>
  process.platform === "win32"
    ? spawnSync(["pi", ...args].join(" "), { shell: true, ...opts })
    : spawnSync("pi", args, opts);

export function resolveSource(ref) {
  if (ref.startsWith("npm:") || ref.startsWith("git:") || /^[a-z]+:\/\//.test(ref)) return ref;
  if (ref.startsWith("@")) return `npm:${ref}`; // scoped npm
  if (/^[\w.-]+\/[\w.-]+$/.test(ref)) return `git:github.com/${ref}`; // owner/repo shorthand
  const hit = catalog.find((c) => c.dir === ref || c.name === ref || c.name === `@bacnh85/${ref}`);
  if (hit) return `npm:${hit.name}`;
  return `npm:${ref}`; // assume bare npm name
}

export function searchCatalog(query) {
  const q = query.toLowerCase();
  return catalog.filter(
    (c) => c.dir.includes(q) || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
  );
}

export function mergeResults(curated, npmResults) {
  const seen = new Set(curated.map((c) => c.name));
  return [
    ...curated.map((c) => ({ ...c, curated: true })),
    ...npmResults.filter((r) => !seen.has(r.name)),
  ];
}

export async function searchNpm(query, limit = 15) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`npm registry ${res.status}`);
  const body = await res.json();
  return body.objects.map((o) => ({
    name: o.package.name,
    description: o.package.description ?? "",
    version: o.package.version,
    date: o.package.date,
    links: o.package.links ?? {},
    curated: false,
  }));
}

export function piInstalled() {
  return spawnPi(["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
}

function pi(args) {
  const r = spawnPi(args, { stdio: "inherit" });
  if (r.error) throw new Error(`failed to run pi: ${r.error.message}`);
  return r.status ?? 0;
}

export function readSettingsPackages(env = process.env) {
  const settingsPath = path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".pi", "agent", "settings.json");
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    return (s.packages ?? [])
      .map((p) => (typeof p === "string" ? p : p.source))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- interactive picker (raw-mode readline) ----------

const KEY = { UP: "\x1b[A", DOWN: "\x1b[B", ENTER: "\r", CTRL_C: "\x03" };

function picker(title, items, renderDetail) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return resolve(null);
    let cursor = 0;
    const checked = new Set();
    const render = () => {
      // \r first: moveCursor(0, -N) keeps the column, and the hint line (no trailing \n)
      // leaves the cursor at its end — without \r the first item redraws indented.
      process.stdout.write("\x1b[?25l\r"); // hide cursor, column 0
      try { process.stdout.moveCursor(0, -(items.length + 1)); } catch {} // ponytail: +1 because hint has no trailing \n
      for (let i = 0; i < items.length; i++) {
        const marker = checked.has(i) ? paint.green("◉") : "○";
        const arrow = i === cursor ? paint.cyan("❯ ") : "  ";
        process.stdout.write(`${arrow}${marker} ${items[i].label ?? items[i].name}\x1b[K\n`);
      }
      const detail = renderDetail?.(items[cursor]);
      if (detail) process.stdout.write(`${paint.dim(detail)}\x1b[K\n`);
      else process.stdout.write("\x1b[K\n");
      process.stdout.write(paint.dim("↑/↓ move · space select · a toggle all · enter confirm · q quit") + "\x1b[K");
    };
    const cleanup = (value) => {
      try { process.stdin.setRawMode(false); } catch {} // ponytail: best-effort restore, some stdin types can't
      try { process.stdin.pause(); } catch {}
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdout.write("\x1b[?25h\n");
      resolve(value);
    };
    const onEnd = () => cleanup(null); // EOF (piped/closed stdin) — bail gracefully
    const onData = (buf) => {
      // PTY/readline may deliver multiple keystrokes in one chunk — scan per character.
      const s = buf.toString();
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\x1b") {
          const seq = s.slice(i, i + 3);
          if (seq === KEY.UP) {
            cursor = (cursor - 1 + items.length) % items.length;
            i += 2;
          } else if (seq === KEY.DOWN) {
            cursor = (cursor + 1) % items.length;
            i += 2;
          }
          continue;
        }
        if (ch === KEY.CTRL_C || ch === "q") return cleanup(null);
        if (ch === " ") checked.has(cursor) ? checked.delete(cursor) : checked.add(cursor);
        else if (ch === "a") checked.size === items.length ? checked.clear() : items.forEach((_, j) => checked.add(j));
        else if (ch === KEY.ENTER)
          return cleanup([...checked].sort((x, y) => x - y).map((j) => items[j]));
      }
      render();
    };
    process.stdout.write(`${paint.bold(title)}\n`);
    try { process.stdin.setRawMode(true); } catch { return resolve(null); }
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    // Reserve exactly the rows render() occupies (items + detail + hint, no
    // trailing \n on hint), so the first moveCursor lands on the first item row.
    process.stdout.write("\n".repeat(items.length + 1));
    render();
  });
}

// ---------- commands ----------

function printList(items) {
  for (const c of items) {
    const tag = c.curated ? paint.green("[bacnh85]") : paint.dim("[npm]");
    const ver = c.version ? paint.dim(` v${c.version}`) : "";
    console.log(`${tag} ${paint.bold(c.name ?? c.dir)}${ver}`);
    if (c.description) console.log(`  ${paint.dim(c.description)}`);
  }
  if (!items.length) console.log(paint.dim("(no matches)"));
}

async function cmdFind(query, flags) {
  let curated = query ? searchCatalog(query) : [...catalog];
  let npm = [];
  try {
    npm = await searchNpm(query ? `${query} keywords:pi-package` : "keywords:pi-package");
  } catch {
    // offline / rate-limited: catalog only
  }
  const merged = mergeResults(curated, npm);
  if (flags.json) return console.log(JSON.stringify(merged, null, 2));
  printList(merged);
}

function cmdList() {
  const pkgs = readSettingsPackages();
  if (!pkgs.length) return console.log(paint.dim("No pi packages installed (or settings.json unreadable)."));
  for (const p of pkgs) console.log(`  ${p}`);
}

async function cmdAdd(refs, flags) {
  for (const ref of refs) {
    const source = resolveSource(ref);
    console.log(paint.cyan(`pi install ${source}${flags.local ? " -l" : ""}`));
    const code = pi(["install", source, ...(flags.local ? ["-l"] : [])]);
    if (code !== 0) console.log(paint.red(`install failed: ${ref}`));
  }
}

async function cmdInteractive(flags) {
  if (!piInstalled()) {
    console.log(paint.red("`pi` not found on PATH. Install it first: https://github.com/earendil-works/pi"));
    return 1;
  }
  const cols = process.stdout.columns || 100;
  const maxDirLen = Math.max(...catalog.map((c) => c.dir.length));
  const maxDescLen = Math.max(30, cols - maxDirLen - 9); // 4 for "❯ ◉ ", maxDirLen, 2 spaces, 3 padding
  const items = catalog.map((c) => {
    const desc = c.description.length > maxDescLen ? `${c.description.slice(0, maxDescLen - 1)}…` : c.description;
    return {
      ...c,
      label: `${c.dir.padEnd(maxDirLen)}  ${paint.dim(desc)}`,
    };
  });
  const chosen = await picker(
    "pi-hub — select @bacnh85 packages to install",
    items,
    (c) => {
      if (!c) return "";
      const full = `${c.name}: ${c.description}`;
      const max = Math.max(40, cols - 2);
      return full.length > max ? `${full.slice(0, max - 1)}…` : full;
    },
  );
  if (!chosen?.length) return console.log(paint.dim("nothing selected"));
  const sources = chosen.map((c) => `npm:${c.name}`);
  if (!flags.yes) {
    console.log(`\nWill install:\n${sources.map((s) => `  ${s}`).join("\n")}`);
  }
  for (const source of sources) {
    console.log(paint.cyan(`pi install ${source}${flags.local ? " -l" : ""}`));
    pi(["install", source, ...(flags.local ? ["-l"] : [])]);
  }
}

function cmdRemove(refs, flags) {
  let sources = refs.map(resolveSource);
  if (!sources.length) {
    const installed = readSettingsPackages().filter((p) => p.startsWith("npm:"));
    if (!installed.length) return console.log(paint.dim("no npm pi packages to remove"));
    sources = installed; // interactive pick happens below via picker
  }
  for (const source of sources) {
    console.log(paint.yellow(`pi remove ${source}`));
    pi(["remove", source]);
  }
}

function usage(code = 0) {
  console.log(`pi-hub — interactive installer for Pi coding agent packages

Usage:
  npx @bacnh85/pi-hub                      browse @bacnh85 catalog, multi-select, install
  npx @bacnh85/pi-hub add <pkg...>         install (shorthand: pi-plan, @scope/pkg, owner/repo)
  npx @bacnh85/pi-hub find [query]         search curated catalog + npm keywords:pi-package
  npx @bacnh85/pi-hub list                 show installed packages from pi settings
  npx @bacnh85/pi-hub remove [pkg...]      uninstall (defaults to installed npm packages)
  npx @bacnh85/pi-hub update               pi update --extensions

Flags:
  -l, --local    project-local install (.pi/settings.json) instead of user scope
  -y, --yes      skip confirmation
  --json         machine-readable output (find)
  -h, --help     this help`);
  if (code !== undefined) process.exitCode = code;
}

// ---------- entry ----------

export async function main(argv) {
  const flags = { local: false, yes: false, json: false };
  const rest = [];
  for (const a of argv) {
    if (a === "-l" || a === "--local") flags.local = true;
    else if (a === "-y" || a === "--yes") flags.yes = true;
    else if (a === "--json") flags.json = true;
    else if (a === "-h" || a === "--help") return usage(0);
    else rest.push(a);
  }
  const [cmd, ...args] = rest;
  switch (cmd ?? "") {
    case "":
      return cmdInteractive(flags);
    case "add":
    case "install":
      if (!args.length) return usage(1);
      return cmdAdd(args, flags);
    case "find":
    case "search":
      return cmdFind(args[0] ?? "", flags);
    case "list":
    case "ls":
      return cmdList();
    case "remove":
    case "rm":
    case "uninstall":
      return cmdRemove(args, flags);
    case "update":
      return pi(["update", "--extensions"]);
    default:
      // treat unknown first arg as add shorthand: `pi-hub pi-plan`
      return cmdAdd([cmd, ...args], flags);
  }
}
