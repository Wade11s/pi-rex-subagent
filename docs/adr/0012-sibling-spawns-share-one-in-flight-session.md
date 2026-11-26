# Sibling spawns share one in-flight session, and never trust it for liveness

Runs spawned concurrently into one group are tabs of one Rex session. `resolveBatch`
lists sessions and creates one when the label is absent, so siblings that list
before any of them creates each create their own. The first launch publishes the
session id it resolves while still in flight, keyed per runner, server and label;
siblings arriving meanwhile join it with `window new`. Reading the share and
publishing one's own is one synchronous step, so exactly one spawn per group
publishes. The entry is forgotten the moment the launch settles. A join that
fails looks again, so the waiters elect one new publisher among them — but only
once a listing has answered without the session, the one proof that no window of
the run can exist. In every other case the window may exist, so that run fails
instead of launching a second one.

## Considered Options

- **Serialise sibling spawns per group with a mutex.** The next spawn would still
  rely on Rex listing the new session before it lists (read-after-write), and
  every sibling would wait for the slowest `rex new` with nothing to gain.
- **A sticky per-group session cache.** A later spawn would add a window to a
  session the user closed in between. The share lasts only while one launch is in
  flight; a later spawn lists again.
- **Trust a joined id without a fallback.** A session closed between the
  publisher's `rex new` and the join would fail a run that, before this change,
  listed and created successfully. A refused join falls back to listing.
- **Fall back on any join error, or on the error kind.** A lost reply leaves it
  unknown whether the window exists; listing and launching again would run the
  same Child twice under one handle. `RexError.kind` cannot carry the proof:
  every nonzero `rex` exit is `failed`, including the CLI's own 5 s timeout
  after the server acted. Only a listing that answers without the session proves
  no window can exist; a session still listed, or Rex not answering, fails the run.
- **Bound the re-election.** After one failed publisher the waiters elect another;
  a bound would turn a transient second failure into a cohort failure, while a
  persistent one costs latency only, bounded by twice the cohort size times the
  Rex-call cap (a launch is `ls` plus `new`). Recorded as a known limit instead.
- **A cross-process lock spanning list-and-create under the runs root.** It
  would also keep two concurrent CLI `spawn` processes in one session, at the
  cost the inbox lock shows (ADR-0009): owner token, staleness steal, crash
  debris. The documented delegation path is `rex_spawn`, which runs every spawn
  of a Parent in that Parent's process, so the CLI case is a known limit.

## Consequences

Siblings wait for the publisher's `ls` and `new`, so one slow Rex call delays
them up to the Rex-call cap instead of failing alone; a persistently failing Rex
serialises the cohort's launch attempts. A run fails only from its own Rex calls:
a join to a session a listing shows gone lists and creates, and a publisher that
fails leaves its waiters to elect a successor. A failed join costs one `ls` before
the run fails, and `rex ls` without a `sessions` array, or with an entry
without a `session_id`, is refused as invalid so the proof is never a malformed
reply. An ambiguous launch reply — the publisher's `rex new` timed
out or came back unreadable after the server acted — still leaves a `failed`
record with empty Rex ids while the window may exist, as it did before this
change; reconciliation is a separate decision. This is not a cache of Rex
validation (ADR-0010): nothing here is trusted beyond the flight of one launch.
Runs that join the publisher report `reusedBatch: true`.
