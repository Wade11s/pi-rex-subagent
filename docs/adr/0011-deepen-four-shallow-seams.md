# Deepen four shallow seams

The run directory's layout is knowledge spread over six modules, the inbox
contract is implemented twice across the process seam, a spawn knob is declared
in five enumerations, and the accounting-aware stop's ordering lives inline in
one tool handler. Each is deepened behind one interface, in that order, without
changing behaviour.

## Considered Options

- **Leave them.** Each is correct today. The cost is paid on every change: a
  knob, a run-directory file, or a finalization rule each require edits in five
  to twelve places that no compiler connects.
- **Deepen everything at once.** The four seams overlap on `record.ts`,
  `lifecycle.ts` and `accounting-tools.ts`; a single diff would make the
  behaviour-preserving claim untestable.

## Decisions

- **Order: inbox, finalization, spawn spec, run directory.** The two cheap,
  independent seams land first; the run directory's 150–200 test call sites land
  last so its churn cannot block anything else.
- **`inbox.ts` owns the whole inbox** — lock, `.seq`, enqueue, next, pending —
  because the parent and the child need the same naming and numbering contract.
  `record.ts` re-exports; the child imports the narrow module.
- **`finalizeStop` composes `stopRun`** rather than absorbing the sentinel and
  close. That reliability code carries six tests and the client-timeout-but-
  server-executed case; a structural refactor must not rewrite it.
- **Two axes, one situation.** The `observe` options encode two independent
  facts — may a missing snapshot be tolerated, may a non-final snapshot be
  charged — and `rex_wait` uses the first without the second. The caller passes
  one situation (`live`, `terminal`, `undeterminable`); the module derives both
  axes per handle.
- **The CLI `stop` stays a management operation.** Making it accounting-aware
  would add a 15 s wait to the path a user reaches for when a child is wedged,
  and would change a documented contract.
- **Layout in the run directory, encoding in the existing functions.** The
  `runDir` value answers for paths; `parseRecord`, `parseStatus`, `parseUsage`
  and `writeRecord` stay the codecs they are. `runDirFor` therefore survives as
  the layout's single source of truth.
- **A codec's own path helper is not a duplicate accessor.** The first draft of
  this decision named `readUsageSnapshot(dir)`, `usageSnapshotPath(dir)` and
  `readRecordFrom(dir)` for deletion. They are not dead: each is the internal
  helper of a codec that publishes or parses those files, and the run-directory
  value delegates to them. Deleting them would move the codecs into the value
  and invert the layering above. What was actually retired is `readStatus(dir)`,
  whose only caller became the value, plus `readTranscript`, which nothing ever
  wrote.
- **The run directory has two constructors.** The parent derives it from a
  handle; the child is handed one. Collapsing them would let an `--env
  PI_CODING_AGENT_DIR` override silently move the directory the child reads
  while `status`, `stop` and `usage` stay put.
- **A spawn knob is declared once.** `spawn-spec.ts` holds the data;
  `buildPiArgs`, `parseArgs` and the `--help` spawn section derive from it.
  README and the skill stay hand-written: they carry judgement, not inventory.
- **Behaviour changes ship separately.** Adding the four `no*` knobs to
  `rex_spawn`, and tightening the inbox to four-digit names, are their own
  commits after the structure lands, so a green suite there means "nothing
  changed" rather than "nothing broke that we noticed".

## Consequences

Every structural commit keeps the existing test suite green by construction. The
acceptance criterion for each seam is that the suite passes without a single
assertion changing.
