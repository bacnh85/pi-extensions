export type CommandRisk = "safe" | "confirm";

export interface RiskResult { risk: CommandRisk; reasons: string[]; }

const DESTRUCTIVE_COMMANDS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\b(?:remove-item|rm)\b(?=[^;&|\r\n]*\s(?:--?(?:recurse|recursive)|-\w*r\w*)\b)(?=[^;&|\r\n]*\s(?:--?force|-\w*f\w*)\b)/i, reason: "Recursive force delete" },
	{ pattern: /\b(?:rmdir|rd|del)\b(?=[^;&|]*\s\/s\b)(?=[^;&|]*\s\/q\b)/i, reason: "Recursive quiet delete" },
	{ pattern: /(?:^|[;&|\r\n]\s*)format\s+|\bcmd(?:\.exe)?\s+\/c\s+format\s+/i, reason: "Format disk" },
	{ pattern: /(?:^|[;&|\r\n]\s*)diskpart\b/i, reason: "Disk partition tool" },
	{ pattern: /reg\s+delete/i, reason: "Registry key delete" },
	{ pattern: /sc\s+delete/i, reason: "Service delete" },
	{ pattern: /netsh\s+advfirewall\s+reset/i, reason: "Firewall reset" },
	{ pattern: /git\s+clean\b(?=[^;&|\r\n]*\s(?:--force|-[a-z]*f[a-z]*)\b)(?=[^;&|\r\n]*\s(?:-d|-[a-z]*d[a-z]*)\b)(?=[^;&|\r\n]*\s(?:-x|-[a-z]*x[a-z]*)\b)/i, reason: "Force clean git ignored files" },
	{ pattern: /git\s+reset\s+--hard/i, reason: "Hard git reset" },
	{ pattern: /git\s+push\b(?=[^;&|]*\s(?:--force|-f)\b)/i, reason: "Force git push" },
	{ pattern: /(?:npm|pnpm|yarn)\s+publish/i, reason: "Package publish" },
	{ pattern: /stop-computer|restart-computer|(?:^|[;&|\r\n]\s*)shutdown\s+/i, reason: "Shutdown/restart computer" },
	{ pattern: /takeown\s+\/f/i, reason: "Take ownership of file" },
	{ pattern: /icacls\s+\/grant/i, reason: "Grant file permissions" },
	{ pattern: /wsl\s+--(?:unregister|terminate)/i, reason: "Destructive WSL operation" },
];

const SENSITIVE_FILE_PATTERNS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /(?:^|[\s\\/'"])\.env(?:\.[a-z0-9]+)*(?=$|[\s;|&><'"])/i, reason: "Environment file" },
	{ pattern: /\.pem(?=$|[\s;|&><'"])/i, reason: "Private key (PEM)" },
	{ pattern: /\.key(?=$|[\s;|&><'"])/i, reason: "Private key file" },
	{ pattern: /id_rsa(?=$|[\s;|&><'"])/i, reason: "SSH private key (RSA)" },
	{ pattern: /id_ed25519(?=$|[\s;|&><'"])/i, reason: "SSH private key (Ed25519)" },
	{ pattern: /[\\/]\.ssh[\\/]/i, reason: "SSH directory" },
	{ pattern: /[\\/]\.(?:aws|azure|kube|gcloud)[\\/]/i, reason: "Cloud credentials" },
	{ pattern: /(?:npmrc|\.pypirc)(?=$|[\s;|&><'"])/i, reason: "Package config (may contain tokens)" },
	{ pattern: /[\\/]AppData[\\/]Roaming[\\/]Microsoft[\\/]Credentials/i, reason: "Windows stored credentials" },
];

export function classifyCommand(command: string): RiskResult {
	const normalized = command.replace(/\.(?:exe|cmd|com)\b/gi, "");
	const reasons = [...DESTRUCTIVE_COMMANDS, ...SENSITIVE_FILE_PATTERNS].filter(rule => rule.pattern.test(normalized)).map(rule => rule.reason);
	return reasons.length ? { risk: "confirm", reasons } : { risk: "safe", reasons: [] };
}

export function isSensitivePath(path: string): boolean {
	return SENSITIVE_FILE_PATTERNS.some(rule => rule.pattern.test(path));
}
