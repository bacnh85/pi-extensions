import { assert } from "chai";

import { startBroadcast, startDiscovery, txtRecord, mdnsPeerKey, mdnsInstanceName, mdnsInstanceHost } from "../lib/mdns";

describe("mDNS", () => {
  describe("startBroadcast / startDiscovery", () => {
    // bonjour-service is an optional dep. Whether installed or not, the public
    // API must return a handle and never throw.
    //
    // NOTE: these live-socket tests publish mDNS records. They stay off by
    // default (opt in with MDNS_NETWORK_TESTS=1) because a naive publish
    // would claim the OS local hostname and make macOS mDNSResponder rename
    // the machine. When run, the pid-suffixed host claim is conflict-free
    // (see mdnsInstanceHost tests).
    const network = process.env.MDNS_NETWORK_TESTS === "1";
    const each = network ? it : it.skip;

    each("startBroadcast returns a handle without throwing", async () => {
      const handle = await startBroadcast({
        serviceType: "a2a",
        name: "pi-test",
        port: 49910, // bonjour-service only ADVERTISES the port; a nonzero value
        // is required or the Service constructor throws and the test would
        // silently exercise the graceful-degrade path instead of publishing.
        txt: { url: "http://127.0.0.1:9910/", cwd: "/r", model: "anthropic/claude" },
      });
      assert.isOk(handle);
      await handle.stop();
    });

    each("startDiscovery returns a handle without throwing", async () => {
      let fired = false;
      const handle = await startDiscovery({
        serviceType: "a2a",
        onUp: () => {
          fired = true;
        },
      });
      assert.isOk(handle);
      await handle.stop();
      // We don't assert !fired — a real network may have peers. The contract
      // is only "returns a handle, stop() is safe".
      void fired;
    });

    each("startDiscovery accepts an onDown callback without throwing", async () => {
      const handle = await startDiscovery({
        serviceType: "a2a",
        onUp: () => {},
        onDown: () => {},
      });
      assert.isOk(handle);
      await handle.stop();
    });
  });

  describe("mdnsInstanceHost / mdnsInstanceName (hostname-claim guards)", () => {
    it("claims a pid-suffixed name, never the OS hostname", () => {
      assert.equal(mdnsInstanceHost("MBP-Sao.local", 1234), "mbp-sao-local-a2a-1234.local");
      // Regression guard: announcing this host must NOT claim the OS name
      // (that is what makes macOS rename the machine).
      assert.notEqual(mdnsInstanceHost("MBP-Sao.local", 1234), "MBP-Sao.local");
    });

    it("sanitizes to RFC 6762-safe labels and caps at 63 chars", () => {
      const h = mdnsInstanceHost("Weird Host_Name!", 7);
      assert.equal(h, "weird-host-name-a2a-7.local");
      assert.isTrue(h.length <= 63, "label must fit a DNS label");
      const long = mdnsInstanceHost("x".repeat(100), 1);
      assert.isTrue(long.length <= 63);
      assert.equal(mdnsInstanceHost("", 5), "pi-a2a-5.local");
      // Instance names get the same suffix-aware cap (long agentName must not
      // produce malformed >63-octet labels that peers silently reject).
      assert.isTrue(mdnsInstanceName("x".repeat(100), 1234567).length <= 63);
      assert.equal(mdnsInstanceName("a", 1), "a-1");
      // Capping at a dash boundary must not produce a double hyphen.
      // Inputs are tuned so the sanitized form is longer than the cap AND has
      // a hyphen exactly at the slice cut (index 63 - suffix.length - 1).
      const nameBoundary = "a".repeat(60) + "-b" + "c".repeat(10); // cut for pid 1 lands on the hyphen
      const hostBoundary = "a".repeat(50) + "-b" + "c".repeat(10); // cut for host lands on the hyphen
      assert.notMatch(mdnsInstanceName(nameBoundary, 1), /--/);
      assert.notMatch(mdnsInstanceHost(hostBoundary, 1), /--/);
    });

    it("makes per-session instance names unique (no probe collision)", () => {
      assert.equal(mdnsInstanceName("My Pi!", 7), "my-pi-7");
      assert.notEqual(mdnsInstanceName("same-agent", 100), mdnsInstanceName("same-agent", 200));
    });
  });

  describe("mdnsPeerKey (dedup)", () => {
    it("uses txt.url when present", () => {
      assert.equal(
        mdnsPeerKey({ name: "a", host: "h", port: 1, txt: { url: "http://1.2.3.4:9910//" } }),
        "http://1.2.3.4:9910",
      );
    });
    it("falls back to name:host:port when no txt.url", () => {
      assert.equal(mdnsPeerKey({ name: "pi", host: "10.0.0.1", port: 9910 }), "pi:10.0.0.1:9910");
      assert.equal(mdnsPeerKey({ name: "pi", host: "10.0.0.1", port: 9910, txt: {} }), "pi:10.0.0.1:9910");
    });
  });

  describe("txtRecord", () => {
    it("packs session essentials into a string map", () => {
      const txt = txtRecord({ url: "http://1.2.3.4:9910/", cwd: "/repo", model: "anthropic/claude" });
      assert.deepEqual(txt, {
        url: "http://1.2.3.4:9910/",
        cwd: "/repo",
        model: "anthropic/claude",
      });
    });

    it("caps every value at 255 UTF-8 bytes (RFC 1035 char-string limit)", () => {
      const txt = txtRecord({
        url: "http://x/" + "x".repeat(300),
        cwd: "/" + "d".repeat(300),
        model: "m".repeat(300),
      });
      for (const v of Object.values(txt)) {
        assert.isAtMost(Buffer.byteLength(v, "utf-8"), 255, "TXT value must fit one byte length prefix");
      }
      // Cuts on a char boundary — multibyte input must not split a codepoint.
      const unicode = "\u00e9".repeat(300); // é is 2 bytes in UTF-8
      const capped = txtRecord({ url: unicode, cwd: "c", model: "m" }).url!;
      assert.isAtMost(Buffer.byteLength(capped, "utf-8"), 255);
      assert.equal([...capped].length * 2, Buffer.byteLength(capped, "utf-8"), "no split codepoints");
    });
  });
});
