import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import childExtension, { planDelivery } from "../src/child.ts";
import { queueMessage, readStatus, writeRecord, type RunRecord } from "../src/record.ts";
import { tempEnv, writeExecutable } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

interface FakePi {
	on: (name: string, handler: Handler) => void;
	registerCommand: (name: string, options: { description?: string; handler: CommandHandler }) => void;
	sendUserMessage: (message: string, options?: { deliverAs?: string }) => void;
}

function fakePi(): {
	pi: FakePi;
	handlers: Map<string, Handler>;
	commands: Map<string, CommandHandler>;
	sent: { message: string; deliverAs?: string }[];
} {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandHandler>();
	const sent: { message: string; deliverAs?: string }[] = [];
	return {
		handlers,
		commands,
		sent,
		pi: {
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, options) => commands.set(name, options.handler),
			sendUserMessage: (message, options) => sent.push({ message, deliverAs: options?.deliverAs }),
		},
	};
}

interface FakeContext {
	idle: boolean;
	aborted: boolean;
	notices: { message: string; level?: string }[];
	isIdle: () => boolean;
	abort: () => void;
	ui: { notify: (message: string, level?: string) => void };
}

function fakeContext(idle: boolean): FakeContext {
	const ctx: FakeContext = {
		idle,
		aborted: false,
		notices: [],
		isIdle: () => ctx.idle,
		abort: () => {
			ctx.aborted = true;
		},
		ui: { notify: (message, level) => ctx.notices.push({ message, level }) },
	};
	return ctx;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The child only needs these two API surfaces; the rest is unused. */
function install(pi: FakePi): void {
	childExtension(pi as unknown as Parameters<typeof childExtension>[0]);
}

const HANDLE = "abc123";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 1,
		handle: HANDLE,
		name: "task",
		title: "task — model:high",
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "",
		launchArgs: [],
		parentRex: { sessionId: "session:parent", windowId: "window:parent", blockId: "block:parent" },
		rex: {
			endpoint: "unix:///tmp/rex.sock",
			hostId: "host-1",
			sessionId: "session:1",
			windowId: "window:1",
			blockId: "block:1",
		},
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface Harness {
	runDir: string;
	calls: () => string[][];
}

function withRunDir<T>(
	fn: (harness: Harness) => Promise<T>,
	options: { record?: RunRecord } = {},
): Promise<T> {
	const temp = tempEnv();
	const runDir = join(temp.dir, "run");
	mkdirSync(runDir, { recursive: true });
	const logPath = join(temp.dir, "rex.log");
	const fakeRex = writeExecutable(
		join(temp.dir, "bin", "rex"),
		[
			"#!/bin/sh",
			`line=$(printf '%s\\t' "$@")`,
			`printf '%s\\n' "$line" >> ${JSON.stringify(logPath)}`,
			'case "$*" in',
			`  *"client ls"*) printf '%s\\n' '{"clients":[{"client_id":"client:app","info":{"kind":"app","label":"Mac"}}]}' ;;`,
			"esac",
			"exit 0",
			"",
		].join("\n"),
	);
	writeRecord(options.record ?? record(), temp.env);
	const saved = {
		runDir: process.env.REX_SUBAGENT_RUN_DIR,
		handle: process.env.PI_REX_SUBAGENT_HANDLE,
		agent: process.env.PI_CODING_AGENT_DIR,
		rex: process.env.REX_SUBAGENT_REX,
	};
	process.env.REX_SUBAGENT_RUN_DIR = runDir;
	process.env.PI_REX_SUBAGENT_HANDLE = HANDLE;
	process.env.PI_CODING_AGENT_DIR = temp.env.PI_CODING_AGENT_DIR;
	process.env.REX_SUBAGENT_REX = fakeRex;
	const calls = (): string[][] => {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => line.split("\t").filter(Boolean));
	};
	return fn({ runDir, calls }).finally(() => {
		const restore = (key: string, value: string | undefined): void => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore("REX_SUBAGENT_RUN_DIR", saved.runDir);
		restore("PI_REX_SUBAGENT_HANDLE", saved.handle);
		restore("PI_CODING_AGENT_DIR", saved.agent);
		restore("REX_SUBAGENT_REX", saved.rex);
		temp.cleanup();
	});
}

test("planDelivery starts a turn when idle and steers when busy", () => {
	assert.equal(planDelivery(true, "auto"), "prompt");
	assert.equal(planDelivery(true, "steer"), "prompt");
	assert.equal(planDelivery(true, "followUp"), "prompt");
	assert.equal(planDelivery(false, "auto"), "steer");
	assert.equal(planDelivery(false, "steer"), "steer");
	assert.equal(planDelivery(false, "followUp"), "followUp");
});

test("the child extension is inert without a run directory", () => {
	delete process.env.REX_SUBAGENT_RUN_DIR;
	const { pi, handlers, commands } = fakePi();
	install(pi);
	assert.equal(handlers.size, 0);
	assert.equal(commands.size, 0);
});

test("the child extension delivers the first message as a user message", async () => {
	await withRunDir(async ({ runDir }) => {
		await queueMessage(runDir, "first task");
		const { pi, handlers, sent } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, fakeContext(true));
		assert.deepEqual(sent, [], "the first turn waits for the TUI to initialize");
		await sleep(700);
		assert.deepEqual(sent, [{ message: "first task", deliverAs: undefined }]);
		assert.equal(existsSync(join(runDir, "inbox", "0001.json")), false);
		const status = readStatus(runDir);
		assert.equal(status?.state, "busy", "a delivered prompt starts a run");
		assert.equal(status?.turn, 1);
		assert.equal(status?.transport, "tui");
		await handlers.get("agent_settled")?.({}, fakeContext(true));
		assert.equal(readStatus(runDir)?.state, "idle");
		await handlers.get("session_shutdown")?.({}, fakeContext(true));
	});
});

test("the child extension steers into a busy turn and follows up after it", async () => {
	await withRunDir(async ({ runDir }) => {
		const { pi, handlers, sent } = fakePi();
		install(pi);
		const busy = fakeContext(true);
		await handlers.get("session_start")?.({}, busy);
		busy.idle = false;
		await queueMessage(runDir, "change course", "steer");
		await queueMessage(runDir, "then summarise", "followUp");
		await handlers.get("agent_start")?.({}, busy);
		await sleep(320);
		assert.deepEqual(sent, [
			{ message: "change course", deliverAs: "steer" },
			{ message: "then summarise", deliverAs: "followUp" },
		]);
		assert.equal(readStatus(runDir)?.state, "busy");
		assert.equal(readStatus(runDir)?.turn, 2);
		await handlers.get("agent_settled")?.({}, fakeContext(true));
		assert.equal(readStatus(runDir)?.state, "idle");
		// A settled turn must not claim a process exit code; only the Rex probe knows one.
		assert.equal(readStatus(runDir)?.lastExit, undefined);
		await handlers.get("session_shutdown")?.({}, fakeContext(true));
	});
});

test("/back selects the parent tab in the connected Rex app", async () => {
	await withRunDir(async ({ calls }) => {
		const { pi, commands } = fakePi();
		install(pi);
		const ctx = fakeContext(true);
		await commands.get("back")?.("", ctx);
		assert.deepEqual(ctx.notices, [{ message: "returned to the parent tab", level: "info" }]);
		const selection = calls().find((args) => args.includes("session.select"));
		assert.ok(selection, `expected a session.select call, got ${JSON.stringify(calls())}`);
		assert.deepEqual(selection.slice(selection.indexOf("do")), [
			"do",
			"session.select",
			"session_id=session:parent",
			"window_id=window:parent",
		]);
		assert.ok(selection.includes("client:app"));
		assert.ok(selection.includes("unix:///tmp/rex.sock"));
	});
});

test("/back explains when the subagent has no parent tab", async () => {
	await withRunDir(
		async ({ calls }) => {
			const { pi, commands } = fakePi();
			install(pi);
			const ctx = fakeContext(true);
			await commands.get("back")?.("", ctx);
			assert.equal(ctx.notices.length, 1);
			assert.match(ctx.notices[0].message, /no parent tab/);
			assert.equal(ctx.notices[0].level, "warning");
			assert.deepEqual(calls(), []);
		},
		{ record: record({ parentRex: undefined }) },
	);
});

test("the child extension aborts and exits when the stop file appears", { timeout: 10_000 }, async () => {
	await withRunDir(async ({ runDir }) => {
		const { pi, handlers } = fakePi();
		install(pi);
		const ctx = fakeContext(true);
		await handlers.get("session_start")?.({}, ctx);
		// The sentinel must end the process; keep the test runner alive while
		// observing it.
		const exits: number[] = [];
		const originalExit = process.exit;
		(process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
			exits.push(code ?? 0);
		};
		try {
			writeFileSync(join(runDir, "stop"), "");
			await sleep(400);
			assert.equal(ctx.aborted, true);
			assert.equal(readStatus(runDir)?.state, "stopped");
			assert.deepEqual(exits, [0], "the sentinel must exit the TUI process, not just abort the turn");
		} finally {
			(process as unknown as { exit: (code?: number) => void }).exit = originalExit;
		}
	});
});

test("the child extension parks unreadable messages instead of looping", async () => {
	await withRunDir(async ({ runDir }) => {
		const inbox = join(runDir, "inbox");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, "0001.json"), "{broken");
		const { pi, handlers, sent } = fakePi();
		install(pi);
		await handlers.get("session_start")?.({}, fakeContext(true));
		await sleep(700);
		assert.deepEqual(sent, []);
		assert.equal(existsSync(join(inbox, "0001.json.bad")), true);
		assert.match(readFileSync(join(runDir, "child.err.log"), "utf8"), /unreadable inbox message 0001\.json/);
	});
});
