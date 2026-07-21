// Readable content extraction using JSDOM + Readability + Turndown.

import { createRequire } from "node:module";
import { signalWithTimeout } from "./retry";

const require = createRequire(import.meta.url);

export interface ReadableContentDeps {
  Readability: any;
  JSDOM: any;
  TurndownService: any;
  gfm: unknown;
}

export function loadReadableContentDependencies(): ReadableContentDeps {
  try {
    return {
      Readability: require("@mozilla/readability").Readability,
      JSDOM: require("jsdom").JSDOM,
      TurndownService: require("turndown"),
      gfm: require("turndown-plugin-gfm").gfm,
    };
  } catch (error: any) {
    throw new Error(
      `Readable content extraction dependencies are missing. Install pi-web dependencies with \`npm install\` in the pi-web extension directory, or install the package with Pi so runtime dependencies are installed. Original error: ${error?.message || error}`,
    );
  }
}

export function htmlToMarkdown(html: string, deps = loadReadableContentDependencies()): string {
  const turndown = new deps.TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(deps.gfm as any);
  turndown.addRule("removeEmptyLinks", {
    filter: (node: any) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchReadableContent(
  url: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<{ title: string; markdown: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: signalWithTimeout(timeoutMs, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const html = await response.text();
  const deps = loadReadableContentDependencies();
  const dom = new deps.JSDOM(html, { url });
  try {
    const article = new deps.Readability(dom.window.document).parse();
    if (article?.content) {
      return { title: article.title || "", markdown: htmlToMarkdown(article.content, deps) };
    }
  } finally {
    dom.window.close();
  }
  // Fallback: strip non-content elements and use main/article/body
  const fallbackDoc = new deps.JSDOM(html, { url });
  try {
    const doc = fallbackDoc.window.document;
    doc.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el: any) => el.remove());
    const title = doc.querySelector("title")?.textContent?.trim() || "";
    const main = doc.querySelector("main, article, [role='main'], .content, #content") || doc.body;
    const fallbackHtml = main?.innerHTML || "";
    if (fallbackHtml.trim().length <= 100) throw new Error("Could not extract readable content from this page.");
    return { title, markdown: htmlToMarkdown(fallbackHtml, deps) };
  } finally {
    fallbackDoc.window.close();
  }
}
