import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAccountingTools } from "./accounting-tools.ts";
import { describeRun, listRuns, openRun } from "./lifecycle.ts";
import type { RunView } from "./lifecycle.ts";
import { reconcileSetup } from "./setup.ts";

const WIDGET_KEY = "rex-subagents";
const REFRESH_MS = 2000;
const PARENT_CLEANUP_POLICY =
	"For Rex subagents, an idle rex_wait result is not a closed Tab. Before finishing, read and verify every completed child's result, " +
	"then call rex_stop with remove:true for each handle unless a concrete upcoming follow-up requires retaining that idle agent. " +
	"Never leave completed Tabs running merely because their results were collected.";

function summary(run: RunView): string {
	const model = run.model ?? "parent model";
	return `${run.name}:${run.state} (${model}, turn ${run.turn})`;
}

function stateColor(state: RunView["state"]): "warning" | "success" | "error" | "muted" {
	if (state === "busy" || state === "stopping") return "warning";
	if (state === "idle") return "success";
	if (state === "failed") return "error";
	return "muted";
}

function shortState(run: RunView): string {
	return `${run.name}:${run.state}`;
}

export default function rexSubagent(pi: ExtensionAPI): void {
	registerAccountingTools(pi);
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetContext: ExtensionContext | undefined;
	let refreshing = false;
	let cleanupReminderSignature: string | undefined;

	// Keep the lifecycle rule visible even when a model reads only part of the
	// skill. A new prompt also earns one fresh cleanup audit at settle time.
	pi.on("before_agent_start", (event) => {
		cleanupReminderSignature = undefined;
		event.systemPromptOptions.sections.rex_subagent_cleanup = PARENT_CLEANUP_POLICY;
	});

	// Completion is pull-based, so a parent can otherwise report its result and
	// settle while every completed child remains alive. Return those children to
	// the parent for an explicit remove/retain decision. The signature guard
	// permits progress after partial cleanup but prevents a no-op infinite loop.
	pi.on("agent_before_settle", async (event, ctx) => {
		const runs = await listRuns({}, { parentSessionId: ctx.sessionManager.getSessionId() }, { probe: false });
		const completed = runs.filter((run) => run.state === "idle" && run.turn > 0);
		if (completed.length === 0) {
			cleanupReminderSignature = undefined;
			return;
		}
		const signature = completed.map((run) => `${run.handle}:${run.turn}`).sort().join("|");
		if (signature === cleanupReminderSignature) return;
		cleanupReminderSignature = signature;
		const actions = completed
			.map((run) => `- ${run.handle} (${run.name}, turn ${run.turn}): rex_stop { "handle": "${run.handle}", "remove": true }`)
			.join("\n");
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "rex-subagent-cleanup",
					content:
						"Before settling, make an explicit cleanup decision for every completed Rex subagent below. " +
						"For each one, read and verify its complete result if you have not already, then execute the listed rex_stop action. " +
						"Retain an idle Tab only for a concrete upcoming follow-up; if you retain one, state that reason. " +
						"Do not merely repeat your previous response.\n" +
						actions,
					display: false,
				},
			],
			continue: true,
		};
	});

	const refreshWidget = async (): Promise<void> => {
		const ctx = widgetContext;
		if (!ctx || refreshing) return;
		refreshing = true;
		try {
			// The widget must not run a Rex probe per run on every tick.
			const runs = await listRuns({}, { parentSessionId: ctx.sessionManager.getSessionId() }, { probe: false });
			const active = runs.filter((run) => run.state === "busy" || run.state === "idle" || run.state === "starting");
			if (ctx !== widgetContext) return;
			if (active.length === 0) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const visible = active.slice(0, 5).map((run) => ctx.ui.theme.fg(stateColor(run.state), shortState(run)));
			if (active.length > visible.length) visible.push(ctx.ui.theme.fg("muted", `+${active.length - visible.length}`));
			ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg("dim", "rex agents: ") + visible.join(ctx.ui.theme.fg("dim", " | "))], {
				placement: "belowEditor",
			});
		} catch {
			// Probing failures belong to /rex-agents output, never to the widget loop.
		} finally {
			refreshing = false;
		}
	};

	pi.registerCommand("rex-subagent-setup", {
		description: "Check or repair the managed rex-subagent CLI symlink",
		handler: async (_args, ctx) => {
			try {
				const report = await reconcileSetup({ repair: true });
				ctx.ui.notify(report.message, report.ok ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("rex-agents", {
		description: "Inspect Rex subagents and show one in the Rex app",
		handler: async (args, ctx) => {
			const all = args.trim() === "all";
			const runs = await listRuns({}, { parentSessionId: all ? undefined : ctx.sessionManager.getSessionId() });
			if (runs.length === 0) {
				ctx.ui.notify(`No Rex subagents${all ? "" : " for this session"}. Spawn with: rex-subagent spawn --prompt "..."`, "info");
				return;
			}
			const labels = runs.map((run) => `${summary(run)}  ${run.handle}`);
			const choice = await ctx.ui.select("Rex subagents", labels);
			if (!choice) return;
			const index = labels.indexOf(choice);
			const run = runs[index];
			if (!run) return;
			try {
				await openRun(run.handle);
				ctx.ui.notify(`Showed ${run.name} in Rex`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("rex-agent-status", {
		description: "Print the state of one Rex subagent",
		handler: async (args, ctx) => {
			const handle = args.trim().split(/\s+/)[0];
			if (!handle) {
				ctx.ui.notify("Usage: /rex-agent-status <handle>", "warning");
				return;
			}
			try {
				const run = await describeRun(handle);
				ctx.ui.notify(`${summary(run)}  cwd=${run.cwd}`, run.state === "failed" ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		widgetContext = ctx;
		try {
			const setup = await reconcileSetup({ repair: true });
			if (setup.changed || !setup.ok) ctx.ui.notify(`rex-subagent setup: ${setup.message}`, setup.ok ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(`rex-subagent setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		await refreshWidget();
		timer = setInterval(() => void refreshWidget(), REFRESH_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		widgetContext = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
