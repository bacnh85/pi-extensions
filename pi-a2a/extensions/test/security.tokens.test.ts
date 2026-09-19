import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  audit,
  auditPath,
  redactConfiguredTokens,
  redactOutbound,
} from "../lib/security";
import { makeTempDir } from "./tmp";

/**
 * Test-only reproduction (security sweep branch burn-pi-secvuln-0919):
 * outbound redaction previously scrubbed only credential-SHAPED patterns
 * (sk-*, ghp_*, JWTs, bearer headers, emails). The deployment's own
 * configured secrets — sharedToken, per-peer tokens, per-peer bearer/apiKey
 * auth tokens, gateway tokens and upstreamTokens — were NOT in that set, so a
 * reply or dispatched message containing one (e.g. the model echoing
 * "the peer token for alice is <value>") left the trust boundary verbatim.
 *
 * The fix: `redactConfiguredTokens` collects every configured secret from an
 * A2AConfig and redacts exact, non-trivial (>= 8 chars) occurrences before
 * the shape-based redactOutbound runs.
 */
describe("security — configured-token redaction (secvuln sweep 0919)", () => {
  const cfg = {
    peers: {
      alpha: { auth: { type: "bearer", token: "alpha-bearer-token-9876" } },
      beta: { auth: { type: "none" } },
      gamma: {
        auth: { type: "apiKey", token: "gamma-api-key-4521" },
        url: "",
        timeout: 1,
        capabilities: [],
      },
    },
    selfIdentity: "",
    server: {
      sharedToken: "shared-token-aabbcc-1122334455",
      peerTokens: {
        alice: "alice-peer-token-773411",
        bob: "bob-peer-token-8842211",
      },
      trustedPeers: [],
      allowAllUsers: false,
      skills: [],
    },
    discovery: {
      gateway: {
        enabled: true,
        url: "http://127.0.0.1:9920",
        token: "gateway-token-1123581321",
      },
      gateways: {
        prod: {
          enabled: true,
          url: "http://127.0.0.1:9921",
          token: "second-gateway-token-951",
          upstreamToken: "upstream-gateway-token-626",
        },
      },
    },
  } as any;

  const SECRET_CASES: Array<[string, string]> = [
    ["server.sharedToken", cfg.server.sharedToken],
    ["server.peerTokens entry", cfg.server.peerTokens.alice],
    ["server.peerTokens entry", cfg.server.peerTokens.bob],
    ["peers[*].auth.token (bearer)", cfg.peers.alpha.auth.token],
    ["peers[*].auth.token (apiKey)", cfg.peers.gamma.auth.token],
    ["discovery.gateway.token", cfg.discovery.gateway.token],
    ["discovery.gateways[k].token", cfg.discovery.gateways.prod.token],
    ["discovery.gateways[k].upstreamToken", cfg.discovery.gateways.prod.upstreamToken],
  ];

  it("redacts every configured token class from outbound text", () => {
    for (const [kind, secret] of SECRET_CASES) {
      const text = `run ${kind}: ${secret} through the pipe`;
      const out = redactConfiguredTokens(text, cfg);
      assert.notInclude(out, secret, `${kind} must be redacted`);
      assert.equal(out, `run ${kind}: [redacted-token] through the pipe`);
      // Chained: shape-based redaction still applies afterwards.
      assert.equal(redactOutbound(out), `run ${kind}: [redacted-token] through the pipe`);
    }
  });

  it("redacts when the token is embedded mid-word in a longer string", () => {
    const out = redactConfiguredTokens(
      `prefix${cfg.server.peerTokens.alice}suffix`,
      cfg,
    );
    assert.notInclude(out, cfg.server.peerTokens.alice);
  });

  it("never redacts short/trivial strings (input integrity)", () => {
    const text = "keep 1 ab 1234567 intact";
    assert.equal(redactConfiguredTokens(text, cfg), text);
  });

  it("tolerates missing config shapes without crashing", () => {
    assert.equal(redactConfiguredTokens("hello world", undefined), "hello world");
    assert.equal(redactConfiguredTokens("hello world", {} as any), "hello world");
    assert.equal(redactConfiguredTokens("", cfg), "");
  });

  it("deduplicates a token configured under multiple keys", () => {
    const dup = { ...cfg, server: { ...cfg.server, sharedToken: cfg.server.peerTokens.alice } } as any;
    const text = `x ${cfg.server.peerTokens.alice} y`;
    assert.equal(redactConfiguredTokens(text, dup), "x [redacted-token] y");
  });

  it("redacts minted inbound gateway tokens (extraTokens class, secvuln2 0920)", () => {
    // `agw-…` tokens are minted per server start for gateway entries without an
    // explicit upstreamToken, persisted to <piDir>/a2a_gateways/<key>.json, and
    // accepted inbound via authenticate()'s extraTokens — they are LIVE
    // credentials for this deployment, exactly like the H-1 classes, yet they
    // live in a server-side Map, not in cfg, so collectConfiguredTokens(cfg)
    // cannot see them. The extraTokens parameter closes that gap.
    const minted = { "gw-main": "agw-minted01abcdef0123456789abcdef" };
    const text = `gateway caller token is ${minted["gw-main"]} — keep it secret`;
    const out = redactConfiguredTokens(text, cfg, { extraTokens: minted });
    assert.notInclude(out, minted["gw-main"], "minted inbound token must be redacted");
    assert.include(out, "[redacted-token]");
  });

  it("still redacts without extraTokens (back-compat of the 3-arg call)", () => {
    const text = `shared: ${cfg.server.sharedToken}`;
    assert.equal(redactConfiguredTokens(text, cfg), "shared: [redacted-token]");
  });
});

describe("security — audit preview redaction (L-1, secvuln2 0920)", () => {
  const cfg = {
    server: {
      sharedToken: "shared-token-aabbcc-1122334455",
      peerTokens: { alice: "alice-peer-token-773411" },
    },
  } as any;
  const secrets = [
    cfg.server.sharedToken,
    cfg.server.peerTokens.alice,
    "sk-ant-SYNTHETICKEYVALUE0123",
  ];

  it("redacts configured + credential-shaped strings in the stored preview", () => {
    const piDir = makeTempDir("pi-a2a-auditredact-");
    const text = `peer said: token is ${cfg.server.sharedToken} and ${cfg.server.peerTokens.alice} and ${"sk-ant-SYNTHETICKEYVALUE0123"}`;
    audit({ piDir, direction: "inbound", identity: "alice", taskId: "task-1", text, config: cfg });
    const line = JSON.parse(readFileSync(auditPath(piDir), "utf-8"));
    for (const secret of secrets) {
      assert.notInclude(line.preview, secret);
    }
    assert.include(line.preview, "[redacted-token]");
    assert.include(line.preview, "[redacted]");
  });

  it("redacts before truncation — a token must never straddle the 300-char cut", () => {
    const piDir = makeTempDir("pi-a2a-auditredact2-");
    // Token starts beyond the 300-char preview boundary: slice-then-redact
    // would keep it verbatim (half in / fully past the cut is still a leak
    // when combined with adjacent audit lines); redact-then-slice cannot.
    const pad = "x".repeat(340);
    const text = `${pad}${cfg.server.sharedToken}`;
    audit({ piDir, direction: "inbound", identity: "alice", taskId: "task-2", text, config: cfg });
    const line = JSON.parse(readFileSync(auditPath(piDir), "utf-8"));
    assert.notInclude(line.preview, cfg.server.sharedToken);
    assert.isAtMost(line.preview.length, 300 + "[redacted-token]".length);
  });

  it("stores plain previews unchanged (no over-redaction)", () => {
    const piDir = makeTempDir("pi-a2a-auditredact3-");
    const text = "a plain forensic line, no secrets here";
    audit({ piDir, direction: "inbound", identity: "alice", taskId: "task-3", text, config: cfg });
    const line = JSON.parse(readFileSync(auditPath(piDir), "utf-8"));
    assert.equal(line.preview, text);
  });

  it("tolerates a missing config (audit keeps working)", () => {
    const piDir = makeTempDir("pi-a2a-auditredact4-");
    audit({ piDir, direction: "inbound", identity: "alice", taskId: "task-4", text: "no cfg passed", config: undefined });
    const line = JSON.parse(readFileSync(auditPath(piDir), "utf-8"));
    assert.equal(line.preview, "no cfg passed");
  });
});
