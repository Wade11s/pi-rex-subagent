# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## What exists in this repo today

`GLOSSARY.md` exists and is the vocabulary of record. `docs/adr/` does not exist yet. `ARCHITECTURE.md` and `docs/usage-accounting.md` are the authoritative design material, and they explain *why* the glossary's distinctions exist:

- **`ARCHITECTURE.md`** — how the run decides what is true and what is terminal: the record/status/probe trio, `agentState` versus `processState`, terminal states, stop and delivery semantics, probe batching, known limits. Read it before touching `src/lifecycle.ts`, `src/record.ts`, `src/stop-policy.ts`, or `src/child.ts`.
- **`docs/usage-accounting.md`** — the accounting contract: child snapshots, parent baselines and cursors, delta and transaction rules, ownership and adoption, stop and removal, the Goal boundary.
- **`README.md`** — behaviour from a user's side: install/setup, `wait`, `send`, `logs`, "Behaviour that differs from tmux subagents", Tests, Known limits.

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
