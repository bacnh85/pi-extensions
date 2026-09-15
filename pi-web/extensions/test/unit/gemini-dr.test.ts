/**
 * Unit tests for the pure-Node Deep Research client (lib/gemini-dr.ts).
 * The plan/confirm fixtures are REAL captured wire responses (2026-09-14,
 * live session) — no network; the transport is injected.
 */

import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractChatIds,
  extractCookieJar,
  extractPlanTitle,
  frameStrings,
  geminiDeepResearch,
  parseFrames,
  type DrHttp,
} from "../../lib/gemini-dr";
import { abortableSleep } from "../../lib/retry";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer => fs.readFileSync(path.join(here, "fixtures", name));

describe("parseFrames (byte-exact, len includes trailing newline)", () => {
  it("parses the captured plan-turn response", () => {
    const frames = parseFrames(fixture("dr-plan.bin"));
    expect(frames.length).to.equal(9);
    expect(frames[0]).to.include("c_10950ff6b1b0ebc1");
  });

  it("returns no frames for bodies without the stream header", () => {
    expect(parseFrames(Buffer.from("garbage"))).to.deep.equal([]);
  });
});

describe("frameStrings / extractChatIds / extractPlanTitle", () => {
  it("recurses into escaped inner-JSON payloads of the real plan fixture", () => {
    const frames = parseFrames(fixture("dr-plan.bin"));
    const strings = frameStrings(frames);
    const ids = extractChatIds(strings);
    expect(ids.cid).to.equal("c_10950ff6b1b0ebc1");
    expect(ids.rid).to.equal("r_b1a8e63da21ae244");
    expect(extractPlanTitle(parseFrames(fixture("dr-plan.bin")))).to.equal("JPEG Compression Research Plan");
  });

  it("extracts chat ids from the real confirm fixture", () => {
    const strings = frameStrings(parseFrames(fixture("dr-confirm.bin")));
    const ids = extractChatIds(strings);
    expect(ids.cid).to.equal("c_10950ff6b1b0ebc1");
    expect(ids.rid).to.equal("r_8d0d706f1f6d605a");
  });
});

describe("geminiDeepResearch (injected transport, fixture-driven cycle)", () => {
  const REPORT_TEXT =
    "Report: The JPEG standard emerged from 1986 onwards, finalized in 1992 as ISO/IEC 10918. " +
    "Its lossy DCT pipeline traded imperceptible detail for ~10:1 compression, and it became the " +
    "dominant image format of the web era. Further reading: https://example.com/jpeg-history";

  function fixtureHttp(): { http: DrHttp; calls: Array<{ url: string; body?: string }> } {
    const calls: Array<{ url: string; body?: string }> = [];
    const http: DrHttp = async (url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.startsWith("https://gemini.google.com/app")) {
        return {
          status: 200,
          headers: { get: () => null, "set-cookie": ["NID=test; Path=/"] },
          buf: Buffer.from(')]}\'\n<html>"SNlM0e":"TOKEN123","cfb2h":"boq_test_build","FdrFJe":"12345"</html>'),
        };
      }
      if (url.includes("StreamGenerate")) {
        const turn = calls.filter((c) => c.url.includes("StreamGenerate")).length;
        return { status: 200, headers: { get: () => null }, buf: turn === 1 ? fixture("dr-plan.bin") : fixture("dr-confirm.bin") };
      }
      // batchexecute poll: first poll echoes the plan transcript (must be
      // skipped, not returned as the report), second returns the report
      const polls = calls.filter((c) => c.url.includes("batchexecute")).length;
      if (polls === 1) {
        const planTranscript = frameStrings(parseFrames(fixture("dr-plan.bin"))).filter((s) => s.length > 200)[0];
        const staleJson = JSON.stringify([null, [["rc_old", [planTranscript]]]]);
        return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n" + (Buffer.byteLength(staleJson) + 1) + "\n" + staleJson + "\n") };
      }
      const reportJson = JSON.stringify([null, [["rc_test", [REPORT_TEXT]]]]);
      return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n" + (Buffer.byteLength(reportJson) + 1) + "\n" + reportJson + "\n") };
    };
    return { http, calls };
  }

  it("runs plan → confirm → poll and extracts the report", async function () {
    this.timeout(30_000);
    const { http, calls } = fixtureHttp();
    const r = await geminiDeepResearch({
      cookie: { psid: "psid-test", psidts: "ts-test" },
      query: "history of JPEG compression",
      timeoutMs: 30_000,
      http,
    });
    expect(r.title).to.equal("JPEG Compression Research Plan");
    expect(r.text).to.include("JPEG standard emerged");
    expect(r.sources).to.deep.equal(["https://example.com/jpeg-history"]);
    expect(r.partial).to.be.undefined;
    // plan turn and confirm turn both carried the deep-research flags
    const posts = calls.filter((c) => c.url.includes("StreamGenerate"));
    expect(posts).to.have.length(2);
    const planInner = JSON.parse(JSON.parse(new URLSearchParams(posts[0].body ?? "").get("f.req") ?? "[]")[1]);
    expect(planInner[49]).to.equal(1);
    expect(planInner[54]).to.deep.equal([[[[[1]]]]]);
    const confirmInner = JSON.parse(JSON.parse(new URLSearchParams(posts[1].body ?? "").get("f.req") ?? "[]")[1]);
    expect(confirmInner[2]).to.deep.equal(["c_10950ff6b1b0ebc1", "r_b1a8e63da21ae244"]); // confirm continues the same chat
  });

  it("reports a partial result when the report never arrives before the timeout", async function () {
    this.timeout(20_000);
    const { http } = fixtureHttp();
    const failing = http;
    const http2: DrHttp = async (url, opts) => {
      if (url.includes("batchexecute")) {
        // never any report
        return { status: 200, headers: { get: () => null }, buf: Buffer.from(")]}'\n\n25\n[[\"e\",4,null,null,25]]\n") };
      }
      return failing(url, opts);
    };
    const r = await geminiDeepResearch({
      cookie: { psid: "psid-test", psidts: "ts-test" },
      query: "q",
      timeoutMs: 1200,
      http: http2,
    });
    expect(r.title).to.equal("JPEG Compression Research Plan");
    expect(r.partial).to.match(/could not be retrieved/);
    expect(r.partial).to.include("c_");
  });

  it("fails fast with an honest partial when the poll is auth-rejected (403)", async function () {
    this.timeout(10_000);
    let streamTurns = 0;
    let polls = 0;
    const http: DrHttp = async (url) => {
      if (url.startsWith("https://gemini.google.com/app")) {
        return {
          status: 200,
          headers: { get: () => null, "set-cookie": [] },
          buf: Buffer.from(')]}\'\n<html>"SNlM0e":"","cfb2h":"boq_test_build","FdrFJe":"1"</html>'),
        };
      }
      if (url.includes("StreamGenerate")) {
        streamTurns++;
        return { status: 200, headers: { get: () => null }, buf: streamTurns === 1 ? fixture("dr-plan.bin") : fixture("dr-confirm.bin") };
      }
      polls++;
      return { status: 403, headers: { get: () => null }, buf: Buffer.from("") };
    };
    const r = await geminiDeepResearch({ cookie: { psid: "psid-test", psidts: "ts-test" }, query: "q", timeoutMs: 8_000, http });
    expect(polls).to.equal(1); // first rejection breaks the loop — no re-polling to the deadline
    expect(r.partial).to.include("report poll rejected (HTTP 403)");
    expect(r.partial).to.include("c_10950ff6b1b0ebc1"); // chat id still surfaced
  });
});

describe("extractCookieJar (case-independent seeding, no duplicate Cookie header)", () => {
  it("seeds the jar from lowercase and capital Cookie keys, stripping the header from rest", () => {
    for (const key of ["cookie", "Cookie"]) {
      const { rest, jar } = extractCookieJar({ [key]: "__Secure-1PSID=abc; NID=zz", "content-type": "x" });
      expect(jar.get("__Secure-1PSID")).to.equal("abc");
      expect(jar.get("NID")).to.equal("zz");
      expect(rest).to.deep.equal({ "content-type": "x" });
      expect(Object.keys(rest).some((k) => k.toLowerCase() === "cookie")).to.be.false;
    }
  });

  it("tolerates a missing cookie header", () => {
    const { rest, jar } = extractCookieJar({ accept: "*/*" });
    expect(jar.size).to.equal(0);
    expect(rest).to.deep.equal({ accept: "*/*" });
  });
});

describe("abortableSleep (listener hygiene)", () => {
  function countingSignal(): { signal: AbortSignal; added: () => number; removed: () => number } {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = controller.signal as AbortSignal & Record<string, unknown>;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...a: unknown[]) => {
      added++;
      return (realAdd as (...args: unknown[]) => void)(...a);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...a: unknown[]) => {
      removed++;
      return (realRemove as (...args: unknown[]) => void)(...a);
    }) as typeof signal.removeEventListener;
    return { signal, added: () => added, removed: () => removed };
  }

  it("removes its abort listener when the timer wins (no leak across polls)", async () => {
    const { signal, added, removed } = countingSignal();
    for (let i = 0; i < 3; i++) await abortableSleep(5, signal);
    expect(added()).to.equal(3);
    expect(removed()).to.equal(3);
  });

  it("rejects with AbortError when aborted mid-sleep", async () => {
    const controller = new AbortController();
    const p = abortableSleep(60_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    try {
      await p;
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).to.equal("AbortError");
    }
  });
});
