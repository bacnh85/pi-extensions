import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotenvValues } from "./lib/env";

export type SerenaWorkerResponse = {
  id: string | null;
  ok: boolean;
  result?: string;
  error?: string;
  [key: string]: unknown;
};

type Pending = {
  resolve: (value: SerenaWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type QueuedRequest = {
  payload: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: SerenaWorkerResponse) => void;
  reject: (error: Error) => void;
};

// JetBrains backend tool remapping tables — single source of truth, interpolated
// into the Python bridge via JSON and unit-tested here (see worker.test.ts).
// Serena's internal 'jetbrains' mode excludes the LSP-flavored tools and activates
// only jet_brains_* variants; the bridge maps pi-facing names + params accordingly.
export const JB_TOOL_MAP: Record<string, string> = {
  get_symbols_overview: "jet_brains_get_symbols_overview",
  find_symbol: "jet_brains_find_symbol",
  find_referencing_symbols: "jet_brains_find_referencing_symbols",
  find_declaration: "jet_brains_find_declaration",
  find_implementations: "jet_brains_find_implementations",
  rename_symbol: "jet_brains_rename",
  safe_delete_symbol: "jet_brains_safe_delete",
};

// LSP-only params the JetBrains variants do not accept (unknown kwargs raise TypeError).
export const JB_DROP_PARAMS: Record<string, string[]> = {
  jet_brains_find_symbol: ["include_kinds", "exclude_kinds", "substring_matching"],
  jet_brains_find_referencing_symbols: ["include_kinds", "exclude_kinds"],
};

// pi-facing param key -> JetBrains param key (safe_delete uses name_path, not name_path_pattern).
export const JB_PARAM_RENAMES: Record<string, Record<string, string>> = {
  jet_brains_safe_delete: { name_path_pattern: "name_path" },
};

const PYTHON_BRIDGE = String.raw`
from __future__ import annotations

import contextlib
import json
import os
import sys
import traceback
from typing import Any

os.environ.setdefault("SERENA_USAGE_REPORTING", "false")

try:
    from serena.agent import SerenaAgent
    from serena.config.context_mode import SerenaAgentContext
    from serena.config.serena_config import SerenaConfig, LanguageBackend
except Exception as exc:
    print(json.dumps({"id": None, "ok": False, "error": f"Failed to import Serena: {type(exc).__name__}: {exc}"}), flush=True)
    raise

try:
    from serena import serena_version
except Exception:
    serena_version = lambda: "unknown"  # type: ignore

# Guarded monkeypatch to enable textDocument/publishDiagnostics in solidlsp
try:
    from solidlsp.language_servers.typescript_language_server import TypeScriptLanguageServer
    _orig_get_initialize_params = TypeScriptLanguageServer._get_initialize_params
    def _patched_get_initialize_params(self, repository_absolute_path: str):
        params = _orig_get_initialize_params(self, repository_absolute_path)
        try:
            params.setdefault("capabilities", {}).setdefault("textDocument", {}).setdefault("publishDiagnostics", {"relatedInformation": True, "versionSupport": True})
        except Exception:
            pass
        return params
    TypeScriptLanguageServer._get_initialize_params = _patched_get_initialize_params
except Exception:
    pass

agents: dict[str, SerenaAgent] = {}
dashboard_opened: bool = False

def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_bridge_config() -> SerenaConfig:
    config = SerenaConfig.from_config_file()
    # Pi keeps one worker per process/session. Keep dashboard available by default,
    # but do not open browser tabs unless explicitly requested.
    config.web_dashboard = env_flag("SERENA_BRIDGE_WEB_DASHBOARD", True)
    config.web_dashboard_open_on_launch = env_flag("SERENA_BRIDGE_OPEN_DASHBOARD", False)
    # SERENA_LANGUAGE_BACKEND selects the code-intelligence backend at worker startup.
    # Unset = Serena's default (LSP). Invalid values raise LanguageBackend.from_str's
    # ValueError, surfaced on worker start rather than silently falling back.
    backend = os.environ.get("SERENA_LANGUAGE_BACKEND")
    if backend:
        config.language_backend = LanguageBackend.from_str(backend)
    return config


# --- JetBrains backend tool remapping -------------------------------------
# Serena's internal 'jetbrains' mode excludes the LSP-flavored tools
# (find_symbol, get_symbols_overview, find_referencing_symbols, rename_symbol,
# safe_delete_symbol, restart_language_server) and activates only jet_brains_*
# variants. pi-serena keeps a stable pi-facing tool contract (serena_* tools),
# so the bridge transparently maps LSP-flavored names + params to the active
# JetBrains variants when the backend is JetBrains.

JB_TOOL_MAP = ${JSON.stringify(JB_TOOL_MAP)}
JB_DROP_PARAMS = ${JSON.stringify(JB_DROP_PARAMS)}
JB_PARAM_RENAMES = ${JSON.stringify(JB_PARAM_RENAMES)}


def resolve_jb_tool_call(tool_name: str, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Map an LSP-flavored pi tool call to the active JetBrains variant."""
    jb_name = JB_TOOL_MAP.get(tool_name, tool_name)
    mapped = dict(params)
    for rename_from, rename_to in JB_PARAM_RENAMES.get(jb_name, {}).items():
        if rename_from in mapped:
            mapped[rename_to] = mapped.pop(rename_from)
    for drop in JB_DROP_PARAMS.get(jb_name, set()):
        mapped.pop(drop, None)
    return jb_name, mapped


def classify_error(message: str) -> str:
    if "Tool named" in message and "not found" in message:
        return "missing_tool"
    if "not active" in message:
        return "inactive_tool"
    if "No active project" in message or "Project" in message and "not found" in message:
        return "project_error"
    if "Cannot extract symbols" in message or "Active languages" in message or "language server" in message or "LSP" in message:
        return "language_server_error"
    return "serena_error"

def respond(payload: dict[str, Any]) -> None:
    # ensure_ascii=True keeps the stdout wire format pure ASCII regardless of the
    # host locale — Node reads stdout as UTF-8, and JSON.parse decodes \uXXXX
    # escapes back to the original characters. ensure_ascii=False wrote raw
    # non-ASCII bytes that sys.stdout encoded with the locale codec, garbling
    # tool output on non-UTF-8 locales.
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def agent_key(project: str, context: str) -> str:
    return f"{os.path.abspath(project)}\0{context}"


def get_agent(project: str, context: str) -> SerenaAgent:
    key = agent_key(project, context)
    agent = agents.get(key)
    if agent is None:
        with contextlib.redirect_stdout(sys.stderr):
            agent = SerenaAgent(project=project, context=SerenaAgentContext.load(context), serena_config=load_bridge_config())
        agents[key] = agent
    return agent


def close_agents() -> None:
    for key, agent in list(agents.items()):
        try:
            agent.on_shutdown()
        except Exception as exc:
            print(f"Error shutting down Serena agent {key}: {exc}", file=sys.stderr, flush=True)
    agents.clear()


def handle(req: dict[str, Any]) -> dict[str, Any]:
    req_id = req.get("id")
    action = req.get("action")

    if action == "shutdown":
        close_agents()
        return {"id": req_id, "ok": True, "shutdown": True}

    if action == "status":
        project = str(req.get("project") or os.getcwd())
        context = str(req.get("context") or "ide")
        data: dict[str, Any] = {
            "id": req_id,
            "ok": True,
            "version": serena_version(),
            "pid": os.getpid(),
            "cachedAgents": len(agents),
            "project": os.path.abspath(project),
            "context": context,
        }
        if req.get("includeAgent"):
            agent = get_agent(project, context)
            data["activeTools"] = agent.get_active_tool_names()
            active_project = agent.get_active_project()
            data["activeProject"] = str(active_project.project_root) if active_project else None
            data["languageBackend"] = agent.get_language_backend().value
            data["dashboardUrl"] = agent.get_dashboard_url()
        return data

    if action == "dashboard":
        project = str(req.get("project") or os.getcwd())
        context = str(req.get("context") or "ide")
        agent = get_agent(project, context)
        global dashboard_opened
        opened = False
        if req.get("open"):
            if not dashboard_opened:
                opened = agent.open_dashboard()
                dashboard_opened = opened
            else:
                opened = True
        return {"id": req_id, "ok": True, "opened": opened, "dashboardUrl": agent.get_dashboard_url()}

    if action == "config":
        project = str(req.get("project") or os.getcwd())
        context = str(req.get("context") or "ide")
        agent = get_agent(project, context)
        with contextlib.redirect_stdout(sys.stderr):
            result = agent.get_current_config_overview()
        return {"id": req_id, "ok": True, "tool": "get_current_config", "result": result}

    if action == "restart_language_server":
        project = str(req.get("project") or os.getcwd())
        context = str(req.get("context") or "ide")
        agent = get_agent(project, context)
        if agent.get_language_backend().is_jetbrains():
            # The JetBrains backend has no language server to restart.
            return {"id": req_id, "ok": True, "tool": "restart_language_server", "result": "Language server restart is not applicable with the JetBrains backend."}
        with contextlib.redirect_stdout(sys.stderr):
            agent.reset_language_server_manager()
        return {"id": req_id, "ok": True, "tool": "restart_language_server", "result": "OK"}

    if action == "call":
        project = str(req.get("project") or os.getcwd())
        context = str(req.get("context") or "ide")
        tool_name = req.get("tool")
        params = req.get("params") or {}
        if not isinstance(tool_name, str) or not tool_name:
            raise ValueError("call request requires non-empty string field 'tool'")
        if not isinstance(params, dict):
            raise ValueError("call request field 'params' must be an object")
        agent = get_agent(project, context)
        if agent.get_language_backend().is_jetbrains():
            tool_name, params = resolve_jb_tool_call(tool_name, params)
        with contextlib.redirect_stdout(sys.stderr):
            result = agent.get_tool_by_name(tool_name).apply_ex(**params)
        # Serena's apply_ex catches many tool failures and returns an "Error: ..." string.
        if isinstance(result, str) and result.startswith("Error"):
            return {"id": req_id, "ok": False, "tool": tool_name, "errorType": classify_error(result), "error": result, "result": result}
        return {"id": req_id, "ok": True, "tool": tool_name, "result": result}

    if action in ("find_declaration", "find_implementations"):
        return _handle_find_symbol_action(req_id, action, req)

    if action == "get_diagnostics_for_file":
        return _handle_diagnostics(req_id, req)

    raise ValueError(f"Unknown action: {action}")


def _get_symbol_retriever(agent: SerenaAgent):
    from serena.symbol import LanguageServerSymbolRetriever
    project = agent.get_active_project_or_raise()
    return project, LanguageServerSymbolRetriever(project)


def _jb_declaration_regexes(name_path: str) -> list[str]:
    """Candidate one-group regexes for jet_brains_find_declaration.

    The JetBrains variant locates the symbol via a regex with exactly one group
    and require_unique=True (the whole regex must match exactly once in the
    file). We try progressively looser declaration-context patterns so common
    names (methods like request) still resolve; each alternative has exactly
    one capturing group.
    """
    import re as _re
    last = _re.escape(name_path.split("/")[-1].split("[")[0])
    return [
        rf"\b(?:class|interface|type|function|const|let|var|def|struct|enum|trait|impl)\s+({last})\b",
        rf"(?<![.\w])({last})\s*\(",
        rf"\b({last})\b",
    ]


def _jb_pick_unique_symbol(symbols: list[dict], name_path: str) -> dict | None:
    """Return the single symbol whose name_path exactly matches, else None.

    find_symbol performs name-path *pattern* matching, so multiple symbols may
    match (overloads foo[0]/foo[1], same-named methods in different classes,
    a field and a method sharing a name). Picking an arbitrary match would
    return the wrong declaration. Only a single match, or exactly one exact
    name-path match, is accepted; otherwise the caller falls through to the
    regex stage (which enforces uniqueness). Mirrored in worker.test.ts.
    """
    if not symbols:
        return None
    if len(symbols) == 1:
        return symbols[0]
    suffix = "/" + name_path
    exact = [s for s in symbols if s.get("name_path") == name_path or (s.get("name_path") or "").endswith(suffix)]
    return exact[0] if len(exact) == 1 else None


def _jb_is_declaration_position_error(result: str) -> bool:
    """True when jet_brains_find_declaration reports the position IS the declaration.

    The JetBrains plugin resolves declarations from a *reference* position; when
    the regex lands on the declaration itself it reports something like "The
    cursor may not be on a resolvable reference". That error text is plugin-
    server-side (not in serena-agent), so match it tolerantly. Mirrored in
    worker.test.ts.
    """
    import re as _re
    return bool(_re.search(r"not.*resolvable|may not be on|is.*declaration|declaration.*itself", result, _re.IGNORECASE))


def _jb_find_declaration(agent: SerenaAgent, name_path: str, relative_path: str) -> str:
    """Route find_declaration through the JetBrains backend.

    Strategy (in order, first success wins):
    1. Resolve the symbol's exact location via the plugin client's find_symbol
       (include_location=True) — the declaration position, no regex ambiguity.
       This handles class fields/properties that the regex heuristics miss.
    2. Fall back to jet_brains_find_declaration with declaration-context regexes;
       when the regex lands on the declaration itself the JetBrains API reports
       "not on a resolvable reference", which means the position IS the declaration.
    Any unresolved case returns an "Error:"-prefixed string so the caller classifies
    it as a failure (never a bare "ValueError:" leaked as a success result).
    """
    import json as _json
    from serena.jetbrains.jetbrains_plugin_client import JetBrainsPluginClient

    project = agent.get_active_project_or_raise()
    # Stage 1: direct location lookup (robust to ambiguous names).
    try:
        with JetBrainsPluginClient.from_project(project) as client:
            response = client.find_symbol(
                name_path=name_path, relative_path=relative_path,
                depth=0, include_location=True,
            )
        symbols = response.get("symbols") or []
        sym = _jb_pick_unique_symbol(symbols, name_path)
        if sym is not None:
            text_range = sym.get("text_range") or {}
            start = text_range.get("start_pos") or {}
            if start.get("line") is not None and start.get("col") is not None:
                return _json.dumps({"symbols": [{"name_path": sym.get("name_path", name_path), "relative_path": sym.get("relative_path", relative_path), "type": sym.get("type", "unknown"), "text_range": {"start_pos": {"line": start["line"], "col": start["col"]}}}]}, indent=2)
    except Exception as exc:
        # Plugin/client error — log it, then fall through to the regex stage.
        print(f"[_jb_find_declaration] stage 1 find_symbol failed, falling back to regex: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)

    # Stage 2: regex fallback (handles symbols the plugin lookup misses).
    from serena.util.text_utils import find_text_coordinates
    tool = agent.get_tool_by_name("jet_brains_find_declaration")
    content = tool.create_code_editor().read_file(relative_path)
    last_error = None
    for regex in _jb_declaration_regexes(name_path):
        try:
            coords = find_text_coordinates(content, regex, require_unique=True)
        except ValueError as exc:
            last_error = f"Error: {type(exc).__name__}: {exc}"
            continue
        if coords is None:
            last_error = f"Error: no match for regex {regex}"
            continue
        with contextlib.redirect_stdout(sys.stderr):
            result = tool.apply_ex(relative_path=relative_path, regex=regex)
        if isinstance(result, str) and result.startswith("Error"):
            last_error = result
            if _jb_is_declaration_position_error(result):
                # The regex matched the declaration itself — that IS the declaration.
                return _json.dumps({"symbols": [{"name_path": name_path, "relative_path": relative_path, "type": "unknown", "text_range": {"start_pos": {"line": coords.line, "col": coords.col}}}]}, indent=2)
            continue
        return result
    return last_error or f"Error: could not resolve declaration for {name_path}"


def _find_symbol_or_raise(retriever, name_path: str, relative_path: str):
    return retriever.find_unique(
        name_path, substring_matching=False, within_relative_path=relative_path
    )


def _format_locations(locations) -> str:
    import json
    result = []
    for loc in locations:
        uri = loc.get("uri", "")
        range_data = loc.get("range", {})
        start = range_data.get("start", {})
        end = range_data.get("end", {})
        result.append({
            "uri": uri,
            "range": {
                "start": {"line": start.get("line"), "character": start.get("character")},
                "end": {"line": end.get("line"), "character": end.get("character")},
            },
        })
    return json.dumps(result, indent=2)


def _handle_find_symbol_action(req_id, action: str, req: dict[str, Any]) -> dict[str, Any]:
    project = str(req.get("project") or os.getcwd())
    context = str(req.get("context") or "ide")
    params = req.get("params") or {}
    name_path = params.get("name_path")
    relative_path = params.get("relative_path")
    if not isinstance(name_path, str) or not name_path:
        return {"id": req_id, "ok": False, "tool": action, "error": f"{action} requires string parameter 'name_path'"}
    if not isinstance(relative_path, str) or not relative_path:
        return {"id": req_id, "ok": False, "tool": action, "error": f"{action} requires string parameter 'relative_path'"}

    agent = get_agent(project, context)
    if agent.get_language_backend().is_jetbrains():
        # Route through the active JetBrains tools: find_declaration locates the
        # symbol via a one-group regex, find_implementations takes the name path.
        if action == "find_declaration":
            result = _jb_find_declaration(agent, name_path, relative_path)
        else:
            with contextlib.redirect_stdout(sys.stderr):
                result = agent.get_tool_by_name("jet_brains_find_implementations").apply_ex(relative_path=relative_path, name_path=name_path)
        if isinstance(result, str) and result.startswith("Error"):
            return {"id": req_id, "ok": False, "tool": action, "errorType": classify_error(result), "error": result, "result": result}
        return {"id": req_id, "ok": True, "tool": action, "result": result}

    project_obj, retriever = _get_symbol_retriever(agent)
    try:
        symbol = _find_symbol_or_raise(retriever, name_path, relative_path)
    except Exception as exc:
        return {"id": req_id, "ok": False, "tool": action, "error": f"Error finding symbol {name_path}: {type(exc).__name__}: {exc}"}

    if symbol is None:
        return {"id": req_id, "ok": False, "tool": action, "error": f"Symbol {name_path} not found in {relative_path}"}

    sym_rel_path = symbol.relative_path
    sym_line = symbol.line
    sym_col = symbol.column
    if sym_rel_path is None or sym_line is None or sym_col is None:
        return {"id": req_id, "ok": False, "tool": action, "error": f"Symbol {name_path} has no position info"}

    ls_manager = project_obj.get_language_server_manager_or_raise()
    lang_server = ls_manager.get_language_server(sym_rel_path)
    if lang_server is None:
        return {"id": req_id, "ok": False, "tool": action, "error": f"No language server available for {sym_rel_path}. The language server may not be active for this file type."}

    if action == "find_declaration":
        locations = lang_server.request_definition(sym_rel_path, sym_line, sym_col)
    else:
        locations = lang_server.request_implementation(sym_rel_path, sym_line, sym_col)

    if not locations:
        return {"id": req_id, "ok": True, "tool": action, "result": "No declarations found."}

    result = _format_locations(locations)
    return {"id": req_id, "ok": True, "tool": action, "result": result}


def _handle_diagnostics(req_id, req: dict[str, Any]) -> dict[str, Any]:
    project = str(req.get("project") or os.getcwd())
    context = str(req.get("context") or "ide")
    params = req.get("params") or {}
    relative_path = params.get("relative_path")
    if not isinstance(relative_path, str) or not relative_path:
        return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "error": "get_diagnostics_for_file requires string parameter 'relative_path'"}
    if os.path.isabs(relative_path):
        return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "error": "relative_path must be a relative path, not absolute"}

    agent = get_agent(project, context)
    if agent.get_language_backend().is_jetbrains():
        # serena-agent 1.2.0 has no JetBrains diagnostics counterpart.
        return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "errorType": "language_server_error", "error": "get_diagnostics_for_file requires the LSP backend; the JetBrains backend does not provide file diagnostics.", "result": json.dumps({"note": "Not applicable with the JetBrains backend."})}

    import json as _json
    import pathlib
    from pathlib import PurePath

    project_obj = agent.get_active_project_or_raise()
    ls_manager = agent.execute_task(project_obj.get_language_server_manager_or_raise, name="GetDiagnosticsLanguageServerManager")
    lang_server = ls_manager.get_language_server(relative_path)
    if lang_server is None:
        return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "error": f"No language server available for {relative_path}"}

    try:
        # Resolve full path and verify it does not escape the repository root
        repo_root = str(pathlib.Path(lang_server.repository_root_path).resolve())
        full_path = str(pathlib.Path(str(PurePath(lang_server.repository_root_path, relative_path))).resolve())
        if not str(pathlib.Path(repo_root) / '') == os.path.commonpath([repo_root, full_path]):
            return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "error": f"Path traversal detected: {relative_path} escapes the repository root"}
        uri = pathlib.Path(full_path).as_uri()

        import threading
        captured = None
        event = threading.Event()

        def on_publish(params: dict[str, Any]) -> None:
            nonlocal captured
            if prev_handler:
                try:
                    prev_handler(params)
                except Exception:
                    pass
            if params.get("uri") == uri:
                captured = params
                event.set()

        prev_handler = lang_server.server.on_notification_handlers.get("textDocument/publishDiagnostics")
        lang_server.server.on_notification("textDocument/publishDiagnostics", on_publish)

        try:
            with lang_server.open_file(relative_path):
                event.wait(timeout=3.0)
                if captured is not None:
                    res_val = _json.dumps(captured, indent=2, default=str)
                    return {"id": req_id, "ok": True, "tool": "get_diagnostics_for_file", "result": res_val}

            # Fallback to pull diagnostics
            result = lang_server.server.send.text_document_diagnostic({
                "textDocument": {"uri": uri},
            })
            return {"id": req_id, "ok": True, "tool": "get_diagnostics_for_file", "result": _json.dumps(result, indent=2, default=str)}
        finally:
            if prev_handler:
                lang_server.server.on_notification("textDocument/publishDiagnostics", prev_handler)
            else:
                lang_server.server.on_notification_handlers.pop("textDocument/publishDiagnostics", None)
    except Exception as exc:
        if isinstance(exc, AttributeError) or getattr(getattr(exc, "cause", None), "code", None) == -32601:
            return {"id": req_id, "ok": True, "tool": "get_diagnostics_for_file", "result": _json.dumps({"note": "Language server does not support pull diagnostics (textDocument/diagnostic) and did not push them within timeout"})}
        err_msg = f"Diagnostics error for {relative_path}: {exc}"
        return {"id": req_id, "ok": False, "tool": "get_diagnostics_for_file", "error": err_msg, "errorType": "language_server_error", "result": _json.dumps({"note": err_msg})}



def main() -> int:
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            req_id = None
            try:
                req = json.loads(line)
                if not isinstance(req, dict):
                    raise ValueError("request must be a JSON object")
                req_id = req.get("id")
                response = handle(req)
                respond(response)
                if req.get("action") == "shutdown":
                    return 0
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                print(traceback.format_exc(), file=sys.stderr, flush=True)
                respond({"id": req_id, "ok": False, "errorType": classify_error(message), "error": message})
    finally:
        close_agents()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;

function runSync(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) return String(result.stdout).trim().replace(/\u001b\[[0-9;]*m/g, "");
  } catch {
    // ignore discovery failures
  }
  return undefined;
}

function serenaPythonCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.SERENA_PYTHON;
  if (configured) candidates.push(configured);

  const addToolDirCandidates = (toolDir: string | undefined) => {
    if (!toolDir) return;
    candidates.push(
      path.join(toolDir, "serena-agent", "Scripts", "python.exe"),
      path.join(toolDir, "serena-agent", "bin", "python"),
    );
  };

  addToolDirCandidates(runSync("uv", ["tool", "dir"]));

  const uvFromBash = runSync("bash", ["-lc", "command -v uv"]);
  if (uvFromBash) addToolDirCandidates(runSync(uvFromBash, ["tool", "dir"]));

  addToolDirCandidates(path.join(os.homedir(), ".local", "share", "uv", "tools"));
  addToolDirCandidates(path.join(os.homedir(), "AppData", "Roaming", "uv", "tools"));

  return [...new Set(candidates)];
}

function findSerenaPython(): string | undefined {
  return serenaPythonCandidates().find((candidate) => fs.existsSync(candidate));
}

export class SerenaWorkerClient {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private queue: QueuedRequest[] = [];
  private processing = false;
  private stopping = false;
  private generation = 0;
  private spawning = false;

  constructor(private readonly onStatus?: (text: string | undefined) => void) {}

  async request(payload: Record<string, unknown>, timeoutMs = 120_000): Promise<SerenaWorkerResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, timeoutMs, resolve, reject });
      this.processQueue();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.rejectQueued(new Error("Serena worker stopped"));
    this.failAll(new Error("Serena worker stopped"));
    const proc = this.process;
    if (!proc) {
      this.stopping = false;
      return;
    }
    try {
      await new Promise<void>((resolve) => {
        const id = String(this.nextId++);
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve();
        }, 2000);
        this.pending.set(id, {
          resolve: () => { clearTimeout(timer); this.pending.delete(id); resolve(); },
          reject: () => { clearTimeout(timer); this.pending.delete(id); resolve(); },
          timer,
        });
        try {
          proc.stdin.write(`${JSON.stringify({ id, action: "shutdown" })}\n`);
        } catch {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve();
        }
      });
    } catch {
      // ignore
    } finally {
      proc.kill();
      if (this.process === proc) {
        this.process = undefined;
        this.processing = false;
        this.onStatus?.(undefined);
      }
      this.stopping = false;
    }
  }

  restart(): void {
    if (this.process) this.process.kill();
    this.rejectQueued(new Error("Serena worker restarted"));
    this.failAll(new Error("Serena worker restarted"));
    this.process = undefined;
    this.processing = false;
    this.ensureStarted();
  }

  private ensureStarted(): void {
    if (this.spawning) return;
    if (this.process && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null) return;
    this.spawning = true;
    try {
      const python = findSerenaPython();
      if (!python) {
        const checked = serenaPythonCandidates().map((candidate) => `- ${candidate}`).join("\n") || "- none";
        throw new Error(
          `Could not find Serena Python. Install with: uv tool install -p 3.13 serena-agent && serena init, or set SERENA_PYTHON to the serena-agent Python executable. Checked:\n${checked}`
        );
      }

      this.generation += 1;
      const proc = spawn(python, ["-u", "-c", PYTHON_BRIDGE], {
        // Merge dot-file values (cwd .env.local/.env, then Pi global config) into the
        // worker env so SERENA_* knobs work from project/global dot files, matching the
        // rest of the monorepo. process.env always wins; first dot file wins.
        // SERENA_USAGE_REPORTING defaults to "false" inside the Python bridge
        // (os.environ.setdefault), so dot-file opt-in works without a TS-side override.
        env: { ...process.env, ...loadDotenvValues(process.cwd()) },
        stdio: "pipe",
      });
      this.process = proc;
      this.buffer = "";
      this.onStatus?.(`Serena worker pid ${proc.pid} gen ${this.generation}`);
      this.spawning = false;

      proc.stdout.setEncoding('utf8');
      proc.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
      proc.stderr.on("data", (chunk) => process.stderr.write(`[serena-worker] ${String(chunk)}`));
      proc.stdin.on('error', () => {});
      proc.on('error', (err) => {
        if (this.process === proc) {
          this.process = undefined;
          this.onStatus?.(undefined);
          this.processing = false;
          this.failAll(new Error(`Serena worker process error: ${err.message}`));
        }
      });
      proc.on("exit", (code, signal) => {
        if (this.process === proc) {
          this.process = undefined;
          this.onStatus?.(undefined);
          this.processing = false;
          this.failAll(new Error(`Serena worker exited code=${code} signal=${signal}`));
        }
      });
    } catch (error) {
      this.spawning = false;
      throw error;
    }
  }

  private processQueue(): void {
    if (this.processing || this.stopping) return;
    const item = this.queue.shift();
    if (!item) return;
    this.processing = true;
    try {
      this.ensureStarted();
    } catch (error) {
      this.processing = false;
      item.reject(error instanceof Error ? error : new Error(String(error)));
      queueMicrotask(() => this.processQueue());
      return;
    }
    const id = String(this.nextId++);
    const request = { id, ...item.payload };
    const finish = () => {
      this.processing = false;
      queueMicrotask(() => this.processQueue());
    };
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.killAndReset(false);
      finish();
      item.reject(new Error(
        `Serena worker request timed out: ${item.payload.action ?? "unknown"}. ` +
        `Worker has been restarted; retry if needed.`
      ));
    }, item.timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        finish();
        item.resolve(value);
      },
      reject: (error) => {
        finish();
        item.reject(error);
      },
      timer,
    });
    try {
      this.process?.stdin.write(`${JSON.stringify(request)}\n`);
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(id);
      this.processing = false;
      item.reject(err instanceof Error ? err : new Error(String(err)));
      queueMicrotask(() => this.processQueue());
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let response: SerenaWorkerResponse;
      try {
        response = JSON.parse(line) as SerenaWorkerResponse;
      } catch {
        process.stderr.write(`[serena-worker] non-json stdout: ${line}\n`);
        continue;
      }
      const id = response.id;
      if (!id) {
        // Responses with null/undefined id are not tied to a pending request.
        // Surface errors (e.g. Python bridge import failures) so they aren't silently lost.
        if (response.ok === false && response.error) {
          process.stderr.write(`[serena-worker] error (no id): ${response.error}\n`);
        }
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private killAndReset(rejectPending = true): void {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
      this.onStatus?.(undefined);
    }
    if (rejectPending) {
      this.processing = false;
      this.failAll(new Error("Serena worker killed due to timeout, restarted"));
    }
    this.buffer = "";
  }

  private rejectQueued(error: Error): void {
    for (const item of this.queue.splice(0)) item.reject(error);
  }

  private failAll(error: Error): void {
    this.processing = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
