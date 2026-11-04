# pi-rex-subagent

Pi subagents that live in Rex terminal windows. Each agent is a **normal
interactive Pi TUI** in its own Rex tab, plus a small extension that delivers
messages from a file inbox. The Rex app shows the session, the tab title, and a
working/finished highlight without any extra tooling.

Planned replacement for `pi-subagent`'s tmux backend; both can coexist.

## Ask your Pi to install it

Copy the prompt below and send it to your Pi — it will check Rex first and
then set everything up:

```text
Install the pi-rex-subagent extension for me:

1. Check the prerequisites first, and stop with a clear report if any fail:
   - `rex whoami` answers and reports a unix:// endpoint (Rex server running locally)
   - Node 22.19+ and the `pi` CLI are on PATH
2. Clone the repo into Pi's global extensions directory:
     git clone https://github.com/Wade11s/pi-rex-subagent.git ~/.pi/agent/extensions/pi-rex-subagent
   (use git@github.com:Wade11s/pi-rex-subagent.git if SSH is set up)
3. Create two symlinks (mkdir -p the parent directories first):
     ~/.pi/agent/skills/rex-subagent -> the clone's skills/rex-subagent
     ~/.pi/agent/bin/rex-subagent   -> the clone's src/cli.ts
4. Verify and report the results:
     - `rex-subagent version` prints a version
     - `rex-subagent doctor` reports the Rex endpoint and host
     - `pi config` lists src/index.ts under Extensions and rex-subagent under Skills
5. Remind me to restart Pi (or run /reload) so the extension loads.
```

## What you get

| Need | How it works |
| --- | --- |
| Parallel agents | One Rex session per `--group`, one window per agent; they are tabs, so the Rex app can show and tile them |
| Visible agent | The tab runs the real Pi TUI; you can watch, type, or press ctrl+c yourself |
| Title | Tab label and Pi session name: `task — model:thinking` |
| Program status | Pi reports OSC 7501 natively (`working`, `blocked`, `done`, `error`); nothing in this package filters it, so Rex's Program Activity settings decide indicator, notification, badge, and sound |
| Model override | `--provider/--model/--thinking` map to Pi flags |
| Follow-up turns | `send <handle> "text"` starts the next turn on the same session |
| Steer a running turn | `send <handle> --steer "text"` injects into the running agent |
| Result | `wait` reports the turn count; once the OS process has ended it reports the real exit code; `logs` renders the session transcript |
| Survival | Rex owns the process, so agents keep running when Pi quits |
| Isolation | `--tools`, `--exclude-tools`, `--no-extensions`, `--no-skills`, `--no-context-files`, `--no-mcp` |

## Requirements

- Pi with Node 22.19 or newer
- A running local Rex server (`rex whoami` must answer over a unix socket)
- `pi` on `PATH` (or `--pi /absolute/path`)

Remote Rex servers are refused on purpose: a subagent must not land on another
machine by accident.

## Install

Clone the repo into Pi's global extensions directory — the parent extension
(widget, `/rex-agents`, `/rex-agent-status`) is auto-discovered through the
`package.json` manifest. The skill and the CLI are then two symlinks:

```sh
git clone git@github.com:Wade11s/pi-rex-subagent.git ~/.pi/agent/extensions/pi-rex-subagent
mkdir -p ~/.pi/agent/skills ~/.pi/agent/bin
ln -sfn ~/.pi/agent/extensions/pi-rex-subagent/skills/rex-subagent ~/.pi/agent/skills/rex-subagent
ln -sfn ~/.pi/agent/extensions/pi-rex-subagent/src/cli.ts ~/.pi/agent/bin/rex-subagent
```

The CLI runs directly from TypeScript, so no build step is needed; update with
`git pull` inside the clone. Or run it directly: `node src/cli.ts <command>`.

Alternatively, `pi install git:github.com/Wade11s/pi-rex-subagent` installs the
extension and skill through the package system — but the CLI still needs a
local clone and the `bin` symlink above, so the clone-first flow is simpler.

## Use

```sh
# one agent
rex-subagent spawn --name review --prompt "Review the current diff independently"

# three models on the same task, tabs in one Rex session
rex-subagent spawn --name review --model anthropic/claude-sonnet-4 --prompt "..."
rex-subagent spawn --name review --model xai/grok-4.7 --thinking high --prompt "..."
rex-subagent spawn --name review --model magpie/workbuddy/deepseek-v4.1-flash --prompt "..."

rex-subagent list
rex-subagent wait <handle>... --for 10m
rex-subagent logs <handle> --tail 40

rex-subagent send <handle> "Now summarise only the blocking issues"
rex-subagent send <handle> --steer "Stop refactoring; fix the failing test"
rex-subagent send <handle> --follow-up "Then open a PR"

rex-subagent open <handle>   # show the tab in a connected Rex app
rex-subagent stop <handle> --remove
# DANGER: --kill-session kills the WHOLE Rex session, taking every sibling
# window in it down with the agent. Only use it when you own every window.

# inside the subagent's own TUI:
/back                        # return to the tab that spawned it
```

Tabs are titled `task — model:thinking`, so three runs of the same task stay
distinguishable:

```
review — claude-sonnet-4
review — grok-4.7:high
review — deepseek-v4.1-flash
```

Children use Pi's fixed `dark` theme by default, so tool and message panel
backgrounds do not depend on terminal color replies that Rex may not provide
for hidden tabs. Pass `--theme <name>` to select another Pi theme, or `--theme
system` to restore terminal-adaptive colors.

Every command accepts `--json`. Exit codes: `0` ok, `1` failure or wait
timeout, `2` usage, `3` Rex unavailable.

`spawn --env KEY=VALUE` (repeatable) exports extra variables into the child.
The child environment is minimal by design — it inherits only `PATH`, `HOME`
and `PI_CODING_AGENT_DIR` — so anything else the task needs (tokens, config
locations) must be passed explicitly with `--env`.

`send` refuses runs that are `stopped`, `gone` or `exited`: nothing would ever
consume the message. When Rex cannot be reached to confirm the process, the
message is still queued and the result reports `unconfirmed: true`.

### Delivery semantics

The child is an interactive Pi, so delivery reuses Pi's own semantics.

| Message | Agent idle | Agent running |
| --- | --- | --- |
| `send` (default) | starts a new turn | steering message: delivered after the current tool calls, before the next model call |
| `--steer` | starts a new turn | same as the default, stated explicitly |
| `--follow-up` | starts a new turn | delivered only after the agent stops |

`wait` reports the delivered-message count and, once the OS process has ended,
its real exit code (from Rex, not from the child). A steer joins the running
turn instead of creating a new one. `wait` resolves each handle as one of:

| Outcome | Meaning | exit code contribution |
| --- | --- | --- |
| `idle` | queued turns finished, agent alive | 0 |
| `stopped` | stopped on purpose | 0 |
| `exited` | the OS process ended | 0 only when it exited `0` after finishing its turns: agent idle, at least one turn ran, nothing left queued |
| `gone` / `failed` | run is no longer manageable | 1 |
| `timeout` | deadline passed | 1 |

A run that dies before its first turn or mid-turn resolves as `exited` with the
real exit code instead of hanging until the timeout. A run whose stop was
requested but not yet completed shows `stopping`: it becomes `stopped` only
once the process really ended or Rex confirmed the close.

## How a run is laid out

```
~/.pi/agent/rex-subagents/<handle>/
  metadata.json     pinned endpoint + host id + session/window/block ids + title
  child.sh          exports the run env, then execs the Pi TUI
  inbox/NNNN.json   {"message":"...","delivery":"auto|steer|followUp"}
  inbox/.seq        monotonic message counter
  inbox/.lock       held while a sender allocates the next index
  status.json       {"state":"starting|busy|idle|stopped","turn":N,"transport":"tui"}
  sessions/         the child Pi session JSONL; `logs` renders it
  stop              sentinel: the child aborts its turn and exits the TUI
  child.err.log     delivery diagnostics
```

`spawn` writes the record, the launcher and the first message *before* creating
the Rex window, so a launch either leaves a readable record or a failed one with
the error. Status comes from two sources: the pinned Rex probe proves the process
is alive, `status.json` (written by the child extension) proves whether a turn is
running. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine,
terminal-state definitions, message-delivery semantics and the concurrency
contracts (inbox locking, confirmed stops, probe batching).

`status.json` is written by the child extension and describes only the current
turn; it carries no exit code (older versions wrote a misleading `lastExit: 0`,
which is ignored now). Exit codes come from the Rex probe once the process ends.

## Program status is Pi's

The child is an ordinary interactive Pi, so it reports the full OSC 7501 sequence
on its own: `working` during a run, `blocked` while a dialog waits for the user,
then `done` or `error`, with the session name as the message.

This package does not filter, delay, or disable those reports. Rex maps them to
tab indicators, system notifications, Dock badges, and sounds, each configured
globally under **Settings → Notifications → Program Activity**. If subagents
should be quieter or louder, change those Rex settings; a per-session mute does
not exist.

```
none → idle → working → done      final: {"state":"done","msg":"<title>"}
```

When stopping or renaming, always address the session and window ids from
`metadata.json`. Never loop over `rex window ls -s ""` or an unset variable: an
empty session id addresses the caller's own session.

## Returning to the parent

`spawn` records where the parent Pi was running (`REX_SESSION` / `REX_BLOCK`,
resolved to a window id) in `metadata.json` under `parentRex`. The child then
offers:

```
/back   # ask the connected Rex app to select the parent tab
```

Requirements and failure modes:

- The parent must have been running inside a Rex tab. Spawning from a plain
  terminal records no `parentRex`, and `/back` says so.
- Exactly one Rex app must be connected. With several, `/back` refuses to guess
  and names them; use `rex-subagent open <handle> --client <id>` from the CLI.
- `/back` only changes which session/tab the app shows. It does not close,
  stop, or restart anything.

## Steering: what Pi already provides

The tmux subagent runs an interactive child with its own extension, which polls
an inbox and calls `pi.sendUserMessage(message, { deliverAs: "steer" | "followUp" })`.
This project keeps that design — the child is a TUI — but owns the extension:
`src/child.ts` is loaded with `-e`, polls `<run>/inbox` every 200 ms, and writes
`status.json`. Steer and follow-up therefore have exactly Pi's semantics.

Highlighting needs no code from us: Pi's interactive mode already reports OSC 7501
(working / done / error) with the session name as the message. Because `spawn`
sets `--name "<task> — <model>:<thinking>"`, Rex shows:

- a spinner on the tab while the agent works (unfocused tabs),
- an indicator in the session picker once a result is ready,
- the same string as the tab label and the Pi session name.

Nothing is written to the terminal from the extension, so the TUI is untouched.

## Behaviour that differs from tmux subagents

- **Nothing is suspended when Pi exits.** The Rex window keeps running; resume
  management does not exist because it is not needed.
- **Nesting is refused.** A child sets `PI_REX_SUBAGENT_HANDLE`; spawning from
  inside it fails unless `--allow-nested` is passed.
- **The agent's TUI is not attached.** It runs in its own tab; `open` asks a
  connected Rex app to show that tab.
- **Interrupt ≠ steer.** To stop work entirely use `stop` (the child aborts), or
  press ctrl+c in the Rex tab.
- **The first turn waits ~0.5 s** so the TUI has initialized before the run
  starts; without that delay Pi's status reporter can miss `working`.

## Tests

```sh
npm test          # deterministic tests, no Rex server or LLM needed
npm run typecheck # tsc on src (strict) and tests
npm run test:live # opt-in: real Rex server, real Pi TUI turns (costs API calls)
```

- `tests/child.test.ts` drives the real child extension through a fake Pi API:
  delivery, steering, follow-ups, stop, `/back`, and unreadable inbox files.
- `tests/cli.test.ts` runs the real CLI end to end against
  `tests/fixtures/fake-rex.mjs`, including the generated launcher and titles.
- `tests/session-log.test.ts` covers the transcript rendering used by `logs`,
  including tail reads of long sessions.
- `tests/record.test.ts` covers the state machine and inbox concurrency
  (in-process and cross-process).

## Verified manually

- Plain titles: a spawned run's window label stayed
  `<task> — <model>:<thinking>` while busy and after settling (`rex session inspect`).
- Program status: a run reported `none → idle → working → done` and ended on
  `{"state":"done","msg":"<title>"}` — the full Pi sequence, untouched.
- `/back`: the exact calls the child makes (`client ls`, then
  `do session.select session_id=… window_id=…`) both exited 0 against the live
  server; `/back` itself is covered by unit tests with a fake `rex`.
- Steer: an agent told to `sleep 20` then reply `DONE` replied `STEERED` instead,
  and the session transcript contained no `DONE` answer.
- `rex-subagent open` / `session.select` with Remote Control enabled switched the
  Rex app to the agent's tab.
- Stop while busy: the Rex session disappeared and no child process leaked.

## Known limits

- macOS in practice: the launcher assumes `/bin/sh` and absolute paths.
- `status` costs one Rex probe per run; the Pi widget reads only local files to
  avoid probing on every tick, so it can briefly show a stale state for a run
  that just died.
- A `stop` that cannot be confirmed keeps the record with a `stopError` so it
  can be retried; the CLI exits 1 in that case.
- Nothing restarts a dead run: `exited`, `gone`, `stopped` and `failed` are
  terminal. Spawn a new run instead.
