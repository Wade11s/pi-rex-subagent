## Project

`rex-subagent` is a Pi extension plus a CLI. `src/index.ts` is the extension entry (widget, cleanup audit, `before_agent_start` reminder), `src/cli.ts` is the `rex-subagent` bin, and `src/child.ts` is the small extension loaded into every child Pi.

TypeScript runs directly on Node 22.19+ — there is no build step and no `dist/`. Relative imports carry the `.ts` extension; `tsc` is typecheck-only (`noEmit`, `strict`, `noUncheckedIndexedAccess` on for `src`). Indentation is tabs, quotes are double, statements end with semicolons.

## Verify

```sh
npm test           # deterministic: fake Rex + fake Pi fixtures, no server, no LLM
npm run typecheck  # tsc on src (strict) and tests
npm run test:live  # opt-in, needs a real Rex server and real Pi turns; costs API calls
```

There is no CI, so run `npm test` and `npm run typecheck` yourself before claiming a change works. `npm run test:live` is never part of a normal loop.

## Before changing lifecycle or accounting code

Read `ARCHITECTURE.md` (record/status/probe, terminal states, why `stopping` is not terminal, stop and delivery semantics) and `docs/usage-accounting.md` (snapshots, cursors, ownership, finalization). `tests/lifecycle.test.ts`, `tests/record.test.ts` and `tests/accounting.test.ts` encode those rules; when they disagree with a change, the state machine is usually right.

Both documents state contracts; `docs/adr/` defends them. When a rule looks arbitrary, read the ADR before changing it — re-proposing a rejected alternative is the most common mistake in this area.

Keep behaviour documents in sync when behaviour changes: `README.md` speaks to users, `ARCHITECTURE.md` to whoever touches the state machine, `docs/usage-accounting.md` to the accounting contract, and `docs/adr/` to whoever asks why. A contract change that reverses an ADR needs a new ADR, not an edit to the old one.

## Terminology

Terms are defined in `GLOSSARY.md` and nowhere else. Use them as written — `handle`, `record`, `status`, `probe`, `stopping` versus `stopped`, `settled turn`, `confirmed stop`, `fail closed`. Do not introduce synonyms in code, docs, error strings, or issue titles.

## Commits

Imperative subject with a conventional prefix, as the history does: `fix: …`, `feat: …`, `docs: …`, `chore: …`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
