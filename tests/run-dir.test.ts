import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runDir, runDirFrom } from "../src/run-dir.ts";
import { runDirFor, writeRecord, type RunRecord } from "../src/record.ts";
import { tempEnv } from "./helpers.ts";

function record(handle: string): RunRecord {
	return {
		version: 1,
		handle,
		name: "alpha",
		title: "alpha — model",
		group: "subagents",
		cwd: "/tmp/project",
		prompt: "do the thing",
		launchArgs: [],
		rex: { endpoint: "http://127.0.0.1:1", hostId: "host-1", sessionId: "session:1", windowId: "window:1", blockId: "block:1" },
		state: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("the handle constructor derives the same directory as the path helper", () => {
	const temp = tempEnv();
	try {
		assert.equal(runDir("abc123", temp.env).dir, runDirFor("abc123", temp.env));
		assert.equal(runDirFrom(temp.dir).dir, temp.dir);
	} finally {
		temp.cleanup();
	}
});

test("the value answers for the record and the status", () => {
	const temp = tempEnv();
	try {
		writeRecord(record("abc123"), temp.env);
		const run = runDir("abc123", temp.env);
		assert.equal(run.record()?.handle, "abc123");
		assert.equal(run.record()?.state, "running");
		assert.equal(run.status(), undefined, "a child that has not booted writes no status");

		run.writeStatus({ state: "busy", turn: 1 });
		// The bytes, not the parser's tolerance: a second writer that wrote
		// different keys, pretty-printed, or skipped the atomic rename would still
		// read back through parseStatus.
		assert.match(
			readFileSync(join(run.dir, "status.json"), "utf8"),
			/^\{"state":"busy","turn":1,"updatedAt":"[^"]+","transport":"tui"\}\n$/,
		);
		// Atomic: the temporary file never survives the write.
		assert.deepEqual(readdirSync(run.dir).filter((name) => name.includes("tmp-")), []);
		assert.equal(run.status()?.state, "busy");
	} finally {
		temp.cleanup();
	}
});

test("the value answers for the snapshot, the inbox and the sentinel", async () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		assert.equal(run.snapshotPath(), join(run.dir, "usage.json"));
		assert.equal(run.snapshot(), undefined);
		assert.equal(run.pending(), 0);
		assert.equal(run.stopRequested(), false);

		assert.equal(await run.enqueue("hello"), 1);
		assert.equal(await run.enqueue("again"), 2);
		assert.equal(run.pending(), 2);

		mkdirSync(run.dir, { recursive: true });
		run.requestStop();
		assert.equal(run.stopRequested(), true);

		mkdirSync(run.sessionsDir(), { recursive: true });
		writeFileSync(join(run.sessionsDir(), "x.jsonl"), "");
		assert.equal(run.sessionsDir(), join(run.dir, "sessions"));
	} finally {
		temp.cleanup();
	}
});

test("a dir-built value reads the same artefacts", () => {
	const temp = tempEnv();
	try {
		const viaHandle = runDir("abc123", temp.env);
		mkdirSync(viaHandle.dir, { recursive: true });
		viaHandle.writeStatus({ state: "idle", turn: 3 });
		const viaDir = runDirFrom(runDirFor("abc123", temp.env));
		assert.equal(viaDir.status()?.state, "idle");
		assert.equal(viaDir.status()?.turn, 3);
	} finally {
		temp.cleanup();
	}
});

test("the surface is exactly the layout, so writes that take a handle stay out", () => {
	const temp = tempEnv();
	try {
		// Asserted as a surface rather than by symbol name: adding a record write
		// or an ownership claim here would let a dir-built value write a record
		// for a handle that lives somewhere else.
		assert.deepEqual(Object.keys(runDir("abc123", temp.env)).sort(), [
			"dir",
			"enqueue",
			"pending",
			"record",
			"requestStop",
			"sessionsDir",
			"snapshot",
			"snapshotPath",
			"status",
			"stopRequested",
			"writeStatus",
		]);
	} finally {
		temp.cleanup();
	}
});

test("a malformed status or record reads as absent, a malformed snapshot fails closed", () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		mkdirSync(run.dir, { recursive: true });
		writeFileSync(join(run.dir, "status.json"), "{not json", "utf8");
		writeFileSync(join(run.dir, "metadata.json"), "{not json", "utf8");
		writeFileSync(join(run.dir, "usage.json"), "{not json", "utf8");
		assert.equal(run.status(), undefined);
		assert.equal(run.record(), undefined);
		// A damaged snapshot must not look like "none yet": accounting would then
		// charge unknown history instead of failing closed.
		assert.throws(() => run.snapshot());
	} finally {
		temp.cleanup();
	}
});

test("asking a never-launched directory for a sentinel does not create it", () => {
	const temp = tempEnv();
	try {
		const dir = join(temp.dir, "never-launched");
		const run = runDirFrom(dir);
		assert.throws(() => run.requestStop());
		assert.equal(existsSync(dir), false, "a stop sentinel must not invent a run directory");
	} finally {
		temp.cleanup();
	}
});
