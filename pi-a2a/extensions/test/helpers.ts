import type { A2AConfig } from "../lib/config";
import { QUEUE_DEFAULTS } from "../lib/queue";

/** Fresh default config for tests (deep-ish copy — server is a nested object). */
export function DEFAULTS(): A2AConfig {
  return {
    peers: {},
    selfIdentity: "",
    server: {
      enabled: false,
      port: 9910,
      portFallback: 10,
      host: "127.0.0.1",
      workspace: "",
      maxConcurrent: 3,
      replyTimeoutSec: 300,
      asyncTimeoutSec: 86400,
      agentName: "",
      publicUrl: "",
      sharedToken: "",
      peerTokens: {},
      trustedPeers: [],
      allowAllUsers: false,
      maxPingpongTurns: 5,
      rateLimitPerMin: 60,
      childTranscripts: true,
      childTranscriptRetentionDays: 30,
      dedupeTtlSec: 300,
      skills: [],
    },
    timeouts: { send: 120000, async: 30000, stream: 120000 },
    retryAttempts: 2,
    queue: { ...QUEUE_DEFAULTS },
    verifySsl: true,
    discovery: {
      local: { enabled: true, heartbeatSec: 15, ttlSec: 60 },
      mdns: { enabled: false, serviceType: "a2a" },
      enrichCard: true,
    },
    ui: { transcript: true },
  };
}
