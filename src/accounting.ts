import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { readRecord, runDirFor, updateRecord, type RunRecord } from "./record.ts";
import { addUsage, parseUsage, readUsageSnapshot, zeroUsage, type UsageSnapshot } from "./usage.ts";

export const ACCOUNTING_DETAILS_VERSION = 1;

export type AccountingKind = "spawn" | "adoption" | "observation";

export interface RunCursor {
	handle: string;
	childSessionId: string | null;
	generation: string | null;
	sequence: number;
	cumulative: Usage;
	final: boolean;
}

export interface AccountingDetails {
	version: 1;
	kind: AccountingKind;
	parentSessionId: string;
	runs: RunCursor[];
}

export interface Observation {
	details: AccountingDetails;
	usage?: Usage;
}

export class AccountingError extends Error {}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseCursor(value: unknown, kind: AccountingKind): RunCursor {
	const raw = objectValue(value);
	if (!raw || typeof raw.handle !== "string" || raw.handle.length === 0 || typeof raw.final !== "boolean") {
		throw new AccountingError("invalid accounting cursor in parent tool result");
	}
	if (!Number.isInteger(raw.sequence) || (raw.sequence as number) < 0) throw new AccountingError("invalid accounting cursor sequence");
	const generation = raw.generation;
	if (generation !== null && (typeof generation !== "string" || generation.length === 0)) {
		throw new AccountingError("invalid accounting cursor generation");
	}
	const childSessionId = raw.childSessionId;
	if (childSessionId !== null && (typeof childSessionId !== "string" || childSessionId.length === 0)) {
		throw new AccountingError("invalid accounting cursor child session");
	}
	const cursor: RunCursor = {
		handle: raw.handle,
		childSessionId: childSessionId as string | null,
		generation: generation as string | null,
		sequence: raw.sequence as number,
		cumulative: parseUsage(raw.cumulative),
		final: raw.final,
	};
	if (kind === "spawn") {
		if (cursor.childSessionId !== null || cursor.generation !== null || cursor.sequence !== 0 || cursor.final || !isZeroUsage(cursor.cumulative)) {
			throw new AccountingError("invalid spawn baseline in parent tool result");
		}
	} else if (cursor.childSessionId === null || cursor.generation === null || cursor.sequence < 1) {
		throw new AccountingError("invalid non-spawn cursor in parent tool result");
	}
	return cursor;
}

function parseDetails(value: unknown, parentSessionId: string): AccountingDetails | undefined {
	const raw = objectValue(value);
	if (!raw || raw.parentSessionId !== parentSessionId) return undefined;
	if (raw.version !== ACCOUNTING_DETAILS_VERSION || !["spawn", "adoption", "observation"].includes(String(raw.kind)) || !Array.isArray(raw.runs)) {
		throw new AccountingError("invalid accounting details in parent tool result");
	}
	const kind = raw.kind as AccountingKind;
	const seen = new Set<string>();
	const runs = raw.runs.map((entry) => {
		const cursor = parseCursor(entry, kind);
		if (seen.has(cursor.handle)) throw new AccountingError("duplicate run cursor in parent tool result");
		seen.add(cursor.handle);
		return cursor;
	});
	return accountingDetails(kind, parentSessionId, runs);
}

export function accountingDetails(kind: AccountingKind, parentSessionId: string, runs: RunCursor[]): AccountingDetails {
	return { version: ACCOUNTING_DETAILS_VERSION, kind, parentSessionId, runs };
}

export function spawnCursor(handle: string): RunCursor {
	return { handle, childSessionId: null, generation: null, sequence: 0, cumulative: zeroUsage(), final: false };
}

function isZeroUsage(usage: Usage): boolean {
	return (
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0 &&
		(usage.cacheWrite1h ?? 0) === 0 &&
		(usage.reasoning ?? 0) === 0 &&
		usage.totalTokens === 0 &&
		usage.cost.input === 0 &&
		usage.cost.output === 0 &&
		usage.cost.cacheRead === 0 &&
		usage.cost.cacheWrite === 0 &&
		usage.cost.total === 0
	);
}

function usageEqual(first: Usage, second: Usage): boolean {
	return JSON.stringify(first) === JSON.stringify(second);
}

function subtractUsage(current: Usage, previous: Usage): Usage {
	if ((previous.cacheWrite1h !== undefined && current.cacheWrite1h === undefined) || (previous.reasoning !== undefined && current.reasoning === undefined)) {
		throw new AccountingError("cumulative Usage lost an optional numeric component");
	}
	const delta = (now: number, before: number, name: string): number => {
		const value = now - before;
		if (!Number.isFinite(value) || value < 0) throw new AccountingError(`negative or invalid Usage delta in ${name}`);
		return value;
	};
	return {
		input: delta(current.input, previous.input, "input"),
		output: delta(current.output, previous.output, "output"),
		cacheRead: delta(current.cacheRead, previous.cacheRead, "cacheRead"),
		cacheWrite: delta(current.cacheWrite, previous.cacheWrite, "cacheWrite"),
		...(current.cacheWrite1h !== undefined || previous.cacheWrite1h !== undefined
			? { cacheWrite1h: delta(current.cacheWrite1h ?? 0, previous.cacheWrite1h ?? 0, "cacheWrite1h") }
			: {}),
		...(current.reasoning !== undefined || previous.reasoning !== undefined
			? { reasoning: delta(current.reasoning ?? 0, previous.reasoning ?? 0, "reasoning") }
			: {}),
		totalTokens: delta(current.totalTokens, previous.totalTokens, "totalTokens"),
		cost: {
			input: delta(current.cost.input, previous.cost.input, "cost.input"),
			output: delta(current.cost.output, previous.cost.output, "cost.output"),
			cacheRead: delta(current.cost.cacheRead, previous.cost.cacheRead, "cost.cacheRead"),
			cacheWrite: delta(current.cost.cacheWrite, previous.cost.cacheWrite, "cost.cacheWrite"),
			total: delta(current.cost.total, previous.cost.total, "cost.total"),
			totalFromProvider: isZeroUsage(previous)
				? current.cost.totalFromProvider === true
				: previous.cost.totalFromProvider === true && current.cost.totalFromProvider === true,
		},
	};
}

function cursorFromSnapshot(snapshot: UsageSnapshot): RunCursor {
	return {
		handle: snapshot.runHandle,
		childSessionId: snapshot.childSessionId,
		generation: snapshot.childSessionGeneration,
		sequence: snapshot.sequence,
		cumulative: snapshot.usage,
		final: snapshot.final,
	};
}

function sameSnapshot(cursor: RunCursor, snapshot: UsageSnapshot): boolean {
	return (
		cursor.childSessionId === snapshot.childSessionId &&
		cursor.generation === snapshot.childSessionGeneration &&
		cursor.sequence === snapshot.sequence &&
		cursor.final === snapshot.final &&
		usageEqual(cursor.cumulative, snapshot.usage)
	);
}

function combineDeltas(deltas: Usage[]): Usage | undefined {
	let combined: Usage | undefined;
	for (const delta of deltas) {
		if (!isZeroUsage(delta)) combined = addUsage(combined, delta);
	}
	return combined;
}

export class UsageObserver {
	private readonly cursors = new Map<string, RunCursor>();
	private parentSessionId = "";
	private restoreError: string | undefined;
	private queue: Promise<void> = Promise.resolve();
	private readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
	}

	restore(ctx: ExtensionContext): void {
		this.parentSessionId = ctx.sessionManager.getSessionId();
		this.cursors.clear();
		this.restoreError = undefined;
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
				if (!["rex_spawn", "rex_adopt", "rex_observe", "rex_wait", "rex_stop"].includes(entry.message.toolName)) continue;
				const details = parseDetails(entry.message.details, this.parentSessionId);
				if (!details) continue;
				const expectedKind = entry.message.toolName === "rex_spawn" ? "spawn" : entry.message.toolName === "rex_adopt" ? "adoption" : "observation";
				if (details.kind !== expectedKind) throw new AccountingError("accounting tool name and result kind disagree");
				for (const cursor of details.runs) this.cursors.set(cursor.handle, cursor);
			}
		} catch (error) {
			this.cursors.clear();
			this.restoreError = error instanceof Error ? error.message : String(error);
		}
	}

	recordSpawn(parentSessionId: string, handle: string): Promise<AccountingDetails> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const cursor = spawnCursor(handle);
			this.cursors.set(handle, cursor);
			return accountingDetails("spawn", parentSessionId, [cursor]);
		});
	}

	adopt(parentSessionId: string, handle: string): Promise<AccountingDetails> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			if (this.cursors.has(handle)) throw new AccountingError(`run ${handle} already has a baseline on this parent branch`);
			const record = readRecord(handle, this.env);
			if (!record) throw new AccountingError(`no Rex subagent with handle ${handle}`);
			if (record.parentSessionId && record.parentSessionId !== parentSessionId) {
				throw new AccountingError(`run ${handle} belongs to a different parent session`);
			}
			const snapshot = readUsageSnapshot(runDirFor(handle, this.env));
			if (!snapshot) throw new AccountingError(`run ${handle} has no usage snapshot to adopt`);
			if (snapshot.runHandle !== handle || (snapshot.parentSessionId !== null && snapshot.parentSessionId !== parentSessionId)) {
				throw new AccountingError(`run ${handle} snapshot has the wrong identity or owner`);
			}
			if (!record.parentSessionId) {
				const claimed = updateRecord(handle, { parentSessionId }, this.env);
				if (!claimed) throw new AccountingError(`run ${handle} disappeared during adoption`);
			}
			const cursor = cursorFromSnapshot(snapshot);
			this.cursors.set(handle, cursor);
			return accountingDetails("adoption", parentSessionId, [cursor]);
		});
	}

	validate(parentSessionId: string, handles: string[]): Promise<void> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			for (const handle of new Set(handles)) {
				this.requireOwnedRun(parentSessionId, handle);
				if (!this.cursors.has(handle)) {
					throw new AccountingError(`run ${handle} has no spawn or adoption baseline on this parent branch`);
				}
			}
		});
	}

	observe(parentSessionId: string, handles: string[], options: { requireFinal?: boolean } = {}): Promise<Observation> {
		return this.transaction(() => {
			this.requireParent(parentSessionId);
			const unique = [...new Set(handles)];
			if (unique.length === 0) throw new AccountingError("at least one run handle is required");
			const next: RunCursor[] = [];
			const deltas: Usage[] = [];
			for (const handle of unique) {
				this.requireOwnedRun(parentSessionId, handle);
				const previous = this.cursors.get(handle);
				if (!previous) throw new AccountingError(`run ${handle} has no spawn or adoption baseline on this parent branch`);
				const snapshot = readUsageSnapshot(runDirFor(handle, this.env));
				if (!snapshot) throw new AccountingError(`run ${handle} has no usage snapshot`);
				if (snapshot.runHandle !== handle) throw new AccountingError(`run ${handle} snapshot has the wrong identity`);
				const unchangedAdoptedBaseline =
					snapshot.parentSessionId === null && previous.generation !== null && sameSnapshot(previous, snapshot);
				if (snapshot.parentSessionId !== parentSessionId && !unchangedAdoptedBaseline) {
					throw new AccountingError(`run ${handle} snapshot has the wrong owner`);
				}
				if (options.requireFinal && !snapshot.final) {
					throw new AccountingError(`run ${handle} has not published its final usage snapshot`);
				}
				if (previous.generation !== null && previous.generation !== snapshot.childSessionGeneration) {
					throw new AccountingError(`run ${handle} changed child-session generation`);
				}
				if (previous.final) {
					if (!sameSnapshot(previous, snapshot)) throw new AccountingError(`run ${handle} published usage after its final snapshot`);
					next.push(previous);
					deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
					continue;
				}
				if (snapshot.sequence < previous.sequence) throw new AccountingError(`run ${handle} snapshot sequence regressed`);
				if (snapshot.sequence === previous.sequence && previous.generation !== null) {
					if (!sameSnapshot(previous, snapshot)) throw new AccountingError(`run ${handle} snapshot conflicts with its cursor`);
					next.push(previous);
					deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
					continue;
				}
				deltas.push(subtractUsage(snapshot.usage, previous.cumulative));
				next.push(cursorFromSnapshot(snapshot));
			}
			for (const cursor of next) this.cursors.set(cursor.handle, cursor);
			const usage = combineDeltas(deltas);
			return { details: accountingDetails("observation", parentSessionId, next), ...(usage ? { usage } : {}) };
		});
	}

	private requireParent(parentSessionId: string): void {
		if (this.restoreError) throw new AccountingError(`cannot restore Rex accounting cursors: ${this.restoreError}`);
		if (!this.parentSessionId) throw new AccountingError("accounting observer has not been restored for this session");
		if (this.parentSessionId !== parentSessionId) throw new AccountingError("accounting observer belongs to a different parent session");
	}

	private requireOwnedRun(parentSessionId: string, handle: string): RunRecord {
		const record = readRecord(handle, this.env);
		if (!record) throw new AccountingError(`no Rex subagent with handle ${handle}`);
		if (record.parentSessionId !== parentSessionId) throw new AccountingError(`run ${handle} belongs to a different parent session`);
		return record;
	}

	private async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.queue;
		let release: () => void = () => undefined;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
