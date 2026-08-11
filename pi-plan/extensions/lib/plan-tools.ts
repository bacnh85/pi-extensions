/**
 * Known read-only/research tools auto-allowed in plan mode.
 * Tools not in this set but in the active baseline require confirmation.
 */
// ponytail: keep in sync with pi-review/extensions/index.ts SAFE_REVIEW_TOOLS (additions there should be mirrored here)
export const READ_ONLY_TOOLS = new Set([
  // Built-in reads
  "read", "grep", "find", "ls",
  // FFF tools
  "ffgrep", "fffind", "resolve_file", "fff_multi_grep", "related_files",
  // Windows tools (read-only: detect, audit, path-convert, classify, doctor)
  "windows_shell_detect", "windows_audit_log",
  "windows_path_to_windows", "windows_path_to_wsl", "windows_path_to_gitbash", "windows_path_quote",
  "windows_safety_classify", "windows_doctor", "windows_tool_discover", "windows_wsl_list_distros",
  // Web tools
  "web_search", "web_extract", "web_map", "web_crawl", "web_screenshot", "web_pdf", "web_status",
  // Serena read-only
  "serena_status", "serena_list_tools", "serena_get_current_config",
  "serena_check_onboarding_performed", "serena_get_symbols_overview", "serena_find_symbol", "serena_find_declaration",
  "serena_find_implementations", "serena_find_referencing_symbols",
  "serena_search_for_pattern", "serena_get_diagnostics_for_file",
  // Munin read-only
  "munin_search", "munin_get", "munin_list", "munin_recent", "munin_capabilities",
  // pi-evolve read-only (reads the in-memory trajectory buffer; evolve_save is a mutation and stays out)
  "evolve_reflect",
  // Plan tools (path-constrained to .agents/plans/, safe in plan mode)
  "write_plan",
  // Advisor returns guidance only; it has no filesystem tools.
  "advisor",
]);

/**
 * Tools that are never available in plan mode — direct source/system mutators.
 */
export const BLOCKED_TOOLS = new Set([
  // File mutation
  "edit", "write",
  // Serena file mutation
  "serena_replace_symbol_body", "serena_insert_before_symbol",
  "serena_insert_after_symbol", "serena_rename_symbol",
  "serena_safe_delete_symbol", "serena_replace_content",
  // Munin mutation
  "munin_store", "munin_delete", "munin_share",
  "munin_capture", "munin_batch_store", "munin_rollback",
  "munin_acknowledge_setup", "munin_encrypt", "munin_decrypt", "munin_export",
  // pi-evolve mutation (stores learnings to Munin/JSONL — blocked like munin_store)
  "evolve_save",
]);

