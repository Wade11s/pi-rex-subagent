# rex-subagent

A Pi extension and CLI that runs each delegated subagent as a normal interactive Pi TUI in its own Rex tab, and reports what that child Pi spends back to the parent.

## Language

### Runs

**Run**:
One spawned subagent: a record directory, a Rex window holding a child Pi, and that child's session. Everything below describes one run.
_Avoid_: agent, job, task, worker

**Handle**:
The run's name and only identifier — its directory name under `~/.pi/agent/rex-subagents/`, and the value every command and tool takes.
_Avoid_: id, run id, key, slug

**Run directory**:
Where one run's durable state lives: record, status, inbox, usage snapshots, child session log, launcher.
_Avoid_: workspace, root, home

**Parent**:
The Pi session that spawns a run, waits on it, and accounts for its usage.

**Child**:
The Pi session inside the Rex window that does the work. It is a normal interactive Pi, not a scripted worker.
_Avoid_: subagent (when the process is meant), worker, slave

**Group**:
The label of the Rex session that child tabs are created in. Runs in one group are tabs of the same session; the default group is `subagents`.
_Avoid_: batch, pool, team

**Batch**:
An existing Rex session a run attaches to instead of creating one, named as `session:<id>` or a label.

**Tab**:
The Rex window hosting one child, as the user sees it. In Rex ids and prose about ids it is a **window**.
_Avoid_: pane, split

**Nesting**:
Spawning from inside a child. Refused unless `--allow-nested`, because a child's children would escape the parent's accounting.
_Avoid_: recursion, chaining

### Lifecycle truth

The run has exactly three sources of truth, each with its own lifetime. Nothing else is a fourth.

**Record**:
`metadata.json`: the parent-written, durable statement of what was launched — pinned Rex endpoint, host, session/window/block ids, title, group, ownership, durable state.
_Avoid_: metadata, manifest, config

**Status**:
`status.json`: the child-written statement of the current **turn** only. It never describes the OS process and never carries an exit code.
_Avoid_: state file, heartbeat

**Probe**:
An on-demand Rex call from the parent answering whether the OS process exists and, once it ended, its real exit code.
_Avoid_: check, ping, poll

**Display state**:
The single state `observeRun` merges from record, status and probe, by fixed precedence. Three sources, one answer.
_Avoid_: merged state, overall state

**Terminal**:
`failed`, `stopped`, `gone`, `exited`. A terminal run never restarts; there is no recovery path.
_Avoid_: done, finished, closed

### Turn and process

The agent's turn and the OS process are separate axes; conflating them is the bug this package exists to avoid.

**agentState**:
The turn axis from status: `starting | busy | idle | stopped`.

**processState**:
The process axis from the probe: `starting | running | exited | gone | unknown`.

**processExitCode**:
Rex's real OS exit code, knowable only after the process ends. The child never writes one.
_Avoid_: lastExit, exit status from the child

**Turn**:
One prompt-to-idle cycle inside the child. Delivered-message and turn counts are how the parent proves work actually happened.

**Settled turn**:
A turn that finished, shown as status `idle`. It says the agent stopped, not that the process did.
_Avoid_: done, complete, finished

### Stopping

**Stop sentinel**:
The `stop` file in the run directory. The child sees it, aborts the running turn, publishes its final usage snapshot, and asks Pi to shut down.
_Avoid_: kill flag, abort file

**Stopping**:
Stop requested and acknowledged, but the process is still alive and the close is unconfirmed. Not terminal — `wait` keeps polling.
_Avoid_: stopped

**Confirmed stop**:
The record is marked `stopped` only after Rex confirmed the close, or a probe proved the block gone. A failed stop keeps the previous record and stays retryable.

**Stop grace**:
The bounded window (10 s by default, `REX_SUBAGENT_STOP_GRACE_MS`) a child has to settle and publish before it forces a success exit.

### Messages

**Inbox**:
`<run>/inbox/`: one JSON file per message, written atomically, consumed in index order, unlinked once handed to Pi.
_Avoid_: queue, outbox

**Delivery**:
`auto` (start a turn when idle, steer when busy), `steer` (join the running turn) or `followUp` (wait until the agent stops).
_Avoid_: message type, mode

**Unconfirmed**:
A send accepted while Rex was unreachable: the file is queued, and it is delivered only if the child turns out to be alive.

### Waiting

**Wait outcome**:
`idle | stopped | exited | gone | failed | timeout`, plus `blocked | error` under `--any`.
_Avoid_: result, status

**Attention outcome**:
`blocked` or `error` returned early by `wait --any` so the parent can look at the run. Not terminal, never success.
_Avoid_: failure, terminal error

**All-settled barrier**:
The default `wait`: every handle resolves before it returns. `--any` returns what is ready and omits the pending.

**waitOutcomeOk**:
The success rule for `exited`: exit code 0 **and** agentState `idle` **and** at least one turn ran **and** nothing left queued. Exit 0 alone proves nothing.
_Avoid_: success check, ok flag

### Accounting

**Usage snapshot**:
`usage.json`: the child's cumulative selected-branch Usage, stamped with sequence, generation and a final marker. The only thing a child publishes about usage.

**Observation**:
Reading a run's snapshot and charging only its unpublished delta into the parent's tool result.

**Cursor**:
The durable per-run, per-branch position recording how much of a snapshot the parent has already charged. Survives parent restarts and branch replay.
_Avoid_: offset, checkpoint

**Baseline**:
The snapshot state recorded at spawn, so usage the child already had is never charged to this delegation.
_Avoid_: starting point, initial value

**Delta**:
Usage between the cursor and the current snapshot — the only amount a parent tool result reports.

**Generation**:
The child session branch a snapshot describes. A changed generation means cursors no longer compare, so accounting fails closed instead of re-baselining.

**Fail closed**:
Refuse the operation and keep the durable record, rather than guess, clamp or re-baseline. The default posture for malformed, regressed or conflicting accounting input.
_Avoid_: bail, error out

**Adoption**:
Claiming a CLI-created run so a parent session may observe it. The claim is published once and the first complete claim wins across independent parents.
_Avoid_: attach, import, take over

**Owner claim**:
`.accounting-owner.json`: the file proving which parent session owns a run's accounting. Created at most once, never overwritten.
_Avoid_: ownership file, lock

**Finalization**:
How a stop settled the accounting: `confirmed` (final snapshot collected), `unconfirmed` (only a non-final snapshot was available), or a `snapshot: "missing"` marker with no delta — bookkeeping, not a usage claim.

**usageFinalizationRequired**:
The durable marker left when a stop could not collect a final snapshot, so a later provably-terminal retry can finish the job instead of losing the usage.

### Rex surface

**Program status**:
Pi's own OSC 7501 reports (`working`, `blocked`, `done`, `error`). This package passes them through untouched; Rex's notification settings decide what the user sees.

**Open**:
Asking a connected Rex app to select the run's tab. It changes what is shown and nothing else.
_Avoid_: focus, attach

**/back**:
The child-side command that asks the Rex app to select the parent's tab, using the `parentRex` location recorded at spawn.
_Avoid_: return, exit

**Prune**:
Deleting records of runs whose Rex window is already gone. Never deletes a run that might still be alive.
_Avoid_: clean, gc, sweep
