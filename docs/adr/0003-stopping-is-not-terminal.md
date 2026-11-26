# `stopping` is not terminal

`failed`, `stopped`, `gone` and `exited` are terminal. `stopping` means the
child saw the stop sentinel and aborted its turn while the OS process is still
alive, so a wait keeps polling.

## Considered Options

- **Treat the child's `status: stopped` as a confirmed stop.** It is not. The
  child aborting its own turn is a request, not proof the process ended.
- **Treat `stopping` as terminal and stop waiting.** It would report a stop the
  user cannot verify, and could orphan a live process.

## Consequences

The record is marked `stopped` only after Rex confirmed the close, or a probe
proved the block gone. A `stopping` run whose process then ends is reported as
a completed stop carrying the real exit code, not as an incidental crash.
