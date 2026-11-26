# Exit zero alone does not prove success

`waitOutcomeOk` classifies an `exited` run as successful only when the exit code
is `0`, `agentState` was `idle`, at least one turn ran, and no messages were left
queued in the inbox.

## Considered Options

- **The exit code alone.** A TUI closed before the first turn, and Pi dying
  during startup, both exit 0 and both mean the work never happened.
- **Turn count alone.** A run can complete a turn and still leave a follow-up
  unread in the inbox.

## Consequences

The four conditions are asserted together in `tests/lifecycle.test.ts`. A new
way for a run to end has to decide which of the four it satisfies.
