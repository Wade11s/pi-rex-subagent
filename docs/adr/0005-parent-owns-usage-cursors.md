# The parent persists usage cursors in its own tool results

The child publishes cumulative Usage snapshots; the parent charges only the
delta past a cursor it durably stores in the `details` of its own tool result.
Pi persists those results, so accounting survives parent restarts and branch
replay without a Rex-side ledger.

## Considered Options

- **Let the child push usage into the parent.** A child cannot be trusted to
  report a delta it computes about itself, and the parent would still have to
  persist what it charged.
- **A Rex-side accounting store.** It adds a fourth source of truth for state
  that already has a durable, replayable home in the session branch.
- **Recompute from the child's session log.** It would make the parent parse a
  child's private session format, which this provider exists to avoid.

## Consequences

A cursor is per run, per branch. Cursors are only as good as branch replay:
abandoned branches are ignored, and a branch that inherits a spawn but not an
observation resumes from the zero baseline.
