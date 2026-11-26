# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Labels in this tracker today

`Wade11s/pi-rex-subagent` as of 2026-11-26. All five roles map 1:1 to a label of the same name.

| Label | Color | Description | Origin |
| --- | --- | --- | --- |
| `needs-triage` | `#fbca04` | Maintainer needs to evaluate this issue | created by setup |
| `needs-info` | `#d4c5f9` | Waiting on reporter for more information | created by setup |
| `ready-for-agent` | `#0e8a16` | Ready for agent implementation | pre-existing |
| `ready-for-human` | `#1d76db` | Requires human implementation | created by setup |
| `wontfix` | `#ffffff` | This will not be worked on | pre-existing (GitHub default) |

A `ready-for-agent` issue should name the files it touches, because this repo's lifecycle rules live in `ARCHITECTURE.md` and an agent that skips it will get `stopped` versus `stopping` wrong.
