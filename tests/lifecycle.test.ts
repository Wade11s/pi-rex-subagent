import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UsageError, buildMessage, buildPiArgs, spawnRun } from "../src/launch.ts";
import {
	describeRun,
	listRuns,
	openRun,
	pruneRuns,
	readLog,
	sendMessage,
	stopRun,
	waitOutcomeOk,
	waitRuns,
} from "../src/lifecycle.ts";
import { inboxIndexes, inboxPath, queueMessage, readInboxMessage } from "../src/inbox.ts";
import {
	readRecord,
	runDirFor,
	writeRecord,
	type RunRecord,
} from "../src/record.ts";
import { runDir, runDirFrom } from "../src/run-dir.ts";
import type { RexEventHandlers } from "../src/rex-events.ts";
import { defaultRunner, RexError, type CommandRunner, type CommandRunResult, type RexFailureKind } from "../src/rex.ts";
import { fakeRunner, json, rexCommand, result, tempEnv, writeExecutable } from "./helpers.ts";

const WHOAMI = { endpoint: "unix:///tmp/rex.sock", host_id: "host-1", account: "me", rex_version: "1" };

function baseRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 1,
		handle: "abc123",
		name: "alpha",
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "hello",
		launchArgs: [],
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

interface SpawnFixture {
	env: NodeJS.ProcessEnv;
	dir: string;
	runner: ReturnType<typeof fakeRunner>;
	cleanup: () => void;
}

/** A fake Rex whose `ls` reports what `new` created, as the real server does. */
interface FakeSession {
	session_id: string;
	label: string;
	window_labels: string[];
}

/** How the reply to a `rex window new` that already acted on the server is lost. */
type LostReply = "timeout" | "unreadable" | "exit";

const LOST_REPLY_KIND: Record<LostReply, RexFailureKind> = { timeout: "unavailable", unreadable: "invalid", exit: "failed" };

/** What the real `rex` CLI prints when its own 5 s `--timeout` gives up. */
const CLI_TIMEOUT: CommandRunResult = {
	code: 4,
	stdout: "",
	stderr: "Error: connecting to Rex server … timed out after 5s; increase --timeout: context deadline exceeded",
	timedOut: false,
};

function lostReply(shape: LostReply): CommandRunResult {
	if (shape === "timeout") return result({ code: -1, timedOut: true });
	if (shape === "unreadable") return result({ code: 0, stdout: "not json\n" });
	return CLI_TIMEOUT;
}

interface StatefulSpawnFixture extends SpawnFixture {
	sessions: FakeSession[];
	/** Make the next `rex new` fail once, then serve normally again. */
	failNextNew: () => void;
	/** Close the session the next `rex new` creates as soon as it is created. */
	vanishNextNew: () => void;
	/** The id of the session `vanishNextNew` closed, once that happened. */
	readonly vanishedSessionId: string | undefined;
	/** Let the next `rex window new` create its window, then lose its reply; afterwards Rex either stops answering (`hang`) or answers `ls` without a list (`malformed`). */
	loseNextWindowNew: (shape: LostReply, after?: "hang" | "malformed") => void;
}

function statefulSpawnFixture(): StatefulSpawnFixture {
	const temp = tempEnv();
	writeExecutable(join(temp.dir, "bin", "pi"), "#!/bin/sh\nexit 0\n");
	const sessions: FakeSession[] = [];
	let counter = 0;
	let failNew = false;
	let vanishNew = false;
	let vanishedSessionId: string | undefined;
	let loseWindowNew: { shape: LostReply; after: "hang" | "malformed" | undefined } | undefined;
	let after: "hang" | "malformed" | undefined;
	const nextId = (prefix: string) => `${prefix}:${++counter}`;
	const runner = fakeRunner((command, args) => {
		const cmd = rexCommand(args);
		if (after === "hang") return CLI_TIMEOUT;
		if (cmd[0] === "whoami") return json(WHOAMI);
		if (cmd[0] === "ls") {
			return json(after === "malformed" ? {} : { sessions: sessions.map(({ session_id, label }) => ({ session_id, label })) });
		}
		if (cmd[0] === "new") {
			if (failNew) {
				failNew = false;
				return result({ code: 1, stderr: "server exploded" });
			}
			const windowLabel = cmd[cmd.indexOf("--window") + 1];
			const session: FakeSession = { session_id: nextId("session"), label: cmd[1] ?? "", window_labels: [windowLabel ?? ""] };
			sessions.push(session);
			if (vanishNew) {
				vanishNew = false;
				vanishedSessionId = session.session_id;
				sessions.splice(sessions.indexOf(session), 1);
			}
			return json({ session_id: session.session_id, initial_windows: [{ window_id: nextId("window"), block_ids: [nextId("block")] }] });
		}
		if (cmd[0] === "window" && cmd[1] === "new") {
			const session = sessions.find((entry) => entry.session_id === cmd[cmd.indexOf("-s") + 1]);
			if (!session) return result({ code: 1, stderr: "session target not found" });
			session.window_labels.push(cmd[cmd.indexOf("-s") + 2] ?? "");
			if (loseWindowNew) {
				// The server created the window; only the reply is lost, unreadable,
				// or the `rex` CLI gave up after the server acted.
				const { shape, after: afterwards } = loseWindowNew;
				loseWindowNew = undefined;
				after = afterwards;
				return lostReply(shape);
			}
			return json({ window_id: nextId("window"), block_ids: [nextId("block")] });
		}
		return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
	});
	return {
		env: temp.env,
		dir: temp.dir,
		runner,
		cleanup: temp.cleanup,
		sessions,
		failNextNew: () => (failNew = true),
		vanishNextNew: () => (vanishNew = true),
		get vanishedSessionId() {
			return vanishedSessionId;
		},
		loseNextWindowNew: (shape, afterwards) => (loseWindowNew = { shape, after: afterwards }),
	};
}

function spawnFixture(sessions: { session_id: string; label: string }[] = []): SpawnFixture {
	const temp = tempEnv();
	writeExecutable(join(temp.dir, "bin", "pi"), "#!/bin/sh\nexit 0\n");
	const runner = fakeRunner((command, args) => {
		const cmd = rexCommand(args);
		if (cmd[0] === "whoami") return json(WHOAMI);
		if (cmd[0] === "ls") return json({ sessions });
		if (cmd[0] === "new") {
			return json({ session_id: "session:new", initial_windows: [{ window_id: "window:new", block_ids: ["block:new"] }] });
		}
		if (cmd[0] === "window" && cmd[1] === "new") return json({ window_id: "window:2", block_ids: ["block:2"] });
		if (cmd[0] === "block" && cmd[1] === "call") return json({ last_exit: null, child: { pid: 1 } });
		if (cmd[0] === "block" && cmd[1] === "inspect") return json({ block: { window_id: "window:parent" } });
		if (cmd[0] === "session" && cmd[1] === "inspect") {
			return json({ windows: [{ window_id: "window:new", layers: [{ blocks: [{ block_id: "block:new" }] }] }] });
		}
		if (cmd[0] === "client") return json({ clients: [{ client_id: "client:1", info: { kind: "app", label: "Mac" } }] });
		if (cmd[0] === "do") return result({ code: 0 });
		if (cmd[0] === "kill") return result({ code: 0 });
		if (cmd[0] === "window" && cmd[1] === "close") return result({ code: 0 });
		return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
	});
	return { env: temp.env, dir: temp.dir, runner, cleanup: temp.cleanup };
}

test("buildMessage joins prompts and appends files", () => {
	const temp = tempEnv();
	try {
		const file = join(temp.dir, "spec.md");
		writeFileSync(file, "file body");
		const message = buildMessage(["one", "two"], [file]);
		assert.match(message, /^one\n\ntwo\n\n--- /);
		assert.match(message, /file body$/);
		assert.throws(() => buildMessage([], []), UsageError);
	} finally {
		temp.cleanup();
	}
});

test("buildPiArgs maps every supported flag", () => {
	const args = buildPiArgs({
		runDir: "/runs/abc",
		handle: "abc",
		title: "alpha — grok:high",
		childExtension: "/pkg/src/child.ts",
		provider: "xai",
		model: "grok",
		thinking: "high",
		theme: "light",
		tools: "read,grep",
		excludeTools: "bash",
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noMcp: true,
	});
	assert.deepEqual(args, [
		"-e",
		"/pkg/src/child.ts",
		"--session-dir",
		"/runs/abc/sessions",
		"--session-id",
		"abc",
		"--name",
		"alpha — grok:high",
		"--use-theme",
		"light",
		"--provider",
		"xai",
		"--model",
		"grok",
		"--thinking",
		"high",
		"--tools",
		"read,grep",
		"--exclude-tools",
		"bash",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-mcp",
	]);
});

test("spawnRun creates a session, stages metadata and queues the prompt", async () => {
	const fixture = spawnFixture();
	try {
		const spawned = await spawnRun(
			{
				name: "alpha",
				model: "grok",
				cwd: fixture.dir,
				prompts: ["do the thing"],
				files: [],
				parentSessionId: "parent-1",
			},
			{ runner: fixture.runner, env: { ...fixture.env, REX_SESSION: "session:parent", REX_BLOCK: "block:parent" } },
		);
		const record = readRecord(spawned.handle, fixture.env);
		assert.deepEqual(record?.parentRex, {
			sessionId: "session:parent",
			windowId: "window:parent",
			blockId: "block:parent",
		});
		assert.equal(record?.state, "running");
		assert.equal(record?.rex.sessionId, "session:new");
		assert.equal(record?.rex.windowId, "window:new");
		assert.equal(record?.rex.blockId, "block:new");
		assert.equal(record?.parentSessionId, "parent-1");
		assert.deepEqual(readInboxMessage(runDir(spawned.handle, fixture.env).dir, 1), {
			message: "do the thing",
			delivery: "auto",
		});

		assert.equal(record?.title, "alpha — grok");
		const run = runDir(spawned.handle, fixture.env);
		const script = readFileSync(join(run.dir, "child.sh"), "utf8");
		assert.match(script, new RegExp(`export REX_SUBAGENT_RUN_DIR='${run.dir}'`));
		assert.match(script, /export REX_SUBAGENT_TITLE='alpha — grok'/);
		assert.ok(!script.includes("PI_PROGRAM_STATUS"), "OSC 7501 must stay enabled");
		assert.match(script, /export REX_SUBAGENT_REX='/);
		assert.match(script, /export PI_REX_SUBAGENT_HANDLE='[0-9a-f]{6}'/);
		assert.match(script, /unset REX_SESSION REX_BLOCK REX_CLIENT/);
		assert.match(script, /exec '.*\/pi' '-e' '.*\/src\/child\.ts' '--session-dir' .*'--model' 'grok'/);
		assert.ok(!script.includes("'--mode'"));
		assert.ok(!script.includes("'-p'"));

		const newCall = fixture.runner.calls.map((call) => rexCommand(call.args)).find((cmd) => cmd[0] === "new");
		assert.ok(newCall);
		assert.equal(newCall[1], "rex-subagents");
		assert.ok(newCall.includes("--shell=none"));
		assert.equal(newCall[newCall.indexOf("--window") + 1], "alpha — grok", "the tab title carries the model");
		assert.deepEqual(newCall.slice(newCall.indexOf("--")), ["--", "/bin/sh", join(run.dir, "child.sh")]);
	} finally {
		fixture.cleanup();
	}
});

test("a second spawn in the same group adds a window instead of a session", async () => {
	const fixture = spawnFixture([{ session_id: "session:batch", label: "rex-subagents" }]);
	try {
		await spawnRun({ name: "beta", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env });
		const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
		assert.ok(!commands.some((cmd) => cmd[0] === "new"), "must not create a second session");
		const windowCall = commands.find((cmd) => cmd[0] === "window" && cmd[1] === "new");
		assert.ok(windowCall);
		assert.equal(windowCall[3], "session:batch");
	} finally {
		fixture.cleanup();
	}
});

test("concurrent spawns in the same group are tabs of one session", async () => {
	const fixture = statefulSpawnFixture();
	try {
		const spawned = await Promise.all(
			["inventory-batch-01", "inventory-batch-02", "inventory-batch-03", "inventory-batch-04"].map((name) =>
				spawnRun({ name, group: "issue-1", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env }),
			),
		);
		const labelled = fixture.sessions.filter((session) => session.label === "rex-issue-1");
		assert.equal(labelled.length, 1, "one group must be one Rex session");
		assert.deepEqual(
			[...(labelled[0]?.window_labels ?? [])].sort(),
			["inventory-batch-01", "inventory-batch-02", "inventory-batch-03", "inventory-batch-04"],
		);
		const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
		assert.equal(commands.filter((cmd) => cmd[0] === "new").length, 1, "exactly one spawn creates the session");
		assert.equal(commands.filter((cmd) => cmd[0] === "window" && cmd[1] === "new").length, 3);
		assert.equal(new Set(spawned.map((run) => run.record.rex.sessionId)).size, 1, "every record points at that session");
		assert.deepEqual(
			spawned.map((run) => run.reusedBatch).sort(),
			[false, true, true, true],
		);
	} finally {
		fixture.cleanup();
	}
});

test("a failed session launch does not poison the siblings waiting on it", async () => {
	const fixture = statefulSpawnFixture();
	try {
		fixture.failNextNew();
		const outcomes = await Promise.allSettled(
			["a", "b", "c", "d"].map((name) => spawnRun({ name, group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env })),
			);
		assert.deepEqual(
			outcomes.map((outcome) => outcome.status).sort(),
			["fulfilled", "fulfilled", "fulfilled", "rejected"],
			"which spawn was the failed publisher is scheduling, not contract",
		);
		const labelled = fixture.sessions.filter((session) => session.label === "rex-g");
		assert.equal(labelled.length, 1, "the waiters elect one publisher and the rest join it");
		// Which spawn was the failed publisher is scheduling, not contract: the survivor
		// holds the three fulfilled Runs' Tabs.
		const fulfilled = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
		assert.equal(fulfilled.length, 3);
		assert.deepEqual(
			[...(labelled[0]?.window_labels ?? [])].sort(),
			fulfilled.map((run) => run.record.name).sort(),
		);
		const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
		assert.equal(commands.filter((cmd) => cmd[0] === "new").length, 2, "the failed attempt and the elected publisher's");
		assert.equal(commands.filter((cmd) => cmd[0] === "window" && cmd[1] === "new").length, 2);
	} finally {
		fixture.cleanup();
	}
});

test("a sibling whose joined session vanished lists and creates instead of failing", async () => {
	const fixture = statefulSpawnFixture();
	try {
		fixture.vanishNextNew();
		const runs = await Promise.all(
			["a", "b"].map((name) => spawnRun({ name, group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env })),
			);
		assert.ok(runs.every((run) => !run.reusedBatch), "the join failed, so the joiner created its own session");
		assert.notEqual(runs[0]?.record.rex.sessionId, runs[1]?.record.rex.sessionId);
		// Which spawn published is scheduling, not contract: the survivor holds one Tab, the joiner's.
		const [survivor] = fixture.sessions;
		assert.equal(fixture.sessions.length, 1);
		const joiner = runs.find((run) => run.record.rex.sessionId === survivor?.session_id);
		assert.ok(joiner, "the survivor is the joiner's own session");
		assert.deepEqual(survivor?.window_labels, [joiner.record.name]);
		const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
		assert.ok(
			commands.some(
				(cmd) => cmd[0] === "window" && cmd[1] === "new" && cmd[cmd.indexOf("-s") + 1] === fixture.vanishedSessionId,
			),
			"the sibling must have tried to join the vanished session first",
		);
	} finally {
		fixture.cleanup();
	}
});

test("an ambiguous join failure fails the run instead of launching a second window", async () => {
	for (const shape of ["timeout", "unreadable", "exit"] as const) {
		const fixture = statefulSpawnFixture();
		try {
			fixture.loseNextWindowNew(shape);
			const outcomes = await Promise.allSettled(
				["a", "b"].map((name) => spawnRun({ name, group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env })),
			);
			assert.deepEqual(
				outcomes.map((outcome) => outcome.status).sort(),
				["fulfilled", "rejected"],
				`a lost reply may have created the window; never launch another (${shape})`,
			);
			const rejected = outcomes.find((outcome) => outcome.status === "rejected");
			assert.ok(
				rejected?.status === "rejected" && rejected.reason instanceof RexError && rejected.reason.kind === LOST_REPLY_KIND[shape],
				`${shape} must surface as ${LOST_REPLY_KIND[shape]}`,
			);
			// The server created the joiner's window before the reply was lost; it stays, unmanaged.
			assert.deepEqual(fixture.sessions.map((session) => [...session.window_labels].sort()), [["a", "b"]], `exactly one window per spawn (${shape})`);
			const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
			assert.equal(commands.filter((cmd) => cmd[0] === "new").length, 1);
			assert.equal(commands.filter((cmd) => cmd[0] === "window" && cmd[1] === "new").length, 1, `no second window for the joiner (${shape})`);
			// The publisher's listing and the one that proves the session still exists.
			assert.equal(commands.filter((cmd) => cmd[0] === "ls").length, 2, `the proof lists once and launches nothing (${shape})`);
			// Those counts alone would also fit a late joiner on the publisher path, so
			// pin the order: the proof follows the failed join.
			const lastLs = commands.findLastIndex((cmd) => cmd[0] === "ls");
			const lastWindowNew = commands.findLastIndex((cmd) => cmd[0] === "window" && cmd[1] === "new");
			assert.ok(lastLs > lastWindowNew && lastWindowNew > 0, `the proof lists after the failed join (${shape})`);
		} finally {
			fixture.cleanup();
		}
	}
});

test("a failed join whose proof cannot be made fails the run with the join's own error", async () => {
	for (const afterwards of ["hang", "malformed"] as const) await proofCannotBeMade(afterwards);
});

async function proofCannotBeMade(afterwards: "hang" | "malformed"): Promise<void> {
	const fixture = statefulSpawnFixture();
	try {
		// The join commits and the CLI times out; then Rex either stops answering
		// or answers ls without a list. Neither proves the session gone.
		fixture.loseNextWindowNew("exit", afterwards);
		const outcomes = await Promise.allSettled(
			["a", "b"].map((name) => spawnRun({ name, group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env })),
			);
		assert.deepEqual(
			outcomes.map((outcome) => outcome.status).sort(),
			["fulfilled", "rejected"],
		);
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		assert.ok(rejected?.status === "rejected");
		assert.match(rejected.reason.message, /rex window new failed/, `the run reports the join's failure, not the proof's (${afterwards})`);
		const commands = fixture.runner.calls.map((call) => rexCommand(call.args));
		assert.equal(commands.filter((cmd) => cmd[0] === "window" && cmd[1] === "new").length, 1, `no second window for the joiner (${afterwards})`);
		assert.equal(commands.filter((cmd) => cmd[0] === "new").length, 1, `nothing is launched after the failed join (${afterwards})`);
		const lastLs = commands.findLastIndex((cmd) => cmd[0] === "ls");
		const lastWindowNew = commands.findLastIndex((cmd) => cmd[0] === "window" && cmd[1] === "new");
		assert.ok(lastLs > lastWindowNew, `the proof was attempted after the failed join (${afterwards})`);
	} finally {
		fixture.cleanup();
	}
}

test("a later spawn re-lists sessions instead of reusing a forgotten one", async () => {
	const fixture = statefulSpawnFixture();
	try {
		const first = await spawnRun({ name: "a", group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env });
		assert.equal(first.reusedBatch, false);
		// The user closes the whole session before the next spawn.
		fixture.sessions.length = 0;
		const second = await spawnRun({ name: "b", group: "g", cwd: fixture.dir, prompts: ["x"], files: [] }, { runner: fixture.runner, env: fixture.env });
		assert.equal(second.reusedBatch, false);
		assert.equal(fixture.sessions.length, 1, "the closed session is not reused");
		assert.notEqual(second.record.rex.sessionId, first.record.rex.sessionId);
	} finally {
		fixture.cleanup();
	}
});

test("spawnRun refuses nested spawning", async () => {
	const fixture = spawnFixture();
	try {
		await assert.rejects(
			() =>
				spawnRun(
					{ name: "x", cwd: fixture.dir, prompts: ["x"], files: [] },
					{ runner: fixture.runner, env: { ...fixture.env, PI_REX_SUBAGENT_HANDLE: "parent" } },
				),
			/nested rex subagents are disabled/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("spawnRun surfaces missing pi and unknown batches", async () => {
	const fixture = spawnFixture();
	try {
		await assert.rejects(
			() =>
				spawnRun(
					{ name: "x", cwd: fixture.dir, prompts: ["x"], files: [] },
					{ runner: fixture.runner, env: { ...fixture.env, PATH: "/nonexistent" } },
				),
			/pi executable not found/,
		);
		await assert.rejects(
			() =>
				spawnRun(
					{ name: "x", cwd: fixture.dir, prompts: ["x"], files: [], batch: "missing-session" },
					{ runner: fixture.runner, env: fixture.env },
				),
			/no Rex session labelled/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("a failed launch keeps a failed record with the error", async () => {
	const temp = tempEnv();
	try {
		writeExecutable(join(temp.dir, "bin", "pi"), "#!/bin/sh\nexit 0\n");
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "ls") return json({ sessions: [] });
			return result({ code: 1, stderr: "server exploded" });
		});
		await assert.rejects(
			() => spawnRun({ name: "x", cwd: temp.dir, prompts: ["x"], files: [] }, { runner, env: temp.env }),
			/server exploded/,
		);
		const runs = await listRuns({ runner, env: temp.env });
		assert.equal(runs.length, 1);
		assert.equal(runs[0].state, "failed");
		assert.match(runs[0].error ?? "", /server exploded/);
	} finally {
		temp.cleanup();
	}
});

test("describeRun merges metadata, supervisor status and the Rex probe", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		runDir("abc123", temp.env).writeStatus({ state: "busy", turn: 2 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block") return json({ last_exit: null, child: { pid: 5 } });
			return result({ code: 1, stderr: "unexpected" });
		});
		const view = await describeRun("abc123", { runner, env: temp.env });
		assert.equal(view.state, "busy");
		assert.equal(view.agentState, "busy");
		assert.equal(view.processState, "running");
		assert.equal(view.processExitCode, null);
		assert.equal(view.turn, 2);
		assert.equal(view.model, undefined);
	} finally {
		temp.cleanup();
	}
});

test("describeRun reports the process exit code when the agent died", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block") return json({ last_exit: { exit_code: 7 } });
			return result({ code: 1, stderr: "unexpected" });
		});
		const view = await describeRun("abc123", { runner, env: temp.env });
		assert.equal(view.state, "exited");
		assert.equal(view.processState, "exited");
		assert.equal(view.processExitCode, 7);
	} finally {
		temp.cleanup();
	}
});

test("describeRun reports a missing window as gone and never as exited", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return result({ code: 1, stderr: 'block target "block:1" not found' });
		});
		assert.equal((await describeRun("abc123", { runner, env: temp.env })).state, "gone");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns resolves on idle and times out on a busy run", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "idle01" }), temp.env);
		writeFileSync(
			runDir("idle01", temp.env).statusPath(),
			JSON.stringify({ state: "idle", turn: 1, lastExit: 0 }),
		);
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 5 } });
		});
		const [idle] = await waitRuns(["idle01"], { timeoutMs: 2000, pollMs: 50 }, { runner, env: temp.env });
		assert.equal(idle.outcome, "idle");
		assert.equal(idle.agentState, "idle");
		// While alive there is no process exit code, whatever status.json claims.
		assert.equal(idle.processExitCode, null);
		const [busy] = await waitRuns(["busy01"], { timeoutMs: 300, pollMs: 50 }, { runner, env: temp.env });
		assert.equal(busy.outcome, "timeout");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns all aborts an in-flight Rex probe without stopping the child", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const controller = new AbortController();
		let markProbeStarted: () => void = () => undefined;
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const runner = fakeRunner(async (_command, args, options) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			markProbeStarted();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve(json({ last_exit: null, child: { pid: 5 } })), 400);
				options?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(options.signal?.reason);
					},
					{ once: true },
				);
			});
		});
		const waiting = waitRuns(
			["busy01"],
			{ timeoutMs: 800, pollMs: 400, signal: controller.signal },
			{ runner, env: temp.env },
		);
		await probeStarted;
		const abortedAt = Date.now();
		const rejected = assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);
		controller.abort();
		await rejected;
		assert.ok(Date.now() - abortedAt < 250, "abort must interrupt the in-flight probe");
		assert.ok(runner.calls.every((call) => call.options?.signal === controller.signal));
		assert.equal(readRecord("busy01", temp.env)?.state, "running");
		assert.ok(!runner.calls.some((call) => rexCommand(call.args)[0] === "kill"));
	} finally {
		temp.cleanup();
	}
});

test("waitRuns all aborts after a real runner resolves its cancelled probe", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const probeMarker = join(temp.dir, "probe-started");
		writeExecutable(
			join(temp.dir, "bin", "rex"),
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("whoami")) {
  process.stdout.write(JSON.stringify(${JSON.stringify(WHOAMI)}) + "\\n");
} else if (args.at(-1) === "process") {
  fs.writeFileSync(${JSON.stringify(probeMarker)}, "started");
  setTimeout(() => process.stdout.write(JSON.stringify({ last_exit: null, child: { pid: 5 } }) + "\\n"), 1000);
} else {
  process.exitCode = 2;
}
`,
		);
		const runner: CommandRunner = {
			run(command, args, options) {
				return defaultRunner.run(command, args, { ...options, env: temp.env });
			},
		};
		const controller = new AbortController();
		const started = Date.now();
		const waiting = waitRuns(
			["busy01"],
			{ timeoutMs: 3000, pollMs: 1000, signal: controller.signal },
			{ runner, env: temp.env },
		);
		while (!existsSync(probeMarker) && Date.now() - started < 1500) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(existsSync(probeMarker), "the real Rex probe did not start");
		const abortedAt = Date.now();
		const rejected = assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);
		controller.abort();
		await rejected;
		assert.ok(Date.now() - abortedAt < 500, "the real runner must resolve its cancelled probe promptly");
		assert.equal(readRecord("busy01", temp.env)?.state, "running");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns all aborts its polling sleep without issuing more Rex calls", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 5 } });
		});
		const controller = new AbortController();
		let callsAtAbort = 0;
		const started = Date.now();
		const waiting = waitRuns(
			["busy01"],
			{ timeoutMs: 600, pollMs: 5000, signal: controller.signal },
			{ runner, env: temp.env },
		);
		const rejected = assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);
		setTimeout(() => {
			callsAtAbort = runner.calls.length;
			controller.abort();
		}, 50);
		await rejected;
		assert.ok(Date.now() - started < 250, "abort must wake the polling sleep");
		assert.equal(runner.calls.length, callsAtAbort, "no Rex call may start after abort");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns any returns settled runs without waiting for busy siblings", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "idle01" }), temp.env);
		runDir("idle01", temp.env).writeStatus({ state: "idle", turn: 1 });
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block" && cmd.at(-1) === "process") return json({ last_exit: null, child: { pid: 5 } });
			if (cmd[0] === "block" && cmd.at(-1) === "program_status") return json({ records: [] });
			return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
		});
		const started = Date.now();
		const results = await waitRuns(
			["idle01", "busy01"],
			{ mode: "any", timeoutMs: 2000, pollMs: 20 },
			{ runner, env: temp.env, watchEvents: () => ({ close: () => {} }) },
		);
		assert.deepEqual(results.map((entry) => entry.handle), ["idle01"]);
		assert.equal(results[0].outcome, "idle");
		assert.ok(Date.now() - started < 1000, "the busy sibling must not hold back the idle result");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns any wakes on a Rex done event instead of the fallback poll", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		const run = runDir("busy01", temp.env);
		run.writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block" && cmd.at(-1) === "process") return json({ last_exit: null, child: { pid: 5 } });
			if (cmd[0] === "block" && cmd.at(-1) === "program_status") {
				return json({ records: [{ state: run.status()?.state === "idle" ? "done" : "working", app: "pi" }] });
			}
			return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
		});
		let closed = false;
		const watchEvents = (...args: any[]) => {
			const handlers = args[2];
			const timer = setTimeout(() => {
				run.writeStatus({ state: "idle", turn: 1 });
				handlers.onEvent({
					sessionId: "session:1",
					blockId: "block:1",
					name: "program_status_changed",
					payload: { id: "", record: { state: "done", app: "pi" } },
				});
			}, 50);
			return { close: () => { closed = true; clearTimeout(timer); } };
		};
		const started = Date.now();
		const results = await waitRuns(
			["busy01"],
			{ mode: "any", timeoutMs: 1500, pollMs: 1000 },
			{ runner, env: temp.env, watchEvents },
		);
		assert.equal(results[0].outcome, "idle");
		assert.ok(Date.now() - started < 500, "the Rex event must wake the wait before the fallback poll");
		assert.equal(closed, true, "the event subscription must not leak after wait returns");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns any aborts its event fallback, closes the subscription, and ignores late events", async (t) => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block" && cmd.at(-1) === "process") return json({ last_exit: null, child: { pid: 5 } });
			if (cmd[0] === "block" && cmd.at(-1) === "program_status") return json({ records: [] });
			return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
		});
		let closed = false;
		let eventHandlers: RexEventHandlers | undefined;
		const controller = new AbortController();
		let callsAtAbort = 0;
		const started = Date.now();
		const waiting = waitRuns(
			["busy01"],
			{ mode: "any", timeoutMs: 600, pollMs: 5000, signal: controller.signal },
			{
				runner,
				env: temp.env,
				watchEvents: (_location, _sessionId, handlers) => {
					eventHandlers = handlers;
					return { close: () => {
						closed = true;
					} };
				},
			},
		);
		const rejected = assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);
		setTimeout(() => {
			callsAtAbort = runner.calls.length;
			controller.abort();
		}, 50);
		await rejected;
		assert.ok(Date.now() - started < 250, "abort must wake the event fallback");
		assert.equal(closed, true, "abort must close the Rex event subscription");
		assert.equal(runner.calls.length, callsAtAbort, "no Rex call may start after abort");
		assert.ok(runner.calls.every((call) => call.options?.signal === controller.signal));
		assert.ok(eventHandlers);
		let lateTimerCalls = 0;
		t.mock.method(globalThis, "setTimeout", () => {
			lateTimerCalls += 1;
			return undefined as unknown as NodeJS.Timeout;
		});
		eventHandlers.onEvent({
			sessionId: "session:1",
			blockId: "block:1",
			name: "program_status_changed",
			payload: { id: "", record: { state: "done", app: "pi" } },
		});
		assert.equal(lateTimerCalls, 0, "a late event must not create a retry timer after cleanup");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns any reconciles missed events through its fallback snapshot", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "busy01" }), temp.env);
		const run = runDir("busy01", temp.env);
		run.writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block" && cmd.at(-1) === "process") return json({ last_exit: null, child: { pid: 5 } });
			if (cmd[0] === "block" && cmd.at(-1) === "program_status") return json({ records: [] });
			return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
		});
		const completion = setTimeout(() => {
			run.writeStatus({ state: "idle", turn: 1 });
		}, 40);
		const results = await waitRuns(
			["busy01"],
			{ mode: "any", timeoutMs: 1000, pollMs: 50 },
			{ runner, env: temp.env, watchEvents: () => ({ close: () => {} }) },
		);
		clearTimeout(completion);
		assert.equal(results[0].outcome, "idle");
	} finally {
		temp.cleanup();
	}
});

test("waitRuns any wakes on child_exited and preserves the real exit code", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "dead01" }), temp.env);
		let exited = false;
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block" && cmd.at(-1) === "process") {
				return exited ? json({ last_exit: { exit_code: 7 } }) : json({ last_exit: null, child: { pid: 5 } });
			}
			return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
		});
		const watchEvents = (...args: any[]) => {
			const handlers = args[2];
			const timer = setTimeout(() => {
				exited = true;
				handlers.onEvent({
					sessionId: "session:1",
					blockId: "block:1",
					name: "child_exited",
					payload: { exit_code: 7 },
				});
			}, 40);
			return { close: () => clearTimeout(timer) };
		};
		const results = await waitRuns(
			["dead01"],
			{ mode: "any", timeoutMs: 1000, pollMs: 1000 },
			{ runner, env: temp.env, watchEvents },
		);
		assert.equal(results[0].outcome, "exited");
		assert.equal(results[0].processExitCode, 7);
		assert.equal(waitOutcomeOk(results[0]), false);
	} finally {
		temp.cleanup();
	}
});

for (const scenario of [
	{ state: "blocked", kind: "question", msg: "Need an answer", detail: "question: Need an answer" },
	{ state: "error", msg: "Model failed", detail: "Model failed" },
] as const) {
	test(`waitRuns any returns Rex ${scenario.state} as an early non-success result`, async () => {
		const temp = tempEnv();
		try {
			writeRecord(baseRecord({ handle: "busy01" }), temp.env);
			runDir("busy01", temp.env).writeStatus({ state: "busy", turn: 1 });
			const runner = fakeRunner((_command, args) => {
				const cmd = rexCommand(args);
				if (cmd[0] === "whoami") return json(WHOAMI);
				if (cmd[0] === "block" && cmd.at(-1) === "process") return json({ last_exit: null, child: { pid: 5 } });
				if (cmd[0] === "block" && cmd.at(-1) === "program_status") {
					return json({ records: [{ state: scenario.state, kind: scenario.kind, msg: scenario.msg, app: "pi" }] });
				}
				return result({ code: 1, stderr: `unexpected rex command ${cmd.join(" ")}` });
			});
			const watchEvents = (...args: any[]) => {
				const handlers = args[2];
				const timer = setTimeout(() => {
					handlers.onEvent({
						sessionId: "session:1",
						blockId: "block:1",
						name: "program_status_changed",
							payload: { id: "", record: { state: scenario.state, kind: scenario.kind, msg: scenario.msg } },
					});
				}, 50);
				return { close: () => clearTimeout(timer) };
			};
			const results = await waitRuns(
				["busy01"],
				{ mode: "any", timeoutMs: 1000, pollMs: 1000 },
				{ runner, env: temp.env, watchEvents },
			);
			assert.equal(results[0].outcome, scenario.state);
			assert.equal(results[0].detail, scenario.detail);
			assert.equal(waitOutcomeOk(results[0]), false);
		} finally {
			temp.cleanup();
		}
	});
}

test("waitRuns resolves exited as terminal with the real exit code", async () => {
	const temp = tempEnv();
	try {
		// No status file at all: the child died before its first turn.
		writeRecord(baseRecord({ handle: "dead01" }), temp.env);
		// Stale idle status: the child died after a finished turn.
		writeRecord(baseRecord({ handle: "dead02" }), temp.env);
		writeFileSync(
			runDir("dead02", temp.env).statusPath(),
			JSON.stringify({ state: "idle", turn: 2, lastExit: 0 }),
		);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: { exit_code: 7 } });
		});
		const results = await waitRuns(["dead01", "dead02"], { timeoutMs: 2000, pollMs: 50 }, { runner, env: temp.env });
		const [preStart, afterTurn] = results;
		assert.equal(preStart.outcome, "exited", "a pre-start exit must not wait until timeout");
		assert.equal(preStart.processExitCode, 7);
		assert.equal(afterTurn.outcome, "exited", "a stale idle status must not mask a dead process");
		assert.equal(afterTurn.processExitCode, 7);
		assert.equal(afterTurn.agentState, "idle");
		assert.equal(waitOutcomeOk(preStart), false);
		assert.equal(waitOutcomeOk(afterTurn), false);
	} finally {
		temp.cleanup();
	}
});

test("waitOutcomeOk accepts a clean exit after the work but not a mid-turn death", () => {
	const base = { handle: "x", state: "exited" as const, turn: 1, processExitCode: null };
	assert.equal(waitOutcomeOk({ ...base, outcome: "idle" }), true);
	assert.equal(waitOutcomeOk({ ...base, outcome: "stopped" }), true);
	assert.equal(waitOutcomeOk({ ...base, outcome: "exited", agentState: "idle", processExitCode: 0 }), true);
	assert.equal(waitOutcomeOk({ ...base, outcome: "exited", agentState: "idle", processExitCode: 1 }), false);
	assert.equal(waitOutcomeOk({ ...base, outcome: "exited", agentState: "busy", processExitCode: 0 }), false);
	assert.equal(waitOutcomeOk({ ...base, outcome: "timeout" }), false);
	assert.equal(waitOutcomeOk({ ...base, outcome: "gone" }), false);
});

test("waitOutcomeOk rejects a zero exit before any turn ran", () => {
	// The user closed the TUI (or Pi died) before the first turn: not success.
	assert.equal(
		waitOutcomeOk({ handle: "x", state: "exited", outcome: "exited", agentState: "starting", turn: 0, processExitCode: 0 }),
		false,
	);
	// Nor without a recorded agent state at all (no status file ever written).
	assert.equal(
		waitOutcomeOk({ handle: "x", state: "exited", outcome: "exited", turn: 0, processExitCode: 0 }),
		false,
	);
	// And not when messages are still queued that the dead process never delivered.
	assert.equal(
		waitOutcomeOk({
			handle: "x",
			state: "exited",
			outcome: "exited",
			agentState: "idle",
			turn: 2,
			processExitCode: 0,
			pendingMessages: 1,
		}),
		false,
	);
});

test("sendMessage queues behind a running turn", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		runDir("abc123", temp.env).writeStatus({ state: "busy", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 5 } });
		});
		const sent = await sendMessage("abc123", "later", {}, { runner, env: temp.env });
		assert.deepEqual(sent, { message: 1, delivery: "auto", queuedBehindRunningTurn: true, unconfirmed: false });
		assert.deepEqual(readInboxMessage(runDir("abc123", temp.env).dir, 1), { message: "later", delivery: "auto" });
		const steered = await sendMessage("abc123", "change course", { delivery: "steer" }, { runner, env: temp.env });
		assert.deepEqual(steered, { message: 2, delivery: "steer", queuedBehindRunningTurn: false, unconfirmed: false });
		const followed = await sendMessage("abc123", "then summarise", { delivery: "followUp" }, { runner, env: temp.env });
		assert.deepEqual(followed, { message: 3, delivery: "followUp", queuedBehindRunningTurn: true, unconfirmed: false });
		await assert.rejects(() => sendMessage("abc123", "  ", {}, { runner, env: temp.env }), /message is empty/);
	} finally {
		temp.cleanup();
	}
});

test("sendMessage refuses runs that can never consume the message", async () => {
	const temp = tempEnv();
	try {
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			const block = cmd[cmd.indexOf("-b") + 1];
			if (block === "block:gone") return result({ code: 1, stderr: `block target "${block}" not found` });
			return json({ last_exit: { exit_code: 0 } });
		});
		const gone = baseRecord({ handle: "gone9" });
		gone.rex = { ...gone.rex, blockId: "block:gone" };
		writeRecord(gone, temp.env);
		writeRecord(baseRecord({ handle: "dead9" }), temp.env);
		writeRecord(baseRecord({ handle: "stop9", state: "stopped" }), temp.env);

	await assert.rejects(() => sendMessage("gone9", "hello", {}, { runner, env: temp.env }), /is gone/);
		await assert.rejects(() => sendMessage("dead9", "hello", {}, { runner, env: temp.env }), /is exited/);
		await assert.rejects(() => sendMessage("stop9", "hello", {}, { runner, env: temp.env }), /is stopped/);
		// Nothing was queued for any of them.
		assert.deepEqual(inboxIndexes(runDir("gone9", temp.env).dir), []);
		assert.deepEqual(inboxIndexes(runDir("dead9", temp.env).dir), []);
		assert.deepEqual(inboxIndexes(runDir("stop9", temp.env).dir), []);
	} finally {
		temp.cleanup();
	}
});

test("sendMessage marks a message unconfirmed when Rex cannot be probed", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return result({ code: 1, stderr: "connection refused" });
		});
		const sent = await sendMessage("abc123", "maybe alive", {}, { runner, env: temp.env });
		assert.equal(sent.unconfirmed, true);
		assert.deepEqual(readInboxMessage(runDir("abc123", temp.env).dir, 1), {
			message: "maybe alive",
			delivery: "auto",
		});
	} finally {
		temp.cleanup();
	}
});

test("an unconfirmed stop with a live child is stopping, not stopped", async () => {
	const temp = tempEnv();
	try {
		// stopRun failed (Rex down), but the child saw the sentinel and aborted.
		writeRecord({ ...baseRecord(), stopError: "rex kill failed: connection refused" }, temp.env);
		runDir("abc123", temp.env).writeStatus({ state: "stopped", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 5 } }); // process still alive
		});
		const view = await describeRun("abc123", { runner, env: temp.env });
		assert.equal(view.state, "stopping");
		assert.equal(view.processState, "running");
		assert.equal(view.stopError, "rex kill failed: connection refused");
		// wait must not report success while the process is still alive.
		const [result] = await waitRuns(["abc123"], { timeoutMs: 250, pollMs: 50 }, { runner, env: temp.env });
		assert.equal(result.outcome, "timeout", `wait settled as ${result.outcome} while the process lives`);
		// and send refuses: the child is shutting down and will not drain.
		await assert.rejects(() => sendMessage("abc123", "too late", {}, { runner, env: temp.env }), /is stopping/);
	} finally {
		temp.cleanup();
	}
});

test("a child that exits after the sentinel settles the stop", async () => {
	const temp = tempEnv();
	try {
		writeRecord({ ...baseRecord(), stopError: "rex kill failed: connection refused" }, temp.env);
		runDir("abc123", temp.env).writeStatus({ state: "stopped", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: { exit_code: 0 } }); // child exited cleanly on the sentinel
		});
		const view = await describeRun("abc123", { runner, env: temp.env });
		assert.equal(view.state, "stopped");
		assert.equal(view.processState, "exited");
		assert.equal(view.processExitCode, 0);
		const [result] = await waitRuns(["abc123"], { timeoutMs: 2000, pollMs: 50 }, { runner, env: temp.env });
		assert.equal(result.outcome, "stopped");
		assert.equal(waitOutcomeOk(result), true);
	} finally {
		temp.cleanup();
	}
});

test("prune keeps a run whose spawn is still starting", async () => {
	const temp = tempEnv();
	try {
		// A record staged before the Rex window exists — prune must not delete it.
		const starting = {
			...baseRecord(),
			state: "starting" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			rex: { ...baseRecord().rex, sessionId: "" },
		};
		writeRecord(starting, temp.env);
		// A starting record older than the grace period is abandoned garbage.
		const staleDate = new Date(Date.now() - 10 * 60_000).toISOString();
		const stale = {
			...starting,
			handle: "old999",
			createdAt: staleDate,
			updatedAt: staleDate,
		};
		writeRecord(stale, temp.env);
		const pruned = await pruneRuns({ env: temp.env });
		assert.deepEqual(pruned.removed, ["old999"]);
		assert.equal(pruned.kept, 1);
		assert.equal(existsSync(runDirFor("abc123", temp.env)), true, "a starting run must survive prune");
	} finally {
		temp.cleanup();
	}
});

test("send is refused while a stopping child cannot be probed", async () => {
	const temp = tempEnv();
	try {
		// Rex is unreachable entirely: the stop cannot be confirmed, but the
		// child already saw the sentinel and is winding down.
		writeRecord({ ...baseRecord(), stopError: "rex kill failed: connection refused" }, temp.env);
		runDir("abc123", temp.env).writeStatus({ state: "stopped", turn: 1 });
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return result({ code: 1, stderr: "connection refused" });
		});
		const view = await describeRun("abc123", { runner, env: temp.env });
		assert.equal(view.state, "stopping", "an acknowledged stop must not degrade to unknown");
		await assert.rejects(() => sendMessage("abc123", "too late", {}, { runner, env: temp.env }), /is stopping/);
		assert.deepEqual(inboxIndexes(runDir("abc123", temp.env).dir), [], "nothing may be queued for a winding-down child");
	} finally {
		temp.cleanup();
	}
});

test("stopRun closes only its window inside a shared session", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "session" && cmd[1] === "inspect") {
				return json({
					windows: [
						{ window_id: "window:1", layers: [{ blocks: [{ block_id: "block:1" }] }] },
						{ window_id: "window:2", layers: [{ blocks: [{ block_id: "block:2" }] }] },
					],
				});
			}
			return result({ code: 0 });
		});
		const stopped = await stopRun("abc123", {}, { runner, env: temp.env });
		assert.equal(stopped.stopped, true);
		const commands = runner.calls.map((call) => rexCommand(call.args));
		assert.ok(commands.some((cmd) => cmd[0] === "window" && cmd[1] === "close"));
		assert.ok(!commands.some((cmd) => cmd[0] === "kill"));
		assert.equal(readRecord("abc123", temp.env)?.state, "stopped");
	} finally {
		temp.cleanup();
	}
});

test("stopRun kills a session that only holds this agent", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "session" && cmd[1] === "inspect") {
				return json({ windows: [{ window_id: "window:1", layers: [{ blocks: [{ block_id: "block:1" }] }] }] });
			}
			return result({ code: 0 });
		});
		await stopRun("abc123", { remove: true }, { runner, env: temp.env });
		const commands = runner.calls.map((call) => rexCommand(call.args));
		assert.ok(commands.some((cmd) => cmd[0] === "kill"));
		assert.equal(existsSync(runDirFor("abc123", temp.env)), false);
	} finally {
		temp.cleanup();
	}
});

test("stopRun preserves records for a failed pre-close finalization", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "session" && cmd[1] === "inspect") {
				return json({ windows: [{ window_id: "window:1", layers: [{ blocks: [{ block_id: "block:1" }] }] }] });
			}
			return result({ code: 0 });
		});
		const stopped = await stopRun(
			"abc123",
			{ remove: true, beforeClose: async () => Promise.reject(new Error("final snapshot unavailable")) },
			{ runner, env: temp.env },
		);
		assert.equal(stopped.stopped, true);
		assert.equal(stopped.removed, false);
		assert.match(stopped.detail ?? "", /final snapshot unavailable/);
		assert.equal(readRecord("abc123", temp.env)?.state, "stopped");
		assert.equal(existsSync(runDirFor("abc123", temp.env)), true);
	} finally {
		temp.cleanup();
	}
});

test("stopRun keeps the record and its state when the server refuses", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return result({ code: 1, stderr: "server is down" });
		});
		const stopped = await stopRun("abc123", { remove: true }, { runner, env: temp.env });
		assert.equal(stopped.stopped, false);
		assert.equal(stopped.removed, false, "--remove must not delete the only management record");
		assert.match(stopped.detail ?? "", /server is down/);
		const record = readRecord("abc123", temp.env);
		assert.equal(record?.state, "running", "state must stay retryable");
		assert.match(record?.stopError ?? "", /server is down/);
		assert.equal(existsSync(runDirFor("abc123", temp.env)), true);
	} finally {
		temp.cleanup();
	}
});

test("stopRun confirms via probe when the close command fails but the window is gone", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "session" && cmd[1] === "inspect") {
				return json({ windows: [{ window_id: "window:1", layers: [{ blocks: [{ block_id: "block:1" }] }] }] });
			}
			// The kill times out client-side but did execute on the server.
			if (cmd[0] === "kill") return result({ code: -1, stderr: "", timedOut: true });
			// The confirming probe finds nothing left.
			if (cmd[0] === "block") return result({ code: 1, stderr: 'block target "block:1" not found' });
			return result({ code: 0 });
		});
		const stopped = await stopRun("abc123", { remove: true }, { runner, env: temp.env });
		assert.equal(stopped.stopped, true);
		assert.equal(stopped.removed, true);
		assert.equal(existsSync(runDirFor("abc123", temp.env)), false);
	} finally {
		temp.cleanup();
	}
});

test("stopRun clears a previous stopError once the retry succeeds", async () => {
	const temp = tempEnv();
	try {
		writeRecord({ ...baseRecord(), stopError: "earlier failure" }, temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "session" && cmd[1] === "inspect") {
				return json({ windows: [{ window_id: "window:1", layers: [{ blocks: [{ block_id: "block:1" }] }] }] });
			}
			return result({ code: 0 });
		});
		const stopped = await stopRun("abc123", {}, { runner, env: temp.env });
		assert.equal(stopped.stopped, true);
		const record = readRecord("abc123", temp.env);
		assert.equal(record?.state, "stopped");
		assert.equal(record?.stopError, undefined);
	} finally {
		temp.cleanup();
	}
});

test("openRun refuses to guess between several Rex apps", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord(), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "client") {
				return json({
					clients: [
						{ client_id: "client:1", info: { kind: "app", label: "A" } },
						{ client_id: "client:2", info: { kind: "app", label: "B" } },
					],
				});
			}
			return result({ code: 0 });
		});
		await assert.rejects(() => openRun("abc123", {}, { runner, env: temp.env }), /multiple Rex apps/);
		const opened = await openRun("abc123", { clientId: "client:2" }, { runner, env: temp.env });
		assert.equal(opened.clientId, "client:2");
		const select = runner.calls.map((call) => rexCommand(call.args)).find((cmd) => cmd.includes("session.select"));
		assert.deepEqual(select, ["-C", "client:2", "do", "session.select", "session_id=session:1", "window_id=window:1"]);
	} finally {
		temp.cleanup();
	}
});

test("pruneRuns removes only vanished resources", async () => {
	const temp = tempEnv();
	try {
		const gone = baseRecord({ handle: "gone01" });
		gone.rex = { ...gone.rex, blockId: "block:gone" };
		const live = baseRecord({ handle: "live01" });
		live.rex = { ...live.rex, blockId: "block:live" };
		writeRecord(gone, temp.env);
		writeRecord(live, temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			if (cmd[0] === "block") {
				const block = cmd[cmd.indexOf("-b") + 1];
				return block === "block:live"
					? json({ last_exit: null, child: { pid: 1 } })
					: result({ code: 1, stderr: `block target "${block}" not found` });
			}
			return result({ code: 1, stderr: "unexpected" });
		});
		const pruned = await pruneRuns({ runner, env: temp.env });
		assert.deepEqual(pruned.removed, ["gone01"]);
		assert.equal(pruned.kept, 1);
		assert.equal(existsSync(runDirFor("live01", temp.env)), true);
	} finally {
		temp.cleanup();
	}
});

test("listRuns filters by parent session", async () => {
	const temp = tempEnv();
	try {
		writeRecord(baseRecord({ handle: "aaa111", parentSessionId: "p1" }), temp.env);
		writeRecord(baseRecord({ handle: "bbb222", parentSessionId: "p2" }), temp.env);
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 1 } });
		});
		const runs = await listRuns({ runner, env: temp.env }, { parentSessionId: "p1" });
		assert.deepEqual(
			runs.map((run) => run.handle),
			["aaa111"],
		);
	} finally {
		temp.cleanup();
	}
});

test("listRuns validates the pinned server once for many runs", async () => {
	const temp = tempEnv();
	try {
		for (const handle of ["aaa111", "bbb222", "ccc333", "ddd444"]) {
			writeRecord(baseRecord({ handle }), temp.env);
		}
		const runner = fakeRunner((_command, args) => {
			const cmd = rexCommand(args);
			if (cmd[0] === "whoami") return json(WHOAMI);
			return json({ last_exit: null, child: { pid: 1 } });
		});
		const runs = await listRuns({ runner, env: temp.env });
		assert.equal(runs.length, 4);
		const whoamiCalls = runner.calls.filter((call) => rexCommand(call.args)[0] === "whoami");
		assert.equal(whoamiCalls.length, 1, `expected one whoami, got ${whoamiCalls.length}`);
		const probes = runner.calls.filter((call) => rexCommand(call.args)[0] === "block");
		assert.equal(probes.length, 4, "every run is still probed individually");
	} finally {
		temp.cleanup();
	}
});

test("queueMessage is what the supervisor reads", async () => {
	const temp = tempEnv();
	try {
		const run = runDirFrom(join(temp.dir, "run"));
		await queueMessage(run.dir, "hello");
		assert.deepEqual(JSON.parse(readFileSync(inboxPath(run.dir, 1), "utf8")), {
			message: "hello",
			delivery: "auto",
		});
	} finally {
		temp.cleanup();
	}
});

test("readLog renders the child session and honours --tail", async () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		const sessions = run.sessionsDir();
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "2026-01-01T00-00-00-000Z_abc123.jsonl"),
			[
				JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "do it" } }),
				JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
				"",
			].join("\n"),
		);
		assert.equal(readLog("abc123", {}, temp.env), "=== prompt 1 ===\ndo it\n\n=== answer 1 ===\ndone\n");
		assert.deepEqual(readLog("abc123", { tail: 1 }, temp.env).split("\n"), [""]);
	} finally {
		temp.cleanup();
	}
});
