# District Nerve Center — Bannu · Codex Project Rules

**`CLAUDE.md` in this folder is the authoritative reference. Read it first.**
This file mirrors the same rules for Codex. Where the two ever disagree, `CLAUDE.md`
wins and the discrepancy must be fixed immediately.

---

## Rule 0 — The reference is living (NON-NEGOTIABLE)

Every session that changes anything in this folder **must** update `CLAUDE.md` and append
to `CHANGELOG.md` before finishing.

- File created, deleted, or renamed → update the repository map in `CLAUDE.md` §6.
- Architectural decision → new ADR in `docs/adr/`, update the index in `CLAUDE.md` §3.
- Decision reversed → mark the old ADR `Superseded`, write the replacement, update §3.
- Milestone or task progress → update `CLAUDE.md` §5 and `backlog/todos.md`.
- Dependency added or removed → update `docs/05-stack.md`.
- Open question raised or resolved → update `docs/06-open-questions.md`.

`CHANGELOG.md` is **append-only**. Never edit or delete a past entry. Never write a hollow
entry just to satisfy the rule — if nothing substantive changed, say so instead.

## Read before implementing

| Before you change | Read |
|---|---|
| Anything structural | `docs/00-thesis.md` + the relevant ADR |
| Data, schema, or state | `docs/03-data-model.md`, `ADR-0001` |
| Permissions or overrides | `docs/04-authority-model.md`, `ADR-0003` |
| Sync, queueing, or timers | `docs/02-connectivity-ladder.md`, `ADR-0002` |
| Routing or notifications | `ADR-0004`, `docs/03-data-model.md` |
| Dependencies or infrastructure | `docs/05-stack.md`, `ADR-0007` |
| What to build next | `backlog/todos.md`, `backlog/milestones.md` |

## Engineering rules

- **Do not invent domain facts** about Bannu, its departments, officials, procedures, or
  existing systems. Unverified → `docs/06-open-questions.md`, marked unknown.
- **One source of truth.** Never create a second copy of department data for the central
  dashboard. The central board and a department board are two projections of one log.
- **Never mutate emergency state in place.** Append an event.
- **Authorisation is server-side**, driven by the authority model — never scattered role
  comparisons, never UI-only.
- **SLA and escalation timers are server-side.** A closed laptop must not stop an escalation.
- **Offline is the substrate.** Every client write is a UUID-stamped event in a durable
  local outbox before it is sent. Airplane mode is a required test environment.
- **No AI in the critical path.** It may assist an operator; it never routes, closes, or
  enters the record as fact.
- **No hardcoded secrets, credentials, endpoints with keys, or demo data** in any path.
- **New dependency** requires an answer to: who restarts this when it fails, and how do
  they know it failed?
- Smallest coherent change. No broad rewrite without an ADR.

## The eight invariants

Never break these. Each has a permanent test. Full text in `docs/01-invariants.md`.

1. An emergency is never lost.
2. Stale data is never rendered as current.
3. A notification failure is never invisible.
4. An aggregate never hides a critical.
5. The UI is never the enforcement layer.
6. No sensitive action is unattributable.
7. An SLA clock never runs on a client.
8. Recovery never produces a notification storm.

## Workflow

1. Read the relevant docs and the existing code. Do not assume the current UI is the spec.
2. State your understanding of the task and the files it affects.
3. Check for architecture or data-ownership implications. If there are any, stop and
   raise them before writing code.
4. Implement the smallest complete change.
5. Add or update tests, including any invariant the change touches.
6. Run lint, typecheck, and tests.
7. Review the diff for accidental changes, debug code, secrets, and demo values.
8. **Update `CLAUDE.md` and append to `CHANGELOG.md`** per Rule 0.
9. Report: what changed, what was tested, what acceptance criteria are covered, what
   risks remain.

## Definition of Done

Acceptance criteria demonstrated · tests pass · server-side authorisation verified ·
sensitive actions auditable · offline path defined and tested where writes are touched ·
no unrelated changes · `CLAUDE.md` and `CHANGELOG.md` updated.

## Role in the two-agent workflow

Codex is the primary implementation and discovery agent. Claude acts as the independent
reviewer and red team, checking work against these same documents. Roles may swap for
critical changes. The value comes from independent verification against one shared source
of truth — not from treating either model as automatically correct.
