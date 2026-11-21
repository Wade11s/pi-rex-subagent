# Usage accounting

Rex children are independent Pi processes. Their assistant and nested-tool usage
cannot be seen by the parent merely because the parent spawned them. The
accounting provider bridges that process boundary without teaching the parent,
pi-goal, or another consumer how to parse a child session.

## Normal tool flow

Use the parent tools for delegation:

| Tool | Purpose |
| --- | --- |
| `rex_spawn` | Launch a direct child and record its zero baseline |
| `rex_wait` | Reconcile lifecycle state, then observe every requested handle |
| `rex_observe` | Collect newly published usage without waiting |
| `rex_adopt` | Claim an unowned run, or establish a baseline for a same-parent CLI-created run |
| `rex_stop` | Stop, collect final usage, and optionally remove the run records |

The CLI remains useful for logs, follow-up messages, inspection, and explicit
management. A CLI-created run has no parent-branch baseline: call `rex_adopt`
before observing it. Do not use a CLI removal path and then expect parent-side
attribution; deletion can strand an unobserved snapshot.

A successful observation stores its cursors in the parent tool result's
`details`. Its combined new usage is stored in the standard Pi tool-result
`usage` field. Pi persists both. Consumers charge the tool result, not the
snapshot and not a second Rex-specific entry.

## Child snapshots

Each run directory contains `usage.json` with this accounting contract:

| Field | Meaning |
| --- | --- |
| `version` | Snapshot schema version, currently `1` |
| `source` | `pi-rex-subagent` |
| `runHandle` | Rex run identity |
| `parentSessionId` | Accounting owner, or `null` before an unowned run is claimed |
| `childSessionId` | Current child Pi session identity |
| `childSessionGeneration` | Opaque identity derived from the durable session header ID and creation timestamp |
| `sequence` | Integer starting at `1` and increasing on every publication in this generation |
| `usage` | Complete cumulative Pi `Usage` for the selected branch |
| `final` | Clean process-quit or stop-finalization marker |
| `updatedAt` | Diagnostic timestamp; never used to calculate a delta or decide staleness |

Generation survives reload and same-session process resume. It is not a PID or
extension-instance counter. A replaced, forked, reset, or different session is a
new generation.

The child recomputes from persisted entries on its selected branch at session
start, turn end, agent settlement, compaction, and session teardown. It also
publishes when stop is noticed and after the aborted turn settles. Snapshot
writes use a unique temporary file and atomic rename.

The aggregate includes:

- assistant-message usage, including persisted error/aborted messages;
- tool-result usage, including nested usage already aggregated by Pi;
- compaction and branch-summary usage.

Standalone usage entries, including cache warming, are excluded. Every numeric
field must be finite and non-negative. Cached reads/writes, optional reasoning
and cacheWrite1h, totalTokens, and all cost fields are preserved. Child active
time is never added to parent active time.

A snapshot is published before corresponding `idle` or `stopped` status. A
reload-related shutdown publishes a non-final snapshot because the same
generation continues. Only process quit or stop finalization marks a snapshot
final. If a process crashes, the last durable snapshot remains collectible, but
usage that never reached the Pi session or a snapshot cannot be recovered.

### Sequence and final-state rules

- Sequence gaps are valid because usage is cumulative.
- Rereading the same sequence with the same accounting payload is idempotent.
- The same sequence with different accounting content is a conflict.
- A lower sequence, changed child session ID or generation, negative component
  delta, or vanished optional numeric component is invalid, including when the
  sequence increases.
- A new sequence or changed payload after a final snapshot is invalid.
- Rereading an identical final snapshot returns zero new usage.

Failures are never clamped, silently reset, or converted into a new zero
baseline.

## Parent baselines and cursors

Accounting details have `version`, `kind`, `parentSessionId`, and `runs`.
`kind` is `spawn`, `adoption`, or `observation`. Each run cursor contains:

- `handle`;
- `childSessionId` (`null` only for a new spawn baseline);
- `generation` (`null` only for a new spawn baseline);
- `sequence`;
- `cumulative` Usage;
- `final`;
- optional `unownedAdoption: true`, present only while the cursor is the exact
  unchanged baseline adopted from a null-owner snapshot.

The cursor version remains `1`: the adoption marker is optional, and older
cursors without it remain valid but do not authorize a null-owner snapshot. The
marker is retained by unchanged observation results for restart and
selected-branch replay, and omitted once a newer owned snapshot advances the
cursor. An owned observation cursor therefore cannot accept an otherwise
identical snapshot whose owner changes to `null`.

A spawn baseline is sequence `0`, neutral zero Usage, no generation, and
`final: false`. It charges all subsequent child work, even when the first wait
happens after several child turns. Adoption instead records the current valid
snapshot as its baseline and charges none of the pre-adoption work. Re-adoption
on a branch that already has a baseline is rejected.

On parent session start and session-tree navigation, the provider folds only
successful Rex accounting tool results on the selected parent branch. It ignores
abandoned branches, failed accounting transactions, and payloads belonging to a
different parent identity. A branch that inherits a spawn but not an earlier
observation therefore resumes from the original zero baseline. Reconstruction
itself charges nothing.

## Delta and transaction rules

- Repeated handles in one call are deduplicated.
- Lifecycle waiting happens before the accounting critical section.
- Wait observes every requested handle, including timeout, blocked, error,
  stopped, gone, failed, and exited outcomes.
- A parent-local transaction queue serializes observation. Multi-run validation
  finishes before any in-memory cursor is committed.
- If any requested run fails validation, the call returns an error with no
  accounting `usage`, and none of that call's cursors advance. A later valid
  retry can charge every delta once.
- A successful call returns one combined Usage delta and every requested run's
  resulting cursor, including unchanged and zero-delta cursors.
- When the combined numeric delta is zero, `usage` is omitted but cursors still
  advance.

Numeric addition and subtraction cover every Usage and cost component. A delta
from a neutral all-zero baseline inherits the current cost provenance. Otherwise
it is provider-reported only when both cumulative endpoints are provider-reported.
A non-neutral cumulative `cost.totalFromProvider` transition from `false` to
`true` is rejected before any cursor commits. A `true` to `false` transition is
valid, and the resulting estimated/mixed stream cannot later be upgraded.
Combining several deltas preserves provider-reported provenance only when every
nonzero contributor has it. Estimated or mixed provenance is never upgraded.

## Ownership, adoption, and nesting

A run has at most one accounting owner in V1:

- A tool-spawned run is owned by the current parent session immediately.
- A same-parent CLI-created run still needs an explicit adoption baseline.
- An unowned run can be claimed by one parent. Its last unowned snapshot can be
  used only as the adoption baseline; subsequent snapshots carry the new owner.
- A run owned by another parent is rejected. Cross-parent transfer is out of
  scope for V1.

Adoption claims are serialized across parent Pi processes by an exclusively
created per-run `.adoption.lock`. The run owner, snapshot identity and owner, and
final ownership write are all validated inside that critical section. A
competing parent that loses the claim receives an error and no baseline, so it
cannot charge the winner's post-adoption delta.

An interrupted adoption whose baseline tool result was never persisted can be
retried by the same owner. The retry establishes a new current baseline and does
not retroactively charge the uncommitted attempt. Locks are not stolen: an
abandoned lock makes later adoption fail closed after a bounded wait. After
confirming that no adopter is still active, an operator may remove only the stale
`.adoption.lock` file to permit recovery.

Nested usage crosses one process boundary at a time. A child's aggregate already
contains its tool-result usage for a grandchild. The root observes only its
direct child and cannot adopt or observe the grandchild independently.

## Stop and removal

For a live run, accounting-aware stop records that finalization is required and
then:

1. Writes the normal local stop sentinel and aborts the current turn.
2. Gives the child an opportunity to publish an early non-final snapshot.
3. Waits for the aborted turn and its tool results to settle.
4. Publishes the final snapshot before stopped status and graceful Pi shutdown.
5. Reconciles the normal Rex close/probe confirmation.
6. Observes the final snapshot.
7. Removes records only after both stop confirmation and final observation
   succeed.

If finalization or final observation fails, the tool reports both the stop
outcome and accounting error, and records and snapshots remain for a retry. The
durable finalization-required marker prevents a later retry from mistaking a
failed accounting stop for a child that was already dead. A run that was already
terminal before accounting-aware stop may be collected from its last non-final
durable snapshot.

If final accounting succeeds but the subsequent removal fails, the tool still
returns the successful Usage delta and cursors together with the removal error.
It must not turn a completed accounting transaction into an error result that
branch replay would ignore.

Existing CLI stop and prune semantics are unchanged. They are not an
accounting-aware removal workflow.

## Managed child navigation

A managed child stays on one session and selected branch in V1. Session
replacement, resume into another session, fork, and session-tree navigation are
refused with an explanatory notification. Reload, same-session process resume,
normal turns, and compaction remain available. An externally caused generation
change or cumulative regression fails closed; V1 does not transparently migrate
it to a new baseline.

## Goal boundary and observation time

Rex has no Goal identity, Goal admission, Token budget, or pi-goal dependency.
The parent tool result is charged only under the consumer's existing rules.

V1 uses **observation-time ownership**. Work performed while a Goal is stopped
but first observed after resume can belong to the observing admission segment.
This is deliberately not invoice-exact lifecycle attribution. Strict pause and
resume reconciliation is outside this provider's V1 boundary.
