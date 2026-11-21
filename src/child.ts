import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readRecord, type Delivery } from "./record.ts";
import { publishUsageSnapshot } from "./usage.ts";

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
	let stopping = false;
	let finalUsagePublished = false;

	mkdirSync(inbox, { recursive: true });

	const publishUsage = (ctx: ExtensionContext, final = false): boolean => {
		try {
			const record = readRecord(handle);
			if (!record) {
				log(`usage ownership read failed for run ${handle || "unknown"}`);
				return false;
			}
			publishUsageSnapshot(ctx, runDir, handle, record.parentSessionId ?? null, final);
			if (final) finalUsagePublished = true;
			return true;
		} catch (error) {
			log(`usage snapshot write failed: ${String(error)}`);
			return false;
		}
	};

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

	const finalizeStop = (ctx: ExtensionContext): void => {
		if (finalUsagePublished) return;
		// Do not claim a clean stopped state before the final snapshot exists.
		// Shutdown still proceeds for safety; the parent retains records when
		// final accounting cannot be collected.
		if (publishUsage(ctx, true)) writeStatus("stopped");
		ctx.shutdown();
	};

	const tick = (): void => {
		const ctx = context;
		if (!ctx) return;
		if (existsSync(stopPath)) {
			if (stopping) return;
			stopping = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			// This early snapshot is useful if shutdown is forced, but it is not
			// final until the aborted turn and its tool results have settled.
			publishUsage(ctx);
			ctx.abort();
			if (ctx.isIdle()) finalizeStop(ctx);
			return;
		}
		drain(ctx);
	};

	const refuseNavigation = (ctx: ExtensionContext): { cancel: true } | undefined => {
		// Only a run with an accounting owner must keep one session branch.
		// A truly unowned CLI child keeps normal Pi navigation; adoption makes
		// later navigation refuse because the claimed cumulative stream would
		// otherwise change generation underneath the parent's cursor.
		const record = handle ? readRecord(handle) : undefined;
		if (!record) {
			ctx.ui.notify("Cannot verify this Rex run's accounting ownership; navigation is refused to fail closed", "warning");
			return { cancel: true };
		}
		if (!record.parentSessionId) return undefined;
		ctx.ui.notify("Managed Rex children keep one session branch for accounting; spawn a new run instead", "warning");
		return { cancel: true };
	};
	pi.on("session_before_switch", async (_event, ctx) => refuseNavigation(ctx));
	pi.on("session_before_fork", async (_event, ctx) => refuseNavigation(ctx));
	pi.on("session_before_tree", async (_event, ctx) => refuseNavigation(ctx));

	pi.registerCommand("back", {
		description: "Return to the Pi tab that spawned this subagent",
		handler: async (_args, ctx) => {
			const result = await returnToParent();
			ctx.ui.notify(result.message, result.ok ? "info" : "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		publishUsage(ctx);
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

	pi.on("turn_end", async (_event, ctx) => {
		context = ctx;
		publishUsage(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		context = ctx;
		if (stopping) {
			finalizeStop(ctx);
			return;
		}
		if (publishUsage(ctx)) {
			writeStatus("idle");
			drain(ctx);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		context = ctx;
		publishUsage(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		context = ctx;
		publishUsage(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!finalUsagePublished) publishUsage(ctx, event.reason === "quit");
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
