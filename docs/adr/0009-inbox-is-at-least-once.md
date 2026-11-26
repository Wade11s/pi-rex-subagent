# The inbox is at-least-once, behind an owner-token lock

A message is one JSON file written atomically as `inbox/NNNN.json`. The child
consumes files in index order and unlinks each after handing it to Pi, so a
message is delivered at least once. Two concurrent senders are serialised by
`inbox/.lock`: an `O_EXCL` file carrying a unique owner token, with a 10 s
staleness steal.

## Considered Options

- **SQLite or a lockfile database.** It adds a dependency for one ordered queue
  whose only writers are short-lived CLI processes.
- **`O_EXCL` without an owner token.** A holder that was stolen from would then
  delete its successor's lock and publish under it.
- **Rename without a lock.** POSIX `rename` would let the second sender silently
  overwrite the first.

## Consequences

The verify→rename gap is an accepted residual risk, recorded in
`ARCHITECTURE.md`; a strictly guaranteed lock would need a heartbeat or
`flock`. Sends to a provably dead run are rejected. A send while Rex is
unreachable is queued and reported `unconfirmed`. Indexes order the files present
in the inbox and are not message identities, so a number may be reused once after
a crash.
