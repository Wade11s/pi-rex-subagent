# Accounting fails closed on conflict, and never re-baselines

Malformed, regressed or conflicting accounting input refuses the operation and
keeps the durable record. The provider never clamps, guesses, or silently resets
to a new zero baseline.

## Considered Options

- **Clamp a negative delta to zero.** It hides a real regression, then charges
  the remainder twice on the next observation.
- **Re-baseline on a generation change.** It would silently discard the work
  between the last observation and the change.

## Consequences

A changed child session, a changed generation, a lower sequence, a negative
component delta, a vanished optional component, or any payload after a final
snapshot all fail closed. A malformed tool-result payload degrades per run: only
the runs it names lose their cursors, and a later valid result restores them. If
a malformed payload names no run, the whole selected branch fails closed, because
falling back to an older cursor could double-charge.
