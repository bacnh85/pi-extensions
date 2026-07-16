/**
 * Agent discovery and configuration for pi-subagent.
 *
 * Loads agent definitions from Markdown files with YAML frontmatter.
 * Discovers from user-level (~/.pi/agent/agents/), project-level
 * (.pi/agents/), and bundled skill agents. Results are cached and
 * invalidated on /reload.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type AgentColor = "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	models?: string[];
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sandbox?: "read-only" | "workspace-write";
	color?: AgentColor;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

export function getModelCandidates(agent: Pick<AgentConfig, "model" | "models">): string[] {
	return [...new Set([agent.model, ...(agent.models ?? [])].filter((model): model is string => Boolean(model)))];
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiscoveryDiagnostic[];
}

export interface AgentDiscoveryDiagnostic {
	filePath: string;
	issue: string;
	/** 'warn' for recoverable issues, 'error' for file-skip issues. */
	severity: "warn" | "error";
}

interface AgentCache {
	userDir: string;
	projectDir: string | null;
	bundledDir: string;
	scope: AgentScope;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiscoveryDiagnostic[];
	/** File-level signature per directory (name:mtime:size for each .md file) */
	dirSignatures: Map<string, string>;
}

let _cache: AgentCache | null = null;

/** Clear the agent cache (call on /reload). */
export function invalidateAgentCache(): void {
	_cache = null;
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "bundled",
	diagnostics: AgentDiscoveryDiagnostic[],
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		diagnostics.push({
			filePath: dir,
			issue: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
			severity: "warn",
		});
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) {
			diagnostics.push({
				filePath: path.join(dir, entry.name),
				issue: `Not a regular file or symlink, skipping.`,
				severity: "warn",
			});
			continue;
		}

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			diagnostics.push({
				filePath,
				issue: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
				severity: "error",
			});
			continue;
		}



		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch (err) {
			diagnostics.push({
				filePath,
				issue: `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
				severity: "error",
			});
			continue;
		}

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			if (typeof frontmatter.name !== "string" && typeof frontmatter.description !== "string") {
				diagnostics.push({
					filePath,
					issue: `Missing both "name" and "description" in frontmatter. Agent file skipped.`,
					severity: "error",
				});
			} else if (typeof frontmatter.name !== "string") {
				diagnostics.push({
					filePath,
					issue: `Missing "name" in frontmatter. Agent file skipped.`,
					severity: "error",
				});
			} else {
				diagnostics.push({
					filePath,
					issue: `Missing "description" in frontmatter. Agent file skipped.`,
					severity: "error",
				});
			}
			continue;
		}

		if (!frontmatter.name.trim()) {
			diagnostics.push({
				filePath,
				issue: `"name" in frontmatter is empty. Agent file skipped.`,
				severity: "error",
			});
			continue;
		}

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
				: Array.isArray(frontmatter.tools)
					? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string")
					: undefined;
		const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() || undefined : undefined;
		const models =
			typeof frontmatter.models === "string"
				? frontmatter.models.split(",").map((item) => item.trim()).filter(Boolean)
				: Array.isArray(frontmatter.models)
					? (frontmatter.models as unknown[]).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
					: undefined;

		if (frontmatter.models !== undefined && typeof frontmatter.models !== "string" && !Array.isArray(frontmatter.models)) {
			diagnostics.push({ filePath, issue: `"models" must be a YAML array or comma-separated string. Ignoring.`, severity: "warn" });
		}
		if (Array.isArray(frontmatter.models)) {
			for (const item of frontmatter.models) {
				if (typeof item === "string" && item.trim()) continue;
				diagnostics.push({ filePath, issue: `"models" entries must be non-empty strings. Ignoring invalid entry.`, severity: "warn" });
			}
		}
		for (const modelName of getModelCandidates({ model, models })) {
			if (modelName.includes("/")) continue;
			diagnostics.push({
				filePath,
				issue: `Model "${modelName}" does not include a provider prefix (e.g., "anthropic/claude-sonnet-4-20250514"). Resolution may fail.`,
				severity: "warn",
			});
		}

		if (typeof frontmatter.thinking === "string" && frontmatter.thinking) {
			const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (!validLevels.includes(frontmatter.thinking)) {
				diagnostics.push({
					filePath,
					issue: `Invalid thinking level "${frontmatter.thinking}". Valid values: ${validLevels.join(", ")}. Using default.`,
					severity: "warn",
				});
			}
		}

		if (typeof frontmatter.sandbox === "string" && frontmatter.sandbox) {
			const validSandboxes = ["read-only", "workspace-write"];
			if (!validSandboxes.includes(frontmatter.sandbox)) {
				diagnostics.push({
					filePath,
					issue: `Invalid sandbox mode "${frontmatter.sandbox}". Valid values: ${validSandboxes.join(", ")}. Ignoring.`,
					severity: "warn",
				});
			}
		}

		const VALID_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
		if (typeof frontmatter.color === "string" && frontmatter.color && !VALID_COLORS.includes(frontmatter.color as any)) {
			diagnostics.push({
				filePath,
				issue: `Invalid color "${frontmatter.color}". Valid values: ${VALID_COLORS.join(", ")}. Ignoring.`,
				severity: "warn",
			});
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model,
			models: models && models.length > 0 ? models : undefined,
			thinking: typeof frontmatter.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(frontmatter.thinking)
				? frontmatter.thinking as AgentConfig["thinking"]
				: undefined,
			sandbox: typeof frontmatter.sandbox === "string" && ["read-only", "workspace-write"].includes(frontmatter.sandbox)
				? frontmatter.sandbox as "read-only" | "workspace-write"
				: undefined,
			color: typeof frontmatter.color === "string" && VALID_COLORS.includes(frontmatter.color as any)
				? frontmatter.color as AgentColor
				: undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Build a stable signature for agent .md files in a directory.
 *  Returns "missing" if the directory doesn't exist, or a sorted
 *  list of `name:mtimeMs:size` entries that catches both content
 *  edits and add/remove/rename operations. */
function dirSignature(dir: string): string {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink()))
			.map((e) => {
				const file = path.join(dir, e.name);
				try {
					const st = fs.statSync(file);
					return `${e.name}:${st.mtimeMs}:${st.size}`;
				} catch {
					return `${e.name}:broken`;
				}
			})
			.sort();
		return `exists:${entries.join("|")}`;
	} catch {
		return "missing";
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agents from standard locations plus bundled skill agents.
 * @param cwd - Working directory for project-level discovery.
 * @param scope - Which agent directories to use.
 * @param bundledAgentsDir - Path to skill-bundled agents directory.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	bundledAgentsDir: string,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Check cache (with file-signature invalidation so editing agent .md files auto-detects changes)
	if (
		_cache &&
		_cache.userDir === userDir &&
		_cache.projectDir === projectAgentsDir &&
		_cache.bundledDir === bundledAgentsDir &&
		_cache.scope === scope
	) {
		let stale = false;
		for (const [dir, cachedSig] of _cache.dirSignatures) {
			if (dirSignature(dir) !== cachedSig) {
				stale = true;
				break;
			}
		}
		if (!stale) {
			return { agents: _cache.agents, projectAgentsDir: _cache.projectAgentsDir, diagnostics: _cache.diagnostics };
		}
		// Cache is stale — rebuild below
		_cache = null;
	}

	const diagnostics: AgentDiscoveryDiagnostic[] = [];

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", diagnostics);
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", diagnostics);
	const bundledAgents = loadAgentsFromDir(bundledAgentsDir, "bundled", diagnostics);

	const agentMap = new Map<string, AgentConfig>();

	// Priority: bundled < user < project (higher index = higher priority)
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	if (scope === "both" || scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope === "both" || scope === "project") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	const agents = Array.from(agentMap.values());

	const dirSignatures = new Map<string, string>();
	for (const dir of [userDir, projectAgentsDir, bundledAgentsDir]) {
		if (!dir) continue;
		dirSignatures.set(dir, dirSignature(dir));
	}

	_cache = {
		userDir,
		projectDir: projectAgentsDir,
		bundledDir: bundledAgentsDir,
		scope,
		agents,
		projectAgentsDir,
		diagnostics,
		dirSignatures,
	};

	return { agents, projectAgentsDir, diagnostics };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
