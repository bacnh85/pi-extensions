import assert from "node:assert/strict";
import test from "node:test";
import { isEvalCommand, isSafeRewrite } from "../safe-rewrite.js";

// Security gate for RTK command rewrites: a rewrite may only prepend `rtk`
// to the original command's first word, must never introduce shell operators,
// and must never touch eval/script commands (node -e, python -c, ...).

test("isSafeRewrite allows a plain rtk prepend", () => {
  assert.equal(isSafeRewrite("git status", "rtk git status"), true);
  assert.equal(isSafeRewrite("cargo build", "rtk cargo build"), true);
});

test("isSafeRewrite allows rewriting to a subcommand of the same first word", () => {
  assert.equal(isSafeRewrite("git log", "rtk git log --oneline"), true);
});

test("isSafeRewrite rejects rewrites that change the first word", () => {
  assert.equal(isSafeRewrite("git status", "rtk hg status"), false);
  assert.equal(isSafeRewrite("ls -la", "rm -rf /"), false);
});

test("isSafeRewrite rejects shell operators in the rewrite", () => {
  assert.equal(isSafeRewrite("cat a", "rtk cat a | rm -rf /"), false);
  assert.equal(isSafeRewrite("cat a", "rtk cat a; rm -rf /"), false);
  assert.equal(isSafeRewrite("cat a", "rtk cat a > /etc/passwd"), false);
  assert.equal(isSafeRewrite("cat a", "rtk cat a && rm -rf /"), false);
  assert.equal(isSafeRewrite("cat a", "rtk cat `whoami`"), false);
});

test("isSafeRewrite rejects shell-injection constructs", () => {
  // command substitution executes even though there is no operator char
  assert.equal(isSafeRewrite("cat a", "rtk cat a $(rm -rf /)"), false);
  assert.equal(isSafeRewrite("cat a", 'rtk cat a "$(rm -rf /)"'), false); // executes inside double quotes too
  // subshell parens
  assert.equal(isSafeRewrite("cat a", "rtk cat a (rm -rf /)"), false);
  assert.equal(isSafeRewrite("cat a", "rtk (cat a)"), false);
  // newline splits into a second command
  assert.equal(isSafeRewrite("cat a", "rtk cat a\nrm -rf /"), false);
  assert.equal(isSafeRewrite("cat a", "rtk cat a\rrm -rf /"), false);
});

test("isSafeRewrite still allows quoted parens and escaped chars", () => {
  assert.equal(isSafeRewrite('git commit -m "fix (bug)"', 'rtk git commit -m "fix (bug)"'), true);
});

test("isSafeRewrite rejects rewriting eval/script commands", () => {
  assert.equal(isSafeRewrite("node -e 'console.log(1)'", "rtk node -e 'console.log(1)'"), false);
  assert.equal(isSafeRewrite("python -c 'print(1)'", "rtk python -c 'print(1)'"), false);
  assert.equal(isSafeRewrite("git status", "rtk node -e 'pwn()'"), false);
});

test("isSafeRewrite rejects rewriting shell-family inline eval", () => {
  // bash/sh -c executes arbitrary inline scripts exactly like node -e
  assert.equal(isSafeRewrite("bash -c 'rm -rf /'", "rtk bash -c 'rm -rf /'"), false);
  assert.equal(isSafeRewrite("zsh -c 'echo hi'", "rtk zsh -c 'echo hi'"), false);
  assert.equal(isSafeRewrite("git status", "rtk sh -c 'pwn()'"), false);
});

test("isEvalCommand detects inline-script interpreter invocations", () => {
  assert.equal(isEvalCommand("node -e 'console.log(1)'"), true);
  assert.equal(isEvalCommand("python -c 'print(1)'"), true);
  assert.equal(isEvalCommand("python3 --eval x"), true);
  assert.equal(isEvalCommand("ruby -e 'puts 1'"), true);
  assert.equal(isEvalCommand("/usr/local/bin/node --print 1"), true);
  assert.equal(isEvalCommand("node -p process.version"), true);
  assert.equal(isEvalCommand("php -r 'echo 1;'"), true);
  assert.equal(isEvalCommand("perl -E 'say 1'"), true);
  assert.equal(isEvalCommand("deno eval 'console.log(1)'"), true);
});

test("isEvalCommand detects shell interpreters and env prefixes", () => {
  // shell family: only -c is the eval form
  assert.equal(isEvalCommand("bash -c 'echo hi'"), true);
  assert.equal(isEvalCommand("sh -c 'echo hi'"), true);
  assert.equal(isEvalCommand("zsh -c 'echo hi'"), true);
  assert.equal(isEvalCommand("ksh -c 'echo hi'"), true);
  assert.equal(isEvalCommand("dash -c 'echo hi'"), true);
  assert.equal(isEvalCommand("fish -c 'echo hi'"), true);
  // env-prefixed interpreters
  assert.equal(isEvalCommand("env node -e 'pwn()'"), true);
  assert.equal(isEvalCommand("env -i bash -c 'pwn()'"), true);
  assert.equal(isEvalCommand("env CI=1 node -e 'pwn()'"), true);
});

test("isEvalCommand does not flag plain script-file runs", () => {
  assert.equal(isEvalCommand("node script.js"), false);
  assert.equal(isEvalCommand("python manage.py migrate"), false);
  assert.equal(isEvalCommand("npm test"), false);
  assert.equal(isEvalCommand("deno run script.ts"), false);
  // bash script.sh is a file run, not inline eval
  assert.equal(isEvalCommand("bash deploy.sh"), false);
  assert.equal(isEvalCommand("sh build.sh --release"), false);
  // env prefix with a non-interpreter command
  assert.equal(isEvalCommand("env CI=1 npm test"), false);
});
