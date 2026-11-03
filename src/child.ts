import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readRecord, type Delivery } from "./record.ts";

const exec = promisify(execFile);

export type DeliveryMethod = "prompt" | "steer" | "followUp";

/**
 * The child is a normal interactive Pi. When it is idle a queued message starts
 * a turn; while it runs, the message uses the same `deliverAs` semantics the
 * tmux subagent uses.
 */
export function planDelivery(idle: boolean, delivery: Delivery): DeliveryMethod {
	if (idle) return "prompt";
	return delivery === "followUp" ? "followUp" : "steer";
}

interface InboxMessage {
	message: string;
	delivery: Delivery;
}

function parseInbox(path: string): InboxMessage | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		const message = typeof record.message === "string" ? record.message : "";
		if (message.length === 0) return undefined;
		const delivery: Delivery =
			record.delivery === "steer" || record.delivery === "followUp" ? record.delivery : "auto";
		return { message, delivery };
	} catch {
		return undefined;
	}
}

/**
 * Child-side half of a rex subagent. It is inert unless the parent set
 * REX_SUBAGENT_RUN_DIR, so loading it in an ordinary Pi session does nothing.
 *
 * Pi's own OSC 7501 reporting is left untouched: Rex decides how to present
 * working/done/blocked according to its Program Activity settings.
 */
export default function rexSubagentChild(pi: ExtensionAPI): void {
	const runDir = process.env.REX_SUBAGENT_RUN_DIR;
	if (!runDir) return;

	const inbox = join(runDir, "inbox");
	const statusPath = join(runDir, "status.json");
	const stopPath = join(runDir, "stop");
	const errorLog = join(runDir, "child.err.log");
	const handle = process.env.PI_REX_SUBAGENT_HANDLE ?? "";
	const rexBinary = process.env.REX_SUBAGENT_REX ?? "rex";
	let turn = 0;
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let delivering = false;

	mkdirSync(inbox, { recursive: true });

	const log = (line: string): void => {
		try {
			appendFileSync(errorLog, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Diagnostics must not disturb the TUI.
		}
	};

	const writeStatus = (state: "starting" | "busy" | "idle" | "stopped"): void => {
		// No exit code here: a settled turn says nothing about the OS process.
		// The real exit code comes from the Rex probe once the process ends.
		const payload = { state, turn, updatedAt: new Date().toISOString(), transport: "tui" };
		try {
			const temporary = `${statusPath}.tmp-${process.pid}`;
			writeFileSync(temporary, `${JSON.stringify(payload)}\n`);
			renameSync(temporary, statusPath);
		} catch (error) {
			log(`status write failed: ${String(error)}`);
		}
	};

	/** Ask a connected Rex app to show the tab this child was spawned from. */
	const returnToParent = async (): Promise<{ ok: boolean; message: string }> => {
		const record = handle ? readRecord(handle) : undefined;
		const parent = record?.parentRex;
		if (!record || !parent) {
			return {
				ok: false,
				message: "this subagent was not spawned from a Rex tab, so there is no parent tab to return to",
			};
		}
		const base = ["-S", record.rex.endpoint, "--autostart=false", "--timeout", "5s"];
		const apps: { clientId: string; label: string }[] = [];
		try {
			const { stdout } = await exec(rexBinary, [...base, "client", "ls", "--json"], { timeout: 10_000 });
			const parsed = JSON.parse(stdout) as { clients?: { client_id?: string; info?: { kind?: string; label?: string } }[] };
			for (const client of parsed.clients ?? []) {
				if (!client.client_id || client.info?.kind !== "app") continue;
				apps.push({ clientId: client.client_id, label: client.info.label ?? client.client_id });
			}
		} catch (error) {
			return { ok: false, message: `could not list Rex apps: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (apps.length === 0) return { ok: false, message: "no Rex app is connected; open Rex, then try again" };
		const only = apps[0];
		if (!only) return { ok: false, message: "no Rex app is connected; open Rex, then try again" };
		if (apps.length > 1) {
			return {
				ok: false,
				message: `multiple Rex apps are connected (${apps.map((app) => app.label).join(", ")}); use rex-subagent open --client from the CLI`,
			};
		}
		const args = [
			...base,
			"-C",
			only.clientId,
			"do",
			"session.select",
			`session_id=${parent.sessionId}`,
			...(parent.windowId ? [`window_id=${parent.windowId}`] : []),
		];
		try {
			await exec(rexBinary, args, { timeout: 10_000 });
			return { ok: true, message: "returned to the parent tab" };
		} catch (error) {
			return { ok: false, message: `returning failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};

	const deliver = (ctx: ExtensionContext, entry: InboxMessage): boolean => {
		const method = planDelivery(ctx.isIdle(), entry.delivery);
		try {
			if (method === "prompt") pi.sendUserMessage(entry.message);
			else pi.sendUserMessage(entry.message, { deliverAs: method });
			turn += 1;
			// A delivered prompt starts a run and a steer joins one; both are busy.
			writeStatus("busy");
			return true;
		} catch (error) {
			log(`delivery failed: ${String(error)}`);
			return false;
		}
	};

	const drain = (ctx: ExtensionContext): void => {
		if (delivering) return;
		delivering = true;
		try {
			let names: string[];
			try {
				names = readdirSync(inbox)
					.filter((name) => name.endsWith(".json"))
					.sort();
			} catch {
				return;
			}
			for (const name of names) {
				const path = join(inbox, name);
				const entry = parseInbox(path);
				if (!entry) {
					renameSync(path, `${path}.bad`);
					log(`unreadable inbox message ${name}`);
					continue;
				}
				if (!deliver(ctx, entry)) return;
				unlinkSync(path);
			}
		} finally {
			delivering = false;
		}
	};

	const tick = (): void => {
		const ctx = context;
		if (!ctx) return;
		if (existsSync(stopPath)) {
			writeStatus("stopped");
			if (timer) clearInterval(timer);
			timer = undefined;
			ctx.abort();
			// The sentinel ends the whole run, not just the turn: leave the TUI so
			// the Rex probe can observe the real process exit. The grace lets the
			// status rename and abort settle first.
			const exitTimer = setTimeout(() => process.exit(0), 150);
			if (typeof exitTimer.unref === "function") exitTimer.unref();
			return;
		}
		drain(ctx);
	};

	pi.registerCommand("back", {
		description: "Return to the Pi tab that spawned this subagent",
		handler: async (_args, ctx) => {
			const result = await returnToParent();
			ctx.ui.notify(result.message, result.ok ? "info" : "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		writeStatus("starting");
		if (!timer) {
			timer = setInterval(tick, 200);
			if (typeof timer.unref === "function") timer.unref();
		}
		// Let the TUI finish initializing before the first turn starts.
		setTimeout(() => {
			if (context === ctx) drain(ctx);
		}, 500);
	});

	pi.on("agent_start", async (_event, ctx) => {
		context = ctx;
		writeStatus("busy");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		context = ctx;
		writeStatus("idle");
		drain(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
