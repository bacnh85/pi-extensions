// Live smoke for web_research (dev script, not part of the test suite).
// Usage:
//   npx tsx extensions/scripts/gemini-smoke.ts "query"            # ask (guest if no cookie)
//   npx tsx extensions/scripts/gemini-smoke.ts "query" research   # Deep Research (cookie + Gemini Advanced)
// Set GEMINI_WEB_SECURE_1PSID in the environment (or ~/.pi/agent/.env.local)
// for authed mode.
import { geminiAsk, geminiResearch, loadGeminiWebConfig } from "../lib/gemini";

async function main() {
  const query = process.argv[2] ?? "What is the capital of France? Answer in one word.";
  const mode = process.argv[3] ?? "ask";
  const config = loadGeminiWebConfig(process.cwd(), true);
  console.log(`mode: ${mode} | cookie: ${config.psid ? "set" : "not set (guest)"}`);
  const t0 = Date.now();
  if (mode === "research") {
    const r = await geminiResearch(query, { config });
    console.log(`research OK in ${Date.now() - t0}ms — title: ${r.title ?? "?"} — sources: ${r.sources.length}`);
    console.log(r.text.slice(0, 400));
  } else {
    const r = await geminiAsk(query, { config });
    console.log(`ask OK in ${Date.now() - t0}ms — model: ${r.model ?? "?"} — guest: ${r.guest} — sources: ${r.sources.length}`);
    console.log(r.text.slice(0, 200));
  }
  process.exit(0);
}

main();
