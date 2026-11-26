# Three sources of truth, and no fourth

Every run is described by exactly three independent sources, each with its own
lifetime: the parent-written `metadata.json` record, the child-written
`status.json` status, and an on-demand Rex probe. `usage.json` is a separate
accounting contract and is deliberately not lifecycle truth.

## Considered Options

- **One merged state file.** A single writer would have to serialise two
  processes that can only observe different things, and a child that dies
  cannot update it.
- **The status file as truth.** The child cannot know its own OS exit code, and
  a stale `busy` would outlive the process.
- **The probe as truth.** Rex is unreachable often enough that every read would
  fail, and it knows nothing about turns.

## Consequences

`observeRun` is the only place that merges them, by fixed precedence. A new
field must be assigned to exactly one source, and adding a fourth source
requires reopening this ADR.
