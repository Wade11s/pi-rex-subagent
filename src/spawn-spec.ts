import type { ParseArgsOptionDescriptor } from "node:util";
import type { SpawnOptions } from "./launch.ts";

/**
 * One declaration per child-launch option: the flag the CLI accepts, the flag
 * Pi receives, the help label, the value kind, whether it repeats, the value it
 * takes when unspecified, and the surfaces that expose it.
 *
 * Everything that used to restate this list derives from it: the child argument
 * builder, the CLI's `parseArgs` table and its value mapping, the help text's
 * spawn section, and the `rex_spawn` schema.
 */

/** Where a row's value goes. Only `pi-flag` rows become child arguments. */
export type SpawnKind =
	| "pi-flag" // a child Pi argument
	| "message" // prompt text
	| "env" // a shell export
	| "identity" // argv[0] or a record field
	| "session" // Rex placement
	| "guard"; // the nesting guard

/** A surface that exposes spawn options. */
export type SpawnSurface = "cli" | "tool";

export interface SpawnOptionRow {
	readonly kind: SpawnKind;
	/** The CLI flag, without the leading `--`, and the key `parseArgs` reports. */
	readonly flag?: string;
	/** Pi's flag. Only `pi-flag` rows declare one, and the names need not match. */
	readonly childFlag?: string;
	/**
	 * The placeholder the help text prints after the flag, punctuation included
	 * (`<text>`, `KEY=VALUE`). Its presence means the flag takes a value; without
	 * one the flag is a switch.
	 */
	readonly arg?: string;
	/** The flag may be given more than once and the value is a list. */
	readonly multiple?: boolean;
	/**
	 * The value the option really takes when unspecified. Code reads it: the
	 * child argument builder sends it, the spawn path falls back to it. The help
	 * text prints it too.
	 */
	readonly childDefault?: string;
	/**
	 * A default the help text prints that no code applies, because the value is
	 * computed at run time: a composed title, the process's working directory, a
	 * binary resolved on PATH. Never read it as a value.
	 */
	readonly helpDefault?: string;
	/** The environment variable that supplies the value when no flag does. */
	readonly env?: string;
	/** The row's help text, before the parenthetical. */
	readonly label: string;
	/** Clarifies the parenthetical's value: `(default: dark; system follows Rex)`. */
	readonly note?: string;
	/** A further clause after the parenthetical: `(repeatable); the child ...`. */
	readonly detail?: string;
	/** Parameter name in the `rex_spawn` schema when it differs from the field. */
	readonly toolName?: string;
	/** The `rex_spawn` schema requires this parameter. */
	readonly required?: true;
	readonly surfaces: readonly SpawnSurface[];
}

/**
 * The declaration, keyed by the `SpawnOptions` field each row fills, in the
 * order the help text and the child arguments present them. The order is
 * deliberate: `pi-flag` rows appear in the order Pi receives their flags.
 *
 * `Required` makes the declaration complete: a `SpawnOptions` field without a
 * row, or a row for no field, fails typecheck, so no option can be restated
 * outside this table.
 */
export const SPAWN_SPEC = {
	name: {
		kind: "identity",
		flag: "name",
		arg: "<text>",
		helpDefault: "model",
		label: "Display name",
		surfaces: ["cli", "tool"],
	},
	provider: {
		kind: "pi-flag",
		flag: "provider",
		arg: "<name>",
		childFlag: "--provider",
		label: "Pi provider for the child",
		surfaces: ["cli", "tool"],
	},
	model: {
		kind: "pi-flag",
		flag: "model",
		arg: "<pattern>",
		childFlag: "--model",
		label: "Pi model for the child",
		surfaces: ["cli", "tool"],
	},
	thinking: {
		kind: "pi-flag",
		flag: "thinking",
		arg: "<level>",
		childFlag: "--thinking",
		label: "off|minimal|low|medium|high|xhigh|max",
		surfaces: ["cli", "tool"],
	},
	theme: {
		kind: "pi-flag",
		flag: "theme",
		arg: "<name>",
		childFlag: "--use-theme",
		childDefault: "dark",
		label: "Child Pi theme",
		note: "system follows Rex",
		surfaces: ["cli", "tool"],
	},
	cwd: {
		kind: "identity",
		flag: "cwd",
		arg: "<dir>",
		helpDefault: "current",
		label: "Working directory",
		surfaces: ["cli", "tool"],
	},
	prompts: {
		kind: "message",
		flag: "prompt",
		arg: "<text>",
		multiple: true,
		label: "Message to queue",
		toolName: "prompt",
		required: true,
		surfaces: ["cli", "tool"],
	},
	files: {
		kind: "message",
		flag: "file",
		arg: "<path>",
		multiple: true,
		label: "Append a file to the message",
		surfaces: ["cli"],
	},
	extraEnv: {
		kind: "env",
		flag: "env",
		arg: "KEY=VALUE",
		multiple: true,
		label: "Extra env var for the child",
		detail: "the child inherits only PATH, HOME and PI_CODING_AGENT_DIR",
		surfaces: ["cli"],
	},
	tools: {
		kind: "pi-flag",
		flag: "tools",
		arg: "<list>",
		childFlag: "--tools",
		label: "Pi --tools allowlist",
		surfaces: ["cli", "tool"],
	},
	excludeTools: {
		kind: "pi-flag",
		flag: "exclude-tools",
		arg: "<list>",
		childFlag: "--exclude-tools",
		label: "Pi --exclude-tools denylist",
		surfaces: ["cli", "tool"],
	},
	noExtensions: {
		kind: "pi-flag",
		flag: "no-extensions",
		childFlag: "--no-extensions",
		label: "Child starts without extensions",
		surfaces: ["cli"],
	},
	noSkills: {
		kind: "pi-flag",
		flag: "no-skills",
		childFlag: "--no-skills",
		label: "Child starts without skills",
		surfaces: ["cli"],
	},
	noContextFiles: {
		kind: "pi-flag",
		flag: "no-context-files",
		childFlag: "--no-context-files",
		label: "Child ignores AGENTS.md / CLAUDE.md",
		surfaces: ["cli"],
	},
	noMcp: {
		kind: "pi-flag",
		flag: "no-mcp",
		childFlag: "--no-mcp",
		label: "Child starts without MCP servers",
		surfaces: ["cli"],
	},
	group: {
		kind: "session",
		flag: "group",
		arg: "<label>",
		childDefault: "subagents",
		label: "Shared session group",
		surfaces: ["cli", "tool"],
	},
	batch: {
		kind: "session",
		flag: "batch",
		arg: "<session|label>",
		label: "Attach to an existing Rex session",
		surfaces: ["cli", "tool"],
	},
	piBinary: {
		kind: "identity",
		flag: "pi",
		arg: "<path>",
		helpDefault: "pi on PATH",
		label: "Pi executable",
		surfaces: ["cli"],
	},
	allowNested: {
		kind: "guard",
		flag: "allow-nested",
		label: "Permit spawning from inside a subagent",
		surfaces: ["cli", "tool"],
	},
	parentSessionId: {
		kind: "identity",
		env: "PI_SESSION_ID",
		label: "Parent session that owns the run",
		surfaces: ["cli"],
	},
} as const satisfies Required<{ [Field in keyof SpawnOptions]: SpawnOptionRow }>;

/** The `SpawnOptions` field a row fills; also the row's key in `SPAWN_SPEC`. */
export type SpawnField = keyof typeof SPAWN_SPEC;

/** The fields owned by rows of one kind. */
export type SpawnFieldsOfKind<Kind extends SpawnKind> = {
	[Field in SpawnField]: (typeof SPAWN_SPEC)[Field]["kind"] extends Kind ? Field : never;
}[SpawnField];

export interface SpawnOption<Field extends SpawnField = SpawnField> extends SpawnOptionRow {
	readonly field: Field;
}

/** Every row, in declaration order. */
export const SPAWN_OPTIONS: readonly SpawnOption[] = (Object.keys(SPAWN_SPEC) as SpawnField[]).map((field) => ({
	field,
	...SPAWN_SPEC[field],
}));

/** The rows a surface exposes, in declaration order. */
export function spawnRowsFor(surface: SpawnSurface): SpawnOption[] {
	return SPAWN_OPTIONS.filter((row) => row.surfaces.includes(surface));
}

/**
 * The rows of one kind, in declaration order. The cast states what the data
 * guarantees and the type cannot follow through the array: a row's kind decides
 * its field.
 */
export function spawnRowsOfKind<Kind extends SpawnKind>(kind: Kind): SpawnOption<SpawnFieldsOfKind<Kind>>[] {
	return SPAWN_OPTIONS.filter((row) => row.kind === kind) as SpawnOption<SpawnFieldsOfKind<Kind>>[];
}

/** `parseArgs` descriptors for every row the CLI parses. */
export function spawnParseTable(): Record<string, ParseArgsOptionDescriptor> {
	const table: Record<string, ParseArgsOptionDescriptor> = {};
	for (const row of SPAWN_OPTIONS) {
		if (row.flag === undefined) continue;
		table[row.flag] = row.arg === undefined ? { type: "boolean" } : row.multiple ? { type: "string", multiple: true } : { type: "string" };
	}
	return table;
}

/** A help line the CLI adds to the spawn section without it being a spawn option. */
export interface SpawnHelpLine {
	readonly flag: string;
	readonly label: string;
}

const HELP_WIDTH = 78;

/**
 * The help text's spawn section: one line per row the CLI parses, wrapped to a
 * terminal width. `extra` carries flags that belong in the section but are not
 * spawn options, such as the CLI's own `--json`.
 */
export function spawnHelp(extra: readonly SpawnHelpLine[] = []): string {
	const lines: RenderLine[] = [];
	for (const row of SPAWN_OPTIONS) {
		if (row.flag === undefined) continue;
		const prefix = `  --${row.flag}${row.arg === undefined ? "" : ` ${row.arg}`}`;
		lines.push({ prefix, text: `${row.label}${parenthetical(row)}${row.detail === undefined ? "" : `; ${row.detail}`}` });
	}
	for (const line of extra) lines.push({ prefix: `  --${line.flag}`, text: line.label });
	return renderHelpLines(lines);
}

interface RenderLine {
	readonly prefix: string;
	readonly text: string;
}

function renderHelpLines(lines: readonly RenderLine[]): string {
	const column = Math.max(...lines.map((line) => line.prefix.length)) + 2;
	const rendered: string[] = [];
	for (const line of lines) {
		const [first = "", ...rest] = wrap(line.text, HELP_WIDTH - column);
		rendered.push(`${line.prefix.padEnd(column)}${first}`);
		for (const continuation of rest) rendered.push(`${" ".repeat(column)}${continuation}`);
	}
	return rendered.join("\n");
}

function parenthetical(row: SpawnOptionRow): string {
	const parts: string[] = [];
	const fallback = row.childDefault ?? row.helpDefault;
	if (fallback !== undefined) parts.push(`default: ${fallback}`);
	if (row.multiple) parts.push("repeatable");
	if (row.note !== undefined) parts.push(row.note);
	return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/** Greedy word wrap, so a long help line stays readable in a standard terminal. */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line.length === 0) line = word;
		else if (line.length + 1 + word.length <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line.length > 0) lines.push(line);
	return lines;
}
