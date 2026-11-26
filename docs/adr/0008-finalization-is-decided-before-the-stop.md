# Finalization is decided before the stop, not while recovering

The durable `usageFinalizationRequired` marker is persisted only when the run was
reliably live immediately before the stop. A later attempt whose pre-stop state
is provably terminal may instead collect the last valid non-final snapshot as
`finalization: "unconfirmed"`. The parent waits 15 s for a final snapshot,
deliberately longer than the child's 10 s stop grace.

## Considered Options

- **Always persist the marker.** A failed describe or an `unknown` display state
  would poison collection for a child that is already dead.
- **Never persist it.** A live stop that loses its final snapshot would have no
  retry path, so the usage would be unrecoverable by design rather than by
  accident.
- **Equal timeouts.** The child's grace bounds when it stops being graceful; the
  parent's wait is a floor for not preempting a healthy slow settlement.

## Consequences

An undeterminable pre-stop state fails closed for that attempt only. Removal
requires both a confirmed stop and a successful final or unconfirmed
observation. A terminal run that never published `usage.json` finishes with a
sequence-zero `snapshot: "missing"` cursor: bookkeeping for zero recoverable
usage, never a claim that no work happened. Once recorded, a later-appearing
snapshot is rejected rather than charged as unknown history.
