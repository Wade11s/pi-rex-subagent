import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { awaitFinalSnapshot, situationOf, terminalHandlesOf } from "../src/finalize-stop.ts";
import { runDir } from "../src/run-dir.ts";
import { DEFAULT_FINALIZATION_WAIT_MS, DEFAULT_STOP_GRACE_MS } from "../src/stop-policy.ts";
import { tempEnv } from "./helpers.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function writeSnapshot(handle: string, env: NodeJS.ProcessEnv, final: boolean): void {
	const run = runDir(handle, env);
	mkdirSync(run.dir, { recursive: true });
	writeFileSync(
		run.snapshotPath(),
		`${JSON.stringify({
			version: 1,
			source: "pi-rex-subagent",
			runHandle: handle,
			parentSessionId: "parent-1",
			childSessionId: handle,
			childSessionGeneration: `generation-${handle}`,
			sequence: 1,
			usage,
			final,
			updatedAt: "2026-01-01T00:00:00.000Z",
		})}\n`,
	);
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
	let clock = 0;
	return {
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
		},
		elapsed: () => clock,
	};
}

test("the pre-stop situation is decided by what can be proven", () => {
	// Undeterminable: no answer at all, or Rex unreachable with no status file.
	assert.equal(situationOf(undefined), "undeterminable");
	assert.equal(situationOf("unknown"), "undeterminable");
	// Terminal: the four states a run never comes back from.
	for (const state of ["failed", "stopped", "gone", "exited"] as const) {
		assert.equal(situationOf(state), "terminal", state);
	}
	// Live: including `stopping`, so a retry keeps requesting finalization.
	for (const state of ["starting", "busy", "idle", "stopping"] as const) {
		assert.equal(situationOf(state), "live", state);
	}
});

test("the wait path shares the terminal determination", () => {
	assert.deepEqual(
		terminalHandlesOf([
			{ handle: "a", state: "exited" },
			{ handle: "b", state: "busy" },
			{ handle: "c", state: "stopping" },
			{ handle: "d", state: "gone" },
			{ handle: "e", state: "idle" },
		]),
		["a", "d"],
	);
});

test("the parent's finalization wait exceeds the child's stop grace", () => {
	// The child's grace bounds when it stops being graceful; the parent's wait is
	// a floor for not preempting a healthy slow settlement.
	assert.ok(
		DEFAULT_FINALIZATION_WAIT_MS > DEFAULT_STOP_GRACE_MS,
		`finalization wait ${DEFAULT_FINALIZATION_WAIT_MS}ms must exceed stop grace ${DEFAULT_STOP_GRACE_MS}ms`,
	);
});

test("a final snapshot ends the wait without polling", async () => {
	const temp = tempEnv();
	try {
		writeSnapshot("abc123", temp.env, true);
		const clock = fakeClock();
		await awaitFinalSnapshot("abc123", { env: temp.env, now: clock.now, sleep: clock.sleep });
		assert.equal(clock.elapsed(), 0, "a published final snapshot must not wait at all");
	} finally {
		temp.cleanup();
	}
});

test("a non-final snapshot polls to the deadline and reports it", async () => {
	const temp = tempEnv();
	try {
		writeSnapshot("abc123", temp.env, false);
		const polls: number[] = [];
		let clock = 0;
		await assert.rejects(
			awaitFinalSnapshot("abc123", {
				env: temp.env,
				now: () => clock,
				sleep: async (ms) => {
					polls.push(ms);
					clock += ms;
					// Bound the loop from the test side: a missing deadline would
					// otherwise spin in microtasks and hang the runner instead of
					// failing, since a starved timer never fires --test-timeout.
					if (polls.length > 8) throw new Error("polled past the deadline");
				},
				finalizationTimeoutMs: 100,
			}),
			/did not publish a final usage snapshot before stop/,
		);
		// Exactly four 25ms polls reach a 100ms deadline. A shorter cadence, a
		// double deadline, or a missing deadline each breaks one of these.
		assert.deepEqual(polls, [25, 25, 25, 25]);
		assert.equal(clock, 100);
	} finally {
		temp.cleanup();
	}
});
