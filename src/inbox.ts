import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The inbox: one JSON file per message, `<run>/inbox/NNNN.json`.
 *
 * Both sides of the process boundary go through this module. The parent
 * enqueues under a lock; the child reads in delivery order, unlinks what it
 * handed to Pi, and parks anything unreadable. Keeping readers and writers
 * together is the point: the naming, ordering and payload rules are one
 * contract, and splitting them is how the two sides drifted apart before.
 *
 * See ARCHITECTURE.md ("Message delivery semantics") and ADR-0009.
 */

export type Delivery = "auto" | "steer" | "followUp";

export interface InboxPayload {
	message: string;
	delivery: Delivery;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function inboxDir(dir: string): string {
	return join(dir, "inbox");
}

export function inboxPath(dir: string, index: number): string {
	return join(inboxDir(dir), `${String(index).padStart(4, "0")}.json`);
}

/**
 * Whether a directory entry is a message. Deliberately looser than the index
 * rule below while the two sides are being unified: the reader still accepts
 * any `.json`, which is what the child has always done.
 */
function isMessageName(name: string): boolean {
	return name.endsWith(".json");
}

/** Message file names in delivery order. */
export function inboxMessageNames(dir: string): string[] {
	try {
		return readdirSync(inboxDir(dir)).filter(isMessageName).sort();
	} catch {
		return [];
	}
}

/** Queue positions the parent counts as pending. */
export function inboxIndexes(dir: string): number[] {
	const path = inboxDir(dir);
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.map((name) => (/^(\d{4})\.json$/.exec(name)?.[1] ?? ""))
		.filter((value) => value.length > 0)
		.map((value) => Number(value))
		.sort((a, b) => a - b);
}

export function parseInboxPayload(value: unknown): InboxPayload | undefined {
	const raw = asRecord(value);
	const message = text(raw?.message);
	if (!message) return undefined;
	const delivery = text(raw?.delivery);
	return {
		message,
		delivery: delivery === "steer" || delivery === "followUp" ? delivery : "auto",
	};
}

export function readInboxMessage(dir: string, index: number): InboxPayload | undefined {
	return readMessageFile(inboxPath(dir, index));
}

function readMessageFile(path: string): InboxPayload | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseInboxPayload(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/** Read one queued message by file name, as the child consumes them. */
export function readQueuedMessage(dir: string, name: string): InboxPayload | undefined {
	return readMessageFile(join(inboxDir(dir), name));
}

/**
 * Remove a message that was handed to Pi. A failure surfaces: leaving a
 * delivered message in place would hand it to Pi again on a later drain.
 */
export function consumeInboxMessage(dir: string, name: string): void {
	unlinkSync(join(inboxDir(dir), name));
}

/**
 * Park an unreadable message so it is never retried. The `.bad` suffix makes
 * the file stop matching the message rule, which is why nothing re-reads it.
 * A failure surfaces: swallowing it would leave the file matching that rule and
 * re-read the same unreadable message on every tick.
 */
export function quarantineInboxMessage(dir: string, name: string): void {
	const path = join(inboxDir(dir), name);
	renameSync(path, `${path}.bad`);
}

function sequencePath(dir: string): string {
	return join(inboxDir(dir), ".seq");
}

function readSequence(dir: string): number {
	try {
		const value = Number(readFileSync(sequencePath(dir), "utf8").trim());
		return Number.isInteger(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}

const LOCK_NAME = ".lock";
/** A lock older than this is assumed abandoned (crashed holder) and stolen. */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;

/** Thrown inside a critical section that lost its lock to a stale steal. */
export class InboxLockStolen extends Error {
	constructor() {
		super("inbox lock was stolen while held");
		this.name = "InboxLockStolen";
	}
}

function readLockToken(lockPath: string): string | undefined {
	try {
		return readFileSync(lockPath, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Serialize "allocate index + publish message" across processes. Atomic renames
 * make each file appear whole, but without the lock two concurrent senders
 * could compute the same index and one rename would silently overwrite the
 * other's message.
 *
 * Ownership: the lock file holds a unique token. A holder whose lock was stolen
 * (because it looked stale) neither releases the successor's lock nor publishes
 * under it: `owns()` re-reads the token before the critical section commits, and
 * a stolen holder raises {@link InboxLockStolen} so the allocation restarts.
 * This narrows the steal hazard to the verify-to-rename gap, and only for a
 * holder that already looked 10 s stale.
 */
export async function withInboxLock<T>(
	critical: (owns: () => boolean) => T,
	dir: string,
	waitMs: number,
): Promise<T> {
	mkdirSync(inboxDir(dir), { recursive: true });
	const lockPath = join(inboxDir(dir), LOCK_NAME);
	const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + waitMs;
	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Held by someone else: wait, or steal it once it looks abandoned.
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
				} else if (Date.now() >= deadline) {
					throw new Error(`inbox lock busy: ${lockPath}`);
				} else {
					await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
				}
			} catch (inner) {
				if (inner instanceof Error && inner.message.startsWith("inbox lock busy")) throw inner;
				// Only a vanished lock (ENOENT) may be retried immediately;
				// anything else (e.g. EACCES) must surface instead of busy-looping.
				if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
			}
			continue;
		}
		const owns = (): boolean => readLockToken(lockPath) === token;
		try {
			writeSync(fd, `${token}\n`);
			return critical(owns);
		} catch (error) {
			if (error instanceof InboxLockStolen) continue; // restart the allocation
			throw error;
		} finally {
			closeSync(fd);
			// Never release a lock that was stolen from us: it belongs to a successor.
			if (owns()) {
				try {
					unlinkSync(lockPath);
				} catch {
					// Already gone.
				}
			}
		}
	}
}

/**
 * Write one message so the runner never observes a partial file. The counter is
 * persisted because consumed messages disappear; numbering must stay monotonic.
 * The inbox lock makes concurrent senders pick distinct indexes instead of
 * racing to the same file name.
 */
export async function queueMessage(
	dir: string,
	message: string,
	delivery: Delivery = "auto",
	options: { lockWaitMs?: number } = {},
): Promise<number> {
	return withInboxLock(
		(owns) => {
			const indexes = inboxIndexes(dir);
			const last = indexes[indexes.length - 1] ?? 0;
			let index = Math.max(last, readSequence(dir)) + 1;
			// Belt and braces against crash leftovers; under the lock nothing
			// else allocates, so this loop cannot spin.
			let path = inboxPath(dir, index);
			while (existsSync(path)) {
				index += 1;
				path = inboxPath(dir, index);
			}
			const temporary = `${path}.tmp-${process.pid}`;
			writeFileSync(temporary, `${JSON.stringify({ message, delivery })}\n`, "utf8");
			// Our lock may have been stolen as stale while we worked; publishing
			// now could collide with the successor's allocation. Restart instead.
			if (!owns()) {
				try {
					unlinkSync(temporary);
				} catch {
					// Best effort; a leftover tmp file is never read as a message.
				}
				throw new InboxLockStolen();
			}
			renameSync(temporary, path);
			writeFileSync(sequencePath(dir), String(index), "utf8");
			return index;
		},
		dir,
		options.lockWaitMs ?? 5_000,
	);
}
