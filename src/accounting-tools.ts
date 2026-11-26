import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UsageObserver, accountingDetails, type AccountingDetails, type AccountingKind } from "./accounting.ts";
import { FinalizeStopError, finalizeStop, terminalHandlesOf } from "./finalize-stop.ts";
import { asSpawnOptions, spawnRun, type SpawnOptions, type SpawnResult } from "./launch.ts";
import {
	describeRun,
	stopRun,
	waitRuns,
	type RunView,
	type StopOptions,
	type StopResult,
	type WaitOptions,
	type WaitResult,
} from "./lifecycle.ts";
import { removeRun, updateRecord } from "./record.ts";
import { spawnRowsFor } from "./spawn-spec.ts";
import { DEFAULT_FINALIZATION_WAIT_MS } from "./stop-policy.ts";

export interface AccountingToolDeps {
	env?: NodeJS.ProcessEnv;
	spawn?: (options: SpawnOptions) => Promise<SpawnResult>;
	wait?: (handles: string[], options: WaitOptions) => Promise<WaitResult[]>;
	stop?: (handle: string, options: StopOptions) => Promise<StopResult>;
	describe?: (handle: string) => Promise<Pick<RunView, "state">>;
	remove?: (handle: string) => void;
	finalizationTimeoutMs?: number;
	/** Injected so the final-snapshot deadline can be exercised. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

function textResult(text: string, details: AccountingDetails, usage?: import("@earendil-works/pi-ai").Usage): AgentToolResult<AccountingDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...(usage ? { usage } : {}),
	};
}

function errorResult(error: unknown, kind: AccountingKind, parentSessionId: string): AgentToolResult<AccountingDetails> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: accountingDetails(kind, parentSessionId, []),
		isError: true,
	};
}

/**
 * The `rex_spawn` parameters: the rows the tool surface exposes, with the
 * required one leading.
 */
const spawnParameters = Type.Object(
	Object.fromEntries(
		spawnRowsFor("tool")
			.toSorted((left, right) => Number(right.required === true) - Number(left.required === true))
			.map((row) => [
				row.toolName ?? row.field,
				row.arg === undefined ? Type.Optional(Type.Boolean()) : row.required === true ? Type.String() : Type.Optional(Type.String()),
			]),
	),
);

/**
 * The `rex_spawn` parameters as spawn options. A `message` row carries the one
 * prompt a call takes; `files` stays empty because the tool takes no files, and
 * the working directory falls back to the caller's.
 */
function spawnOptionsFromTool(params: Record<string, unknown>, cwd: string, parentSessionId: string): SpawnOptions {
	const options: Record<string, unknown> = { files: [], parentSessionId };
	for (const row of spawnRowsFor("tool")) {
		const value = params[row.toolName ?? row.field];
		if (value === undefined) continue;
		options[row.field] = row.kind === "message" ? [value] : value;
	}
	options.cwd ??= cwd;
	return asSpawnOptions(options);
}

export function registerAccountingTools(pi: ExtensionAPI, deps: AccountingToolDeps = {}): void {
	const observer = new UsageObserver(deps.env);
	const launch = deps.spawn ?? ((options: SpawnOptions) => spawnRun(options, { env: deps.env }));
	const wait = deps.wait ?? ((handles: string[], options: WaitOptions) => waitRuns(handles, options, { env: deps.env }));
	const stop = deps.stop ?? ((handle: string, options: StopOptions) => stopRun(handle, options, { env: deps.env }));
	const describe = deps.describe ?? ((handle: string) => describeRun(handle, { env: deps.env }));
	const remove = deps.remove ?? ((handle: string) => removeRun(handle, deps.env));
	const finalizationTimeoutMs = deps.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_WAIT_MS;

	pi.on("session_start", (_event, ctx) => {
		observer.restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		observer.restore(ctx);
	});

	pi.registerTool({
		name: "rex_spawn",
		label: "Rex subagent spawn",
		description: "Launch a direct Rex child with durable parent-side usage accounting.",
		parameters: spawnParameters,
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const env = deps.env ?? process.env;
			let spawned: SpawnResult | undefined;
			try {
				spawned = await launch(spawnOptionsFromTool(params, ctx.cwd, parentSessionId));
				const details = await observer.recordSpawn(parentSessionId, spawned.handle);
				return textResult(`Spawned Rex subagent ${spawned.handle}. Use rex_wait or rex_observe before accepting its result.`, details);
			} catch (error) {
				if (!spawned) return errorResult(error, "spawn", parentSessionId);
				const baselineError = error instanceof Error ? error.message : String(error);
				let preservationError: string | undefined;
				try {
					const retained = updateRecord(
						spawned.handle,
						{ usageBaselineError: `accounting baseline failed after launch: ${baselineError}` },
						env,
					);
					if (!retained) throw new Error("run record is unavailable");
				} catch (recordError) {
					preservationError = recordError instanceof Error ? recordError.message : String(recordError);
				}

				let rollbackError: string | undefined;
				try {
					const rollback = await stop(spawned.handle, { remove: false });
					if (!rollback.stopped) throw new Error(rollback.detail ?? "stop could not be confirmed");
				} catch (error) {
					rollbackError = error instanceof Error ? error.message : String(error);
				}
				const preservation = preservationError ? ` Run-record diagnostic could not be persisted: ${preservationError}.` : "";
				if (rollbackError) {
					return errorResult(
						new Error(
							`Rex subagent ${spawned.handle} launched, but its accounting baseline failed: ${baselineError}. ` +
								`Rollback failed: ${rollbackError}. The child may still be running without a baseline; explicit management of ${spawned.handle} is required.${preservation}`,
						),
						"spawn",
						parentSessionId,
					);
				}
				return errorResult(
					new Error(
						`Rex subagent ${spawned.handle} launched, but its accounting baseline failed: ${baselineError}. ` +
							`The child was stopped and its records retained for explicit recovery; no usage was charged and the failed spawn cannot be adopted.${preservation}`,
					),
					"spawn",
					parentSessionId,
				);
			}
		},
	});

	pi.registerTool({
		name: "rex_wait",
		label: "Rex subagent wait",
		description: "Wait for Rex children, then observe every requested handle for newly published usage.",
		parameters: Type.Object({
			handles: Type.Array(Type.String(), { minItems: 1 }),
			timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
			any: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const parentSessionId = ctx.sessionManager.getSessionId();
			let outcomes: WaitResult[] | undefined;
			try {
				const handles = [...new Set(params.handles)];
				// Ownership and replay integrity must be valid before waiting. A
				// missing baseline is decided only after terminal/missing evidence
				// exists; ordinary observations still enforce it below.
				await observer.validate(parentSessionId, handles, { allowMissingBaseline: true });
				outcomes = await wait(handles, { timeoutMs: params.timeoutMs, mode: params.any ? "any" : "all", signal });
				signal?.throwIfAborted();
				const terminalHandles = terminalHandlesOf(outcomes);
				const observed = await observer.observe(parentSessionId, handles, { allowMissingSnapshotFor: terminalHandles, signal });
				const missing = observed.details.runs.filter((run) => run.snapshot === "missing");
				return textResult(
					JSON.stringify({
						outcomes,
						...(missing.length > 0
							? {
									diagnostics: missing.map((run) => ({
										handle: run.handle,
										snapshot: "missing",
										finalization: "unconfirmed",
										detail: "terminal owned run had no usage snapshot; zero is bookkeeping only and unknown history was not charged",
									})),
								}
							: {}),
					}),
					observed.details,
					observed.usage,
				);
			} catch (error) {
				signal?.throwIfAborted();
				// Lifecycle outcomes are the run's terminal state; a failed usage
				// observation must not hide them, exactly as rex_stop preserves its
				// stop outcome alongside an accounting error.
				const message = error instanceof Error ? error.message : String(error);
				const lifecycle = outcomes ? `\n${JSON.stringify({ outcomes })}` : "";
				return errorResult(new Error(`${message}${lifecycle}`), "observation", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_stop",
		label: "Rex subagent stop",
		description: "Stop a Rex child, collect its durable usage, and remove records only after accounting succeeds.",
		parameters: Type.Object({
			handle: Type.String(),
			remove: Type.Optional(Type.Boolean()),
			killSession: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			const env = deps.env ?? process.env;
			try {
				const result = await finalizeStop(
					parentSessionId,
					{ handle: params.handle, remove: params.remove, killSession: params.killSession },
					{
						observer,
						stop,
						describe,
						remove,
						env,
						finalizationTimeoutMs,
						...(deps.now ? { now: deps.now } : {}),
						...(deps.sleep ? { sleep: deps.sleep } : {}),
					},
				);
				return textResult(
					JSON.stringify({
						stopped: result.stopped,
						removed: result.removed,
						...(result.finalization ? { finalization: result.finalization } : {}),
						...(result.snapshot
							? {
									snapshot: result.snapshot,
									diagnostic:
										"terminal owned run had no usage snapshot; zero is bookkeeping only and unknown history was not charged",
								}
							: {}),
						...(result.residuals.markerClear ? { finalizationMarkerError: result.residuals.markerClear } : {}),
						...(result.residuals.removal ? { removalError: result.residuals.removal } : {}),
					}),
					result.details,
					result.usage,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const outcome = error instanceof FinalizeStopError && error.stopped
					? `\n${JSON.stringify({ stopped: error.stopped })}`
					: "";
				return errorResult(new Error(`${message}${outcome}`), "observation", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_adopt",
		label: "Rex subagent adopt",
		description: "Adopt an unowned or same-parent CLI-created Rex run at its current usage snapshot.",
		parameters: Type.Object({ handle: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			try {
				const details = await observer.adopt(parentSessionId, params.handle);
				return textResult(`Adopted Rex subagent ${params.handle} at its current usage baseline.`, details);
			} catch (error) {
				return errorResult(error, "adoption", parentSessionId);
			}
		},
	});

	pi.registerTool({
		name: "rex_observe",
		label: "Rex subagent observe",
		description: "Observe direct Rex children and return only newly observed model usage.",
		parameters: Type.Object({ handles: Type.Array(Type.String(), { minItems: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const parentSessionId = ctx.sessionManager.getSessionId();
			try {
				const observed = await observer.observe(parentSessionId, params.handles);
				return textResult(`Observed ${observed.details.runs.length} Rex subagent(s).`, observed.details, observed.usage);
			} catch (error) {
				return errorResult(error, "observation", parentSessionId);
			}
		},
	});
}
