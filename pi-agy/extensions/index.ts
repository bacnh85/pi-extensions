import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { checkAgyHealth, checkAgyConnectivity, spawnAgy, buildAgyPrompt, detectVerifyCommand, parseJsonResponse } from "./lib/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piAgyExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agy_execute",
    label: "Antigravity CLI",
    description:
      "Run a task through the Antigravity CLI (agy) for bulk implementation, scaffolding, or test generation.",
    promptSnippet: "Run a task through the Antigravity CLI (agy)",
    promptGuidelines: [
      "Plan or research with one family only when needed; implement with flash-medium or sonnet according to which quota group should carry the work.",
      "Use flash-medium by default for bulk coding, exploration, tests, and repetitive work.",
      "Use flash-low for trivial few-step or high-volume work, and flash-high for difficult agentic work.",
      "Use pro-low or pro-high only when advanced reasoning needs escalation within the Gemini quota group.",
      "Use sonnet for normal coding or review in the Claude quota group; reserve opus for the hardest architecture, root-cause, or adversarial review.",
      "Use gpt-oss when an open-model alternative is specifically desired.",
      "For consequential work, use one family to produce and the opposite family to cross-review in mode=plan; do not spend both quota groups on trivial tasks.",
      "Batch related work, prefer digest output for non-write calls, and avoid parallel calls within one shared-quota group.",
      "Always review the git diff and run verification after agy runs with mode=accept-edits.",
      "Never use agy for irreversible production changes.",
      "Set an appropriate timeout_ms for large tasks (default 5m).",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task instruction for agy.",
        minLength: 1,
      }),
      model: Type.Optional(
        Type.Union(
          [
            Type.Literal("flash-low"),
            Type.Literal("flash-medium"),
            Type.Literal("flash-high"),
            Type.Literal("pro-low"),
            Type.Literal("pro-high"),
            Type.Literal("sonnet"),
            Type.Literal("opus"),
            Type.Literal("gpt-oss"),
          ],
          { description: "Model alias. Defaults to 'flash-medium'.", default: "flash-medium" },
        ),
      ),
      tier: Type.Optional(
        Type.Union(
          [Type.Literal("flash"), Type.Literal("flash-lo"), Type.Literal("pro")],
          { description: "Legacy Gemini tier. Ignored when model is set." },
        ),
      ),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("accept-edits"), Type.Literal("plan"), Type.Literal("sandbox")],
          { description: "'accept-edits' (default), 'plan', or 'sandbox'.", default: "accept-edits" },
        ),
      ),
      dir: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to current project root.",
        }),
      ),
      digest: Type.Optional(
        Type.Boolean({
          description: "Request compact digests instead of full output. Defaults on for plan/sandbox and off for accept-edits.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default 300000 = 5m, max 600000).",
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.dir ? path.resolve(ctx.cwd, params.dir) : ctx.cwd;
      const prompt = params.prompt;
      const abortSignal = signal ?? new AbortController().signal;
      const timeoutMs = Math.min(
        params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      try {
        if (!(await stat(cwd)).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);

        // Pre-flight checks (parallel)
        await Promise.all([
          checkAgyHealth(cwd, abortSignal),
          checkAgyConnectivity(cwd, abortSignal),
        ]);

        // Build the prompt — compact output is safe by default only in non-write modes
        const mode = params.mode ?? "accept-edits";
        const useDigest = params.digest ?? mode !== "accept-edits";
        // Tier 2.2: inject the project's verify command for accept-edits (Google Best Practices)
        const verifyCmd = mode === "accept-edits" ? await detectVerifyCommand(cwd) : null;
        const finalPrompt = buildAgyPrompt(prompt, mode, useDigest, verifyCmd);

        const output = await spawnAgy(
          {
            prompt: finalPrompt,
            model: params.model,
            tier: params.tier,
            mode,
            dir: cwd,
            timeout_ms: timeoutMs,
          },
          abortSignal,
        );

        // Tier 2.1: plan/sandbox return JSON — surface the .response field to Pi cleanly
        const text = mode === "accept-edits" ? output : parseJsonResponse(output);

        // Truncation guard for Pi's context window
        if (text.length > MAX_OUTPUT_CHARS) {
          return {
            content: [
              {
                type: "text" as const,
                text: text.slice(0, MAX_OUTPUT_CHARS) + "\n\n(Output truncated to 8000 chars)",
              },
            ],
            details: {},
          };
        }

        return {
          content: [{ type: "text" as const, text: text || "(empty response)" }],
          details: {},
        };
      } catch (err) {
        throw new Error(`agy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
