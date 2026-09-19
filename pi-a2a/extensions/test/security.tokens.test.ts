import { assert } from "chai";
import { redactConfiguredTokens, redactOutbound } from "../lib/security";

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
});
