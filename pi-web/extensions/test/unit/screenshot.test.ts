/**
 * Unit tests for web_screenshot's tool-result shape.
 *
 * The screenshot must come back as a real inline image block (ImageContent)
 * so multimodal models can see it — not as base64 text. Regression guard for
 * pi-web 0.6.2; the HTTP layer is stubbed so no Crawl4AI daemon is needed.
 */

import { expect } from "chai";
import piWebExtension from "../../index";

function harness(): Record<string, any> {
  const tools: Record<string, any> = {};
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on() {},
  };
  piWebExtension(pi);
  return tools;
}

const BASE_RESPONSE = { success: true, url: "https://example.com", mime: "image/png", size: 3 };

async function runScreenshot(payload: Record<string, unknown>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })) as any;
  try {
    const tools = harness();
    return await tools.web_screenshot.execute(
      "t1", { url: "https://example.com" }, new AbortController().signal, undefined, {},
    );
  } finally {
    globalThis.fetch = orig;
  }
}

describe("web_screenshot tool result shape", () => {
  it("returns the PNG as an inline image block, not base64 text", async () => {
    const result = await runScreenshot({ ...BASE_RESPONSE, screenshot: "QUJD" });
    const image = result.content.find((c: any) => c.type === "image");
    expect(image).to.deep.equal({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(result.content[0].type).to.equal("text");
    expect(result.content[0].text).to.not.include("base64");
  });

  it("returns text-only when no screenshot comes back", async () => {
    const result = await runScreenshot({ ...BASE_RESPONSE });
    expect(result.content).to.have.lengthOf(1);
    expect(result.content[0].type).to.equal("text");
  });

  it("falls back to image/png when the response has no mime", async () => {
    const result = await runScreenshot({ success: true, url: "https://example.com", screenshot: "QUJD" });
    const image = result.content.find((c: any) => c.type === "image");
    expect(image).to.deep.equal({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("surfaces daemon success:false as a loud error", async () => {
    let err: any = null;
    try {
      await runScreenshot({ success: false, error_message: "nav failed" });
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(String(err?.message)).to.match(/nav failed/);
  });
});
