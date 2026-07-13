/**
 * Thread Store for pi-subagent.
 *
 * In-memory registry tracking all subagent invocations during a pi session.
 * Enables the /agent command to list and switch between subagent threads.
 * Supports subscriptions so UIs can react to thread status changes.
 */

import type { SubAgentResult } from "./runner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadMode = "single" | "parallel-task" | "chain-step";
export type ThreadStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentThread {
	id: string;
	agentName: string;
	task: string;
	mode: ThreadMode;
	status: ThreadStatus;
	result?: SubAgentResult;
	toolCallId?: string;
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// Thread Store
// ---------------------------------------------------------------------------

export class ThreadStore {
	private threads = new Map<string, SubagentThread>();
	private order: string[] = [];
	private listeners = new Set<() => void>();

	/** Subscribe to thread store changes. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* best effort */ }
		}
	}

	createThread(params: {
		agentName: string;
		task: string;
		mode: ThreadMode;
		toolCallId?: string;
	}): SubagentThread {
		const id = cryptoGenId();
		const now = Date.now();
		const thread: SubagentThread = {
			id,
			agentName: params.agentName,
			task: params.task,
			mode: params.mode,
			status: "running",
			toolCallId: params.toolCallId,
			createdAt: now,
			updatedAt: now,
		};
		this.threads.set(id, thread);
		this.order.push(id);
		this.notify();
		return thread;
	}

	updateThread(id: string, updates: Partial<Pick<SubagentThread, "status" | "result">>): void {
		const thread = this.threads.get(id);
		if (!thread) return;
		if (updates.status) thread.status = updates.status;
		if (updates.result) thread.result = updates.result;
		thread.updatedAt = Date.now();
		this.notify();
	}

	getThread(id: string): SubagentThread | undefined {
		return this.threads.get(id);
	}

	getAllThreads(): SubagentThread[] {
		return this.order.map((id) => this.threads.get(id)!).filter(Boolean);
	}

	clear(): void {
		this.threads.clear();
		this.order = [];
		this.notify();
	}
}

/** Singleton instance. */
export const threadStore = new ThreadStore();

// ---------------------------------------------------------------------------
// ID generation (UUID v4 style, good enough for in-memory use)
// ---------------------------------------------------------------------------

const cryptoGenId = () => crypto.randomUUID();
