// Live smoke for web_research + web_image (dev script, not part of the test suite).
// Usage:
//   npx tsx extensions/scripts/gemini-smoke.ts "query"            # ask (guest if no cookie)
//   npx tsx extensions/scripts/gemini-smoke.ts "query" research   # Deep Research (cookie + Gemini Advanced)
//   npx tsx extensions/scripts/gemini-smoke.ts "prompt" image     # Gemini web image generation
//   npx tsx extensions/scripts/gemini-smoke.ts "prompt" zai       # Z.ai GLM-Image (needs ZAI_API_KEY)
//   npx tsx extensions/scripts/gemini-smoke.ts x auth             # rotate + persist cookie store (no prompt needed)
// Set GEMINI_WEB_SECURE_1PSID in the environment (or ~/.pi/agent/.env.local)
// for authed Gemini mode. Prints full answers (no preview slicing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { geminiAsk, geminiGenerateImage, geminiResearch, loadGeminiWebConfig } from "../lib/gemini";
import { refreshGeminiAuth } from "../lib/gemini-auth";
import { ZAI_PRESET, apiGenerateImage, loadImageApiConfig } from "../lib/imageapi";

function pngMagic(file: string): string {
  const b = fs.readFileSync(file).subarray(0, 4);
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "PNG ok" : "NOT A PNG";
}

async function main() {
  const query = process.argv[2] ?? "What is the capital of France? Answer in one word.";
  const mode = process.argv[3] ?? "ask";
  const config = loadGeminiWebConfig(process.cwd(), true);
  const t0 = Date.now();
  if (mode === "auth") {
    const r = await refreshGeminiAuth(config);
    if (r.ok) {
      console.log(`rotate OK in ${Date.now() - t0}ms — fresh __Secure-1PSIDTS persisted to ${r.store}`);
    } else {
      console.log(`rotate FAILED — ${r.reason}${r.stale ? " (store cleared)" : ""}. Paste a fresh cookie from an incognito login, then re-run.`);
      process.exitCode = 1;
    }
  } else if (mode === "research") {
    const r = await geminiResearch(query, { config });
    console.log(`research OK in ${Date.now() - t0}ms — title: ${r.title ?? "?"} — sources: ${r.sources.length}`);
    if (r.sources.length) console.log(r.sources.map((s) => `  ${s}`).join("\n"));
    console.log(r.text);
  } else if (mode === "image") {
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gemini-smoke-image-"));
    const r = await geminiGenerateImage(query, { config, outDir });
    console.log(`image OK in ${Date.now() - t0}ms — guest: ${r.guest} — model: ${r.model ?? "?"} — files: ${r.paths.length}`);
    for (const p of r.paths) console.log(`  ${p} — ${fs.statSync(p).size} bytes — ${pngMagic(p)}`);
  } else if (mode === "zai") {
    const cfg = loadImageApiConfig(process.cwd(), true);
    if (!cfg.zai) throw new Error("ZAI_API_KEY (or Z_AI_API_KEY) not set — cannot smoke the Z.ai images API");
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zai-smoke-image-"));
    const r = await apiGenerateImage({
      baseUrl: ZAI_PRESET.baseUrl,
      apiKey: cfg.zai.apiKey,
      model: ZAI_PRESET.defaultModel,
      prompt: query,
      outDir,
    });
    console.log(`zai OK in ${Date.now() - t0}ms — model: ${r.model ?? "?"} — files: ${r.paths.length} — unsaved urls: ${r.urls.length}`);
    for (const p of r.paths) console.log(`  ${p} — ${fs.statSync(p).size} bytes — ${pngMagic(p)}`);
    for (const u of r.urls) console.log(`  (not saved, host unreachable) ${u}`);
  } else {
    const r = await geminiAsk(query, { config });
    console.log(`ask OK in ${Date.now() - t0}ms — model: ${r.model ?? "?"} — guest: ${r.guest} — sources: ${r.sources.length}`);
    if (r.sources.length) console.log(r.sources.map((s) => `  ${s}`).join("\n"));
    console.log(r.text);
  }
  process.exit(process.exitCode ?? 0);
}

main();
