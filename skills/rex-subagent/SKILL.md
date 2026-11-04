---
name: rex-subagent
description: Delegate work to Pi subagents that run as visible Pi TUIs in Rex tabs. Use for parallel reviews, independent investigations, multi-model comparisons, delegated implementation, and steering a running agent.
---

# Rex subagents

`rex-subagent` starts a separate Pi in its own Rex tab: a real interactive TUI
with its own session, named `task — model:thinking`, highlighted by Rex while it
works. You can read its result, queue turns, and steer a running agent.

## When to use it

Use a subagent when work is independent enough to run in parallel, when a second
opinion should not share your context, or when you want to change an agent's
direction while it runs. Do the work yourself when you would only wait on one
small step.

Do not spawn more than about four agents without a concrete reason. Every agent
is a full Pi session and costs tokens.

## Spawn

```sh
rex-subagent spawn --name review --prompt "Review the current diff for correctness"
rex-subagent spawn --name tests --prompt "Run the test suite and report failures" --tools read,bash,grep,find
rex-subagent spawn --name alt --model xai/grok-4.7 --thinking high --prompt "..."
```

- `--prompt` and `--file` are repeatable; they form one message.
- Agents spawned with the same `--group` share one Rex session, so their tabs sit
  next to each other.
- The tab title is `task — model:thinking`; use a short, specific `--name`.
- The child is an ordinary interactive Pi: it reports OSC 7501 (`working`,
  `blocked`, `done`, `error`) itself. This package never filters or disables it;
  Rex's Program Activity settings decide indicators, notifications, and sounds.
- Add `--provider`, `--model`, `--thinking` to override the parent's model.
- `--theme <name>` selects the child's Pi theme (default: `dark`, which keeps
  panel backgrounds in hidden tabs). Use `--theme system` to follow terminal colors.
- Restrict a read-only investigation with `--tools read,grep,find`.
- Spawn prints the handle. Keep it: every later command needs it.

## Wait and read

Completion is pull-based: a finished child does not automatically message or
wake the parent agent. After spawning, do any independent local work, then call
`rex-subagent wait <handle>...` before reporting delegated work as complete.
Widget updates and Rex notifications are for the human UI only. After `wait`
returns, read each child's result with `rex-subagent logs` and verify it before
presenting it as completed work.

```sh
rex-subagent wait <handle>... [--for 10m]   # exit 0 only on a clean settle
rex-subagent logs <handle> --tail 60
rex-subagent status <handle>
```

`wait` reports `idle`, `stopped`, `exited`, `gone`, `failed`, or `timeout`.
Exit 0 means every run settled cleanly: `idle`, `stopped`, or `exited` with
exit code 0 after genuinely finishing its turns — the agent was idle, at least
one turn ran, and no message was left undelivered. Exit code 0 before the
first turn (a closed TUI or an early crash) is a failure, not success. An
`exited` run
carries the real process exit code — believe it over any older output. A
timeout is not proof that the agent failed: check `status` and `logs` before
deciding.

Do not interrupt an agent that is still running unless the user asks for it.

The agent is a normal TUI. If it asks a question or needs permission, it shows
`blocked` in Rex; read `logs` or ask the user to look at the tab.

## Follow up and steer

```sh
rex-subagent send <handle> "Focus only on the error handling"        # next turn
rex-subagent send <handle> --steer "Stop refactoring; fix the test"  # running turn
rex-subagent send <handle> --follow-up "Then write the summary"      # after the turn
```

`--steer` (and the default while the agent is busy) injects the message into the
running turn, after its current tool calls. `--follow-up` waits until the agent
stops. A steer does not create a new turn.

`send` refuses stopped, gone or exited runs — a dead run never consumes
messages. If Rex cannot be reached, the message is still queued but marked
`unconfirmed`.

To stop an agent entirely use `rex-subagent stop`, which aborts it. Do not try to
interrupt by sending text.

## Stop

```sh
rex-subagent stop <handle> --remove
```

Stop every agent when its result is no longer needed. Do not leave idle agents
running. If a stop cannot be confirmed (Rex unreachable), the command keeps the
run record with a `stopError` so it can simply be retried — never delete the run
directory manually to "fix" a stuck stop.

Never pass `--kill-session` unless the user asks for it: it kills the entire
Rex session, closing every sibling window in it, not just this agent.

## Return to the parent

Inside a subagent's TUI, `/back` selects the tab that spawned it. It does not
stop or close anything, and it fails with a message when the parent was not in a
Rex tab or when several Rex apps are connected.

## Rules

- Never spawn from inside a subagent. The guard sets `PI_REX_SUBAGENT_HANDLE`;
  only pass `--allow-nested` when the user asks for recursion.
- Report which handle produced a result. Do not present a subagent's output as
  your own verification.
- Use `rex-subagent open <handle>` only when the user asks to see the tab; it
  changes which session the Rex app shows.
- Always address runs by handle. `rex-subagent` resolves the session, window and
  block ids from `metadata.json`; never run `rex window close` or `rex kill` in a
  shell loop, and never pass an empty or guessed session id — an empty id
  addresses the caller's own session.
- `list` shows this session's runs; add `--all` to see every run on the machine.
