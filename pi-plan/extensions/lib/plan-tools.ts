export const SERENA_PLAN_TOOLS = [
	"serena_status",
	"serena_list_tools",
	"serena_get_current_config",
	"serena_get_symbols_overview",
	"serena_find_symbol",
	"serena_find_declaration",
	"serena_find_implementations",
	"serena_find_referencing_symbols",
	"serena_search_for_pattern",
	"serena_get_diagnostics_for_file",
];

export const WEB_PLAN_TOOLS = [
	"web_search",
	"web_extract",
	"web_map",
	"web_crawl",
	"web_screenshot",
	"web_pdf",
	"web_status",
];

export const MUNIN_PLAN_TOOLS = [
	"munin_search",
	"munin_get",
	"munin_list",
	"munin_recent",
	"munin_capabilities",
];

export const DEFAULT_PLAN_TOOLS = [
	"read", "bash", "grep", "find", "ls",
	...WEB_PLAN_TOOLS,
	...MUNIN_PLAN_TOOLS,
	...SERENA_PLAN_TOOLS,
];

export const PLAN_ALLOWED_TOOLS = new Set(DEFAULT_PLAN_TOOLS);
