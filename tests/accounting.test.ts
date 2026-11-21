import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { registerAccountingTools } from "../src/accounting-tools.ts";
import type { WaitOptions, WaitResult } from "../src/lifecycle.ts";
import { runDirFor, writeRecord, type RunRecord } from "../src/record.ts";
import { existsSync } from "node:fs";
import { tempEnv } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = {
	content: { type: "text"; text: string }[];
	details: any;
	usage?: Usage;
	isError?: boolean;
};
type FakeTool = { execute: (id: string, params: any, signal: undefined, update: undefined, ctx: unknown) => Promise<ToolResult> };

function harness(
	env: NodeJS.ProcessEnv,
	spawn?: (options: any) => Promise<any>,
	branch: unknown[] = [],
	wait?: (handles: string[], options: WaitOptions) => Promise<WaitResult[]>,
	lifecycle: {
		stop?: (handle: string, options: any) => Promise<any>;
		describe?: (handle: string) => Promise<any>;
		remove?: (handle: string) => void;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerTool(tool: FakeTool & { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerAccountingTools(pi, { env, spawn, wait, stop: lifecycle.stop, describe: lifecycle.describe, remove: lifecycle.remove });
	const context = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionId: () => "parent-1",
			getBranch: () => branch,
		},
	};
	return {
		tools,
		async start() {
			await handlers.get("session_start")?.({}, context);
		},
		execute(name: string, params: unknown): Promise<ToolResult> {
			const tool = tools.get(name);
			assert.ok(tool, `missing tool ${name}`);
			return tool.execute("call-1", params, undefined, undefined, context);
		},
	};
}

function record(handle: string, parentSessionId = "parent-1"): RunRecord {
	return {
		version: 1,
		handle,
		name: handle,
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "work",
		launchArgs: [],
		parentSessionId,
		rex: {
			endpoint: "unix:///tmp/rex.sock",
			hostId: "host-1",
			sessionId: `session:${handle}`,
			windowId: `window:${handle}`,
			blockId: `block:${handle}`,
		},
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function writeSnapshot(handle: string, env: NodeJS.ProcessEnv, sequence: number, usage: Usage, overrides: Record<string, unknown> = {}): void {
	const dir = runDirFor(handle, env);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "usage.json"),
		`${JSON.stringify({
			version: 1,
			source: "pi-rex-subagent",
			runHandle: handle,
			parentSessionId: "parent-1",
			childSessionId: handle,
			childSessionGeneration: `generation-${handle}`,
			sequence,
			usage,
			final: false,
			updatedAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		})}\n`,
	);
}

const firstUsage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	cacheWrite1h: 1,
	reasoning: 3,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.1, total: 3.3, totalFromProvider: true },
};

const secondUsage: Usage = {
	input: 14,
	output: 9,
	cacheRead: 5,
	cacheWrite: 1,
	cacheWrite1h: 1,
	reasoning: 5,
	totalTokens: 29,
	cost: { input: 1.4, output: 3.6, cacheRead: 0.5, cacheWrite: 0.1, total: 5.6, totalFromProvider: true },
};

function persistToolResult(branch: unknown[], toolName: string, result: ToolResult): void {
	branch.push({
		type: "message",
		id: `entry-${branch.length + 1}`,
		parentId: branch.length === 0 ? null : `entry-${branch.length}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "toolResult", toolName, details: result.details, isError: result.isError === true },
	});
}

async function spawnForTest(parent: ReturnType<typeof harness>, handle: string): Promise<void> {
	const result = await parent.execute("rex_spawn", { prompt: "do work", name: handle });
	assert.equal(result.isError, undefined, result.content[0]?.text);
}

test("parallel children and repeated handles produce one combined delta", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
		const created = record(options.name);
		writeRecord(created, fixture.env);
		return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
	});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, secondUsage);
		const result = await parent.execute("rex_observe", { handles: ["child-a", "child-a", "child-b", "child-b"] });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.runs.length, 2);
		assert.deepEqual(result.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
		const repeated = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(repeated.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("concurrent observations of one child charge a snapshot once", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const results = await Promise.all([
			parent.execute("rex_observe", { handles: ["child1"] }),
			parent.execute("rex_observe", { handles: ["child1"] }),
		]);
		assert.equal(results.filter((result) => result.usage !== undefined).length, 1);
		assert.deepEqual(results.find((result) => result.usage)?.usage, firstUsage);
		assert.equal(results.every((result) => result.details.runs[0].sequence === 1), true);
	} finally {
		fixture.cleanup();
	}
});

test("overlapping multi-run observations cannot double charge or deadlock", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, secondUsage);
		const results = await Promise.all([
			parent.execute("rex_observe", { handles: ["child-a", "child-b"] }),
			parent.execute("rex_observe", { handles: ["child-b", "child-a"] }),
		]);
		assert.equal(results.filter((result) => result.usage !== undefined).length, 1);
		assert.deepEqual(results.find((result) => result.usage)?.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("a failed multi-run observation advances no cursor and can be retried", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeFileSync(join(runDirFor("child-b", fixture.env), "usage.json"), "not-json\n");
		const failed = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(failed.isError, true);
		assert.equal(failed.usage, undefined);
		assert.deepEqual(failed.details.runs, []);

		writeSnapshot("child-a", fixture.env, 2, secondUsage);
		writeSnapshot("child-b", fixture.env, 1, firstUsage);
		const retried = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, {
			input: 24,
			output: 14,
			cacheRead: 7,
			cacheWrite: 2,
			cacheWrite1h: 2,
			reasoning: 8,
			totalTokens: 47,
			cost: { input: 2.4, output: 5.6, cacheRead: 0.7, cacheWrite: 0.2, total: 8.899999999999999, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("restart and selected-branch replay restore only durable branch cursors", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: ["child1"] });
		persistToolResult(branch, "rex_observe", first);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		const afterRestart = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
		assert.deepEqual(afterRestart.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});

		const spawnOnlyBranch = branch.filter((entry: any) => entry.message.details.kind === "spawn");
		const navigated = harness(fixture.env, undefined, spawnOnlyBranch);
		await navigated.start();
		const fromSpawnBaseline = await navigated.execute("rex_observe", { handles: ["child1"] });
		assert.equal(fromSpawnBaseline.isError, undefined, fromSpawnBaseline.content[0]?.text);
		assert.deepEqual(fromSpawnBaseline.usage, secondUsage);
	} finally {
		fixture.cleanup();
	}
});

test("adoption claims an unowned run at its current snapshot and excludes history", async () => {
	const fixture = tempEnv();
	try {
		const existing = record("cli-run");
		existing.parentSessionId = undefined;
		writeRecord(existing, fixture.env);
		writeSnapshot("cli-run", fixture.env, 5, firstUsage, { parentSessionId: null });
		const parent = harness(fixture.env);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.usage, undefined);
		assert.equal(adopted.details.kind, "adoption");
		assert.equal(adopted.details.runs[0].sequence, 5);
		assert.deepEqual(adopted.details.runs[0].cumulative, firstUsage);
		assert.equal(JSON.parse(readFileSync(join(runDirFor("cli-run", fixture.env), "metadata.json"), "utf8")).parentSessionId, "parent-1");
		const unchanged = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.equal(unchanged.isError, undefined, unchanged.content[0]?.text);
		assert.equal(unchanged.usage, undefined);

		writeSnapshot("cli-run", fixture.env, 6, secondUsage);
		const observed = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.deepEqual(observed.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		const repeated = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(repeated.isError, true);
		assert.equal(repeated.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("a same-parent CLI-created run uses an explicit adoption baseline", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("cli-run"), fixture.env);
		writeSnapshot("cli-run", fixture.env, 3, firstUsage);
		const parent = harness(fixture.env);
		await parent.start();
		const adopted = await parent.execute("rex_adopt", { handle: "cli-run" });
		assert.equal(adopted.isError, undefined, adopted.content[0]?.text);
		assert.equal(adopted.usage, undefined);
		writeSnapshot("cli-run", fixture.env, 4, secondUsage);
		const observed = await parent.execute("rex_observe", { handles: ["cli-run"] });
		assert.deepEqual(observed.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});

test("adoption rejects other-parent runs and unknown existing snapshots", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("other-run", "parent-2"), fixture.env);
		writeSnapshot("other-run", fixture.env, 1, firstUsage, { parentSessionId: "parent-2" });
		writeRecord(record("empty-run"), fixture.env);
		const parent = harness(fixture.env);
		await parent.start();
		const other = await parent.execute("rex_adopt", { handle: "other-run" });
		assert.equal(other.isError, true);
		assert.match(other.content[0].text, /different parent/);
		const missing = await parent.execute("rex_adopt", { handle: "empty-run" });
		assert.equal(missing.isError, true);
		assert.equal(missing.usage, undefined);
		const observed = await parent.execute("rex_observe", { handles: ["other-run"] });
		assert.equal(observed.isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("wait returns lifecycle outcomes and observes usage even on timeout", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			async (handles): Promise<WaitResult[]> =>
				handles.map((handle) => ({ handle, outcome: "timeout", state: "busy", turn: 1, processExitCode: null })),
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const result = await parent.execute("rex_wait", { handles: ["child1"], timeoutMs: 10 });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.match(result.content[0].text, /timeout/);
		assert.deepEqual(result.usage, firstUsage);
		assert.equal(result.details.kind, "observation");
		assert.equal(result.details.runs[0].sequence, 1);
	} finally {
		fixture.cleanup();
	}
});

test("accounting-aware stop collects the final delta before removal", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "busy" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 2, secondUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.details.runs[0].final, true);
		assert.deepEqual(stopped.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a clean final zero-delta stop advances the final cursor without usage", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "idle" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 2, firstUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });
		const stopped = await parent.execute("rex_stop", { handle: "child1" });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.equal(stopped.usage, undefined);
		assert.equal(stopped.details.runs[0].sequence, 2);
		assert.equal(stopped.details.runs[0].final, true);
	} finally {
		fixture.cleanup();
	}
});

test("failed final observation preserves records and can be retried", async () => {
	const fixture = tempEnv();
	try {
		let lifecycleState = "busy";
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: lifecycleState }),
				stop: async () => {
					lifecycleState = "stopped";
					return { handle: "child1", stopped: true, removed: false };
				},
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const failed = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(failed.isError, true);
		assert.equal(failed.usage, undefined);
		assert.match(failed.content[0].text, /"stopped":true/);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);
		const stillNotFinal = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stillNotFinal.isError, true);
		assert.equal(stillNotFinal.usage, undefined);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), true);

		writeSnapshot("child1", fixture.env, 2, secondUsage, { final: true });
		const retried = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(retried.isError, undefined, retried.content[0]?.text);
		assert.deepEqual(retried.usage, secondUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("an already dead child remains collectible without a final marker", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			[],
			undefined,
			{
				describe: async () => ({ state: "exited" }),
				stop: async () => ({ handle: "child1", stopped: true, removed: false }),
			},
		);
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.deepEqual(stopped.usage, firstUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("conflicting, regressed, changed, negative, and post-final snapshots fail closed", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child1");
			writeRecord(created, fixture.env);
			return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child1");
		writeSnapshot("child1", fixture.env, 1, firstUsage);
		await parent.execute("rex_observe", { handles: ["child1"] });

		writeSnapshot("child1", fixture.env, 1, firstUsage, { childSessionId: "different-child" });
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 1, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 2, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, undefined);

		writeSnapshot("child1", fixture.env, 3, secondUsage, { childSessionGeneration: "replacement" });
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 3, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, undefined);

		writeSnapshot("child1", fixture.env, 2, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 4, firstUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		const negative = { ...secondUsage, input: -1 };
		writeSnapshot("child1", fixture.env, 4, negative);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		writeSnapshot("child1", fixture.env, 4, secondUsage);
		const usagePath = join(runDirFor("child1", fixture.env), "usage.json");
		writeFileSync(usagePath, readFileSync(usagePath, "utf8").replace('"totalTokens":29', '"totalTokens":1e999'));
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
		const withoutOptional = { ...secondUsage };
		delete withoutOptional.cacheWrite1h;
		delete withoutOptional.reasoning;
		writeSnapshot("child1", fixture.env, 4, withoutOptional);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);

		writeSnapshot("child1", fixture.env, 4, secondUsage, { final: true });
		const final = await parent.execute("rex_observe", { handles: ["child1"] });
		assert.equal(final.isError, undefined, final.content[0]?.text);
		assert.equal(final.usage, undefined);
		assert.equal(final.details.runs[0].final, true);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).usage, undefined);
		writeSnapshot("child1", fixture.env, 5, secondUsage);
		assert.equal((await parent.execute("rex_observe", { handles: ["child1"] })).isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("mixed provider-cost provenance is never upgraded", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async (options) => {
			const created = record(options.name);
			writeRecord(created, fixture.env);
			return { handle: options.name, record: created, dir: runDirFor(options.name, fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		await spawnForTest(parent, "child-b");
		const estimated: Usage = {
			...firstUsage,
			cost: { ...firstUsage.cost, totalFromProvider: false },
		};
		writeSnapshot("child-a", fixture.env, 1, firstUsage);
		writeSnapshot("child-b", fixture.env, 1, estimated);
		const combined = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(combined.usage?.cost.totalFromProvider, false);

		writeSnapshot("child-a", fixture.env, 2, secondUsage);
		writeSnapshot("child-b", fixture.env, 2, secondUsage);
		const later = await parent.execute("rex_observe", { handles: ["child-a", "child-b"] });
		assert.equal(later.usage?.cost.totalFromProvider, false);
	} finally {
		fixture.cleanup();
	}
});

test("a dead child's durable snapshot remains collectible after parent restart", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		writeSnapshot("child1", fixture.env, 1, firstUsage);

		const restarted = harness(fixture.env, undefined, branch, undefined, {
			describe: async () => ({ state: "exited" }),
			stop: async () => ({ handle: "child1", stopped: true, removed: false }),
		});
		await restarted.start();
		const collected = await restarted.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(collected.isError, undefined, collected.content[0]?.text);
		assert.deepEqual(collected.usage, firstUsage);
		assert.equal(existsSync(runDirFor("child1", fixture.env)), false);
	} finally {
		fixture.cleanup();
	}
});

test("a removal failure still returns the successful accounting result", async () => {
	const fixture = tempEnv();
	try {
		const branch: unknown[] = [];
		const parent = harness(
			fixture.env,
			async () => {
				const created = record("child1");
				writeRecord(created, fixture.env);
				return { handle: "child1", record: created, dir: runDirFor("child1", fixture.env), reusedBatch: false };
			},
			branch,
			undefined,
			{
				describe: async () => ({ state: "idle" }),
				stop: async () => {
					writeSnapshot("child1", fixture.env, 1, firstUsage, { final: true });
					return { handle: "child1", stopped: true, removed: false };
				},
				remove: () => {
					throw new Error("permission denied");
				},
			},
		);
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		persistToolResult(branch, "rex_spawn", spawned);
		const stopped = await parent.execute("rex_stop", { handle: "child1", remove: true });
		assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
		assert.deepEqual(stopped.usage, firstUsage);
		assert.match(stopped.content[0].text, /permission denied/);
		assert.match(stopped.content[0].text, /"removed":false/);
		persistToolResult(branch, "rex_stop", stopped);

		const restarted = harness(fixture.env, undefined, branch);
		await restarted.start();
		const observed = await restarted.execute("rex_observe", { handles: ["child1"] });
		assert.equal(observed.isError, undefined, observed.content[0]?.text);
		assert.equal(observed.usage, undefined);
	} finally {
		fixture.cleanup();
	}
});

test("stop validates ownership and baseline before changing the run", async () => {
	const fixture = tempEnv();
	try {
		writeRecord(record("other-run", "parent-2"), fixture.env);
		writeSnapshot("other-run", fixture.env, 1, firstUsage, { parentSessionId: "parent-2" });
		writeRecord(record("unadopted-run"), fixture.env);
		writeSnapshot("unadopted-run", fixture.env, 1, firstUsage);
		const parent = harness(fixture.env, undefined, [], undefined, {
			describe: async () => ({ state: "busy" }),
			stop: async (handle) => {
				const current = JSON.parse(readFileSync(join(runDirFor(handle, fixture.env), "metadata.json"), "utf8"));
				writeRecord({ ...current, state: "stopped" }, fixture.env);
				writeSnapshot(handle, fixture.env, 2, secondUsage, { final: true });
				return { handle, stopped: true, removed: false };
			},
		});
		await parent.start();
		const other = await parent.execute("rex_stop", { handle: "other-run" });
		assert.equal(other.isError, true);
		assert.equal(JSON.parse(readFileSync(join(runDirFor("other-run", fixture.env), "metadata.json"), "utf8")).state, "running");
		const unadopted = await parent.execute("rex_stop", { handle: "unadopted-run" });
		assert.equal(unadopted.isError, true);
		assert.equal(JSON.parse(readFileSync(join(runDirFor("unadopted-run", fixture.env), "metadata.json"), "utf8")).state, "running");
	} finally {
		fixture.cleanup();
	}
});

test("nested delegation is charged only through the immediate child aggregate", async () => {
	const fixture = tempEnv();
	try {
		const parent = harness(fixture.env, async () => {
			const created = record("child-a");
			writeRecord(created, fixture.env);
			return { handle: "child-a", record: created, dir: runDirFor("child-a", fixture.env), reusedBatch: false };
		});
		await parent.start();
		await spawnForTest(parent, "child-a");
		writeRecord(record("grandchild-b", "child-a"), fixture.env);
		writeSnapshot("child-a", fixture.env, 1, secondUsage);
		writeSnapshot("grandchild-b", fixture.env, 1, firstUsage, { parentSessionId: "child-a" });
		const direct = await parent.execute("rex_observe", { handles: ["child-a"] });
		assert.deepEqual(direct.usage, secondUsage);
		const nested = await parent.execute("rex_observe", { handles: ["grandchild-b"] });
		assert.equal(nested.isError, true);
		assert.equal(nested.usage, undefined);
		const adopted = await parent.execute("rex_adopt", { handle: "grandchild-b" });
		assert.equal(adopted.isError, true);
	} finally {
		fixture.cleanup();
	}
});

test("spawn establishes a zero baseline and observe returns only new usage", async () => {
	const fixture = tempEnv();
	try {
		const handle = "child1";
		const parent = harness(fixture.env, async () => {
			const created = record(handle);
			writeRecord(created, fixture.env);
			return { handle, record: created, dir: runDirFor(handle, fixture.env), reusedBatch: false };
		});
		await parent.start();
		const spawned = await parent.execute("rex_spawn", { prompt: "do work" });
		assert.equal(spawned.isError, undefined);
		assert.equal(spawned.usage, undefined);
		assert.deepEqual(spawned.details, {
			version: 1,
			kind: "spawn",
			parentSessionId: "parent-1",
			runs: [
				{
					handle,
					childSessionId: null,
					generation: null,
					sequence: 0,
					cumulative: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
					},
					final: false,
				},
			],
		});

		writeSnapshot(handle, fixture.env, 1, firstUsage);
		const first = await parent.execute("rex_observe", { handles: [handle] });
		assert.equal(first.isError, undefined);
		assert.deepEqual(first.usage, firstUsage);
		assert.equal(first.details.runs[0].sequence, 1);
		assert.equal(first.details.runs[0].generation, `generation-${handle}`);

		writeSnapshot(handle, fixture.env, 2, firstUsage);
		const repeated = await parent.execute("rex_observe", { handles: [handle] });
		assert.equal(repeated.isError, undefined);
		assert.equal(repeated.usage, undefined);
		assert.equal(repeated.details.runs[0].sequence, 2);

		writeSnapshot(handle, fixture.env, 3, secondUsage);
		const next = await parent.execute("rex_observe", { handles: [handle] });
		assert.deepEqual(next.usage, {
			input: 4,
			output: 4,
			cacheRead: 3,
			cacheWrite: 0,
			cacheWrite1h: 0,
			reasoning: 2,
			totalTokens: 11,
			cost: { input: 0.3999999999999999, output: 1.6, cacheRead: 0.3, cacheWrite: 0, total: 2.3, totalFromProvider: true },
		});
	} finally {
		fixture.cleanup();
	}
});
