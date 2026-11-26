# The agent's turn and the OS process are separate axes

`agentState` (`starting | busy | idle | stopped`) comes from the child's status
file; `processState` (`starting | running | exited | gone | unknown`) comes from
the Rex probe. The child never writes an exit code: a settled turn says the
agent finished, not that the process did.

## Considered Options

- **The child reporting `lastExit: 0` on shutdown.** Removed. It fabricated a
  clean exit the process never had, and made a crashed run look finished.
- **One combined state string.** It hides the case that matters most: an `idle`
  agent whose process is gone, and a `busy` agent that has already died.

## Consequences

`processExitCode` is knowable only after the process ends, and only from Rex.
Anything that must distinguish "finished its turns" from "the window closed"
has to read both axes.
