/**
 * Unit tests for the local Chrome capture engine (lib/chrome.ts).
 */

import { expect } from "chai";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPdfArgs,
  buildScreenshotArgs,
  capturePdf,
  captureScreenshot,
  findChromeBinary,
  isLocalUrl,
  isSsrfBlocked,
  resolveEngine,
} from "../../lib/chrome";

describe("isLocalUrl", () => {
  const local = [
    "http://localhost:3000",
    "http://localhost",
    "https://app.localhost:5173",
    "http://127.0.0.1:8080",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.50:4200",
    "http://169.254.1.1/",
    "http://0.0.0.0/",
    "http://[::1]:8080",
    "http://[fd00::1]:3000",
    "http://[fe80::1]:3000",
    "file:///Users/me/project/index.html",
  ];
  for (const url of local) {
    it(`local: ${url}`, () => {
      expect(isLocalUrl(url)).to.equal(true);
    });
  }

  const remote = [
    "https://example.com",
    "http://8.8.8.8/",
    "http://172.32.0.1/",
    "http://192.169.1.1/",
    "http://[2001:db8::1]/",
    "https://developer.chrome.com/blog",
    "not a url",
  ];
  for (const url of remote) {
    it(`remote: ${url}`, () => {
      expect(isLocalUrl(url)).to.equal(false);
    });
  }
});

describe("resolveEngine", () => {
  it("auto routes localhost to local", () => {
    expect(resolveEngine("auto", "http://localhost:3000")).to.equal("local");
    expect(resolveEngine(undefined, "http://127.0.0.1:8080")).to.equal("local");
    expect(resolveEngine(undefined, "file:///tmp/x.html")).to.equal("local");
  });

  it("auto routes public URLs to daemon", () => {
    expect(resolveEngine("auto", "https://example.com")).to.equal("daemon");
    expect(resolveEngine(undefined, "https://example.com")).to.equal("daemon");
  });

  it("explicit engine wins over URL class", () => {
    expect(resolveEngine("local", "https://example.com")).to.equal("local");
    expect(resolveEngine("daemon", "http://localhost:3000")).to.equal("daemon");
  });
});

describe("isSsrfBlocked", () => {
  it("matches daemon SSRF rejections", () => {
    expect(isSsrfBlocked(new Error("URL blocked (SSRF protection)"))).to.equal(true);
    expect(isSsrfBlocked(new Error("request failed: SSRF protection triggered"))).to.equal(true);
    expect(isSsrfBlocked(new Error("connection refused"))).to.equal(false);
    expect(isSsrfBlocked("URL blocked by policy")).to.equal(true);
  });
});

describe("buildScreenshotArgs", () => {
  const base = {
    chromePath: "/usr/bin/chrome",
    outPath: "/tmp/out.png",
    userDataDir: "/tmp/profile",
    url: "http://localhost:3000",
    width: 1280,
    height: 800,
  };

  it("builds headless screenshot command with defaults", () => {
    const args = buildScreenshotArgs(base);
    expect(args[0]).to.equal("/usr/bin/chrome");
    expect(args).to.include("--headless");
    expect(args).to.include("--window-size=1280,800");
    expect(args).to.include("--screenshot=/tmp/out.png");
    expect(args).to.include("--user-data-dir=/tmp/profile");
    expect(args[args.length - 1]).to.equal("http://localhost:3000");
    expect(args.join(" ")).to.not.include("virtual-time-budget");
  });

  it("fullPage uses the tall-window ceiling", () => {
    const args = buildScreenshotArgs({ ...base, fullPage: true });
    expect(args).to.include("--window-size=1280,8000");
  });

  it("waitForSec maps to virtual-time-budget", () => {
    const args = buildScreenshotArgs({ ...base, waitForSec: 2.5 });
    expect(args).to.include("--virtual-time-budget=2500");
  });
});

describe("buildPdfArgs", () => {
  it("builds print-to-pdf command without headers", () => {
    const args = buildPdfArgs({
      chromePath: "/usr/bin/chrome",
      outPath: "/tmp/out.pdf",
      userDataDir: "/tmp/profile",
      url: "http://localhost:3000",
    });
    expect(args).to.include("--print-to-pdf=/tmp/out.pdf");
    expect(args).to.include("--no-pdf-header-footer");
    expect(args[args.length - 1]).to.equal("http://localhost:3000");
  });
});

describe("findChromeBinary", () => {
  it("prefers CHROME_PATH when it exists", () => {
    const fake = process.argv[0]; // some path that definitely exists
    process.env.CHROME_PATH = fake;
    try {
      expect(findChromeBinary()).to.equal(fake);
    } finally {
      delete process.env.CHROME_PATH;
    }
  });

  it("falls through when CHROME_PATH does not exist", () => {
    process.env.CHROME_PATH = "/nonexistent/chrome-binary-xyz";
    try {
      // On a dev machine with Chrome installed this finds the real binary;
      // in CI it returns null. Either way it must not return the bad path.
      const found = findChromeBinary();
      expect(found).to.not.equal("/nonexistent/chrome-binary-xyz");
    } finally {
      delete process.env.CHROME_PATH;
    }
  });

  it("returns a string or null", () => {
    const found = findChromeBinary();
    expect(found === null || typeof found === "string").to.equal(true);
  });
});

describe("capture URL trust boundary", () => {
  it("rejects switch-like URLs before any spawn", async () => {
    try {
      await captureScreenshot({ url: "--proxy-server=http://evil", timeoutMs: 500 });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("Invalid capture URL");
      expect(err.message).to.not.include("Chrome");
    }
  });

  it("rejects non-http/file schemes for PDF too", async () => {
    try {
      await capturePdf({ url: "chrome://settings", timeoutMs: 500 });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).to.include("Invalid capture URL");
    }
  });
});

describe("runChrome via stub binary", () => {
  const PAYLOAD = "FAKEPNGDATA";
  let dir: string;

  const writeStub = (body: string): string => {
    const p = path.join(dir, `stub-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  // Stub contract: writes the --screenshot= target, then (optionally) hangs.
  const writeAndMaybeHang = (hang: boolean): string =>
    writeStub(
      `for a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}" ;; esac; done\n` +
      `printf '${PAYLOAD}' > "$out"\n` +
      (hang ? "sleep 30\n" : ""),
    );

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-chrome-test-"));
  });

  afterEach(() => {
    delete process.env.CHROME_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves via the file-stability poll even when the binary never exits", async () => {
    process.env.CHROME_PATH = writeAndMaybeHang(true); // writes, then sleeps forever
    const cap = await captureScreenshot({ url: "http://localhost:9/x", timeoutMs: 10_000 });
    expect(cap.base64).to.equal(Buffer.from(PAYLOAD).toString("base64"));
  });

  it("rejects on timeout when no output file appears", async () => {
    process.env.CHROME_PATH = writeStub("sleep 30"); // never writes
    try {
      await captureScreenshot({ url: "http://localhost:9/x", timeoutMs: 700 });
      expect.fail("should have timed out");
    } catch (err: any) {
      expect(err.message).to.include("timed out");
    }
  });
});
