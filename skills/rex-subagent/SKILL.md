---
name: rex-subagent
description: Delegate work to Pi subagents that run as visible Pi TUIs in Rex tabs. Use for parallel reviews, independent investigations, multi-model comparisons, delegated implementation, and steering a running agent.
---

# Rex subagents

`rex-subagent` starts a separate Pi in its own Rex tab: a real interactive TUI
with its own Pi session, named `task — model:thinking`, highlighted by Rex while
it works. You can read its result, queue turns, and steer a running agent.

## Completion is not cleanup

`rex_wait` returning `idle` means the child's turn is complete; it does **not**
close the Rex Tab or exit the child process. After reading and verifying each
child's complete result, call `rex_stop` with `{ "handle": "...", "remove": true }`.
The parent extension audits idle children before settling and can request one
bounded cleanup continuation; when reminded, execute the actions instead of
merely repeating the result. Retain an idle Tab only for a concrete upcoming
follow-up. See **Stop** below for accounting failures and whole-Session cleanup.

## When to use it

Use a subagent when work is independent enough to run in parallel, when a second
opinion should not share your context, or when you want to change an agent's
direction while it runs. Do the work yourself when you would only wait on one
small step.

Do not spawn more than about four agents without a concrete reason. Every agent
is a full Pi session and costs tokens.

## Spawn

Plan the Rex hierarchy before launching. Keep each objective in one meaningfully
named Rex Session, with its related agents in Tabs under that Session. Parallel
agents working on the same objective still share one Session; reserve separate
Sessions for separate objectives.

- **Session (`group`)**: Give each objective an explicit, meaningful name such as
  `fix-auth-timeout` or `pr-123-review`, including an issue or PR id when useful.
  Rex labels the Session `rex-<group>`. Use the same `group` for every agent
  contributing to that objective: the first spawn creates the Session when it is
  absent, and later spawns reuse it and add Tabs. Choose a different meaningful
  `group` for a different objective instead of relying on the generic default.
- **Existing Session (`batch`)**: Attach related work to an existing Session by
  passing its exact Rex label, such as `rex-fix-auth-timeout`, or `session:<id>`.
  This selects that Session directly and avoids creating a duplicate.
- **Tab (`name`)**: Give each agent a short, specific role such as `code-review`
  or `test-review`. Every `rex_spawn` adds one Tab to the selected Session, and
  the title becomes `task — model:thinking`.

Use the accounting-aware `rex_spawn` tool for normal delegation:

```json
{
  "prompt": "Review the current diff for correctness",
  "name": "code-review",
  "group": "fix-auth-timeout",
  "tools": "read,bash,grep,find"
}
```

For a sibling test reviewer, keep `group` unchanged and set its `name` to
`test-review`; both Tabs then belong to `rex-fix-auth-timeout`.

Optional parameters include `cwd`, `provider`, `model`, `thinking`, `theme`,
`excludeTools`, `group`, and `batch`. The tool returns the handle and an explicit
zero usage baseline. Keep the handle: every later operation needs it.

- The child is an ordinary interactive Pi: it reports OSC 7501 (`working`,
  `blocked`, `done`, `error`) itself. This package never filters or disables it;
  Rex's Program Activity settings decide indicators, notifications, and sounds.
- Add `provider`, `model`, or `thinking` to override the parent's model.
- `theme` selects the child's Pi theme (default: `dark`, which keeps panel
  backgrounds in hidden tabs). Use `system` to follow terminal colors.
- Restrict a read-only investigation with `tools: "read,grep,find"`.
- The CLI spawn command remains available for diagnostics and manual runs, but
  such a run has no parent-branch baseline. Call `rex_adopt` before observing it.

## Wait and read

Completion is pull-based: a finished child does not automatically message or
wake the parent agent. After spawning, do any independent local work, then call
`rex_wait` before reporting delegated work as complete. It reconciles lifecycle
state and returns only newly observed child usage through the parent tool result.

```json
{
  "handles": ["handle-a", "handle-b"],
  "any": true,
  "timeoutMs": 600000
}
```

For several independent tasks, prefer `any: true`: it uses Rex events to return
fast finishers (and blocked/error runs) without waiting for slow siblings.
Process each returned handle, then wait again on only the remaining handles.
Every requested handle is observed for usage, including pending, timeout,
blocked, error, stopped, and exited outcomes. Use `rex_observe` with the same
`handles` array when you need a usage observation without waiting.

Widget updates and Rex notifications are for the human UI only. After `rex_wait`
returns, read each child's complete result and independently verify its
deliverables before presenting it as completed work. Use the full transcript for
final results; `--tail` is only for recent progress while an agent is running:

```sh
rex-subagent logs <handle>
rex-subagent status <handle>
# Optional progress check, not final acceptance:
rex-subagent logs <handle> --tail 60
```

A missing or empty final response is not a completed result: inspect `status`,
wait again or retry the read as appropriate. Logs contain only user/assistant
text, so inspect changed files and rerun relevant tests instead of treating the
child's summary as verification.

`wait` reports `idle`, `stopped`, `exited`, `gone`, `failed`, or `timeout`;
`--any` can also return `blocked` or `error` early. Exit 0 means every returned
result settled cleanly: `idle`, `stopped`, or `exited` with exit code 0 after
genuinely finishing its turns — the agent was idle, at least one turn ran, and
no message was left undelivered. In default all mode that includes every
requested run; `--any` omits pending handles. Blocked, error and timeout are
not success. Exit code 0 before the first turn (a closed TUI or an early crash)
is a failure, not success. An `exited` run carries the real process exit code —
believe it over any older output. A
timeout is not proof that the agent failed: check `status` and `logs` before
deciding.

Do not interrupt an agent that is still running unless the user asks for it.

The agent is a normal TUI. If it asks a question in assistant text, `logs` may
show the question. Permission and authentication dialog details appear in the
TUI, not in `logs`: ask the user to resolve those in the tab, then wait again.
Use `status` and the `rex_wait` outcome for lifecycle state.

## Follow up and steer

```sh
rex-subagent send <handle> "Focus only on the error handling"        # idle: start a new turn
rex-subagent send <handle> --steer "Stop refactoring; fix the test"  # busy: steer the running turn
rex-subagent send <handle> --follow-up "Then write the summary"      # busy: deliver after the turn
```

`--steer` (and the default while the agent is busy) injects the message into the
running turn, after its current tool calls. `--follow-up` waits until the agent
stops. A steer does not create a new turn.

`send` refuses stopped, gone or exited runs — a dead run never consumes
messages. If Rex cannot be reached, the message is still queued but marked
`unconfirmed`.

To stop an agent entirely use `rex_stop`, which aborts it. Do not try to
interrupt by sending text.

## Adopt an existing run

A pre-existing CLI-created run must be explicitly adopted before observation:

```json
{
  "handle": "existing-handle"
}
```

Call this through `rex_adopt`. Adoption records the current snapshot as the
baseline, so earlier work is not charged retroactively. Unowned and same-parent
runs can be adopted; runs owned by another parent are rejected. A root cannot
adopt its own grandchild and charge it a second time.

## Stop

Close an idle agent as soon as its complete result has been read and verified
and no follow-up is planned. Keep an idle Tab only for a concrete upcoming
follow-up. To close the Tab and remove its run records through the
accounting-aware workflow, call `rex_stop` with `remove: true`:

```json
{
  "handle": "existing-handle",
  "remove": true
}
```

Check that the result reports `removed: true`. Apply this cleanup to every idle
or terminal agent whose result is no longer needed; a finished task must leave
no idle Tabs that exist only because cleanup was deferred.

### Close a task Session

1. Build a checklist of every handle spawned or adopted for the objective. Wait
   for all pending work, read and verify each result, and ensure no follow-up is
   planned. Choose one `final-handle` if the whole Session may be closed. Every
   handle must end the cleanup either verified and removed or deliberately
   retained.
2. Stop and remove every other completed agent with `rex_stop` and
   `remove: true`; keep `final-handle` available for the whole-Session close. If
   the Session should remain open, stop and remove `final-handle` as well and
   finish without the whole-Session gate below.
3. Before an autonomous whole-Session close, run this read-only gate. Use the
   `sessionId` and `windowId` reported for `final-handle`; never guess them:

   ```sh
   rex-subagent status <final-handle> --json
   rex-subagent list --all --json
   rex --autostart=false session inspect <session-id> --json
   ```

   Autonomous closure requires every condition to pass together:

   - Every subagent in the Session is accounted for, finished and verified, and
     no result, follow-up or Tab is still needed.
   - `list --all` shows no unaccounted or another parent's run with the same
     `sessionId`.
   - `session inspect` shows no window other than `final-handle`'s owned window;
     an already-exited final process may leave no window.
   - All inventory commands succeeded and the Session has no shared or uncertain
     ownership.

   `rex_stop` validates ownership of the stopped handle only; this gate is the
   parent's required sibling-window safety check. If any condition fails or is
   uncertain, close only owned Tabs and ask the user before killing the Session.
4. After the complete gate passes, the parent may close the task Session without
   additional confirmation. Make one final accounting-aware stop:

   ```json
   {
     "handle": "final-handle",
     "remove": true,
     "killSession": true
   }
   ```

   This kills every remaining window in the Rex Session. Stopping the sole
   remaining window also closes the Session without `killSession: true`; after
   `removed: true`, the closer handle is gone and no second stop is needed.

`rex_stop` collects a live child's final usage after its aborted turn and tool
results settle, then observes that usage before removing records. A terminal
retry may report `finalization: "unconfirmed"` or `snapshot: "missing"`; these
diagnostics do not prove final or zero historical usage. If accounting cannot be
confirmed, retry the preserved run records and snapshots — never delete the run
directory manually. CLI stop and prune remain management operations, not
accounting-aware removal workflows.

## Return to the parent

Inside a subagent's TUI, `/back` selects the tab that spawned it. It does not
stop or close anything, and it fails with a message when the parent was not in a
Rex tab or when several Rex apps are connected.

## Rules

- CLI setup runs automatically when the parent session starts. If the command
  is unavailable, use `/rex-subagent-setup`, then retry `rex-subagent doctor`.
  If setup reports that its bin directory is not on `PATH`, run the reported
  `linkPath` directly (default:
  `"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/rex-subagent" doctor`) or fix
  `PATH` first. Preserve foreign files and follow the reported conflict instead
  of replacing them.
- Never spawn from inside a subagent. The guard sets `PI_REX_SUBAGENT_HANDLE`;
  only pass `allowNested: true` (or the CLI's `--allow-nested`) when the user asks
  for recursion.
- Use `rex_spawn`, `rex_wait`/`rex_observe`, and `rex_stop` for the normal
  delegation workflow. Bare CLI wait/stop/removal does not establish or advance
  the parent's accounting cursor. If a run was created through the CLI, adopt it
  first with `rex_adopt`.
- A managed child refuses session replacement, fork, and tree navigation to keep
  its cumulative accounting stream coherent; spawn a replacement run instead.
- Report which handle produced a result. Do not present a subagent's output as
  your own verification.
- Use `rex-subagent open <handle>` only when the user asks to see the tab; it
  changes which session the Rex app shows.
- Always address runs by handle. `rex-subagent` resolves the session, window and
  block ids from `metadata.json`; never run `rex window close` or `rex kill` in a
  shell loop, and never pass an empty or guessed session id — an empty id
  addresses the caller's own session.
- `list` shows this session's runs; add `--all` to see every run on the machine.
