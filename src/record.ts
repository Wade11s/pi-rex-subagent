import { randomBytes } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// The inbox lives in its own module, shared with the child process. These
// re-exports keep the existing record-module callers working unchanged; they
// are retired once every caller names the inbox module directly.
export {
	consumeInboxMessage,
	inboxDir,
	inboxIndexes,
	inboxMessageNames,
	inboxPath,
	InboxLockStolen,
	parseInboxPayload,
	quarantineInboxMessage,
	queueMessage,
	readInboxMessage,
	readQueuedMessage,
	withInboxLock,
} from "./inbox.ts";
export type { Delivery, InboxPayload } from "./inbox.ts";

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function runsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "rex-subagents");
}

export function newHandle(): string {
	return randomBytes(3).toString("hex");
}

export interface RexResources {
	endpoint: string;
	hostId: string;
	sessionId: string;
	windowId: string;
	blockId: string;
}

/** Where the spawning Pi ran, so a child can offer `/back`. */
export interface ParentRexLocation {
	sessionId: string;
	windowId?: string;
	blockId?: string;
}

export type RecordState = "starting" | "running" | "exited" | "stopped" | "failed";

export interface RunRecord {
	version: 1;
	handle: string;
	name: string;
	title?: string;
	group: string;
	cwd: string;
	prompt: string;
	provider?: string;
	model?: string;
	thinking?: string;
	launchArgs: string[];
	parentSessionId?: string;
	parentRex?: ParentRexLocation;
	rex: RexResources;
	state: RecordState;
	error?: string;
	/** Set when a stop attempt could not be confirmed; cleared once it succeeds. */
	stopError?: string;
	/** A live accounting-aware stop must collect a final snapshot before removal. */
	usageFinalizationRequired?: boolean;
	/** A launched child whose spawn baseline failed must not be adopted as unknown history. */
	usageBaselineError?: string;
	createdAt: string;
	updatedAt: string;
}

/** What the child extension reports about the agent's current turn. */
export type SupervisorState = "starting" | "busy" | "idle" | "stopped";

export interface RunStatus {
	state: SupervisorState;
	turn: number;
	/**
	 * Deprecated: the child used to write a hard-coded 0 here, which said
	 * nothing about the OS process. Real exit codes come from the Rex probe
	 * (`RunObservation.processExitCode`). Still parsed for old status files.
	 */
	lastExit?: number | null;
	updatedAt: string;
	transport?: string;
}

/** What the OS-level process behind the Rex window is doing. */
export type ProcessState = "starting" | "running" | "exited" | "gone" | "unknown";

export type DisplayState =
	| "starting"
	| "busy"
	| "idle"
	| "stopping"
	| "exited"
	| "gone"
	| "stopped"
	| "failed"
	| "unknown";

export function isTerminalDisplayState(state: DisplayState): boolean {
	return state === "failed" || state === "stopped" || state === "gone" || state === "exited";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseParentRex(value: unknown): ParentRexLocation | undefined {
	const raw = asRecord(value);
	const sessionId = text(raw?.sessionId);
	if (!sessionId) return undefined;
	const parsed: ParentRexLocation = { sessionId };
	const windowId = text(raw?.windowId);
	const blockId = text(raw?.blockId);
	if (windowId) parsed.windowId = windowId;
	if (blockId) parsed.blockId = blockId;
	return parsed;
}

export function parseRecord(value: unknown): RunRecord | undefined {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return undefined;
	const rex = asRecord(raw.rex);
	const handle = text(raw.handle);
	const name = text(raw.name);
	const cwd = text(raw.cwd);
	const state = text(raw.state);
	const createdAt = text(raw.createdAt);
	const updatedAt = text(raw.updatedAt);
	if (!handle || !name || !cwd || !state || !createdAt || !updatedAt) return undefined;
	if (!["starting", "running", "exited", "stopped", "failed"].includes(state)) return undefined;
	if (!rex) return undefined;
	const endpoint = text(rex.endpoint);
	const hostId = text(rex.hostId);
	const sessionId = typeof rex.sessionId === "string" ? rex.sessionId : undefined;
	const windowId = typeof rex.windowId === "string" ? rex.windowId : undefined;
	const blockId = typeof rex.blockId === "string" ? rex.blockId : undefined;
	if (!endpoint || !hostId || sessionId === undefined || windowId === undefined || blockId === undefined) return undefined;
	if (raw.usageFinalizationRequired !== undefined && typeof raw.usageFinalizationRequired !== "boolean") return undefined;
	if (raw.usageBaselineError !== undefined && typeof raw.usageBaselineError !== "string") return undefined;
	// A staged or failed record may not have Rex resources yet; a live one must.
	if (state !== "starting" && state !== "failed" && !(sessionId && windowId && blockId)) return undefined;
	const launchArgs = Array.isArray(raw.launchArgs)
		? raw.launchArgs.filter((entry): entry is string => typeof entry === "string")
		: [];
	return {
		version: 1,
		handle,
		name,
		title: text(raw.title),
		group: text(raw.group) ?? "rex-subagent",
		cwd,
		prompt: text(raw.prompt) ?? "",
		provider: text(raw.provider),
		model: text(raw.model),
		thinking: text(raw.thinking),
		launchArgs,
		parentSessionId: text(raw.parentSessionId),
		parentRex: parseParentRex(raw.parentRex),
		rex: { endpoint, hostId, sessionId, windowId, blockId },
		state: state as RecordState,
		error: text(raw.error),
		stopError: text(raw.stopError),
		...(raw.usageFinalizationRequired === undefined
			? {}
			: { usageFinalizationRequired: raw.usageFinalizationRequired }),
		usageBaselineError: text(raw.usageBaselineError),
		createdAt,
		updatedAt,
	};
}

export function parseStatus(value: unknown): RunStatus | undefined {
	const raw = asRecord(value);
	if (!raw) return undefined;
	const state = text(raw.state);
	if (!state || !["starting", "busy", "idle", "stopped"].includes(state)) return undefined;
	const turn = raw.turn;
	const lastExit = raw.lastExit;
	if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return undefined;
	if (lastExit !== undefined && lastExit !== null && (typeof lastExit !== "number" || !Number.isInteger(lastExit))) return undefined;
	const transport = text(raw.transport);
	const parsed: RunStatus = { state: state as SupervisorState, turn, updatedAt: text(raw.updatedAt) ?? "" };
	if (lastExit !== undefined) parsed.lastExit = lastExit;
	if (transport) parsed.transport = transport;
	return parsed;
}

export function runDirFor(handle: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runsRoot(env), handle);
}

const ACCOUNTING_OWNER_FILE = ".accounting-owner.json";

export function accountingOwnerPath(handle: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runDirFor(handle, env), ACCOUNTING_OWNER_FILE);
}

function readClaimedOwner(dir: string): string | undefined {
	const path = join(dir, ACCOUNTING_OWNER_FILE);
	if (!existsSync(path)) return undefined;
	const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
	if (raw?.version !== 1) throw new Error("invalid accounting owner claim");
	const owner = text(raw.parentSessionId);
	if (!owner) throw new Error("invalid accounting owner claim");
	return owner;
}

/** Atomically claim an unowned run. Existing claims are never overwritten. */
export function claimRecordOwner(handle: string, parentSessionId: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const path = accountingOwnerPath(handle, env);
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		// Publish only complete content. link(2) provides atomic no-overwrite
		// creation, while EEXIST leaves the existing durable owner untouched.
		writeFileSync(temporary, `${JSON.stringify({ version: 1, parentSessionId })}\n`, { encoding: "utf8", flag: "wx" });
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		return true;
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export function ensureRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
	const root = runsRoot(env);
	mkdirSync(root, { recursive: true });
	return root;
}

export function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

/** The run-directory file names this module reads and writes. */
export const RECORD_FILE = "metadata.json";
export const STATUS_FILE = "status.json";

/**
 * The record read. The run-directory value delegates to this, and it is what
 * `readRecord` is built from, so it stays here beside the parser rather than
 * moving into the value.
 */
export function readRecordFrom(dir: string): RunRecord | undefined {
	const path = join(dir, "metadata.json");
	if (!existsSync(path)) return undefined;
	try {
		const record = parseRecord(JSON.parse(readFileSync(path, "utf8")));
		if (!record) return undefined;
		const claimedOwner = readClaimedOwner(dir);
		if (claimedOwner !== undefined) {
			// Conflicting durable identities are corruption, not permission to
			// choose one. A matching claim overlays older metadata for compatibility.
			if (record.parentSessionId && record.parentSessionId !== claimedOwner) return undefined;
			record.parentSessionId = claimedOwner;
		}
		return record;
	} catch {
		return undefined;
	}
}

export function readRecord(handle: string, env: NodeJS.ProcessEnv = process.env): RunRecord | undefined {
	return readRecordFrom(runDirFor(handle, env));
}

export function writeRecord(record: RunRecord, env: NodeJS.ProcessEnv = process.env): RunRecord {
	const dir = runDirFor(record.handle, env);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "metadata.json"), record);
	return record;
}

export function updateRecord(
	handle: string,
	patch: Partial<RunRecord>,
	env: NodeJS.ProcessEnv = process.env,
): RunRecord | undefined {
	const current = readRecord(handle, env);
	if (!current) return undefined;
	const next: RunRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
	writeRecord(next, env);
	return next;
}

export interface RecordEntry {
	record: RunRecord;
	dir: string;
}

export function listRecords(env: NodeJS.ProcessEnv = process.env): RecordEntry[] {
	const root = runsRoot(env);
	if (!existsSync(root)) return [];
	const entries: RecordEntry[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const record = readRecordFrom(dir);
		if (record) entries.push({ record, dir });
	}
	return entries.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
}

export function removeRun(handle: string, env: NodeJS.ProcessEnv = process.env): void {
	rmSync(runDirFor(handle, env), { recursive: true, force: true });
}

/** What the child reports about its current turn, as it writes it. */
export interface StatusWrite {
	state: SupervisorState;
	turn: number;
}

/**
 * Publish the turn status atomically. There is no exit code here: a settled turn
 * says nothing about the OS process, and the real code comes only from the Rex
 * probe.
 *
 * Throws on failure. The child wraps this because a status write must never
 * break its TUI; a caller that cannot tolerate a throw has to decide that for
 * itself rather than inherit it from the codec.
 */
export function writeStatus(dir: string, status: StatusWrite): void {
	const payload = {
		state: status.state,
		turn: status.turn,
		updatedAt: new Date().toISOString(),
		transport: "tui",
	};
	const path = join(dir, STATUS_FILE);
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`);
	renameSync(temporary, path);
}

/** The part of a Rex probe that the state machine needs. */
export interface RunProbe {
	state: "running" | "exited" | "missing" | "unknown";
	exitCode?: number;
}

/** Agent-turn state and OS-process state, merged for display. */
export interface RunObservation {
	state: DisplayState;
	processState: ProcessState;
	processExitCode: number | null;
}

function agentTurnDisplay(record: RunRecord, status: RunStatus | undefined): DisplayState {
	if (status?.state === "busy") return "busy";
	if (status?.state === "idle") return "idle";
	// The child saw the stop sentinel and aborted its turn — that alone is not
	// a confirmed stop: while the process lives the run is merely "stopping".
	if (status?.state === "stopped") return "stopping";
	// No status file yet: the child has not booted far enough to write one.
	return "starting";
}

/**
 * Merge durable metadata, the child's turn status and the Rex process probe.
 *
 * Precedence (first match wins) — see ARCHITECTURE.md:
 *  1. record failed  → the launch never produced a manageable process.
 *  2. record stopped → stop was confirmed; closed resources are expected.
 *  3. probe missing  → the Rex resources are gone.
 *  4. probe exited   → the OS process ended; terminal, with its real exit code,
 *                      even when a stale status.json still claims busy/idle.
 *                      If the child had acknowledged a stop, this counts as a
 *                      completed stop instead of an incidental exit.
 *  5. probe unknown  → Rex is unreachable; report the last busy signal, or
 *      "starting" while the record is still starting without any status.
 *  6. otherwise the agent-turn state from status.json decides; a child that
 *      acknowledged the stop sentinel while the process lives is "stopping",
 *      not stopped — the stop is not confirmed until the process ends or Rex
 *      confirms the close.
 */
export function observeRun(record: RunRecord, status: RunStatus | undefined, probe: RunProbe | undefined): RunObservation {
	if (record.state === "failed") return { state: "failed", processState: "gone", processExitCode: null };
	if (record.state === "stopped") return { state: "stopped", processState: "gone", processExitCode: null };
	if (!probe) {
		if (record.state === "exited") return { state: "exited", processState: "exited", processExitCode: null };
		return { state: agentTurnDisplay(record, status), processState: "unknown", processExitCode: null };
	}
	if (probe.state === "missing") return { state: "gone", processState: "gone", processExitCode: null };
	if (probe.state === "exited") {
		// The child acknowledged a stop and then the process ended: that is a
		// completed stop (with the real exit code), not an incidental crash.
		if (status?.state === "stopped") {
			return { state: "stopped", processState: "exited", processExitCode: probe.exitCode ?? null };
		}
		return { state: "exited", processState: "exited", processExitCode: probe.exitCode ?? null };
	}
	if (probe.state === "unknown") {
		if (record.state === "starting" && !status) return { state: "starting", processState: "unknown", processExitCode: null };
		// The child acknowledged the stop even though Rex cannot be probed:
		// it is shutting down and will not drain anything — keep refusing sends.
		if (status?.state === "stopped") return { state: "stopping", processState: "unknown", processExitCode: null };
		return { state: status?.state === "busy" ? "busy" : "unknown", processState: "unknown", processExitCode: null };
	}
	return { state: agentTurnDisplay(record, status), processState: "running", processExitCode: null };
}
