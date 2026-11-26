#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionDescriptor } from "node:util";
import { RexError } from "./rex.ts";
import { UsageError, asSpawnOptions, spawnRun, type SpawnOptions } from "./launch.ts";
import { SPAWN_OPTIONS, spawnHelp, spawnParseTable } from "./spawn-spec.ts";
import { reconcileSetup } from "./setup.ts";
import {
	LifecycleError,
	describeRun,
	doctor,
	listRuns,
	openRun,
	pruneRuns,
	readLog,
	sendMessage,
	stopRun,
	waitOutcomeOk,
	waitRuns,
	type RunView,
} from "./lifecycle.ts";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function version(): string {
	try {
		return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const HELP = `rex-subagent — Pi subagents as Rex windows

Usage:
  rex-subagent <command> [options]

Commands:
  spawn    Launch one agent window and queue its first message
  list     List known runs and their state
  status   Show one run in detail
  wait     Wait for runs to finish; --any returns on the first result
  send     Queue a message; --steer reaches the running turn
  logs     Print the run transcript
  open     Show a run in a connected Rex app
  stop     Stop runs and remove their Rex windows
  prune    Delete records whose Rex window is already gone
  doctor   Report the pinned Rex server, runs and installation health
  setup    Create or repair the managed rex-subagent CLI symlink

Spawn options:
${spawnHelp([{ flag: "json", label: "Machine-readable output" }])}

Other options:
  --any               wait: return settled/blocked/error results without waiting
                      for busy siblings; Rex events provide immediate wakeups
  --for <duration>    wait timeout, e.g. 30s, 5m, 2h (default: no limit)
  --tail <lines>      logs line limit (reads only the end of long sessions)
  --message <text>    send: message body, instead of positional text
  --steer             deliver into the running turn (default: auto)
  --follow-up         deliver after the current turn ends
  --remove            stop also deletes the run directory
  --kill-session      DANGER: stop kills the whole Rex session, taking every
                      sibling window in it down with the agent
  --client <id|label> open target app when several are connected
  --all               list runs from every parent session

wait resolves each handle as idle, stopped, exited (process ended; clean only
when it exited 0 after finishing its turns: idle, at least one turn, nothing
left queued), gone, failed, or timeout. With --any it can also return blocked
or error as soon as Rex reports them. A requested-but-unconfirmed stop shows
as stopping until the process really ends.

Exit codes: 0 ok, 1 failure or wait timeout, 2 usage, 3 Rex unavailable.
wait exits 0 only when every returned result settled cleanly (idle or stopped,
or exited 0 after finishing its turns). Default all mode returns every handle;
--any omits handles that are still pending. Blocked, error and timeout are not
success. A stop that could not be confirmed exits 1 and keeps the record so it
can be retried.
`;

class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

function parseDuration(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
	if (!match) throw new CliError(`invalid duration: ${value}`, 2);
	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return Math.round(amount * factor);
}

function printRun(run: RunView): string {
	const target =
		run.state === "busy" || run.state === "stopping"
			? "warning"
			: run.state === "idle"
				? "success"
				: run.state === "failed"
					? "error"
					: "muted";
	const model = [run.provider, run.model].filter(Boolean).join("/") || "parent model";
	const exit = run.processExitCode === null ? "-" : String(run.processExitCode);
	return `${run.handle}  ${run.name.padEnd(18)}  ${color(run.state.padEnd(8), target)}  ${model}  turn ${run.turn}  exit ${exit}`;
}

function color(text: string, kind: string): string {
	if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
	const code = kind === "success" ? 32 : kind === "warning" ? 33 : kind === "error" ? 31 : 90;
	return `\u001b[${code}m${text}\u001b[0m`;
}

async function commandSpawn(values: Record<string, unknown>): Promise<number> {
	const result = await spawnRun(spawnOptionsFromCli(values));
	if (values.json) {
		process.stdout.write(`${JSON.stringify({ handle: result.handle, sessionId: result.record.rex.sessionId, windowId: result.record.rex.windowId, blockId: result.record.rex.blockId, name: result.record.name, reusedBatch: result.reusedBatch })}\n`);
	} else {
		process.stdout.write(
			`spawned ${result.handle} (${result.record.name}) in Rex session ${result.record.rex.sessionId}\n` +
				`  window ${result.record.rex.windowId}\n` +
				`  wait:  rex-subagent wait ${result.handle} --for 10m\n` +
				`  send:  rex-subagent send ${result.handle} "follow-up"\n`,
		);
	}
	return 0;
}

async function commandList(values: Record<string, unknown>): Promise<number> {
	const runs = await listRuns({}, { parentSessionId: values.all ? undefined : process.env.PI_SESSION_ID });
	if (values.json) {
		process.stdout.write(`${JSON.stringify(runs.map(stripRun), null, 2)}\n`);
		return 0;
	}
	if (runs.length === 0) {
		process.stdout.write("No Rex subagents\n");
		return 0;
	}
	for (const run of runs) process.stdout.write(`${printRun(run)}\n`);
	return 0;
}

async function commandStatus(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	const handle = requireHandle(positionals);
	const run = await describeRun(handle);
	if (values.json) {
		process.stdout.write(`${JSON.stringify({ ...stripRun(run), detail: run.detail, error: run.error, stopError: run.stopError }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${printRun(run)}\n`);
	process.stdout.write(`  cwd      ${run.cwd}\n`);
	process.stdout.write(`  session  ${run.sessionId || "-"}\n`);
	process.stdout.write(`  window   ${run.windowId || "-"}\n`);
	process.stdout.write(`  block    ${run.blockId || "-"}\n`);
	process.stdout.write(`  group    ${run.group}\n`);
	if (run.error) process.stdout.write(`  error    ${run.error}\n`);
	if (run.stopError) process.stdout.write(`  stop     unconfirmed: ${run.stopError}\n`);
	if (run.detail) process.stdout.write(`  detail   ${run.detail}\n`);
	return 0;
}

async function commandWait(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	if (positionals.length === 0) throw new CliError("wait needs at least one handle", 2);
	const timeoutMs = parseDuration(asString(values.for));
	const results = await waitRuns(positionals, { timeoutMs, mode: values.any === true ? "any" : "all" });
	if (values.json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	} else {
		for (const result of results) {
			process.stdout.write(
				`${result.handle}  ${result.outcome.padEnd(8)}  turn ${result.turn}  exit ${result.processExitCode ?? "-"}${result.outcome === "exited" && result.agentState === "busy" ? " (died mid-turn)" : ""}${result.pendingMessages ? ` (${result.pendingMessages} undelivered)` : ""}${result.detail ? ` (${result.detail})` : ""}\n`,
			);
		}
	}
	return results.every(waitOutcomeOk) ? 0 : 1;
}

async function commandSend(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	const handle = positionals[0];
	if (!handle) throw new CliError("send needs a handle", 2);
	const message = [...positionals.slice(1)].join(" ") || asString(values.message);
	if (!message) throw new CliError('send needs a message: rex-subagent send <handle> "text"', 2);
	const delivery = values.steer === true ? "steer" : values["follow-up"] === true ? "followUp" : "auto";
	const result = await sendMessage(handle, message, { delivery });
	if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
	else
		process.stdout.write(
			`queued message ${result.message}${result.queuedBehindRunningTurn ? " (after the running turn)" : ""}${result.unconfirmed ? " (Rex unreachable; will deliver only if the agent is alive)" : ""}\n`,
		);
	return 0;
}

async function commandLogs(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	const handle = requireHandle(positionals);
	const text = readLog(handle, { tail: values.tail ? Number(values.tail) : undefined });
	process.stdout.write(text.endsWith("\n") || text.length === 0 ? text : `${text}\n`);
	return 0;
}

async function commandStop(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	if (positionals.length === 0) throw new CliError("stop needs at least one handle", 2);
	const results = [];
	for (const handle of positionals) {
		results.push(
			await stopRun(handle, {
				remove: values.remove === true,
				killSession: values["kill-session"] === true,
			}),
		);
	}
	if (values.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	else
		for (const result of results) {
			process.stdout.write(
				`${result.handle}  ${result.stopped ? "stopped" : "stop unconfirmed (record kept; retry the stop)"}${result.removed ? "  (record removed)" : ""}${result.detail ? `  ${result.detail}` : ""}\n`,
			);
		}
	return results.every((result) => result.stopped) ? 0 : 1;
}

async function commandOpen(values: Record<string, unknown>, positionals: string[]): Promise<number> {
	const handle = requireHandle(positionals);
	const result = await openRun(handle, { clientId: asString(values.client) });
	if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
	else process.stdout.write(`showed ${handle} in ${result.clientId}\n`);
	return 0;
}

async function commandPrune(values: Record<string, unknown>): Promise<number> {
	const result = await pruneRuns();
	if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
	else process.stdout.write(`removed ${result.removed.length}, kept ${result.kept}\n`);
	return 0;
}

async function commandSetup(values: Record<string, unknown>): Promise<number> {
	const report = await reconcileSetup({ repair: true });
	if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else process.stdout.write(`${report.message}\n`);
	return report.ok ? 0 : 1;
}

async function commandDoctor(values: Record<string, unknown>): Promise<number> {
	const report = await doctor();
	if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else {
		process.stdout.write(`endpoint  ${report.endpoint}\n`);
		process.stdout.write(`host      ${report.hostId}\n`);
		process.stdout.write(`version   ${report.version ?? "-"}\n`);
		process.stdout.write(`sessions  ${report.sessions}\n`);
		process.stdout.write(`apps      ${report.apps.join(", ") || "none connected"}\n`);
		process.stdout.write(`runs      ${report.runs}\n`);
		process.stdout.write(`setup     ${report.setup.status}: ${report.setup.message}\n`);
	}
	return 0;
}

function stripRun(run: RunView): Record<string, unknown> {
	return {
		handle: run.handle,
		name: run.name,
		group: run.group,
		state: run.state,
		agentState: run.agentState,
		processState: run.processState,
		processExitCode: run.processExitCode,
		turn: run.turn,
		provider: run.provider,
		model: run.model,
		thinking: run.thinking,
		cwd: run.cwd,
		sessionId: run.sessionId,
		windowId: run.windowId,
		blockId: run.blockId,
	};
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const pair of pairs) {
		const index = pair.indexOf("=");
		if (index <= 0) throw new CliError(`--env expects KEY=VALUE, got ${pair}`, 2);
		env[pair.slice(0, index)] = pair.slice(index + 1);
	}
	return env;
}

/**
 * The spawn options the CLI parsed, read through the declaration: a row's flag
 * selects the value, its kind says how to read it, a row without a value
 * placeholder is a switch, and a row without a flag comes from the environment.
 * The loop covers every `SpawnOptions` field, which the declaration's coverage
 * check guarantees.
 */
function spawnOptionsFromCli(values: Record<string, unknown>): SpawnOptions {
	const options: Record<string, unknown> = {};
	for (const row of SPAWN_OPTIONS) {
		const flag = row.flag;
		if (flag === undefined) {
			if (row.env !== undefined) options[row.field] = process.env[row.env];
			continue;
		}
		const value = values[flag];
		if (row.kind === "message") options[row.field] = asStrings(value);
		else if (row.kind === "env") options[row.field] = parseEnvPairs(asStrings(value));
		else options[row.field] = row.arg === undefined ? value === true : asString(value);
	}
	options.cwd ??= process.cwd();
	return asSpawnOptions(options);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
}

function requireHandle(positionals: string[]): string {
	const handle = positionals[0];
	if (!handle) throw new CliError("missing handle", 2);
	return handle;
}

const OPTIONS: Record<string, ParseArgsOptionDescriptor> = {
	...spawnParseTable(),
	json: { type: "boolean" },
	all: { type: "boolean" },
	any: { type: "boolean" },
	for: { type: "string" },
	tail: { type: "string" },
	remove: { type: "boolean" },
	"kill-session": { type: "boolean" },
	client: { type: "string" },
	message: { type: "string" },
	steer: { type: "boolean" },
	"follow-up": { type: "boolean" },
	help: { type: "boolean" },
	version: { type: "boolean" },
};

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP);
		return 0;
	}
	if (command === "version" || command === "--version") {
		process.stdout.write(`rex-subagent ${version()}\n`);
		return 0;
	}
	let parsed: { values: Record<string, unknown>; positionals: string[] };
	try {
		parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true }) as {
			values: Record<string, unknown>;
			positionals: string[];
		};
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), 2);
	}
	if (parsed.values.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const { values, positionals } = parsed;
	switch (command) {
		case "spawn":
			return commandSpawn(values);
		case "list":
			return commandList(values);
		case "status":
			return commandStatus(values, positionals);
		case "wait":
			return commandWait(values, positionals);
		case "send":
			return commandSend(values, positionals);
		case "logs":
			return commandLogs(values, positionals);
		case "stop":
			return commandStop(values, positionals);
		case "open":
			return commandOpen(values, positionals);
		case "prune":
			return commandPrune(values);
		case "doctor":
			return commandDoctor(values);
		case "setup":
			return commandSetup(values);
		default:
			throw new CliError(`unknown command: ${command}\n\n${HELP}`, 2);
	}
}

try {
	const code = await main(process.argv.slice(2));
	process.exitCode = code;
} catch (error) {
	if (error instanceof CliError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = error.exitCode;
	} else if (error instanceof UsageError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
	} else if (error instanceof RexError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = error.kind === "unavailable" ? 3 : 1;
	} else if (error instanceof LifecycleError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} else {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	}
}

	export {};
