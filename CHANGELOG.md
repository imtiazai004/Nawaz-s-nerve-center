# Changelog

Append-only project history. **Never edit or delete a past entry.** Newest at the bottom,
so the file reads in the order things actually happened.

Every session that changes anything in this folder appends one entry. Format:

```
## YYYY-MM-DD — <short title>
- **Added:**    <what came into existence>
- **Changed:**  <what was modified, and why>
- **Removed:**  <what was deleted, and why>
- **Decided:**  <ADR-xxxx, if a decision was made>
- **Open:**     <questions raised or resolved>
```

Omit lines that do not apply. Do not write hollow entries to satisfy the rule — if nothing
substantive changed, say so in the session summary instead.

---

## 2026-08-01 — Project established

- **Added:** `Build with Claude/` folder created as the working home for the Claude-led
  design and build track, alongside the existing engineering handbook in the parent folder.
- **Added:** `CLAUDE.md` — the living build reference, with Rule 0 requiring it to be
  updated on every change.
- **Added:** `AGENTS.md` — the same rules mirrored for Codex.
- **Added:** `README.md`, `CHANGELOG.md` (this file).
- **Added:** `docs/00-thesis.md` — the engineering thesis: root idea, seven load-bearing
  decisions, ground truths specific to Bannu, and the reasoning behind the build order.
- **Added:** `docs/01-invariants.md` — the eight things the system must never do, each
  written as a testable prohibition.
- **Added:** `docs/02-connectivity-ladder.md` — five levels of degraded operation from
  full connectivity to total blackout, with the timestamp semantics for each.
- **Added:** `docs/03-data-model.md` — entity sketch and the event catalog.
- **Added:** `docs/04-authority-model.md` — the field-level ownership and override policy.
- **Added:** `docs/05-stack.md` — technology choices, selected for operability.
- **Added:** `docs/06-open-questions.md` — what we do not know yet, with blockers marked.
- **Added:** `docs/adr/` — index, template, and ADR-0001 through ADR-0007.
- **Added:** `backlog/milestones.md` — M0 through M5 with pass/fail gates.
- **Added:** `backlog/todos.md` — M0 decomposed into implementation-sized tasks.
- **Added:** `.claude/settings.json` — Stop hook enforcing Rule 0.
- **Decided:** ADR-0001 event log as the record · ADR-0002 offline as the substrate ·
  ADR-0003 declarative authority · ADR-0004 duty seats over departments · ADR-0005 silence
  is a signal · ADR-0006 report/incident split · ADR-0007 boring operable stack.
- **Open:** All domain facts about Bannu's departments, existing systems, and contacts are
  unverified assumptions. Five blocking questions raised in `docs/06-open-questions.md`,
  the most important being whether Rescue 1122 and Health already run systems we should
  integrate with rather than replace.

## 2026-08-01 — Rule 0 enforcement wired

- **Added:** `.claude/rule0-check.ps1` — Stop hook script. Compares the newest modification
  time under this folder against `CLAUDE.md` and `CHANGELOG.md`; if content is newer, it
  blocks the stop once and names the stale files. Fails open on any error, and nudges at
  most once per session, so a broken hook can never wedge a session or loop.
- **Changed:** `.claude/settings.json` now points at that script via the exec-form `args`
  array rather than a shell string — the folder path contains spaces and must never reach
  a shell parser.
- **Added:** a matching `.claude/settings.json` in the parent `Nawaz/` folder, so Rule 0 is
  enforced whether Claude Code is opened on `Nawaz/` or on `Build with Claude/`. Both
  reference the same script by absolute path.
- **Changed:** `CLAUDE.md` §6 repository map updated to list the script and record the
  dual-settings arrangement, including the note that both paths need updating if this
  folder is ever moved.
- **Verified:** script pipe-tested in both states — blocks when docs are newer than the
  reference, silent on a repeat call within the same session. Both settings files parse and
  resolve to an existing script.

## 2026-08-01 — Independence decided; scope list published

- **Decided:** **No integration with government-issued systems.** Owner's decision. Several
  departments already run government software, and the district wants this platform run
  independently for its own efficiency and control. No API coupling, no dependency on any
  provincial or federal system's availability.
- **Open → Resolved:** Q-01 (does Rescue 1122 already run a dispatch system) and Q-02 (what
  must departments report upward) both closed in `docs/06-open-questions.md`. M1 and M2 are
  unblocked; no interface-discovery work is needed.
- **Changed:** Q-02's answer reframed from integration target to **export target** — the
  system generates the file formats departments must submit upward, without connecting to
  anything. Preserves independence and removes the double-work objection.
- **Open:** New risk recorded, and it is the serious one. Departments already using other
  systems now face **double entry**, which is the most likely cause of adoption failure.
  Two mitigations already in plan: the 15-second rapid-intake budget is now a hard
  requirement rather than an aspiration, and report export turns duplicated work into saved
  work. Bypass rate becomes the decisive adoption metric.
- **Added:** `docs/07-capabilities.md` — plain-language capability list for non-technical
  readers, structured as one emergency's nine-step journey followed by twelve capability
  groups, plus an explicit "deliberately not included" section. This is now the scope
  document: anything not listed there or in `backlog/milestones.md` is out of scope.
- **Added:** published shareable version of the capability list at
  https://claude.ai/code/artifact/3c83fe83-eee2-46c4-b85a-7daacdb3768a
- **Changed:** `CLAUDE.md` §5 gains a "Settled — do not reopen without the owner" subsection
  recording the independence decision and its double-entry consequence; §6 repository map
  updated for the new document; immediate next actions now point at Q-03, Q-04 and Q-05,
  which are the remaining blockers.

## 2026-08-01 — M0 begun: the domain core

- **Decided:** proceed into M0 without waiting for Q-03, Q-04 and Q-05. These are
  organisational questions whose answers take weeks, and waiting produces nothing. The
  mitigation is structural rather than optimistic: the domain core is written as pure logic
  with **no database, no framework and no hosting assumption**, so that no answer to any of
  the three can invalidate it. Recorded in `docs/06-open-questions.md` as an explicit
  "proceeding at recorded risk" note rather than a silently skipped gate.
- **Added:** git repository initialised at the folder root, with `.gitignore` covering
  `node_modules`, build output, and — importantly — `.env` and key material.
- **Added:** `app/` scaffold — TypeScript 5.7 (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), ESLint 9, Prettier, Vitest. One command, `npm run check`,
  runs typecheck, lint, format check and tests.
- **Added:** `app/src/domain/events.ts` — the full event catalog from `03-data-model.md`.
  Every envelope carries `occurredAt` and `recordedAt`, and a client-generated `eventId`
  that doubles as the idempotency key.
- **Added:** `app/src/domain/incident.ts` — the fold. Deterministic ordering (occurred,
  then recorded, then id), duplicate events dropped, and **override provenance**: a district
  override never erases the department's own value, and a later department reassessment
  cannot silently undo an override.
- **Added:** `app/src/domain/authority.ts` — the policy table as data, with break-glass
  (always requires a reason, even for the DC) and authority-then-time conflict resolution.
- **Added:** `app/src/domain/sla.ts` — the timestamp split from ADR-0002 made concrete.
  Measurement uses `occurredAt` so metrics tell the truth; escalation firing uses
  `recordedAt` plus a grace window so a reconnect produces one labelled late-arrival alert
  instead of a retroactive storm.
- **Added:** `app/src/domain/__tests__/` — 32 tests, all passing. Includes permanent
  invariant tests for INV-04 (500 routine incidents cannot hide one critical), INV-06
  (no unattributable action), INV-07 (escalation fires with every client closed) and INV-08
  (replay changes nothing; late arrival gets grace, not a storm).
- **Changed:** `backlog/todos.md` — M0-01, M0-08, M0-09, M0-10, M0-20, M0-21, M0-22 marked
  `DONE`; M0-05, M0-18, M0-29, M0-39 `DOING`; M0-02, M0-06, M0-07, M0-19, M0-23 `BLOCKED`
  on a database. New "Where M0 stands" section states plainly that no in-memory stub will
  stand in for Postgres — a stub would let tasks be marked done while proving nothing about
  durability, which is the one thing INV-01 actually claims.
- **Changed:** `CLAUDE.md` §5 and §6 rewritten for the new state, including a standing
  instruction to keep `npm run check` green and not to fake the database.
- **Open:** Postgres is not installed on this machine and Docker is unavailable. M0-02 and
  everything downstream of it is gated on Q-03 — confirming the deployment target with
  whoever will maintain the system. This is now the single highest-value unblock.
- **Verified:** `npm run check` green — typecheck clean, lint clean, formatting clean,
  32/32 tests passing. Committed as `2666417` with no `node_modules` and no secrets staged.

## 2026-08-01 — Ownership answered; event store on real Postgres

- **Open → Resolved:** Q-03 (who maintains this) and Q-05 (who formally owns this), both
  answered together: **the district administration — the DC office and/or the AC
  Headquarter office.** Source: project owner. Notable for a reason worth recording — it is
  an *office, not a person*, so it survives transfers, which is the same logic as ADR-0004.
- **Changed:** `docs/05-stack.md` status from *proposed* to **confirmed**. DC/AC office IT
  is precisely the small-team profile the stack was chosen for, so the answer validates the
  existing choice rather than changing it.
- **Open:** two practical items carried forward to M5 handover rather than treated as
  answered — whether a **named technical person** exists or must be designated (P-07), and
  **hosting budget and its source** (P-08), which decides cloud VM versus on-premise.
  Building so either works.
- **Added:** local PostgreSQL 17.10, portable binaries under `%LOCALAPPDATA%\dnc-postgres`
  on port 5433. Not a Windows service, no elevation, removable by deleting one folder.
  `scripts/dev-db.ps1` starts, stops and inspects it. The winget package was tried first
  and failed — EnterpriseDB returns HTTP 403 to the automated installer download.
- **Added:** `app/db/migrations/0001_event_store.sql` — the event table with **append-only
  enforced by database triggers**. UPDATE, DELETE and TRUNCATE all raise, so a future
  maintainer writing a well-intentioned UPDATE hits a wall rather than a code review.
- **Added:** `app/src/db/pool.ts` — connection pool, ISO-string timestamp parsing, and a
  deliberately minimal forward-only migration runner. No rollback, no checksums, no
  framework: a mistake is corrected by writing the next migration, the same discipline the
  event log itself follows.
- **Added:** `app/src/db/eventStore.ts` — idempotent append, incident load, sync cursor,
  late-arrival query. **No update method and no delete method exist.** That is the interface
  making ADR-0001 hard to violate by accident.
- **Decided:** [ADR-0008](docs/adr/ADR-0008-causal-event-ordering.md) — events carry a
  causal sequence, not just timestamps. **This came from a real bug an integration test
  caught, and it is the most valuable thing to happen this session.** The original
  comparator ordered by `(occurred_at, recorded_at, event_id)`. An offline batch shares a
  millisecond, and Postgres `now()` is transaction-time so `recorded_at` ties across one
  INSERT — leaving a random UUID to decide order. Four events stored as
  `acknowledged, overridden, reported, triaged`; `triaged` folded after `overridden` and
  silently discarded a district override. The comparator was deterministic, had a passing
  shuffle test, and was wrong. Determinism was never the hard part.
- **Added:** `app/db/migrations/0002_event_ordering.sql` — `client_seq` for causal order
  within a device's batch, `seq` for arrival order. Forward-only: 0001 was not edited.
- **Changed:** the sync cursor from a timestamp to `seq`. Same root cause wearing a
  different hat — a timestamp cursor silently skips every event sharing a `recorded_at`, so
  a client resuming mid-batch would lose the remainder permanently and invisibly.
- **Changed:** `compareEvents` and the SQL `ORDER BY` are now tested against each other
  directly, because a silent divergence between them would be very hard to spot.
- **Added:** 17 integration tests against real PostgreSQL, including a regression test that
  reproduces the ordering bug exactly. Total 49 tests, verified stable across four
  consecutive runs (the original failure was intermittent).
- **Changed:** `backlog/todos.md` — M0-02, M0-06, M0-07, M0-09 now `DONE`; new M0-40 for the
  ordering fix; P-01, P-02, P-03, P-05 closed; P-07 and P-08 added for M5 handover.
  Nothing in M0 is `BLOCKED` any more.
- **Changed:** `CLAUDE.md` — environment setup instructions, updated repository map, ADR-0008
  in the index, and a standing warning to read ADR-0008 before touching event ordering.
- **Verified:** `npm run check` green — typecheck, lint, formatting, 49/49 tests. Committed
  as `8b4d6e5`. `app/.env` confirmed unstaged.
