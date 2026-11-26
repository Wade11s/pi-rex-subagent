# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## What exists in this repo today

`GLOSSARY.md` exists and is the vocabulary of record. `docs/adr/` holds the
recorded decisions. `ARCHITECTURE.md` and `docs/usage-accounting.md` are the
contracts those decisions produced, and they state *what must be true* rather
than arguing for it:

- **`ARCHITECTURE.md`** — how the run decides what is true and what is terminal: the record/status/probe trio, `agentState` versus `processState`, terminal states, stop and delivery semantics, probe batching, known limits. Read it before touching `src/lifecycle.ts`, `src/record.ts`, `src/stop-policy.ts`, or `src/child.ts`.
- **`docs/usage-accounting.md`** — the accounting contract: child snapshots, parent baselines and cursors, delta and transaction rules, ownership and adoption, stop and removal, the Goal boundary.
- **`README.md`** — behaviour from a user's side: install/setup, `wait`, `send`, `logs`, "Behaviour that differs from tmux subagents", Tests, Known limits.

Each contract section ends with a `Why:` line naming the ADR that defends it.
Follow that link when a rule looks arbitrary; the rejected alternatives are
there, and re-proposing one of them is the most common review mistake in this
repo.

## ADRs

- [`0001`](../adr/0001-three-sources-of-truth.md) three sources of truth
- [`0002`](../adr/0002-turn-and-process-are-separate-axes.md) the turn and the process are separate axes
- [`0003`](../adr/0003-stopping-is-not-terminal.md) `stopping` is not terminal
- [`0004`](../adr/0004-exit-zero-alone-is-not-success.md) exit zero alone does not prove success
- [`0005`](../adr/0005-parent-owns-usage-cursors.md) the parent persists usage cursors in its own tool results
- [`0006`](../adr/0006-accounting-fails-closed.md) accounting fails closed, and never re-baselines
- [`0007`](../adr/0007-adoption-claims-a-run-once.md) adoption claims a run once, by atomic hard link
- [`0008`](../adr/0008-finalization-is-decided-before-the-stop.md) finalization is decided before the stop
- [`0009`](../adr/0009-inbox-is-at-least-once.md) the inbox is at-least-once, behind an owner-token lock
- [`0010`](../adr/0010-read-paths-cache-rex-validation.md) read paths cache Rex validation; mutating paths do not
- [`0011`](../adr/0011-deepen-four-shallow-seams.md) deepen four shallow seams (the current refactor programme)

A new ADR needs all three: the decision is hard to reverse, a future reader
would wonder why, and there were real alternatives. Otherwise it is a
convention — put it in `AGENTS.md`.

`GLOSSARY.md` is the only place terms are defined. Take `record`, `status`, `probe`, `handle`, the four `agentState` values, the five `processState` values, `stopping` (not terminal) versus `stopped`/`exited`/`gone`/`failed` (terminal), `settled turn` (the agent finished, the process did not) and `fail closed` from there, and do not invent synonyms.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
