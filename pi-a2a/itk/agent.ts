// A2A ITK / ACTS agent: the pi-a2a server with a deterministic runner in place
// of a model session, so a2a-itk can test the protocol layer.
// Started by a2a-itk as `npm run itk-agent -- --httpPort N --grpcPort M`.
import { A2AServer, type SessionRunner } from "../extensions/lib/server.ts";
import { sendTask } from "../extensions/lib/client.ts";
import { loadConfig } from "../extensions/lib/config.ts";
import { decodeInstruction, type CallAgent, type Instruction } from "./instruction.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const httpPort = Number(arg("--httpPort") ?? 9910);

// The server frames inbound text ("[A2A inbound — …]\n\n<text>") and prefixes a
// continuation with the task's earlier turns; behaviours key on the first turn.
const firstTurn = (m: string) => m.slice(m.indexOf("]\n\n") + 3).replace(/^\[Peer\]\n/, "");
const lastTurn = (m: string) => m.split("[New message]\n").pop()!;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason ?? new Error("aborted"))), { once: true });
  });

// --- ITK traversal: execute the protobuf Instruction a2a-itk sends ---------

const PROTOBUF = "application/x-protobuf";
function instructionOf(parts: any[] | undefined): Instruction | undefined {
  const p = parts?.find((x) => x?.mediaType === PROTOBUF || x?.filename === "instruction.bin");
  return p?.raw ? decodeInstruction(Buffer.from(p.raw, "base64")) : undefined;
}

async function run(inst: Instruction): Promise<string[]> {
  if ("returnResponse" in inst) return [inst.returnResponse.response];
  if ("steps" in inst) {
    const out: string[] = [];
    for (const s of inst.steps) out.push(...(await run(s)));
    return out;
  }
  return [await callAgent(inst.callAgent)];
}

/** One hop, made with pi-a2a's own outbound client (sendTask). */
async function callAgent(c: CallAgent): Promise<string> {
  if (c.transport.toUpperCase() !== "JSONRPC") throw new Error(`pi-a2a speaks JSONRPC only, not ${c.transport}`);
  if (c.behavior !== "send_message") throw new Error(`behavior ${c.behavior} not supported`);
  const part = { raw: Buffer.from(c.instructionBytes!).toString("base64"), mediaType: PROTOBUF, filename: "instruction.bin" };
  const peer = { url: c.agentCardUri, auth: { type: "none" as const }, timeout: 60_000, capabilities: [] };
  const r = await sendTask({ cfg, piDir, peer, agentLabel: c.agentCardUri, message: "[itk instruction]", parts: [part] });
  if (r.state !== "TASK_STATE_COMPLETED") throw new Error(`hop to ${c.agentCardUri} ended ${r.state}: ${r.reply}`);
  return r.reply;
}

const runner: SessionRunner = async ({ message, parts, signal }) => {
  const inst = instructionOf(parts);
  if (inst) return { reply: (await run(inst)).join("\n"), inputRequired: false };
  const text = firstTurn(message);
  const prefix = /^tck-[a-z-]+/.exec(text)?.[0];
  switch (prefix) {
    case undefined:
      return { reply: text, inputRequired: false };
    case "tck-complete-task":
    case "tck-artifact-text":
    case "tck-stream-basic":
      return { reply: "streamed content", inputRequired: false };
    case "tck-long-running":
      await sleep(1000, signal);
      return { reply: "done", inputRequired: false };
    case "tck-cancel":
      await sleep(60_000, signal);
      return { reply: "not canceled", inputRequired: false };
    case "tck-input-required":
      return { reply: "need more input", inputRequired: true };
    case "tck-multi-turn":
      return /^done\b/.test(lastTurn(message).trim())
        ? { reply: "conversation complete", inputRequired: false }
        : { reply: "need more input", inputRequired: true };
    case "tck-task-failure":
      throw new Error("tck-task-failure: requested failure");
    default:
      throw new Error(`unsupported behavior ${prefix}`);
  }
};

const cfg = loadConfig({ cwd: process.cwd(), env: {} });
cfg.server = { ...cfg.server, port: httpPort, portFallback: 0, host: "127.0.0.1", agentName: "pi-a2a-itk",
  childTranscripts: false, rateLimitPerMin: 100_000, maxPingpongTurns: 20, maxConcurrent: 20 };
cfg.discovery = { ...cfg.discovery, local: { ...cfg.discovery.local, enabled: false }, enrichCard: false };
const piDir = mkdtempSync(join(tmpdir(), "pi-a2a-itk-"));
const info = await new A2AServer({ cfg, cwd: piDir, piDir, runner }).start();
console.log(`pi-a2a ITK agent on ${info.url}`);
