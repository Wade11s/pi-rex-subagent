import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, writeFileSync as writeFile } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxDir, inboxEntries, inboxIndexes, inboxMessageNames, queueMessage } from "../src/inbox.ts";
import { runDir } from "../src/run-dir.ts";
import { tempEnv } from "./helpers.ts";

function touch(dir: string, name: string): void {
	mkdirSync(inboxDir(dir), { recursive: true });
	writeFileSync(join(inboxDir(dir), name), `${JSON.stringify({ message: name })}\n`);
}

test("only four-digit names are messages", () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		for (const name of ["0042.json", "0001.json", "7.json", "0009.json.bad", "notes.json", "README"]) {
			touch(run.dir, name);
		}
		const entries = inboxEntries(run.dir);
		assert.deepEqual(entries.messages, ["0001.json", "0042.json"]);
		// Parked and bookkeeping files are not entries to report: `.bad` was
		// reported when it was quarantined, and `.seq` is the writer's.
		assert.deepEqual(entries.ignored.sort(), ["7.json", "README", "notes.json"]);
	} finally {
		temp.cleanup();
	}
});

test("the pending count agrees with what will be delivered", () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		for (const name of ["0001.json", "0010.json", "0002.json", "9.json", "0010.json.bad"]) {
			touch(run.dir, name);
		}
		// One rule, so these cannot disagree: a name counted as pending is a name
		// the reader would hand over, and nothing else.
		assert.deepEqual(
			inboxIndexes(run.dir),
			inboxMessageNames(run.dir).map((name) => Number(name.slice(0, 4))),
		);
		assert.deepEqual(inboxIndexes(run.dir), [1, 2, 10]);
	} finally {
		temp.cleanup();
	}
});

test("an absent inbox directory is empty rather than an error", () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		assert.deepEqual(inboxEntries(run.dir), { messages: [], ignored: [] });
		assert.deepEqual(inboxIndexes(run.dir), []);
	} finally {
		temp.cleanup();
	}
});

test("every queued message is a message by the reading rule", async () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		const indexes = [await queueMessage(run.dir, "one"), await queueMessage(run.dir, "two")];
		assert.deepEqual(indexes, [1, 2]);
		assert.deepEqual(inboxIndexes(run.dir), indexes);
		assert.deepEqual(inboxEntries(run.dir).ignored, []);
	} finally {
		temp.cleanup();
	}
});

test("an index past 9999 is still a message and still ordered last", async () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		mkdirSync(inboxDir(run.dir), { recursive: true });
		// A long-lived run rolls 9999 into 10000; the writer pads to a minimum of
		// four digits, so the reader must keep consuming what it produces.
		writeFile(join(inboxDir(run.dir), ".seq"), "9999", "utf8");
		writeFile(join(inboxDir(run.dir), "9999.json"), `${JSON.stringify({ message: "last" })}\n`, "utf8");
		assert.equal(await queueMessage(run.dir, "rollover"), 10000);
		assert.deepEqual(inboxMessageNames(run.dir), ["9999.json", "10000.json"], "numeric order, not text order");
		assert.deepEqual(inboxIndexes(run.dir), [9999, 10000]);
		assert.deepEqual(inboxEntries(run.dir).ignored, []);
	} finally {
		temp.cleanup();
	}
});

test("an unreadable inbox surfaces instead of reading as empty", () => {
	const temp = tempEnv();
	try {
		const run = runDir("abc123", temp.env);
		mkdirSync(run.dir, { recursive: true });
		// A file where the directory should be: any error except "absent" must
		// surface, because an empty answer lets a wait call a live run settled.
		writeFile(join(run.dir, "inbox"), "", "utf8");
		assert.throws(() => inboxEntries(run.dir), /ENOTDIR|ENOENT|EACCES|EEXIST/);
		assert.throws(() => inboxIndexes(run.dir));
	} finally {
		temp.cleanup();
	}
});
