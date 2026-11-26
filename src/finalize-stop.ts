import { existsSync } from "node:fs";
import type { AccountingDetails, Observation, UsageObserver } from "./accounting.ts";
import type { StopOptions, StopResult } from "./lifecycle.ts";
import { isTerminalDisplayState, readRecord, runDirFor, updateRecord, type DisplayState } from "./record.ts";
import { DEFAULT_FINALIZATION_WAIT_MS } from "./stop-policy.ts";
import { readUsageSnapshot, usageSnapshotPath } from "./usage.ts";

/**
 * The accounting-aware stop: one operation that owns the pre-stop
 * classification, the durable finalization marker, the wait for a final
 * snapshot, the observation, and the permission to remove.
 *
 * It *composes* the lifecycle stop rather than absorbing the sentinel write and
 * the Rex close. That code carries the client-timeout-but-executed-on-the-
 * server case and six tests; this module must not rewrite it.
 *
 * See ARCHITECTURE.md ("Stop semantics"), docs/usage-accounting.md ("Stop and
 * removal") and ADR-0008 / ADR-0011.
 */

/** How much can be proven about the run immediately before the stop. */
export type PreStopSituation = "live" | "terminal" | "undeterminable";

/**
 * Classify the pre-stop state. Only a provably terminal run may skip
 * finalization; a state that cannot be read, or reads as `unknown` because Rex
 * is unreachable, is undeterminable and must not persist the marker — it would
 * otherwise poison later collection of a child that is already dead.
 *
 * A run that is already `stopping` counts as live, so a retry keeps asking for
 * the final snapshot.
 */
export function situationOf(state: DisplayState | undefined): PreStopSituation {
	if (state === undefined) return "undeterminable";
	if (isTerminalDisplayState(state)) return "terminal";
	if (state === "unknown") return "undeterminable";
	return "live";
}

/** The handles a wait outcome set proves terminal, for the observation that follows it. */
export function terminalHandlesOf(outcomes: readonly { handle: string; state: DisplayState }[]): string[] {
	return outcomes.filter((outcome) => isTerminalDisplayState(outcome.state)).map((outcome) => outcome.handle);
}

const SNAPSHOT_POLL_MS = 25;

export interface SnapshotWaitDeps {
	env: NodeJS.ProcessEnv;
	/** Injected so the deadline and the poll loop can be exercised. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	finalizationTimeoutMs?: number;
}

export interface FinalizeDeps extends SnapshotWaitDeps {
	observer: UsageObserver;
	stop: (handle: string, options: StopOptions) => Promise<StopResult>;
	describe: (handle: string) => Promise<Pick<{ state: DisplayState }, "state"> | undefined>;
	remove: (handle: string) => void;
}

export interface FinalizeStopOptions {
	handle: string;
	remove?: boolean;
	killSession?: boolean;
}

/** Problems that survive a successful accounting transaction. */
export interface FinalizeStopResiduals {
	markerClear?: string;
	removal?: string;
}

export interface FinalizeStopResult {
	stopped: StopResult;
	removed: boolean;
	finalization?: "unconfirmed";
	snapshot?: "missing";
	usage?: Observation["usage"];
	details: AccountingDetails;
	residuals: FinalizeStopResiduals;
}

/** Thrown when the stop or its accounting failed; carries what was learned. */
export class FinalizeStopError extends Error {
	readonly stopped: StopResult | undefined;

	constructor(message: string, stopped?: StopResult, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FinalizeStopError";
		this.stopped = stopped;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wait for the child's final snapshot before the close proceeds. Bounded, so a
 * child that never settles cannot hold the stop open forever.
 */
export async function awaitFinalSnapshot(handle: string, deps: SnapshotWaitDeps): Promise<void> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const timeoutMs = deps.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_WAIT_MS;
	const deadline = now() + timeoutMs;
	for (;;) {
		const snapshot = readUsageSnapshot(runDirFor(handle, deps.env));
		if (snapshot?.final && snapshot.runHandle === handle) return;
		if (now() >= deadline) {
			throw new Error(`run ${handle} did not publish a final usage snapshot before stop`);
		}
		await sleep(SNAPSHOT_POLL_MS);
	}
}

/**
 * Stop a run, collect its durable usage, and only then permit removal.
 *
 * A live stop always requests finalization before the close, even if the child
 * subsequently dies. A provably terminal one instead accepts the last durable
 * non-final snapshot as `finalization: "unconfirmed"`, because no final can
 * still arrive.
 */
export async function finalizeStop(
	parentSessionId: string,
	options: FinalizeStopOptions,
	deps: FinalizeDeps,
): Promise<FinalizeStopResult> {
	const { handle } = options;
	const env = deps.env;

	// Ownership and replay integrity must hold before anything is mutated. The
	// baseline itself is decided below, once the pre-stop state is known.
	await deps.observer.validate(parentSessionId, [handle], { allowMissingBaseline: true });

	const existing = readRecord(handle, env);
	const before = await deps.describe(handle).catch(() => undefined);
	const situation = situationOf(before?.state);
	const terminal = situation === "terminal";
	const missingSnapshot = !existsSync(usageSnapshotPath(runDirFor(handle, env)));

	// Preserve fail-before-stop for an unadopted run that has a snapshot and for
	// every live run. Only a terminal absence may use the zero-observation
	// recovery cursor.
	await deps.observer.validate(parentSessionId, [handle], {
		allowMissingBaseline: terminal && missingSnapshot,
	});

	const requireFinal = !terminal;
	// The marker is durable evidence that a stop owed a final snapshot. Only a
	// reliably live state may create it; an undeterminable one fails closed for
	// this attempt alone, which is what keeps a later dead-child collection
	// possible.
	const hasFinalizationMarker = existing?.usageFinalizationRequired === true || (requireFinal && situation === "live");
	if (requireFinal && situation === "live" && existing?.usageFinalizationRequired !== true) {
		if (!updateRecord(handle, { usageFinalizationRequired: true }, env)) {
			throw new FinalizeStopError(`no Rex subagent with handle ${handle}`);
		}
	}

	let stopped: StopResult | undefined;
	try {
		stopped = await deps.stop(handle, {
			remove: false,
			killSession: options.killSession,
			beforeClose: requireFinal ? () => awaitFinalSnapshot(handle, deps) : undefined,
		});
		if (!stopped.stopped) {
			// The stop never reached accounting, so this is not an AccountingError.
			throw new Error(stopped.detail ?? `could not confirm stop for ${handle}`);
		}

		const observed = await deps.observer.observe(parentSessionId, [handle], {
			requireFinal,
			allowUnconfirmedFinal: terminal,
			allowMissingSnapshotFor: terminal ? [handle] : [],
		});

		const cursor = observed.details.runs[0];
		const residuals: FinalizeStopResiduals = {};
		if (hasFinalizationMarker) {
			try {
				if (!updateRecord(handle, { usageFinalizationRequired: undefined }, env)) {
					throw new Error("run record is unavailable");
				}
			} catch (error) {
				// The observation is already committed. Preserve its Usage and
				// cursors while surfacing the remaining management problem.
				residuals.markerClear = errorMessage(error);
			}
		}
		if (options.remove) {
			try {
				deps.remove(handle);
			} catch (error) {
				// Accounting already succeeded. Return its Usage and cursors so that
				// a removal error cannot hide them from durable branch replay.
				residuals.removal = errorMessage(error);
			}
		}
		// The lifecycle stop ran with remove:false, so its own flag is always
		// false. Report the real end state in both places, so a caller never sees
		// the two disagree.
		const removed = options.remove === true && residuals.removal === undefined;
		return {
			stopped: { ...stopped, removed },
			removed,
			...(cursor?.finalization ? { finalization: cursor.finalization } : {}),
			...(cursor?.snapshot ? { snapshot: cursor.snapshot } : {}),
			...(observed.usage ? { usage: observed.usage } : {}),
			details: observed.details,
			residuals,
		};
	} catch (error) {
		throw new FinalizeStopError(errorMessage(error), stopped, error);
	}
}
