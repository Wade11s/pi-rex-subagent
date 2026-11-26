# Read paths cache Rex validation; mutating paths never do

`status`, `list` and `wait` cache a successful `rex whoami` for 10 s per runner
and endpoint, bound probes to 6 at a time, and make `wait` bound every Rex call
by the remaining deadline. `stop` and `open` always validate uncached.

## Considered Options

- **Validate on every probe.** `status` used to run one `whoami` plus one probe
  per run, serially: the cost is linear in run count for a value that changes
  rarely.
- **Cache everywhere.** It would let `stop` act against a server that changed
  seconds ago, which is the one place a stale answer causes damage.
- **Cache failures.** A transient Rex outage would then persist for the TTL.

## Consequences

Widgets pass `probe: false` and read local files only, so they can briefly show
a stale `busy`/`idle` for a process that just died; the next probing command
corrects it.
