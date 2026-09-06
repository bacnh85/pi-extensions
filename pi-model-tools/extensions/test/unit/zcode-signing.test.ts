import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientSigningManager,
  buildZcodeIdentityHeaders,
  createProofOfWork,
  parseSigningCredential,
  resolveZcodeIdentity,
  zcodeSigningEnabled,
  type MutableHeaders,
  type SigningCredential,
} from "../../lib/zcode-signing.ts";

const IDENTITY = {
  appVersion: "3.10.2",
  sourceTitle: "electron",
  refererOrigin: "https://zcode.z.ai",
  deviceMid: "11111111-2222-3333-4444-555555555555",
};
const CRED: SigningCredential = { credential: "abc123.secret456", appVersion: "3.10.2" };
const URL_ULTRA = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
const URL_API = "https://api.z.ai/api/anthropic/v1/messages";
const URL_START_PLAN = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

const GATE_ENABLED = {
  code: 0,
  data: { codingPlanSignature: { enable: true } },
};
const GATE_DISABLED = { code: 0, data: {} };

/** JSON response helper for the injected fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function baseHeaders(): MutableHeaders {
  return {
    "x-api-key": CRED.credential,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-session-id": "sess_test_0001",
  };
}

// The fixture needs the same HKDF the lib uses; re-implemented here so the test
// validates against the algorithm, not a shared secret helper.
async function hkdfTestHelpers() {
  const { createHash, hkdfSync } = await import("node:crypto");
  return {
    createHash,
    derive: (secret: string, info: string) =>
      new Uint8Array(
        hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("WD_CLIENT_SIGN_KDF_SALT", "utf8"), Buffer.from(info, "utf8"), 32),
      ),
  };
}

/** Server-side privateCipher for apiKeyId/secret wrapping pkcs8 (AES-256-GCM, AAD=apiKeyId). */
async function sealPrivateKey(apiKeyId: string, secret: string, pkcs8: Uint8Array<ArrayBuffer>): Promise<string> {
  const { derive } = await hkdfTestHelpers();
  const aesBits = new Uint8Array(derive(secret, "ed25519_priv"));
  const aesKey = await crypto.subtle.importKey("raw", aesBits, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: Buffer.from(apiKeyId, "utf8"), tagLength: 128 },
      aesKey,
      pkcs8,
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return Buffer.from(out).toString("base64");
}

interface MockCalls {
  urls: string[];
  gateCount: number;
  handshakeCount: number;
}

/**
 * Fetch mock: gate (enabled/disabled per arg) + handshake returning a fixture
 * cipher for a freshly generated key (kept in `state.privateKey`).
 */
function makeFetch(opts: { gateEnabled: boolean; gateThrows?: boolean; handshakeStatus?: number }) {
  const calls: MockCalls = { urls: [], gateCount: 0, handshakeCount: 0 };
  const privateKeys: CryptoKey[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.urls.push(url);
    if (url.includes("/api/v1/agent/configs")) {
      calls.gateCount += 1;
      if (opts.gateThrows) throw new Error("network down");
      return jsonResponse(opts.gateEnabled ? GATE_ENABLED : GATE_DISABLED);
    }
    if (url.includes("/api/paas/c1f3a7e2/v2/client")) {
      calls.handshakeCount += 1;
      if (opts.handshakeStatus) return jsonResponse({ code: opts.handshakeStatus, msg: "nope" }, opts.handshakeStatus);
      // Verify the HMAC handshake signature the same way the server would.
      const body = JSON.parse(String(init?.body)) as { apiKey: string; nonce: string; sig: string; ts: string };
      const [apiKeyId, secret] = body.apiKey.split(".");
      const { derive } = await hkdfTestHelpers();
      const hmacBits = new Uint8Array(derive(secret, "getSignKey_hmac"));
      const hmacKey = await crypto.subtle.importKey("raw", hmacBits, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      const message = `get_sign_key\n${apiKeyId}\n${body.ts}\n${body.nonce}`;
      const ok = await crypto.subtle.verify(
        "HMAC",
        hmacKey,
        Buffer.from(body.sig, "base64"),
        Buffer.from(message, "utf8"),
      );
      assert.ok(ok, "handshake HMAC signature must verify server-side");
      const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
      privateKeys.push(pair.privateKey);
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      // The server seals the PKCS8 key as BASE64 TEXT (upstream TextDecoder decode).
      const pkcs8Text = Buffer.from(pkcs8).toString("base64");
      const privateCipher = await sealPrivateKey(apiKeyId, secret, new TextEncoder().encode(pkcs8Text));
      return jsonResponse({ code: 200, data: { privateCipher } });
    }
    return jsonResponse({ code: 404 }, 404);
  };
  return { fetchImpl, calls, getPrivateKey: (i = 0) => privateKeys[i] };
}

async function signedHeaders(manager: ClientSigningManager, url = URL_ULTRA): Promise<MutableHeaders> {
  const headers = baseHeaders();
  const signed = await manager.sign(url, headers, CRED);
  assert.equal(signed, true, "request should be signed");
  return headers;
}

describe("zcode-signing", () => {
  it("credential parse: two-part ok, zero/two dots rejected, empty parts rejected", () => {
    assert.deepEqual(parseSigningCredential("abc123.secret456"), { apiKeyId: "abc123", apiKeySecret: "secret456" });
    assert.equal(parseSigningCredential("nodotshere"), undefined);
    assert.equal(parseSigningCredential("a.b.c"), undefined);
    assert.equal(parseSigningCredential(".secret"), undefined);
    assert.equal(parseSigningCredential("id."), undefined);
  });

  it("identity headers: exact set, env overrides, printable gate drops bad values", () => {
    const h = buildZcodeIdentityHeaders(IDENTITY);
    assert.equal(h["User-Agent"], "ZCode/3.10.2");
    assert.equal(h["X-ZCode-App-Version"], "3.10.2");
    assert.equal(h["X-Title"], "Z Code@electron");
    assert.equal(h["X-ZCode-Agent"], "glm");
    assert.equal(h["HTTP-Referer"], "https://zcode.z.ai");
    assert.equal(h["X-Release-Channel"], "production");
    assert.equal(h["X-Device-Mid"], IDENTITY.deviceMid);
    assert.ok(h["X-Platform"] && h["X-Platform"].includes("-"));
    assert.ok(h["X-Client-Language"], "locale header present");
    assert.ok(h["X-Client-Timezone"], "timezone header present");
    assert.ok(h["X-Os-Category"] && h["X-Os-Version"]);
    // printable-ASCII gate: unprintable appVersion → header dropped, UA falls back
    const bad = buildZcodeIdentityHeaders({ ...IDENTITY, appVersion: "bad\u0007bell" });
    assert.equal(bad["User-Agent"], "ZCode/unknown");
    assert.equal(bad["X-ZCode-App-Version"], undefined);
    // env override wins (resolveZcodeIdentity applies it before header build)
    const prev = process.env.ZCODE_IDENTITY_APP_VERSION;
    process.env.ZCODE_IDENTITY_APP_VERSION = "9.9.9";
    try {
      assert.equal(resolveZcodeIdentity().appVersion, "9.9.9");
    } finally {
      if (prev === undefined) delete process.env.ZCODE_IDENTITY_APP_VERSION;
      else process.env.ZCODE_IDENTITY_APP_VERSION = prev;
    }
  });

  it("resolveZcodeIdentity: appVersion default and non-secret deviceMid present", () => {
    const id = resolveZcodeIdentity();
    assert.match(id.appVersion, /^[\x20-\x7e]+$/);
    assert.ok(id.deviceMid && id.deviceMid.length >= 32, "deviceMid is a UUID");
    assert.equal(id.refererOrigin, "https://zcode.z.ai");
  });

  it("PoW: candidate solves 8 leading zero bits and matches nonce+counter shape", async () => {
    const pow = await createProofOfWork("abc123", "sess_x", "1700000000000");
    assert.match(pow, /^[0-9a-f]{24}[0-9a-f]{8}$/, "12-byte nonce hex + 4-byte counter hex");
    // Re-derive: seed + candidate digest must have 8 leading zero bits.
    const { createHash } = await import("node:crypto");
    const seed = createHash("sha256").update("abc123\nzcode\nsess_x\n1700000000000", "utf8").digest("hex").slice(0, 32);
    const digest = createHash("sha256").update(`${seed}\n${pow}`, "utf8").digest();
    assert.equal(digest[0], 0, "8 leading zero bits = first byte zero");
  });

  it("signing happy path: gate probe + handshake once, all 7 headers, sig verifies with fixture pubkey, PoW valid", async () => {
    const { fetchImpl, calls, getPrivateKey } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = await signedHeaders(manager); // signed with handshake #1's key
    for (const name of ["X-Client-Ts", "X-Client-Version", "X-Client-Sig", "X-Session-Id", "X-Client-Nonce", "X-App-Id", "X-Client-Pow"]) {
      assert.ok(headers[name], `${name} present`);
    }
    assert.equal(headers["X-App-Id"], "zcode");
    assert.equal(headers["X-Session-Id"], "sess_test_0001");
    assert.equal(headers["X-Client-Version"], "3.10.2");
    assert.ok(!("x-session-id" in headers), "lowercase copy replaced by canonical X-Session-Id");

    // gate + handshake: once per (origin, credential) state; cached afterwards
    assert.equal(calls.gateCount, 1);
    assert.equal(calls.handshakeCount, 1);
    assert.ok(calls.urls[0].startsWith("https://zcode.z.ai/api/v1/agent/configs"));
    // handshake plane is host-fixed to api.z.ai (live-verified: 404 on zcode.z.ai)
    assert.ok(calls.urls[1].startsWith("https://api.z.ai/api/paas/c1f3a7e2/v2/client"));
    await signedHeaders(manager, URL_ULTRA); // cached — no extra network
    assert.equal(calls.gateCount + calls.handshakeCount, 2, "gate+handshake cached per credential");

    // Verify the business signature with the fixture's public key.
    const apiKeyId = CRED.credential.split(".")[0];
    const message = `${apiKeyId}\n${headers["X-Client-Ts"]}\n3.10.2\nsess_test_0001\n${headers["X-Client-Nonce"]}`;
    const verifyKey = await publicFromPrivate(getPrivateKey(0)!);
    const ok = await crypto.subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(headers["X-Client-Sig"]!, "base64"),
      Buffer.from(message, "utf8"),
    );
    assert.ok(ok, "Ed25519 signature verifies with the handshake-issued key");
  });

  it("fail-open: gate disabled → untouched headers", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: false });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = baseHeaders();
    const signed = await manager.sign(URL_ULTRA, headers, CRED);
    assert.equal(signed, false);
    assert.deepEqual(Object.keys(headers).sort(), Object.keys(baseHeaders()).sort());
    assert.equal(calls.gateCount, 1);
    assert.equal(calls.handshakeCount, 0);
  });

  it("fail-open: gate fetch throws → unsigned, negative-cached (immediate 2nd call no refetch)", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: true, gateThrows: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = baseHeaders();
    assert.equal(await manager.sign(URL_ULTRA, headers, CRED), false);
    assert.equal(await manager.sign(URL_ULTRA, headers, CRED), false);
    assert.equal(calls.gateCount, 1, "cooldown prevents refetch");
  });

  it("fail-open: handshake 500 → unsigned", async () => {
    const { fetchImpl } = makeFetch({ gateEnabled: true, handshakeStatus: 500 });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = baseHeaders();
    assert.equal(await manager.sign(URL_ULTRA, headers, CRED), false);
    assert.ok(!headers["X-Client-Sig"]);
  });

  it("unsigned paths and non-https are never signed", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    assert.equal(await manager.sign(URL_START_PLAN, baseHeaders(), CRED), false);
    assert.equal(await manager.sign("http://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages", baseHeaders(), CRED), false);
    assert.equal(calls.gateCount, 0, "no network before eligibility checks");
  });

  it("missing x-session-id → skipped (client's own rule)", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = baseHeaders();
    delete headers["x-session-id"];
    assert.equal(await manager.sign(URL_ULTRA, headers, CRED), false);
    assert.equal(calls.gateCount, 0);
  });

  it("single-part credential → skipped", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    assert.equal(await manager.sign(URL_ULTRA, baseHeaders(), { credential: "legacy-key", appVersion: "3.10.2" }), false);
    assert.equal(calls.gateCount, 0, "cheap local checks run before the network");
  });

  it("401 ladder: two consecutive 401s after signed requests → bypass", async () => {
    const { fetchImpl } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    await signedHeaders(manager); // sign #1
    manager.noteResponse401(); // 401 after sign #1 → count 1 + invalidate
    await signedHeaders(manager, URL_ULTRA); // re-handshake, sign #2
    manager.noteResponse401(); // 401 after sign #2 → count 2 → bypass
    const headers = baseHeaders();
    assert.equal(await manager.sign(URL_ULTRA, headers, CRED), false, "bypassed after 2 consecutive 401s");
    assert.ok(!headers["X-Client-Sig"]);
  });

  it("401 ladder: an intervening success resets the count (consecutive semantics)", async () => {
    const { fetchImpl } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    await signedHeaders(manager);
    manager.noteResponse401(); // 401 #1
    await signedHeaders(manager, URL_ULTRA);
    manager.noteResponseOk(); // success between 401s
    await signedHeaders(manager, URL_ULTRA);
    manager.noteResponse401(); // 401 again — count back to 1, NOT bypass
    await signedHeaders(manager, URL_ULTRA); // must still sign
  });

  it("origin allowlist: non-z.ai base URL → unsigned, zero network (no credential egress)", async () => {
    const { fetchImpl, calls } = makeFetch({ gateEnabled: true });
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl });
    const headers = baseHeaders();
    assert.equal(
      await manager.sign("https://open.bigmodel.cn/api/anthropic/v1/messages", headers, CRED),
      false,
      "bigmodel origin never signed",
    );
    assert.equal(calls.gateCount + calls.handshakeCount, 0, "no fetch may carry the credential to the gate/handshake");
    assert.ok(!headers["X-Client-Sig"]);
  });

  it("handshake failure backs off: immediate retry does not re-attempt the handshake", async () => {
    let calls = 0;
    let gateUp = true;
    const now = { t: 1_000_000_000_000 };
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/agent/configs")) return jsonResponse(gateUp ? GATE_ENABLED : GATE_DISABLED);
      calls += 1;
      return jsonResponse({ code: 500, msg: "boom" }, 500);
    };
    const manager = new ClientSigningManager({ identity: IDENTITY, fetchImpl, now: () => now.t });
    const h1 = baseHeaders();
    assert.equal(await manager.sign(URL_ULTRA, h1, CRED), false);
    assert.equal(calls, 1);
    const h2 = baseHeaders();
    assert.equal(await manager.sign(URL_ULTRA, h2, CRED), false, "unsigned during cooldown");
    assert.equal(calls, 1, "handshake not retried within cooldown");
    now.t += 61_000; // advance past cooldown → retries
    assert.equal(await manager.sign(URL_ULTRA, baseHeaders(), CRED), false, "still fails (500)");
    assert.equal(calls, 2, "handshake retried after cooldown");
  });
});

async function publicFromPrivate(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const { crv, kty, x, y } = jwk;
  return await crypto.subtle.importKey("jwk", { crv, kty, x, y }, "Ed25519", true, ["verify"]);
}
