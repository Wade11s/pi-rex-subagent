import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot } from "./usage.ts";
import { inboxIndexes, queueMessage, type Delivery } from "./inbox.ts";
import {
	readRecordFrom,
	readStatus as readStatusFile,
	runDirFor,
	writeStatus as writeStatusFile,
	type RunRecord,
	type RunStatus,
	type StatusWrite,
} from "./record.ts";
import { readUsageSnapshot, usageSnapshotPath } from "./usage.ts";

/**
 * The run directory: where one run's durable state lives — record, status,
 * inbox, usage snapshots, stop sentinel, child session log.
 *
 * This module owns the *layout*. The codecs stay where they are: the record,
 * status and usage codecs keep their rules and their atomic writers, and the
 * path helper that derives a directory from a handle remains the single source
 * of truth. Every method here delegates; none re-implements a codec. What
 * changes is that a caller no longer assembles the layout by hand.
 *
 * Not served here, on purpose: the launcher script (written once at spawn) and
 * the child's diagnostics log (a stream the child appends to). They live in the
 * directory but neither is a question a caller asks about a run.
 *
 * Two constructors, because the two real callers receive different things: the
 * parent has a handle and derives the directory, while the child is handed one.
 * Collapsing them would let a launch-time environment override move the
 * directory the child reads while its writes stayed put.
 *
 * Writes that already take a handle (the record, the ownership claim) stay with
 * their codecs: they derive the directory from the handle themselves, and
 * routing them through a value built from an explicit directory would let the
 * two disagree. This value answers questions about a directory, it does not
 * claim ownership of one.
 *
 * See GLOSSARY.md ("Run directory") and ADR-0011.
 */

export interface RunDirectory {
	/** The directory itself. Layout is this value's output, not its secret. */
	readonly dir: string;

	/**
	 * The durable statement of what was launched. An absent or malformed record
	 * reads as `undefined`.
	 */
	record(): RunRecord | undefined;
	/**
	 * What the child says about the current turn. An absent or malformed status
	 * reads as `undefined`.
	 */
	status(): RunStatus | undefined;
	/**
	 * Publish the turn status atomically; no exit code, ever. Throws on failure,
	 * as the codec does: whether a failed write may break the caller is the
	 * caller's decision.
	 */
	writeStatus(status: StatusWrite): void;

	/** Where the child publishes cumulative usage. */
	snapshotPath(): string;
	/**
	 * The child's last published snapshot. Unlike the two reads above, this one
	 * throws on a malformed file: a damaged snapshot must fail closed rather than
	 * look like "no snapshot yet", which accounting would charge as unknown
	 * history.
	 */
	snapshot(): UsageSnapshot | undefined;

	/** Queue one message for the child. */
	enqueue(message: string, delivery?: Delivery): Promise<number>;
	/** How many messages the reader would deliver. */
	pending(): number;

	/** Write the local stop sentinel. */
	requestStop(): void;
	/** Whether the sentinel is present. */
	stopRequested(): boolean;

	/** Where the child Pi keeps its session, which is the transcript of record. */
	sessionsDir(): string;
}

const STOP_FILE = "stop";

function build(dir: string): RunDirectory {
	return {
		dir,
		record: () => readRecordFrom(dir),
		status: () => readStatusFile(dir),
		writeStatus: (status) => writeStatusFile(dir, status),
		snapshotPath: () => usageSnapshotPath(dir),
		snapshot: () => readUsageSnapshot(dir),
		enqueue: (message, delivery) => queueMessage(dir, message, delivery),
		pending: () => inboxIndexes(dir).length,
		// No directory creation: a sentinel for a run that never launched would
		// leave a stray run directory whose stop is already requested.
		requestStop: () => writeFileSync(join(dir, STOP_FILE), ""),
		stopRequested: () => existsSync(join(dir, STOP_FILE)),
		sessionsDir: () => join(dir, "sessions"),
	};
}

/**
 * The run directory for a handle. The layout is derived from the handle and the
 * environment, exactly as the path helper always has.
 */
export function runDir(handle: string, env: NodeJS.ProcessEnv = process.env): RunDirectory {
	return build(runDirFor(handle, env));
}

/**
 * The already-known directory: for the child, which is handed one, and for a
 * test that builds a run without going through the handle rule.
 */
export function runDirFrom(dir: string): RunDirectory {
	return build(dir);
}
