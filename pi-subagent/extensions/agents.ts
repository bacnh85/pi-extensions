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

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface AgentCache {
	userDir: string;
	projectDir: string | null;
	bundledDir: string;
	scope: AgentScope;
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** File-level signature per directory (name:mtime:size for each .md file) */
	dirSignatures: Map<string, string>;
}

let _cache: AgentCache | null = null;

/** Clear the agent cache (call on /reload). */
export function invalidateAgentCache(): void {
	_cache = null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "bundled"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
				: Array.isArray(frontmatter.tools)
					? (frontmatter.tools as unknown[]).filter((t): t is string => typeof t === "string")
					: undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(frontmatter.thinking)
				? frontmatter.thinking as AgentConfig["thinking"]
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
				const st = fs.statSync(file);
				return `${e.name}:${st.mtimeMs}:${st.size}`;
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
			return { agents: _cache.agents, projectAgentsDir: _cache.projectAgentsDir };
		}
		// Cache is stale — rebuild below
		_cache = null;
	}

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const bundledAgents = loadAgentsFromDir(bundledAgentsDir, "bundled");

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
		dirSignatures,
	};

	return { agents, projectAgentsDir };
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
