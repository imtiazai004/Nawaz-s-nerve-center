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
| P-01 | Confirm who formally owns this system (Q-05) | `TODO` | Determines whether departments will accept central override at all |
| P-02 | Establish who maintains it after handover, and what they can run (Q-03) | `TODO` | **Blocks stack confirmation, and therefore M0** |
| P-03 | Find out whether Rescue 1122 already runs a dispatch system (Q-01) | `TODO` | Blocks M1. Integration beats replacement |
| P-04 | Establish legal basis for holding citizen emergency data (Q-04) | `TODO` | Blocks the pilot |
| P-05 | Map what each department already reports upward (Q-02) | `TODO` | Blocks M2 onboarding design |
| P-06 | Ask whether a Bannu place gazetteer already exists (Q-08) | `TODO` | Weeks of work vs a phone call |

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
| M0-01 | Repository scaffold, TypeScript, lint, format, test tooling | `TODO` | P-02 | Fresh clone installs and runs all checks clean |
| M0-02 | Postgres + migration framework + local dev setup | `TODO` | M0-01 | Migrations run deterministically from empty |
| M0-03 | Structured logging with correlation ids; health endpoint | `TODO` | M0-01 | Health endpoint returns dependency status |
| M0-04 | CI: lint, typecheck, test on every commit | `TODO` | M0-01 | Red build blocks merge |
| M0-05 | Secret handling: env template, secret store, nothing in repo | `TODO` | M0-01 | Secret scan passes; no key in frontend bundle |

### The event core — `ADR-0001`

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-06 | `IncidentEvent` table: append-only, client UUID, dual timestamps | `TODO` | M0-02 | Insert-only enforced at DB level, not just in code |
| M0-07 | Event append API with idempotency on `event_id` | `TODO` | M0-06 | Same event twice = one row, no error |
| M0-08 | `incident_current` projection + fold logic | `TODO` | M0-06 | State matches expected fold for every event type |
| M0-09 | Projection rebuild from log | `TODO` | M0-08 | **Drop all projections, rebuild, assert identical** |
| M0-10 | Point-in-time replay — state as of any timestamp | `TODO` | M0-08 | Reconstructs state at an arbitrary past moment |
| M0-11 | Event payload versioning from the start | `TODO` | M0-06 | v1 events readable after a v2 is introduced |

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
| M0-18 | Person / Seat / DutyAssignment model | `TODO` | M0-02 | "Who holds seat X now" answerable |
| M0-19 | Server-side session auth, seat-scoped | `TODO` | M0-18 | Revocation is immediate |
| M0-20 | `AuthorityRule` table + evaluation | `TODO` | M0-18 | Rules are data, editable without deploy |
| M0-21 | Authority tests generated per policy row | `TODO` | M0-20 | Owner writes; authority overrides; others refused |
| M0-22 | Override as event, with reason; provenance in projection | `TODO` | M0-20, M0-08 | Original value survives and renders |
| M0-23 | Direct-API authorisation tests (INV-05) | `TODO` | M0-20 | Every refusal tested outside the UI |

### The lifecycle

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-24 | Report entity + intake endpoint that never rejects | `TODO` | M0-06 | No input produces a silent drop (INV-01) |
| M0-25 | Report → Incident linking (manual for M0) | `TODO` | M0-24 | New report creates or links to an incident |
| M0-26 | Triage: severity + category as events | `TODO` | M0-07 | — |
| M0-27 | Routing to one department, one seat | `TODO` | M0-18, M0-26 | Routes to the current duty holder |
| M0-28 | Acknowledgement by duty seat | `TODO` | M0-27 | Records actor + seat held at that moment |
| M0-29 | **Server-side SLA timer + escalation** (INV-07) | `TODO` | M0-28 | **Fires with every client closed** |
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
| M0-39 | Invariant test suite scaffold (INV-01…08) | `TODO` | M0-04 | Each invariant has at least one failing-if-broken test |

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

## M1 and beyond

Decomposed when M0's gate passes — not before. Task lists written far ahead of the code
they describe are fiction, and they encourage building to a stale plan instead of to what
M0 actually taught us.

Milestone definitions and gates: [`milestones.md`](milestones.md).
