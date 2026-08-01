# Todos

Live task list. **Update status as work completes** — this file and `CLAUDE.md` §5 are how
the next session knows where things stand.

**Status:** `TODO` · `DOING` · `BLOCKED` · `DONE`

---

## Before M0 — unblock

These are not engineering tasks. They are phone calls and meetings, and they gate real
work. See `docs/06-open-questions.md`.

| # | Task | Status | Notes |
|---|---|---|---|
| P-01 | Confirm who formally owns this system (Q-05) | `DONE` | District administration — DC office and/or AC HQ office. An office, not a person, so it survives transfers |
| P-02 | Establish who maintains it after handover (Q-03) | `DONE` | Same answer. Confirms `05-stack.md` rather than changing it |
| P-03 | Find out whether Rescue 1122 already runs a dispatch system (Q-01) | `DONE` | Yes, and it does not matter — the district runs independently |
| P-04 | Establish legal basis for holding citizen emergency data (Q-04) | `TODO` | Blocks the **pilot**, not the build. Nothing before M4 touches real citizen data |
| P-05 | Map what each department already reports upward (Q-02) | `DONE` | Reframed as an export target, collected during M1/M2 onboarding |
| P-06 | Ask whether a Bannu place gazetteer already exists (Q-08) | `TODO` | Weeks of work vs a phone call |
| P-07 | Identify a **named technical person** in the DC/AC office, or designate one | `TODO` | M5 handover. The office owning it and someone able to restore a backup at 02:00 are different facts |
| P-08 | Hosting budget and its source | `TODO` | Decides cloud VM vs on-premise. Built so either works, so it is a deployment-time fork |

---

## M0 — The Spine

**Goal:** one report, from a phone with no signal, all the way to a closed incident with a
complete audit trail.

**Not in M0:** styling, maps, a second department, multiple notification channels,
analytics, public reporting. Anything that is not the spine is a distraction from proving
the spine.

### Foundation

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-01 | Repository scaffold, TypeScript, lint, format, test tooling | `DONE` | — | `npm run check` green: typecheck, lint, format, 32 tests |
| M0-02 | Postgres + migration framework + local dev setup | `DONE` | — | Portable PG 17.10 on :5433, `scripts/dev-db.ps1`, forward-only migration runner |
| M0-03 | Structured logging with correlation ids; health endpoint | `TODO` | M0-02 | Health endpoint returns dependency status |
| M0-04 | CI: lint, typecheck, test on every commit | `TODO` | M0-01 | Red build blocks merge |
| M0-05 | Secret handling: env template, secret store, nothing in repo | `DOING` | M0-01 | `.env.example`, `.env` gitignored and verified unstaged. Real secret store pending deployment |

### The event core — `ADR-0001`

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-06 | `IncidentEvent` table: append-only, client UUID, dual timestamps | `DONE` | — | **UPDATE, DELETE and TRUNCATE all raise at the database.** Tested |
| M0-07 | Event append API with idempotency on `event_id` | `DONE` | M0-06 | Same event twice = one row, no error. Partially-synced batches append only what is missing |
| M0-08 | `incident_current` projection + fold logic | `DONE` | — | `app/src/domain/incident.ts`; every event type covered |
| M0-09 | Projection rebuild from log | `DONE` | M0-08 | State from the database matches state folded in memory, override provenance included |
| M0-10 | Point-in-time replay — state as of any timestamp | `DONE` | M0-08 | Both `knownAt` (what we saw) and `happenedBy` (what was true) |
| M0-11 | Event payload versioning from the start | `DOING` | M0-06 | `payload_version` column exists; no v2 reader yet |
| M0-40 | **Causal event ordering** — `clientSeq` + `seq` | `DONE` | M0-06 | New. `ADR-0008`. Found by an integration test; the old comparator was deterministic but causally wrong |

### Offline substrate — `ADR-0002`

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-12 | PWA shell + service worker | `TODO` | M0-01 | Installs on Android; loads with no network |
| M0-13 | IndexedDB durable outbox | `TODO` | M0-12 | Survives process kill and device restart |
| M0-14 | Write path: local persist → then sync, never the reverse | `TODO` | M0-13, M0-07 | No write path bypasses the outbox |
| M0-15 | Pending state in UI — never a checkmark until server-confirmed | `TODO` | M0-13 | Visually distinct; outbox count visible |
| M0-16 | Sync on reconnect, ordered, idempotent | `TODO` | M0-14 | 50 queued events replay once, in order |
| M0-17 | `occurred_at` / `recorded_at` semantics + gap flagging | `TODO` | M0-06 | Late arrival tagged; measurement uses occurred_at |

### Identity, seats, authority — `ADR-0003`, `ADR-0004`

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-18 | Person / Seat / DutyAssignment model | `DOING` | M0-02 | `Seat` and tiers defined in `authority.ts`; roster needs persistence |
| M0-19 | Server-side session auth, seat-scoped | `BLOCKED` | M0-02 | Revocation is immediate |
| M0-20 | `AuthorityRule` table + evaluation | `DONE` | — | `app/src/domain/authority.ts`. Rules are data; move to DB with M0-02 |
| M0-21 | Authority tests generated per policy row | `DONE` | M0-20 | Every row exercised: owner allowed, outsider refused |
| M0-22 | Override as event, with reason; provenance in projection | `DONE` | M0-20, M0-08 | Original value survives; a later department reassessment cannot silently undo it |
| M0-23 | Direct-API authorisation tests (INV-05) | `BLOCKED` | M0-02 | Needs an API to call. Domain-level refusals already tested |

### The lifecycle

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-24 | Report entity + intake endpoint that never rejects | `TODO` | M0-06 | No input produces a silent drop (INV-01) |
| M0-25 | Report → Incident linking (manual for M0) | `TODO` | M0-24 | New report creates or links to an incident |
| M0-26 | Triage: severity + category as events | `TODO` | M0-07 | — |
| M0-27 | Routing to one department, one seat | `TODO` | M0-18, M0-26 | Routes to the current duty holder |
| M0-28 | Acknowledgement by duty seat | `TODO` | M0-27 | Records actor + seat held at that moment |
| M0-29 | **Server-side SLA timer + escalation** (INV-07) | `DOING` | M0-28 | **Decision logic done and tested** in `app/src/domain/sla.ts`, including late-arrival grace. Needs the durable job queue from M0-02 to actually fire |
| M0-30 | Reassignment by control room, with reason | `TODO` | M0-22 | Auditable; owning department notified |
| M0-31 | Resolve and close with evidence | `TODO` | M0-07 | — |
| M0-32 | One notification channel with tracked delivery state (INV-03) | `TODO` | M0-27 | Failure is visible, not a log line |

### Views

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-33 | Central board — all active incidents, unstyled | `TODO` | M0-08 | One projection, not a copy |
| M0-34 | Department board — same log, scoped by authority | `TODO` | M0-08, M0-20 | Provably the same source as M0-33 |
| M0-35 | Incident detail with full event history and provenance | `TODO` | M0-22 | Every value answers "who set this, when, why" |
| M0-36 | Rapid intake form — three fields, offline-capable | `TODO` | M0-14 | Timed; establishes the 15s baseline for M1 |

### Operations

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-37 | Automated backup | `TODO` | M0-02 | Runs on schedule, verified non-empty |
| M0-38 | **Restore drill, actually performed** | `TODO` | M0-37 | Executed end to end, timed, documented |
| M0-39 | Invariant test suite scaffold (INV-01…08) | `DOING` | M0-04 | INV-04, 06, 07, 08 covered in `__tests__/invariants.test.ts`. INV-01, 02, 03, 05 need persistence and an API — the gap is recorded in that file's header so it stays visible |

---

## Gate check — M0

All must pass before M1 starts:

- [ ] Report submitted in airplane mode reaches the server after reconnect, exactly once
- [ ] Projections dropped and rebuilt from the log produce identical results
- [ ] Incident state reconstructable at any past timestamp
- [ ] Escalation fires with every client closed
- [ ] Central override preserves and displays the department's original value
- [ ] Every mutation refuses unauthorised direct API calls
- [ ] Restore from backup performed successfully, end to end
- [ ] `CLAUDE.md` §5 and `CHANGELOG.md` reflect the true state

---

## Where M0 stands

**Done: the domain core and the event store.** The fold, the authority model, the SLA
timing logic, and a real PostgreSQL event store with append-only enforced by database
triggers. 49 tests pass, 17 of them against the real database. `npm run check` is green and
stable across repeated runs.

**Nothing is blocked any more.** Q-03 and Q-05 are answered — the district administration
(DC office / AC HQ office) owns and maintains it, which confirms the stack rather than
changing it. Q-04 still blocks the **pilot**, but nothing before M4 touches real citizen
data, so it does not block the build.

**Next, and it is the piece that matters most: the offline outbox (M0-12 to M0-17).** The
event store can receive a synced batch; nothing produces one yet. Until a report survives
airplane mode all the way to the server, the central claim of this project is unproven.

**One design flaw already found and fixed** — see `ADR-0008`. It was invisible to the pure
domain tests and only appeared against a real database. This is precisely why the plan
says build the spine early rather than writing more documents.

**Deliberately not faked.** No in-memory stub stands in for Postgres, anywhere. A stub
cannot demonstrate durability or genuine immutability, and INV-01 is exactly the claim that
nothing is ever lost.

## M1 and beyond

Decomposed when M0's gate passes — not before. Task lists written far ahead of the code
they describe are fiction, and they encourage building to a stale plan instead of to what
M0 actually taught us.

Milestone definitions and gates: [`milestones.md`](milestones.md).
