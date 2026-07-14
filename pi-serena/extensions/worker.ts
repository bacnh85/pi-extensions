import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    from serena.config.serena_config import SerenaConfig
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
    return config


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
    print(json.dumps(payload, ensure_ascii=False), flush=True)


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

    import json as _json
    import pathlib
    from pathlib import PurePath

    agent = get_agent(project, context)
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
				env: { ...process.env, SERENA_USAGE_REPORTING: process.env.SERENA_USAGE_REPORTING ?? "false" },
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
