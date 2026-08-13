import type { A2AConfig } from "../lib/config";

/** Fresh default config for tests (deep-ish copy — server is a nested object). */
export function DEFAULTS(): A2AConfig {
  return {
    peers: {},
    server: {
      enabled: false,
      port: 9910,
      portFallback: 10,
      host: "127.0.0.1",
      workspace: "",
      maxConcurrent: 3,
      replyTimeoutSec: 300,
      agentName: "",
      publicUrl: "",
      sharedToken: "",
      peerTokens: {},
      trustedPeers: [],
      allowAllUsers: false,
      maxPingpongTurns: 5,
      rateLimitPerMin: 60,
      skills: [],
    },
    timeouts: { send: 120000, async: 30000, stream: 120000 },
    retryAttempts: 2,
    verifySsl: true,
  };
}
