# Adoption claims a run exactly once, by atomic hard link

An unowned run is claimed by writing a complete `.accounting-owner.json`
temporary file and publishing it with a no-overwrite hard link. The first
complete claim wins across independent parent processes; later adopters re-read
it and receive an error, so a losing parent can never charge the winner's
post-adoption delta.

## Considered Options

- **A lock file with a stale-steal policy.** It reintroduces exactly the
  verify→publish race the inbox lock has to document as a residual risk, and
  there is nothing to steal here because the claim is published whole.
- **Create, then write.** Readers could observe an empty or partial owner.
- **Direct write with an existence check.** It has a create→write window and a
  check→write race.

## Consequences

Filesystems without hard links return a run-level accounting error; there is
deliberately no direct-write fallback. A crash before the link leaves the run
unowned and claimable; a crash after preserves a complete claim; an orphaned
`*.tmp-*` file is not a claim and readers ignore it.
