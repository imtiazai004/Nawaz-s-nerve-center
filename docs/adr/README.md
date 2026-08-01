# Architecture Decision Records

One file per decision. **Never delete or rewrite an ADR** — if a decision changes, mark
the old one `Superseded by ADR-xxxx` and write a new one.

The point of an ADR is not to record what we decided. It is to record *why*, and what we
gave up — so that in six months, when someone asks "why is it built this way?", the answer
exists and is honest about its trade-offs.

---

## Index

| # | Decision | Status | Reversal cost |
|---|---|---|---|
| [0001](ADR-0001-event-log-as-record.md) | The event log is the record; state is a projection | Accepted | **Very high** — total rewrite after data exists |
| [0002](ADR-0002-offline-first.md) | Offline is the substrate, not a later phase | Accepted | **Very high** — retrofitting is a rewrite |
| [0003](ADR-0003-declarative-authority.md) | Ownership and override are data, not `if` statements | Accepted | High — every authorisation site |
| [0004](ADR-0004-duty-seats.md) | Route to a duty seat, not to a department | Accepted | High — identity and permission model |
| [0005](ADR-0005-silence-is-a-signal.md) | Absence of reports is never rendered as "normal" | Accepted | Medium — projection semantics |
| [0006](ADR-0006-report-vs-incident.md) | One incident, many reports | Accepted | High — core entity split |
| [0007](ADR-0007-boring-stack.md) | Boring, single-node, operable at 02:00 | Accepted | Medium — replaceable per layer |
| [0008](ADR-0008-causal-event-ordering.md) | Events carry a causal sequence, not just timestamps | Accepted | Medium — only before real data exists |

---

## Template

```markdown
# ADR-XXXX — <Title>

**Status:** Proposed | Accepted | Superseded by ADR-YYYY
**Date:** YYYY-MM-DD
**Reversal cost:** Low | Medium | High | Very high

## Context
What situation forces a decision? What constraints are real?

## Decision
What we are doing. Stated plainly, in the present tense.

## Rationale
Why this and not the obvious alternative.

## Consequences
### We gain
### We give up
### We must therefore also

## Alternatives considered
What else was on the table, and why it lost.

## How we would know this was wrong
The observable signal that should make us revisit. Be specific.
```

The last section is not optional. A decision with no falsification condition is a belief,
not an engineering choice.
