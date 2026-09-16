#!/usr/bin/env node
// Polls the ZCode credential store until the JWT becomes chat-valid (ZCode
// desktop refreshes it when the user interacts with the app), then runs the
// JWT attribution legs automatically. Bounded: 30 min, then gives up.
//
// Usage: node scripts/jwt-wait-probe.mjs   (log: /tmp/zcode-jwt-watcher.log)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createDecipheriv } from "node:crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CREDS = join(homedir(), ".zcode", "v2", "credentials.json");

function readJwt() {
  try {
    const store = JSON.parse(readFileSync(CREDS, "utf8"));
    const [iv, tag, ct] = store["zcodejwttoken"].slice(7).split(".").map((s) => Buffer.from(s, "base64url"));
    const key = createHash("sha256").update(`zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`).digest();
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

async function jwtChatValid(jwt) {
  try {
    const r = await fetch("https://api.z.ai/api/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": jwt, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, messages: [{ role: "user", content: "Reply OK" }] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const MAX_MINUTES = Number(process.env.WATCH_MAX_MINUTES || 30);
const t0 = Date.now();
console.log(`watching for valid ZCode JWT (max ${MAX_MINUTES} min; open ZCode and send a prompt to refresh it)…`);
while ((Date.now() - t0) / 60000 < MAX_MINUTES) {
  const jwt = readJwt();
  if (jwt && (await jwtChatValid(jwt))) {
    console.log("JWT chat-valid — running attribution legs");
    execFileSync("node", [join(scriptDir, "probe-zcode-attribution.mjs"), "--jwt"], { stdio: "inherit" });
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 45_000));
}
console.log("gave up: JWT never became chat-valid within 30 min");
process.exit(1);
