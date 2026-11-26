import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addWindow,
	createSession,
	defaultRunner,
	discoverRex,
	inspectBlock,
	listSessions,
	RexError,
	type CommandRunner,
	type LaunchedWindow,
	type RexLocation,
} from "./rex.ts";
import {
	ensureRunsRoot,
	newHandle,
	runDirFor,
	writeRecord,
	type ParentRexLocation,
	type RunRecord,
} from "./record.ts";
import { runTitle, sanitizeLabel, sessionLabel } from "./labels.ts";
import { runDir } from "./run-dir.ts";
import { shellQuote } from "./shell.ts";
import { SPAWN_SPEC, spawnRowsOfKind, type SpawnFieldsOfKind, type SpawnOption } from "./spawn-spec.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface SpawnOptions {
	name?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	theme?: string;
	cwd: string;
	prompts: string[];
	files: string[];
	tools?: string;
	excludeTools?: string;
	noExtensions?: boolean;
	noSkills?: boolean;
	noContextFiles?: boolean;
	noMcp?: boolean;
	piBinary?: string;
	group?: string;
	batch?: string;
	parentSessionId?: string;
	allowNested?: boolean;
	extraEnv?: Record<string, string>;
}

/**
 * The spawn options assembled through the declaration. Reading a row's kind and
 * flag is what fills this object, and the declaration's coverage check
 * guarantees every `SpawnOptions` field arrives.
 */
export function asSpawnOptions(values: Record<string, unknown>): SpawnOptions {
	return values as unknown as SpawnOptions;
}

export interface SpawnDeps {
	runner?: CommandRunner;
	env?: NodeJS.ProcessEnv;
}

export class UsageError extends Error {}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (isAbsolute(name)) return isExecutable(name) ? name : undefined;
	const entries = (env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
	for (const entry of entries) {
		const candidate = join(entry, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function buildMessage(prompts: string[], files: string[]): string {
	const parts = prompts.filter((part) => part.trim().length > 0);
	if (parts.length === 0 && files.length === 0) {
		throw new UsageError("spawn needs at least one --prompt or --file");
	}
	for (const file of files) {
		const path = resolve(file);
		if (!existsSync(path)) throw new UsageError(`prompt file not found: ${file}`);
		parts.push(`--- ${path} ---\n${readFileSync(path, "utf8")}`);
	}
	return parts.join("\n\n");
}

/** The `pi-flag` rows: the only spawn options that become child arguments. */
type PiFlagOptions = Partial<Pick<SpawnOptions, SpawnFieldsOfKind<"pi-flag">>>;

type ChildFlagRow = SpawnOption<SpawnFieldsOfKind<"pi-flag">>;

const childFlagRows: readonly ChildFlagRow[] = spawnRowsOfKind("pi-flag");

/** The run's own arguments, plus every `pi-flag` row that shapes the child. */
export type PiArgsOptions = {
	/** Which child extension runs, in which session directory, under which tab title. */
	runDir: string;
	handle: string;
	title: string;
	childExtension: string;
} & PiFlagOptions;

/**
 * A normal interactive Pi, so the user sees the agent's TUI in its tab. The
 * child extension is loaded explicitly and delivers messages from the inbox.
 */
export function buildPiArgs(options: PiArgsOptions): string[] {
	const theme = SPAWN_SPEC.theme;
	const args = [
		"-e",
		options.childExtension,
		"--session-dir",
		join(options.runDir, "sessions"),
		"--session-id",
		options.handle,
		"--name",
		options.title,
		// The theme closes the run's identity block: its declared default is always
		// sent, so the child never falls back to Pi's own theme.
		theme.childFlag,
		options.theme ?? theme.childDefault,
	];
	for (const row of childFlagRows) {
		// The theme row belongs to the identity block above: Pi receives it first,
		// and its declared default is always sent. The argv order stays as released.
		if (row.field === "theme") continue;
		args.push(...childFlagArgs(row, options));
	}
	return args;
}

/** The child arguments one `pi-flag` row contributes. */
function childFlagArgs(row: ChildFlagRow, options: PiFlagOptions): string[] {
	if (row.childFlag === undefined) return [];
	const value = options[row.field];
	if (typeof value === "boolean") return value ? [row.childFlag] : [];
	// Truthiness, not an undefined check: an empty value has always meant "the
	// caller did not set this", so it must not reach the child as `--model ""`.
	// The theme row is exempt: it is always sent from the identity block.
	const resolved = value || row.childDefault;
	return typeof resolved === "string" && resolved.length > 0 ? [row.childFlag, resolved] : [];
}

/** The `pi-flag` rows' values, taken straight from the spawn options. */
function childFlagValues(options: SpawnOptions): PiFlagOptions {
	const values: Record<string, unknown> = {};
	for (const row of childFlagRows) values[row.field] = options[row.field];
	return values as PiFlagOptions;
}

export interface ChildScriptOptions {
	piBinary: string;
	piArgs: string[];
	runDir: string;
	title: string;
	handle: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	extraEnv?: Record<string, string>;
}

/** Exports everything the child needs, then replaces the shell with the TUI. */
export function buildChildScript(options: ChildScriptOptions): string {
	const exports: string[] = [];
	for (const key of ["PATH", "HOME", "PI_CODING_AGENT_DIR"] as const) {
		const value = options.env[key];
		if (typeof value === "string" && value.length > 0) exports.push(`export ${key}=${shellQuote(value)}`);
	}
	for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
		exports.push(`export ${key}=${shellQuote(value)}`);
	}
	exports.push(`export REX_SUBAGENT_RUN_DIR=${shellQuote(options.runDir)}`);
	exports.push(`export REX_SUBAGENT_TITLE=${shellQuote(options.title)}`);
	exports.push(`export PI_REX_SUBAGENT_HANDLE=${shellQuote(options.handle)}`);
	exports.push("unset REX_SESSION REX_BLOCK REX_CLIENT");
	const argv = [options.piBinary, ...options.piArgs].map(shellQuote).join(" ");
	return `#!/bin/sh
# Generated by rex-subagent. Runs the child Pi TUI inside this Rex window.
set -u
${exports.join("\n")}
cd ${shellQuote(options.cwd)} || exit 1
exec ${argv}
`;
}

export interface BatchTarget {
	sessionId?: string;
	label: string;
}

export async function resolveBatch(
	location: RexLocation,
	options: Pick<SpawnOptions, "batch" | "group">,
	runner: CommandRunner,
): Promise<BatchTarget> {
	const group = options.group ?? SPAWN_SPEC.group.childDefault;
	const label = sessionLabel(group);
	const sessions = await listSessions(location, runner);
	if (options.batch) {
		if (options.batch.startsWith("session:")) {
			if (!sessions.some((session) => session.sessionId === options.batch)) {
				throw new UsageError(`Rex session ${options.batch} does not exist on this server`);
			}
			return { sessionId: options.batch, label };
		}
		const match = sessions.find((session) => session.label === options.batch);
		if (!match) throw new UsageError(`no Rex session labelled ${options.batch}`);
		return { sessionId: match.sessionId, label: options.batch };
	}
	const existing = sessions.find((session) => session.label === label);
	return { sessionId: existing?.sessionId, label };
}

/** Remember the parent's Rex tab so the child can offer a way back. */
export async function captureParentLocation(
	location: RexLocation,
	runner: CommandRunner,
	env: NodeJS.ProcessEnv,
): Promise<ParentRexLocation | undefined> {
	const sessionId = env.REX_SESSION;
	if (!sessionId) return undefined;
	const blockId = env.REX_BLOCK;
	let windowId: string | undefined;
	if (blockId) {
		try {
			windowId = await inspectBlock(location, sessionId, blockId, runner);
		} catch {
			// The parent tab is a convenience; never fail a spawn over it.
		}
	}
	const parent: ParentRexLocation = { sessionId };
	if (windowId) parent.windowId = windowId;
	if (blockId) parent.blockId = blockId;
	return parent;
}

export interface SpawnResult {
	handle: string;
	record: RunRecord;
	dir: string;
	reusedBatch: boolean;
}

/**
 * Siblings spawned concurrently into one group must be tabs of one session, but
 * `resolveBatch` lists sessions before any sibling has created theirs, so each
 * would create its own. The first launch publishes the session it resolves while
 * it is still in flight; siblings that arrive meanwhile join that session instead
 * of listing again. The entry is forgotten the moment the launch settles, so a
 * later spawn lists again and notices a session the user closed in between, and
 * a failed launch leaves nothing for its siblings to trust: a join that fails
 * looks again, so the waiters elect one new publisher among them instead of each
 * creating a session — but only when a listing answers without the session, which
 * is the one proof that no window of this run can exist. Every other failure,
 * including the `rex` CLI giving up after the server may have acted, fails the
 * run rather than launching a second Child. Keyed per runner like the location
 * cache, so tests with separate fake servers never share.
 */
const inFlightSessions = new WeakMap<CommandRunner, Map<string, Promise<string>>>();

function sessionShareKey(location: RexLocation, group: string): string {
	return `${location.endpoint}|${location.hostId}|${sessionLabel(group)}`;
}

function inFlightSessionId(runner: CommandRunner, key: string): Promise<string> | undefined {
	return inFlightSessions.get(runner)?.get(key);
}

function publishInFlightSessionId(runner: CommandRunner, key: string, sessionId: Promise<string>): void {
	let shares = inFlightSessions.get(runner);
	if (!shares) {
		shares = new Map();
		inFlightSessions.set(runner, shares);
	}
	shares.set(key, sessionId);
	const forget = () => {
		const current = inFlightSessions.get(runner);
		if (current?.get(key) === sessionId) current.delete(key);
	};
	sessionId.then(forget, forget);
}

export async function spawnRun(options: SpawnOptions, deps: SpawnDeps = {}): Promise<SpawnResult> {
	const env = deps.env ?? process.env;
	const runner = deps.runner ?? defaultRunner;
	const nested = env.PI_REX_SUBAGENT_HANDLE;
	if (nested && !options.allowNested) {
		throw new UsageError(
			`nested rex subagents are disabled (already inside ${nested}); pass --allow-nested only when recursion is intended`,
		);
	}
	const message = buildMessage(options.prompts, options.files);
	const cwd = resolve(options.cwd);
	if (!existsSync(cwd)) throw new UsageError(`cwd does not exist: ${cwd}`);
	const piBinary = options.piBinary
		? isAbsolute(options.piBinary)
			? options.piBinary
			: findExecutable(options.piBinary, env)
		: findExecutable("pi", env);
	if (!piBinary || !isExecutable(piBinary)) {
		throw new UsageError("pi executable not found; pass --pi /absolute/path/to/pi");
	}

	const location = await discoverRex(runner, env);
	const parentRex = await captureParentLocation(location, runner, env);
	ensureRunsRoot(env);
	let handle = newHandle();
	for (let attempt = 0; attempt < 5 && existsSync(runDirFor(handle, env)); attempt += 1) handle = newHandle();
	const run = runDir(handle, env);
	const dir = run.dir;
	mkdirSync(dir, { recursive: true });

	const name = sanitizeLabel(options.name ?? "");
	const title = runTitle({
		name: options.name,
		model: options.model,
		thinking: options.thinking,
		handle,
	});
	const ground = options.group ?? SPAWN_SPEC.group.childDefault;
	const createdAt = new Date().toISOString();
	const piArgs = buildPiArgs({
		runDir: dir,
		handle,
		title,
		childExtension: join(here, "child.ts"),
		...childFlagValues(options),
	});

	const childEnv: Record<string, string> = { ...(options.extraEnv ?? {}) };
	// `/back` shells out to the same Rex CLI this machine used to spawn the run.
	childEnv.REX_SUBAGENT_REX = findExecutable("rex", env) ?? "rex";
	const scriptPath = join(dir, "child.sh");
	writeFileSync(
		scriptPath,
		buildChildScript({
			piBinary,
			piArgs,
			runDir: dir,
			title,
			handle,
			cwd,
			env,
			extraEnv: childEnv,
		}),
		{ mode: 0o755 },
	);
	// Queue the first task before launch: the child delivers it on session start.
	await run.enqueue(message);

	const record: RunRecord = {
		version: 1,
		handle,
		name: name || title,
		title,
		group: ground,
		cwd,
		prompt: message,
		provider: options.provider,
		model: options.model,
		thinking: options.thinking,
		launchArgs: piArgs,
		parentSessionId: options.parentSessionId,
		parentRex,
		rex: { endpoint: location.endpoint, hostId: location.hostId, sessionId: "", windowId: "", blockId: "" },
		state: "starting",
		createdAt,
		updatedAt: createdAt,
	};
	writeRecord(record, env);

	try {
		const argv = ["/bin/sh", scriptPath];
		const window = { windowLabel: title, cwd, argv };
		const shareKey = options.batch ? undefined : sessionShareKey(location, ground);
		let launched: LaunchedWindow;
		let reusedBatch: boolean;
		// Reading the share and publishing one's own happen in one synchronous
		// stretch, so exactly one spawn per group becomes the publisher and every
		// other joins it. A join that fails looks again — another waiter may have
		// taken over as publisher, and otherwise this spawn lists and creates on its
		// own — but only once a listing has answered without the session. Each retry
		// follows a distinct failed launch or a session proved gone, so the loop
		// ends.
		for (;;) {
			const sibling = shareKey ? inFlightSessionId(runner, shareKey) : undefined;
			if (sibling) {
				const sessionId = await sibling.catch(() => undefined);
				if (sessionId) {
					try {
						launched = await addWindow(location, sessionId, window, runner);
						reusedBatch = true;
						break;
					} catch (error) {
						// A failed join is retried only when Rex proves the session gone:
						// a listing that answers without it. The error kind cannot prove
						// that — every nonzero `rex` exit is `failed`, including the CLI's
						// own 5 s timeout after the server may have created the window. In
						// every other case the window may exist, so the run fails instead
						// of launching a second Child under the same handle.
						if (!(error instanceof RexError)) throw error;
						const listed = await listSessions(location, runner).catch(() => undefined);
						if (listed && !listed.some((session) => session.sessionId === sessionId)) continue;
						throw error;
					}
				}
				continue;
			}
			const launch = (async () => {
				const batch = await resolveBatch(location, options, runner);
				const result = batch.sessionId
					? await addWindow(location, batch.sessionId, window, runner)
					: await createSession(location, { label: batch.label, ...window }, runner);
				return { reusedBatch: Boolean(batch.sessionId), result };
			})();
			if (shareKey) publishInFlightSessionId(runner, shareKey, launch.then((outcome) => outcome.result.sessionId));
			const outcome = await launch;
			launched = outcome.result;
			reusedBatch = outcome.reusedBatch;
			break;
		}
		const updated: RunRecord = {
			...record,
			rex: {
				endpoint: location.endpoint,
				hostId: location.hostId,
				sessionId: launched.sessionId,
				windowId: launched.windowId,
				blockId: launched.blockId,
			},
			state: "running",
			updatedAt: new Date().toISOString(),
		};
		writeRecord(updated, env);
		return { handle, record: updated, dir, reusedBatch };
	} catch (error) {
		const failed: RunRecord = {
			...record,
			state: "failed",
			error: error instanceof Error ? error.message : String(error),
			updatedAt: new Date().toISOString(),
		};
		writeRecord(failed, env);
		throw error;
	}
}
