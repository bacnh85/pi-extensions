import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountFromPiAuth,
  loadCwdEnvFilesIfTrusted,
} from "../index.ts";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-env-"));

function makeCtx(trusted: boolean) {
  return { isProjectTrusted: () => trusted };
}

// ── loadCwdEnvFilesIfTrusted — cwd .env only for trusted projects ───────────

test("cwd .env is NOT ingested when project is untrusted", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".env"), "PI_SUB_PROBE_UNTRUSTED=1\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    loadCwdEnvFilesIfTrusted(makeCtx(false));
    assert.equal(process.env.PI_SUB_PROBE_UNTRUSTED, undefined);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Idempotence folded in: module-level one-shot state persists across tests in
// this file, so the first trusted load must be the one that proves both.
test("cwd .env IS ingested when trusted, exactly once; real env wins over it", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".env"), "PI_SUB_PROBE_TRUSTED=from-file\n");
  const cwd = process.cwd();
  process.chdir(dir);
  delete process.env.PI_SUB_PROBE_TRUSTED;
  try {
    loadCwdEnvFilesIfTrusted(makeCtx(true));
    assert.equal(process.env.PI_SUB_PROBE_TRUSTED, "from-file");
    // Second call must be a no-op even though the file changed underneath.
    fs.writeFileSync(path.join(dir, ".env"), "PI_SUB_PROBE_LATE=2\n");
    loadCwdEnvFilesIfTrusted(makeCtx(true));
    assert.equal(process.env.PI_SUB_PROBE_LATE, undefined);
  } finally {
    delete process.env.PI_SUB_PROBE_TRUSTED;
    delete process.env.PI_SUB_PROBE_LATE;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Expired Codex access token → plan renders "expired" ─────────────────────

function b64urlJwt(payload: object): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

test("expired Codex access token → plan is 'expired', not the stale plan label", () => {
  const account = accountFromPiAuth({
    type: "oauth",
    access: b64urlJwt({
      exp: Math.floor(Date.now() / 1000) - 10,
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
  });
  assert.equal(account.plan, "expired");
});

test("valid Codex access token keeps the real plan label", () => {
  const account = accountFromPiAuth({
    type: "oauth",
    access: b64urlJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
  });
  assert.equal(account.plan, "Plus");
});
