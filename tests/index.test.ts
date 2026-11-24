import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rexSubagent from "../src/index.ts";
import { removeRun, runDirFor, writeRecord, type RunRecord } from "../src/record.ts";
import { tempEnv } from "./helpers.ts";

function parentRun(handle: string, parentSessionId = "parent-1"): RunRecord {
	return {
		version: 1,
		handle,
		name: handle,
		group: "cleanup-test",
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

test("parent extension reconciles setup on session start and exposes manual setup", async () => {
	const fixture = tempEnv();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPath = process.env.PATH;
	const notifications: { message: string; level: string }[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Set<string>();
	let ctx!: ExtensionContext;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.env.PI_CODING_AGENT_DIR;
		process.env.PATH = `${join(fixture.dir, "agent", "bin")}:${fixture.env.PATH}`;
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
				commands.set(name, command);
			},
			registerTool(tool: { name: string }) {
				tools.add(tool.name);
			},
		} as unknown as ExtensionAPI;
		ctx = {
			sessionManager: { getSessionId: () => "parent-session" },
			ui: {
				setWidget() {},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext;

		rexSubagent(pi);
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(existsSync(join(fixture.dir, "agent", "bin", "rex-subagent")), true);
		assert.equal(commands.has("rex-subagent-setup"), true);
		assert.deepEqual([...tools].sort(), ["rex_adopt", "rex_observe", "rex_spawn", "rex_stop", "rex_wait"]);

		await commands.get("rex-subagent-setup")?.handler("", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /current|ready/i);
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		fixture.cleanup();
	}
});

test("parent settle returns idle children for a bounded cleanup decision", async () => {
	const fixture = tempEnv();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const ctx = {
		sessionManager: { getSessionId: () => "parent-1" },
	} as unknown as ExtensionContext;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.env.PI_CODING_AGENT_DIR;
		const pi = {
			on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		rexSubagent(pi);

		for (const [handle, state, parent] of [
			["child-a", "idle", "parent-1"],
			["child-b", "idle", "parent-1"],
			["child-c", "busy", "parent-1"],
			["other-parent", "idle", "parent-2"],
		] as const) {
			writeRecord(parentRun(handle, parent), fixture.env);
			writeFileSync(
				join(runDirFor(handle, fixture.env), "status.json"),
				JSON.stringify({ state, turn: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
			);
		}

		const settle = handlers.get("agent_before_settle");
		assert.ok(settle, "the parent must audit completed children before settling");
		const first = await settle({ entries: [] }, ctx);
		assert.equal(first.continue, true);
		assert.equal(first.entries.length, 1);
		assert.equal(first.entries[0].type, "custom_message");
		assert.equal(first.entries[0].display, false);
		assert.match(first.entries[0].content, /child-a/);
		assert.match(first.entries[0].content, /child-b/);
		assert.doesNotMatch(first.entries[0].content, /child-c/);
		assert.doesNotMatch(first.entries[0].content, /other-parent/);
		assert.match(first.entries[0].content, /rex_stop/);
		assert.match(first.entries[0].content, /"remove": true/);

		const repeated = await settle({ entries: [] }, ctx);
		assert.equal(repeated, undefined, "the same unfinished signature must not loop forever");

		removeRun("child-a", fixture.env);
		const remaining = await settle({ entries: [] }, ctx);
		assert.equal(remaining.continue, true, "partial cleanup returns the remaining handles to the parent");
		assert.doesNotMatch(remaining.entries[0].content, /child-a/);
		assert.match(remaining.entries[0].content, /child-b/);
		assert.equal(await settle({ entries: [] }, ctx), undefined);

		const beforeStart = handlers.get("before_agent_start");
		assert.ok(beforeStart);
		const prompt = {
			messageType: "user",
			systemPrompt: "base",
			systemPromptOptions: { sections: {}, promptGuidelines: [] },
		};
		await beforeStart(prompt, ctx);
		assert.match(JSON.stringify(prompt.systemPromptOptions), /rex_stop/);
		assert.match(JSON.stringify(prompt.systemPromptOptions), /idle/i);
		assert.equal((await settle({ entries: [] }, ctx)).continue, true, "a new user run gets one fresh cleanup audit");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fixture.cleanup();
	}
});
