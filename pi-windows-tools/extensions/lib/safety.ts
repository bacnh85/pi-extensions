export type CommandRisk = "safe" | "confirm";

export interface RiskResult {
	risk: CommandRisk;
	reasons: string[];
}

// ── Dangerous command patterns (case-insensitive prefix/path match) ──

const DESTRUCTIVE_COMMANDS: { pattern: RegExp; reason: string }[] = [
	// PowerShell destructive
	{ pattern: /remove-item\s+-recurse\s+-force/i, reason: "Recursive force delete" },
	{ pattern: /rm\s+-[rf]+\s+/i, reason: "Recursive force remove" },
	{ pattern: /rmdir\s+\/s\s+\/q/i, reason: "Recursive quiet directory remove" },
	{ pattern: /del\s+\/s\s+\/q/i, reason: "Recursive quiet file delete" },

	// Disk operations
	{ pattern: /^format\s+/i, reason: "Format disk" },
	{ pattern: /^diskpart\b/i, reason: "Disk partition tool" },

	// Registry
	{ pattern: /reg\s+delete/i, reason: "Registry key delete" },

	// Service management
	{ pattern: /sc\s+delete/i, reason: "Service delete" },

	// Network
	{ pattern: /netsh\s+advfirewall\s+reset/i, reason: "Firewall reset" },

	// Git destructive
	{ pattern: /git\s+clean\s+-fdx/i, reason: "Force clean git ignored files" },
	{ pattern: /git\s+reset\s+--hard/i, reason: "Hard git reset" },
	{ pattern: /git\s+push\s+--force/i, reason: "Force git push" },
	{ pattern: /git\s+push\s+--force-with-lease/i, reason: "Force git push" },

	// Package publish
	{ pattern: /npm\s+publish/i, reason: "npm package publish" },
	{ pattern: /pnpm\s+publish/i, reason: "pnpm package publish" },
	{ pattern: /yarn\s+publish/i, reason: "yarn package publish" },

	// System commands
	{ pattern: /stop-computer/i, reason: "Shutdown computer" },
	{ pattern: /restart-computer/i, reason: "Restart computer" },
	{ pattern: /^shutdown\s+/i, reason: "Shutdown/restart computer" },

	// Ownership/permissions (destructive)
	{ pattern: /takeown\s+\/f/i, reason: "Take ownership of file" },
	{ pattern: /icacls\s+\/grant/i, reason: "Grant file permissions" },

	// WSL destructive
	{ pattern: /wsl\s+--unregister/i, reason: "Unregister WSL distro" },
	{ pattern: /wsl\s+--terminate/i, reason: "Terminate WSL distro" },
];

// ── Sensitive file / path patterns (case-insensitive) ──

const SENSITIVE_FILE_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Environment / secrets
	{ pattern: /(?:^|[\s\\/])\.env(?:\.[a-z0-9]+)?$/i, reason: "Environment file" },
	{ pattern: /\.pem$/i, reason: "Private key (PEM)" },
	{ pattern: /\.key$/i, reason: "Private key file" },
	{ pattern: /id_rsa$/i, reason: "SSH private key (RSA)" },
	{ pattern: /id_ed25519$/i, reason: "SSH private key (Ed25519)" },
	{ pattern: /[\\/]\.ssh[\\/]/i, reason: "SSH directory" },
	{ pattern: /[\\/]\.aws[\\/]/i, reason: "AWS credentials" },
	{ pattern: /[\\/]\.azure[\\/]/i, reason: "Azure credentials" },
	{ pattern: /[\\/]\.kube[\\/]/i, reason: "Kubernetes config" },
	{ pattern: /[\\/]\.gcloud[\\/]/i, reason: "Google Cloud credentials" },
	{ pattern: /npmrc$/i, reason: "npm config (may contain tokens)" },
	{ pattern: /\.pypirc$/i, reason: "Python package config (may contain tokens)" },
	{ pattern: /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Credentials/i, reason: "Windows stored credentials" },
];

/**
 * Classify a command string for risk.
 * Returns the highest risk level found along with matched rules.
 */
export function classifyCommand(command: string): RiskResult {
	const reasons: string[] = [];

	// Check destructive patterns
	for (const rule of DESTRUCTIVE_COMMANDS) {
		if (rule.pattern.test(command)) {
			reasons.push(rule.reason);
		}
	}

	// Check sensitive file paths in the command
	for (const rule of SENSITIVE_FILE_PATTERNS) {
		if (rule.pattern.test(command)) {
			reasons.push(rule.reason);
		}
	}

	if (reasons.length > 0) {
		return { risk: "confirm", reasons };
	}

	return { risk: "safe", reasons: [] };
}

/**
 * Check if a path matches any sensitive file pattern.
 */
export function isSensitivePath(path: string): boolean {
	return SENSITIVE_FILE_PATTERNS.some(rule => rule.pattern.test(path));
}
