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
| M0-12 | **PWA shell + service worker** | `DONE` | M0-01 | App opens with the network cut; navigations resolve offline; `/sync` and `/health` never cached. 11 tests |
| M0-43 | Connectivity derived from sync outcomes, not `navigator.onLine` | `DONE` | M0-12 | New. Chromium reports `onLine: true` with the network cut — the app was claiming "delivered immediately" during a total outage |
| M0-13 | IndexedDB durable outbox | `DONE` | — | Proven across real page reloads in real Chromium. `clientSeq` and cursor both survive |
| M0-14 | Write path: local persist → then sync, never the reverse | `DONE` | M0-13, M0-07 | `enqueue()` returns once durable, before any network attempt |
| M0-15 | Pending state — never a checkmark until server-confirmed | `DONE` | M0-13 | Entry states `pending`/`inflight`/`blocked`; release only on server confirmation. **UI still owed with M0-36** |
| M0-16 | Sync on reconnect, ordered, idempotent | `DONE` | M0-14 | Batched in operator order; ambiguous retries drain; nothing lost across 20 failed attempts |
| M0-17 | `occurred_at` / `recorded_at` semantics + gap flagging | `DONE` | M0-06 | Server assigns `recorded_at`; a client cannot forge it. Late arrivals queryable |
| M0-41 | Sync protocol and endpoints | `DONE` | M0-07 | New. Strict envelope, permissive payload; one bad event never fails the batch |
| M0-42 | **The M0 gate — offline spine end to end** | `DONE` | all above | New. 14 steps, nothing stubbed. See `app/src/__tests__/spine.e2e.test.ts` |

### Identity, seats, authority — `ADR-0003`, `ADR-0004`

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-18 | Person / Seat / DutyAssignment model | `DONE` | M0-02 | Migration 0003. One current holder per seat enforced by a partial unique index |
| M0-19 | Server-side session auth, seat-scoped | `DONE` | M0-02 | Token never stored, only its SHA-256. Revocation instant; seat re-resolved every request |
| M0-44 | Actor identity stamped server-side | `DONE` | M0-19 | New. Closes impersonation: a client claiming the DC seat is discarded |
| M0-20 | `AuthorityRule` table + evaluation | `DONE` | — | `app/src/domain/authority.ts`. Rules are data; move to DB with M0-02 |
| M0-21 | Authority tests generated per policy row | `DONE` | M0-20 | Every row exercised: owner allowed, outsider refused |
| M0-22 | Override as event, with reason; provenance in projection | `DONE` | M0-20, M0-08 | Original value survives; a later department reassessment cannot silently undo it |
| M0-23 | Direct-API authorisation tests (INV-05) | `DONE` | M0-19 | 25 tests, every refusal by direct HTTP call — never through the UI |

### The lifecycle

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-24 | Report entity + intake endpoint that never rejects | `TODO` | M0-06 | No input produces a silent drop (INV-01) |
| M0-25 | Report → Incident linking (manual for M0) | `TODO` | M0-24 | New report creates or links to an incident |
| M0-26 | Triage: severity + category as events | `TODO` | M0-07 | — |
| M0-27 | Routing to one department, one seat | `TODO` | M0-18, M0-26 | Routes to the current duty holder |
| M0-28 | Acknowledgement by duty seat | `TODO` | M0-27 | Records actor + seat held at that moment |
| M0-29 | **Server-side SLA timer + escalation** (INV-07) | `DONE` | M0-28 | Scanner + scheduler behind a Postgres advisory lock. Walks the seat ladder; vacant posts flagged, never swallowed. 18 tests |
| M0-45 | Escalation scan is starvation-free | `DONE` | M0-29 | New. Oldest-first ordering; hitting the scan cap is reported, not absorbed |
| M0-46 | Process entry point with ordered shutdown | `DONE` | M0-29 | New. `src/main.ts` — one deployable, structured logs, health endpoint |
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

- [x] Report submitted in airplane mode reaches the server after reconnect, exactly once
- [x] Projections dropped and rebuilt from the log produce identical results
- [x] Incident state reconstructable at any past timestamp
- [x] Escalation fires with every client closed
- [x] Central override preserves and displays the department's original value
- [x] `CLAUDE.md` §5 and `CHANGELOG.md` reflect the true state
- [x] **The app opens with no network** — M0-12
- [x] **Every mutation refuses unauthorised direct API calls** — M0-19, 25 tests
- [ ] Restore from backup performed successfully, end to end — M0-38, needs someone who is
      not the original developer

Seven of eight. The one open item needs another person, not more code — a restore procedure
that has only ever been performed by the person who wrote it is not a backup strategy.

---

## Where M0 stands

**The gate has passed.** `app/src/__tests__/spine.e2e.test.ts` walks one critical emergency
through 14 steps with nothing stubbed: captured on a handset with the network genuinely
cut, committed to storage rather than memory, surviving a full document teardown,
delivering itself on reconnect with no operator action, escalating server-side while
unacknowledged, overridden by the control room without erasing the department's own
assessment, resolved, closed — and then proof that the history cannot be rewritten and any
past moment can be reconstructed as it was seen then.

Real Chromium, real IndexedDB, Playwright cutting the network at the driver level, real
HTTP, real PostgreSQL. 100 tests pass.

**M0-12 has landed**, so gate step 4 is now the real test: the handset is closed and
reopened **with the network still cut**, and the app opens from the service worker cache.
It previously had to be weakened to restore connectivity first.

**Six things were found by building rather than planning**, and none would have shown up
in a design document:

1. `ADR-0008` — event ordering that was deterministic and causally wrong. Invisible to the
   pure domain tests, obvious against a real database with real transaction semantics.
2. A test-infrastructure fault where two Chromium suites shared a worker: a teardown crash
   hid ten results behind a run that reported success.
3. The app trusted `navigator.onLine`, which Chromium reports as `true` with the network
   cut — the same thing a handset on a tower with dead backhaul does. It displayed
   *"Connected. Reports are delivered immediately"* during a total outage.
4. **`verifyPassword` accepted any password against a corrupted hash row.** Base64-decoding
   garbage yields an empty buffer, scrypt asked for a zero-length key returns one too, and
   `timingSafeEqual(empty, empty)` is `true`. One bad row would have opened an account
   completely.
5. `Outbox.sync()` handed an overlapping caller a fabricated `{ offline: false }` — a
   connectivity claim nothing had measured, feeding the same lie to the UI as (3). The old
   test even encoded the bug in its assertion.
6. **The escalation scan could starve an emergency indefinitely.** It took an arbitrary
   `LIMIT` of the open set with no ordering, so once a district had more open incidents
   than the cap, *which* ones got scanned was down to whatever order Postgres returned. An
   incident could lose that lottery on every pass, forever, with nothing reporting a
   problem. Now oldest-first, and hitting the cap is surfaced.

**Deliberately not faked, anywhere.** No in-memory Postgres, no `fake-indexeddb`, no mocked
network. Each would satisfy its interface and prove nothing about the one property that
matters — that an emergency is never lost.

## M1 and beyond

Decomposed when M0's gate passes — not before. Task lists written far ahead of the code
they describe are fiction, and they encourage building to a stale plan instead of to what
M0 actually taught us.

Milestone definitions and gates: [`milestones.md`](milestones.md).
