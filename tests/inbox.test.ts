import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, writeFileSync as writeFile } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inboxDir, inboxEntries, inboxIndexes, inboxMessageNames, queueMessage } from "../src/inbox.ts";
import { runDirFor } from "../src/record.ts";
import { tempEnv } from "./helpers.ts";

function touch(runDir: string, name: string): void {
	mkdirSync(inboxDir(runDir), { recursive: true });
	writeFileSync(join(inboxDir(runDir), name), `${JSON.stringify({ message: name })}\n`);
}

test("only four-digit names are messages", () => {
	const temp = tempEnv();
	try {
		const runDir = runDirFor("abc123", temp.env);
		for (const name of ["0042.json", "0001.json", "7.json", "0009.json.bad", "notes.json", "README"]) {
			touch(runDir, name);
		}
		const entries = inboxEntries(runDir);
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
		const runDir = runDirFor("abc123", temp.env);
		for (const name of ["0001.json", "0010.json", "0002.json", "9.json", "0010.json.bad"]) {
			touch(runDir, name);
		}
		// One rule, so these cannot disagree: a name counted as pending is a name
		// the reader would hand over, and nothing else.
		assert.deepEqual(
			inboxIndexes(runDir),
			inboxMessageNames(runDir).map((name) => Number(name.slice(0, 4))),
		);
		assert.deepEqual(inboxIndexes(runDir), [1, 2, 10]);
	} finally {
		temp.cleanup();
	}
});

test("an absent inbox directory is empty rather than an error", () => {
	const temp = tempEnv();
	try {
		const runDir = runDirFor("abc123", temp.env);
		assert.deepEqual(inboxEntries(runDir), { messages: [], ignored: [] });
		assert.deepEqual(inboxIndexes(runDir), []);
	} finally {
		temp.cleanup();
	}
});

test("every queued message is a message by the reading rule", async () => {
	const temp = tempEnv();
	try {
		const runDir = runDirFor("abc123", temp.env);
		const indexes = [await queueMessage(runDir, "one"), await queueMessage(runDir, "two")];
		assert.deepEqual(indexes, [1, 2]);
		assert.deepEqual(inboxIndexes(runDir), indexes);
		assert.deepEqual(inboxEntries(runDir).ignored, []);
	} finally {
		temp.cleanup();
	}
});

test("an index past 9999 is still a message and still ordered last", async () => {
	const temp = tempEnv();
	try {
		const runDir = runDirFor("abc123", temp.env);
		mkdirSync(inboxDir(runDir), { recursive: true });
		// A long-lived run rolls 9999 into 10000; the writer pads to a minimum of
		// four digits, so the reader must keep consuming what it produces.
		writeFile(join(inboxDir(runDir), ".seq"), "9999", "utf8");
		writeFile(join(inboxDir(runDir), "9999.json"), `${JSON.stringify({ message: "last" })}\n`, "utf8");
		assert.equal(await queueMessage(runDir, "rollover"), 10000);
		assert.deepEqual(inboxMessageNames(runDir), ["9999.json", "10000.json"], "numeric order, not text order");
		assert.deepEqual(inboxIndexes(runDir), [9999, 10000]);
		assert.deepEqual(inboxEntries(runDir).ignored, []);
	} finally {
		temp.cleanup();
	}
});

test("an unreadable inbox surfaces instead of reading as empty", () => {
	const temp = tempEnv();
	try {
		const runDir = runDirFor("abc123", temp.env);
		mkdirSync(runDir, { recursive: true });
		// A file where the directory should be: any error except "absent" must
		// surface, because an empty answer lets a wait call a live run settled.
		writeFile(join(runDir, "inbox"), "", "utf8");
		assert.throws(() => inboxEntries(runDir), /ENOTDIR|ENOENT|EACCES|EEXIST/);
		assert.throws(() => inboxIndexes(runDir));
	} finally {
		temp.cleanup();
	}
});
