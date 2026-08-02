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
| P-04 | Establish legal basis for holding citizen emergency data (Q-04) | `DONE` | The district administration is legally empowered to record, hold, act on and respond to any emergency in the district. Owner, 2026-08-02. **Retention limits and read-access rules remain ours to design** — being allowed to hold data is not a decision about how long, or who may look |
| P-05 | Map what each department already reports upward (Q-02) | `DONE` | Reframed as an export target, collected during M1/M2 onboarding |
| P-06 | Ask whether a Bannu place gazetteer already exists (Q-08) | `DROPPED` | Owner: do not go to that depth. Location capture already works without it (M0-48) |
| P-07 | Identify a **named technical person** in the DC/AC office, or designate one | `DONE` | **Allah Nawaz Khan, AC Headquarter Bannu.** Owner, 2026-08-02. He is also the M0-38 restore-drill candidate — M5 asks that he has fixed something himself under supervision, which is a training obligation, not a naming one |
| P-08 | Where does the application run? | `DONE` | **On-premise, DC office primary + AC Headquarter standby, Google Cloud for off-site backups.** Owner, 2026-08-02. See **ADR-0011**. Rented database rejected — it would take the control room down with the district's internet line. Weekly cloud upload rejected in favour of **nightly**: weekly means losing up to seven days of emergency record. Unblocks M0-37 scheduling; creates M0-53 and M0-54 |
| P-11 | Procure the notification channels (Q-07, ADR-0012) | `TODO` | **Longest lead time in the project.** WhatsApp Business API needs a Meta business account, a verified number and **pre-approved templates** — Meta must approve the alert wording before a single alert can be sent. Plus an SMS gateway account, a telephony provider, and a **GSM modem + SIM** for the DC server. Adapters build against fakes meanwhile, so this gates delivery, not development |
| P-12 | Google Cloud Storage bucket + service account for backups (ADR-0011) | `TODO` | Small cost, real prerequisite. **The bucket must be private and dumps encrypted before upload** — a dump holds every reporter's phone number in the district |
| P-10 | Purge the contact list from git history? | `DONE` | **No — owner decided it is fine; the repo is private.** 2026-08-02. Recorded so nobody reopens it as an oversight. `1d15b77` still contains the document |
| P-09 | Where does the repository live? | `DONE` | GitHub, private: `imtiazai004/Nawaz-s-nerve-center`. Resolved 2026-08-02. **Separate from P-08** — the code being on GitHub says nothing about where the application runs, and on-premise remains a live and arguably better option |

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
| M0-03 | Structured logging with correlation ids; health endpoint | `DONE` | M0-02 | `src/obs/log.ts`. One JSON line per request with a correlation id, echoed in `x-correlation-id` and carried through background passes via `AsyncLocalStorage`. Sensitive fields never reach a log; bodies are never logged at all. Routine 200s (`/health`, static assets) are filtered so the signal survives. 15 tests |
| M0-04 | CI: lint, typecheck, test on every commit | `DONE` | M0-01 | `.github/workflows/ci.yml`. Real PostgreSQL 17 and real Chromium — the suite is not worth running against a fake. **A missing `TEST_DATABASE_URL` under CI is a hard failure, not a skip**, so a broken secret cannot produce a green build that ran fifty tests instead of 297 |
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
| M0-15 | Pending state — never a checkmark until server-confirmed | `DONE` | M0-13 | Entry states `pending`/`inflight`/`blocked`; release only on server confirmation. Rendered as "saved on this device", never "sent" |
| M0-47 | Login screen; signed-out is distinct from offline | `DONE` | M0-19 | New. 15 tests. An emergency can still be captured while signed out — INV-01 outranks tidiness |
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
| M0-24 | Report entity + intake endpoint that never rejects | `DONE` | M0-06 | `POST /incidents`. Accepts an empty body, a nonsense severity, even unparseable JSON. Records what it assumed rather than filling silently. Refuses only a *future* `occurredAt`, which would buy the incident SLA time |
| M0-25 | Report → Incident linking (manual for M0) | `DONE` | M0-24 | Intake creates the incident and its first report in one `reported` event |
| M0-26 | Triage: severity + category as events | `DONE` | M0-07 | `POST /incidents/:id/triage`, authorised by the policy table |
| M0-27 | Routing to one department, one seat | `DONE` | M0-18, M0-26 | `POST /incidents/:id/route`. Tehsil tier and above, reason required. A second attempt is sent to reassign so the handover is recorded as one |
| M0-28 | Acknowledgement by duty seat | `DONE` | M0-27 | `POST /incidents/:id/acknowledge`. Seat stamped from the session, never the body. New policy row `incident.acknowledgement` — district may acknowledge, with a reason |
| M0-29 | **Server-side SLA timer + escalation** (INV-07) | `DONE` | M0-28 | Scanner + scheduler behind a Postgres advisory lock. Walks the seat ladder; vacant posts flagged, never swallowed. 18 tests |
| M0-45 | Escalation scan is starvation-free | `DONE` | M0-29 | New. Oldest-first ordering; hitting the scan cap is reported, not absorbed |
| M0-46 | Process entry point with ordered shutdown | `DONE` | M0-29 | New. `src/main.ts` — one deployable, structured logs, health endpoint |
| M0-30 | Reassignment by control room, with reason | `DONE` | M0-22 | `POST /incidents/:id/reassign`. Reason enforced (INV-06). **Notification of the department losing it waits on M0-32** |
| M0-31 | Resolve and close with evidence | `DONE` | M0-07 | `resolve` then `close`; closing an unresolved incident is refused, because an incident closed with no recorded outcome is the failure the closure-completeness metric measures |
| M0-49 | Incident read endpoint, authority-scoped | `DONE` | M0-20 | New. `GET /incidents/:id` returns state **and** full history, so provenance is renderable without a second request. Cross-department reads answered as *not found*, never *forbidden* |
| M0-32 | One notification channel with tracked delivery state (INV-03) | `DONE` | M0-27 | Attempt recorded **before** delivery is tried, so a crash leaves a visible pending obligation. Three states, never two — queued is not delivered. A vacant post fails loudly instead of swallowing it. Failures and silences counted separately **on the board**. In-app channel only; SMS/voice is M3, blocked on Q-07. 16 + 6 tests |

### Views

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-33 | Central board — all active incidents, unstyled | `DONE` | M0-08 | `GET /incidents` + the screen. Folded on demand; **no board table**. Says how old it is, and says "NOT LIVE" when it cannot reach the server (INV-02). Summary reports worst-assessed and unassessed separately (ADR-0009). 12 + 7 tests |
| M0-34 | Department board — same log, scoped by authority | `DONE` | M0-08, M0-20 | Same `buildBoard`, same projection — the scoping falls out of the seat, so there is no second query to disagree. The board now **names** the department, and the seat has an inbox: `/notifications` rendered, with delivery recorded only when a human acknowledges. 4 new tests |
| M0-35 | Incident detail with full event history and provenance | `DONE` | M0-22 | Every value answers "who set this, when, why". An override shows both values with the reason and both seats named; actors are named by seat then person, never by uuid; an event nobody performed reads "the system"; late arrivals show their gap. 10 browser tests |
| M0-51 | Department registry | `DONE` | — | Migration 0005: `department` table, real FK from `seat`, `person.password_hash` nullable. `ops/directory.ts` loads the district's list idempotently and **reports conflicts rather than resolving them**. Board and detail now show department names. 22 tests. Structure and tiers remain unverified — **Q-18** |
| M0-36 | **Rapid intake — measured against the 15s budget** | `DONE` | M0-14 | ~800ms at 4× CPU throttle. Two taps, no typing, submit-then-enrich. 10 tests |
| M0-48 | Layered location capture that never blocks | `DONE` | M0-36 | New. GPS watched from open; whatever arrived by submit is attached. Captured layers recorded |

### M1a — the administration console

The milestone that came out of **ADR-0010**. Two offices are the authority for the whole
district, so their console is the product rather than a supporting screen — and almost every
question that was "waiting on the district" turned into a screen where they enter the answer.

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M1a-01 | Routing signals per department | `DONE` | M0-51 | `domain/routing.ts`. Category or keyword, matched on whole words so `gas` never matches `gasht`. Several departments matching is the correct answer, not a conflict. **An assumed category never satisfies a category signal** — the ADR-0009 error, one field over. 23 tests |
| M1a-02 | Auto-route at intake; unassigned is recorded, never inferred | `DONE` | M1a-01 | No match appends an **empty `routed` event**, so "we looked and found nobody" is a fact with a timestamp rather than indistinguishable from "nobody has looked yet". Routing cannot make intake fail (INV-01) |
| M1a-03 | Departments as editable data | `DONE` | M0-51 | Create, rename, retire, restore, contact number. Retiring retires the routing signals with it — a department that no longer exists must stop receiving emergencies. **The two administrative offices cannot retire themselves** |
| M1a-04 | SLA targets as configuration (**closes Q-06**) | `DONE` | — | Migration 0007 seeds `PLACEHOLDER_SLA` into `sla_target` and the table becomes the authority. Per department and per severity, `unknown` included. The board and the escalation job both read it |
| M1a-05 | `config_event` — an append-only record of every configuration change | `DONE` | — | Who, when, why, before and after. Same guarantee as the incident log, enforced by triggers. Without it, "why was this not flagged late?" has no answer six weeks later |
| M1a-06 | The unassigned queue, loudly | `DONE` | M1a-02 | A banner above everything, a summary tally, and a marked row. Named on both administrative dashboards because they are the ones who can fix it (ADR-0005) |
| M1a-07 | District performance — every department side by side | `DONE` | — | Median before mean, measured from `occurredAt` so an outage shows as an outage, ranked by what needs attention. **A department with no data shows a dash, never a zero** |
| M1a-08 | The console itself | `DONE` | M1a-03…07 | Four tabs. Offered only to the two offices, and refused server-side when the tab is bypassed (INV-05). 25 API tests + 10 browser tests |
| M1a-09 | Collapse `Tier` to two rungs | `TODO` | ADR-0010 | Four values remain in the type and two are used. A follow-up, not a prerequisite |
| M1a-10 | The roster: people and numbers per department, **editable by the department itself** | `TODO` | M1a-03 | Who holds which post, right now. Notifications land on a post (ADR-0004) and the roster is what turns that into a person to reach. Scoped two ways from one screen: the two offices see all 79, a department sees itself. **Routing signals and SLA deadlines stay with the administration** — a department able to edit its own routing could quietly stop receiving night calls |
| M1a-11 | Placeholder contacts | `DONE` | — | Migration 0008. A stand-in number fills a post so the roster is complete and editable, and is **never dialled and never counted as reached**. Rescue 1122 unblocked (R-01) |

### Operations

| # | Task | Status | Depends on | Acceptance |
|---|---|---|---|---|
| M0-37 | Automated backup | `DOING` | M0-02 | Backup, restore, verification and the ledger are **built and tested** — a real `pg_dump` → `psql` round trip, 17 tests. `/health` reports staleness. **Nothing schedules it yet** — but P-08 is answered now (ADR-0011), so this is unblocked and split into M0-53 |
| M0-53 | Schedule the nightly backup; encrypt and upload to Google Cloud Storage | `TODO` | M0-37, P-12 | ADR-0011. Nightly, not weekly. Encrypted before it leaves the district. Upload failure is **loud** — a silent backup failure is worse than no backup, because it buys false confidence |
| M0-54 | Streaming replication to the AC Headquarter standby | `TODO` | ADR-0011 | One record, two machines. **`/health` must report replication lag**, or the standby is a comforting fiction rather than a standby |
| M0-38 | **Restore drill, actually performed** | `TODO` | M0-37 | No longer blocked on code. `docs/08-runbook.md` is written for someone who did not build this, and the path in it has been executed by the test suite. **Needs a second person**, timed, with what actually happened written down |
| M0-39 | Invariant test suite scaffold (INV-01…08) | `DONE` | M0-04 | **All eight covered.** INV-04, 06, 07, 08 at the domain layer; INV-01 by `spine.e2e.test.ts`; INV-05 by 25 direct-HTTP refusals; INV-02 by `board.e2e.test.ts` 5–6; INV-03 by 6 domain tests plus `notify.test.ts`. Where each lives is named in the invariant file's header |

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
- [ ] Restore from backup performed successfully, end to end — M0-38

Eight of nine. The open item needs **both** an automated backup (M0-37, which does not exist
yet and is code) and a second person to perform the restore — a restore procedure that has
only ever been performed by the person who wrote it is not a backup strategy.

---

## M1 starts next

M0's **architecture gate** has passed, which is what unblocks M1 — but the gate proves the
spine, it does not mean the M0 task list is finished.

**The lifecycle now exists as HTTP** (M0-24…28, 30, 31, 49): intake that cannot refuse,
triage, routing, acknowledgement, reassignment, resolution, closure, and an authority-scoped
read — every one of them gated by the policy table and tested by direct HTTP call, never
through a browser. That was the largest open block and it is closed.

What remains open in M0, eleven of forty-nine:

**All eight invariants now have permanent tests** (M0-39), which was not true of any previous
milestone report. The lifecycle is complete: capture, route, notify, acknowledge, escalate,
override, close — every step reachable, authorised and observable.

- ~~The department board (M0-34).~~ **Done.**
- **Operations.** M0-04 CI, M0-03 correlation ids. Backup and restore are built (M0-37);
  scheduling waits on P-08, and the drill (M0-38) waits on a person.
- **M0-51**, a department registry. Departments have no table and render as uuids.
- **Half-done:** M0-05 secrets, M0-11 payload versioning.

**The repository is on GitHub and CI runs on every push** (P-09, M0-04). That also gives the
intermittent `Worker exited unexpectedly` — twice in roughly twelve local runs — somewhere to
be observed properly, rather than depending on one person noticing.

**The district's contact list is loaded** (M0-51): 79 offices, 81 posts, 39 officers, 38 of
those posts vacant. Every remaining M0 item now waits on a person or a decision rather than
on code — see **Q-18** (how Bannu is organised, and what tier each seat is: the escalation
ladder cannot work until that is answered) and **Q-19** (two officers sharing one number).

**Every M0 task that is code is now done.** What remains needs a person (M0-38 restore
drill), a deployment decision (M0-37 scheduling and M0-05 secrets, both on P-08), or a thing
that does not exist yet (M0-11 needs a payload v2 before a v2 reader means anything).

**M1a is done and it moved the ground under the rest of the plan.** Q-18 is answered by
ADR-0010, Q-06 by a screen rather than a number, and "which departments respond to what" by
routing signals the district writes. M2's gate — *adding a department is a configuration
exercise measured in hours* — is met a milestone early and proved by a browser test.

**What M1 still needs is one phone number.** Rescue 1122's post is loaded vacant, and a
vacant post is exactly what the escalation ladder is built to surface rather than swallow.
The console now shows it: a department with routing signals and nobody to notify is flagged
on its own card.

**M0-38 is now a scheduling problem, not an engineering one.** The runbook is written for
someone who did not build this, and every step in it has been executed by the test suite
against a real cluster. What it needs is a second person, an hour, and a stopwatch.

Before M1 gets far it needs two answers: **Q-08** (does a Bannu place gazetteer already
exist — weeks of work versus a phone call) and **Q-06** (real SLA targets, since the
escalation loop is live on guessed ones).

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
7. The service worker would have **cached `/auth/me`** — on a shared handset, showing the
   previous holder as signed in after a shift change and attributing their reports to
   someone who had gone home.
8. `navigator.onLine` caused the **same bug a second time**, in the offline-login notice.
   Noted in `CLAUDE.md` as a standing instruction not to read it.

**Deliberately not faked, anywhere.** No in-memory Postgres, no `fake-indexeddb`, no mocked
network. Each would satisfy its interface and prove nothing about the one property that
matters — that an emergency is never lost.

## M1 and beyond

Decomposed when M0's gate passes — not before. Task lists written far ahead of the code
they describe are fiction, and they encourage building to a stale plan instead of to what
M0 actually taught us.

Milestone definitions and gates: [`milestones.md`](milestones.md).
