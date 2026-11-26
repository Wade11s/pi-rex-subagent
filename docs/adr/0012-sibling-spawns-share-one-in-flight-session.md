# Sibling spawns share one in-flight session, and never trust it for liveness

Runs spawned concurrently into one group are tabs of one Rex session. `resolveBatch`
lists sessions and creates one when the label is absent, so siblings that list
before any of them creates each create their own. The first launch publishes the
session id it resolves while still in flight, keyed per runner, server and label;
siblings arriving meanwhile join it with `window new`. Reading the share and
publishing one's own is one synchronous step, so exactly one spawn per group
publishes. The entry is forgotten the moment the launch settles, and a join that
fails looks again, so the waiters elect one new publisher among them.

## Considered Options

- **Serialise sibling spawns per group with a mutex.** The next spawn would still
  rely on Rex listing the new session before it lists (read-after-write), and
  every sibling would wait for the slowest `rex new` with nothing to gain.
- **A sticky per-group session cache.** A later spawn would add a window to a
  session the user closed in between. The share lasts only while one launch is in
  flight; a later spawn lists again.
- **Trust a joined id without a fallback.** A session closed between the
  publisher's `rex new` and the join would fail a run that, before this change,
  listed and created successfully. A failed join falls back to listing.
- **A cross-process lock under the runs root.** Two concurrent CLI `spawn`
  processes still each create a session. The inbox lock (ADR-0009) shows the cost
  — owner token, staleness steal, crash debris — and the documented delegation
  path is `rex_spawn`, which runs every spawn of a Parent in that Parent's
  process. Recorded as a known limit instead.

## Consequences

Siblings wait for the publisher's `ls` and `new`, so one slow Rex call delays
them up to the Rex-call cap instead of failing alone. A run fails only from its
own Rex calls: a join that fails lists and creates, and a publisher that fails
leaves its waiters to elect a successor. This is not a cache of Rex validation
(ADR-0010): nothing here is trusted beyond the flight of one launch. Runs that
join the publisher report `reusedBatch: true`.
