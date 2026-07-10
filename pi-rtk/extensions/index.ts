import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasUnsupportedRtkFind } from "./findFallback.js";

const REWRITE_TIMEOUT_MS = 2_000;
const RTK_UNAVAILABLE_RETRY_MS = 30_000;
const MIN_SUPPORTED_RTK: [number, number, number] = [0, 23, 0];
const RTK_STATUS_KEY = "pi-rtk";
const RTK_SUBCOMMANDS = ["enable", "disable", "status"] as const;

let sessionEnabled = true;
let rtkUnavailableNotified = false;
let rtkAvailable: boolean | undefined;
let rtkLastCheckedAt = 0;

function piConfigDirs(): string[] {
	return process.env.PI_CODING_AGENT_DIR ? [process.env.PI_CODING_AGENT_DIR] : [path.join(os.homedir(), ".pi", "agent")];
}

function loadEnv(cwd = process.cwd()): void {
	for (const file of [path.resolve(cwd, ".env.local"), path.resolve(cwd, ".env"), ...piConfigDirs().flatMap((dir) => [path.join(dir, ".env.local"), path.join(dir, ".env")])]) {
		let text: string;
		try { text = fs.readFileSync(file, "utf8"); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (!match || process.env[match[1]] !== undefined) continue;
			process.env[match[1]] = match[2].trim().replace(/^[\'\"]|[\'\"]$/g, "");
		}
	}
}

function parseSemver(raw: string): [number, number, number] | null {
	const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function isAtLeastVersion(current: [number, number, number], minimum: [number, number, number]): boolean {
	for (let i = 0; i < minimum.length; i += 1) {
		if (current[i] > minimum[i]) return true;
		if (current[i] < minimum[i]) return false;
	}
	return true;
}

function rewritingEnabled(): boolean {
	return sessionEnabled && process.env.RTK_DISABLED !== "1";
}

function updateStatus(ctx: ExtensionContext): void {
	const envDisabled = process.env.RTK_DISABLED === "1";
	ctx.ui.setStatus(RTK_STATUS_KEY, sessionEnabled && !envDisabled ? "rtk ✓" : "rtk ✗");
}

function notifyRtkUnavailable(ctx: ExtensionContext, message: string): void {
	if (rtkUnavailableNotified) return;
	rtkUnavailableNotified = true;
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	else console.warn(message);
}

async function getRtkVersion(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS }).catch(() => undefined);
	if (!result || result.code !== 0) return null;
	return result.stdout.trim() || null;
}

async function checkRtkAvailable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const version = await getRtkVersion(pi);
	if (!version) {
		rtkAvailable = false;
		rtkLastCheckedAt = Date.now();
		notifyRtkUnavailable(ctx, "[pi-rtk] rtk binary not found in PATH; shell command rewrites will pass through unchanged");
		return false;
	}

	const parsedVersion = parseSemver(version.replace(/^rtk\s+/, ""));
	if (parsedVersion && !isAtLeastVersion(parsedVersion, MIN_SUPPORTED_RTK)) {
		rtkAvailable = false;
		rtkLastCheckedAt = Date.now();
		notifyRtkUnavailable(ctx, `[pi-rtk] ${version} is too old; need rtk >= 0.23.0 for \`rtk rewrite\`; shell command rewrites will pass through unchanged`);
		return false;
	}

	rtkAvailable = true;
	rtkLastCheckedAt = Date.now();
	rtkUnavailableNotified = false;
	return true;
}

async function ensureRtkAvailableForRewrite(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	if (rtkAvailable !== false) return true;
	if (Date.now() - rtkLastCheckedAt < RTK_UNAVAILABLE_RETRY_MS) return false;
	return checkRtkAvailable(pi, ctx);
}

async function rewriteCommand(pi: ExtensionAPI, command: string, signal?: AbortSignal, ctx: ExtensionContext): Promise<string | null> {
	if (!(await ensureRtkAvailableForRewrite(pi, ctx))) return null;

	const result = await pi.exec("rtk", ["rewrite", command], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	}).catch(() => undefined);

	if (!result) {
		rtkAvailable = false;
		rtkLastCheckedAt = Date.now();
		notifyRtkUnavailable(ctx, "[pi-rtk] rtk rewrite failed to start; shell command rewrites will pass through unchanged");
		return null;
	}

	rtkAvailable = true;
	rtkLastCheckedAt = Date.now();
	rtkUnavailableNotified = false;
	if (result.killed) return null;
	// rtk rewrite exit codes: 0 = no rewrite (empty stdout), 1 = error,
	// 3 = successful rewrite (rewritten command in stdout).
	// Accept both 0 and 3 as success; we read stdout regardless of exit code.
	if (result.code !== 0 && result.code !== 3) return null;

	const rewritten = result.stdout.trim();
	if (hasUnsupportedRtkFind(rewritten)) return null;
	return rewritten.length > 0 ? rewritten : null;
}


// ponytail: reject RTK rewrites that change the first word or add shell operators
function isSafeRewrite(original: string, rewritten: string): boolean {
	var o = original.trim().split(/\s+/)[0], n = rewritten.trim().split(/\s+/)[0];
	return o === n && (/[|><;&`]/.test(original) || !/[|><;&`]/.test(rewritten));
}

async function maybeRewriteCommand(pi: ExtensionAPI, command: string, signal?: AbortSignal, ctx: ExtensionContext): Promise<string | null> {
	if (!rewritingEnabled()) return null;
	if (typeof command !== "string" || command.trim() === "") return null;
	if (command.trimStart().startsWith("rtk ")) return null;
	var rewritten = await rewriteCommand(pi, command, signal, ctx);
	if (rewritten && rewritten !== command && !isSafeRewrite(command, rewritten)) return null;
	return rewritten;
}

async function showRtkStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const available = await checkRtkAvailable(pi, ctx);
	const version = available ? await getRtkVersion(pi) : null;
	const envDisabled = process.env.RTK_DISABLED === "1";
	const cacheState = rtkAvailable === false ? `unavailable (retry in ${Math.max(0, Math.ceil((RTK_UNAVAILABLE_RETRY_MS - (Date.now() - rtkLastCheckedAt)) / 1000))}s)` : "available";
	const lines = [
		`Session toggle: ${sessionEnabled ? "enabled" : "disabled"}`,
		`RTK_DISABLED: ${envDisabled ? "1 (rewrites bypassed)" : "not set"}`,
		`Runtime cache: ${cacheState}`,
		`Binary: ${version ?? "rtk not detected on PATH"}`,
		"Tip: use /rtk enable, /rtk disable, /rtk status; use RTK_DISABLED=1 for an environment-level bypass.",
	];
	ctx.ui.notify(lines.join("\n"), "info");
	updateStatus(ctx);
}

async function handleRtkCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const subcommand = args.trim();
	if (subcommand.length === 0) {
		await showRtkStatus(pi, ctx);
		return;
	}

	if (!(RTK_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		ctx.ui.notify("Unknown /rtk subcommand. Valid forms: /rtk enable, /rtk disable, /rtk status.", "error");
		return;
	}

	if (subcommand === "status") {
		await showRtkStatus(pi, ctx);
		return;
	}

	sessionEnabled = subcommand === "enable";
	updateStatus(ctx);
	ctx.ui.notify(`pi-rtk ${sessionEnabled ? "enabled" : "disabled"} for this session`, "info");
}

export default function piRtkExtension(pi: ExtensionAPI) {
	loadEnv();
	const localBashOperations = createLocalBashOperations();

	pi.registerCommand("rtk", {
		description: "Control pi-rtk shell command rewriting",
		handler: async (args, ctx) => {
			await handleRtkCommand(pi, args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Reset per-session toggle
		sessionEnabled = true;
		rtkUnavailableNotified = false;
		updateStatus(ctx);
		await checkRtkAvailable(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(RTK_STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event) => {
		if (!rewritingEnabled()) return;
		return {
			systemPrompt: event.systemPrompt +
				"\n\nYour bash commands are transparently rewritten through RTK for token savings. " +
				"Command output reflects the rewritten command; the original command text in your tool calls is replaced before execution.",
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isToolCallEventType("bash", event)) return;

			const originalCommand = event.input.command;
			const rewritten = await maybeRewriteCommand(pi, originalCommand, ctx.signal, ctx);
			if (rewritten && rewritten !== originalCommand) {
				event.input.command = rewritten;
			}
		} catch (error) {
			const msg = "[pi-rtk] unexpected rewrite error; passing bash command through unchanged";
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.warn(msg, error);
		}
	});

	pi.on("user_bash", async (event, ctx) => {
		try {
			updateStatus(ctx);
			if (event.excludeFromContext) return;

			const rewritten = await maybeRewriteCommand(pi, event.command, ctx.signal, ctx);
			if (!rewritten || rewritten === event.command) return;
			return {
				operations: {
					exec: (_command, cwd, options) => localBashOperations.exec(rewritten, cwd, options),
				},
			};
		} catch (error) {
			const msg = "[pi-rtk] unexpected user_bash rewrite error; passing command through unchanged";
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.warn(msg, error);
			return;
		}
	});
}
