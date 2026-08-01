# District Nerve Center — Bannu

**Claude Code project memory and living build reference.**

> This file is the single reference for building this software. It is not a
> snapshot written once at the start — it is maintained continuously and must
> always describe the project as it is *right now*. See **Rule 0**.

---

## Rule 0 — This file is living (NON-NEGOTIABLE)

**Every session that changes anything in this folder must update this file before finishing.**

This is not optional, not "when convenient", and not something to batch up for later.
A `CLAUDE.md` that has drifted from reality is worse than no `CLAUDE.md`, because the
next session — human or agent — will trust it and be wrong.

### What triggers an update

| Change | What must be updated |
|---|---|
| File or folder **created** | §6 Repository map, `CHANGELOG.md` |
| File or folder **deleted or renamed** | §6 Repository map, `CHANGELOG.md` |
| An **architectural decision** is made | New ADR in `docs/adr/`, §3 index here, `CHANGELOG.md` |
| A decision is **reversed or superseded** | Mark old ADR `Superseded`, write the new one, update §3, `CHANGELOG.md` |
| A **dependency** is added or removed | `docs/05-stack.md`, `CHANGELOG.md` |
| An **invariant** is added or changed | `docs/01-invariants.md`, §4 here, `CHANGELOG.md` |
| **Milestone progress** (task done, gate passed/failed) | §5 Current state, `backlog/todos.md`, `CHANGELOG.md` |
| An **open question** is raised or resolved | `docs/06-open-questions.md`, `CHANGELOG.md` |
| A **domain fact** is verified or falsified | `docs/06-open-questions.md` + relevant doc, `CHANGELOG.md` |
| Scope is **added or cut** | §5 Current state, `backlog/milestones.md`, `CHANGELOG.md` |

### How to update

1. Make the change.
2. Update the affected documents in `docs/` or `backlog/`.
3. Update the relevant section of this file — usually §5 (Current state) and §6 (Repository map).
4. Append one entry to `CHANGELOG.md`. **Append only. Never edit or delete a past entry.**
   Format:
   ```
   ## YYYY-MM-DD — <short title>
   - **Added:**    <what came into existence>
   - **Changed:**  <what was modified, and why>
   - **Removed:**  <what was deleted, and why>
   - **Decided:**  <ADR-xxxx, if a decision was made>
   - **Open:**     <questions raised or resolved>
   ```
   Omit lines that do not apply. Never write an empty entry to satisfy the rule.
5. If nothing substantive changed (a typo fix, a reformat), say so explicitly in your
   summary instead of writing a hollow changelog entry.

### Why append-only

The changelog mirrors the architecture it describes (see `ADR-0001`). The project's own
history is an event log: state is what you get by folding the entries. If you edit the
past, you lose the ability to answer *"why did we do it that way in March?"* — which is
the question that matters most six months in.

---

## 1. What we are building

A district-wide operational platform for **Bannu, Khyber Pakhtunkhwa, Pakistan**, whose
purpose is fast, coordinated, accountable emergency response — plus routine district
operations coordination — across all government departments.

**It is not a dashboard.** It is the system of record for what happens in the district.
If the real record lives in a paper register and this is a summary of it, the project has
failed.

## 2. The root idea (immutable)

These five statements are the foundation. Anything that cannot be traced to them is scope
creep, and any change to them requires explicit owner approval and a new ADR.

1. One district-wide operational platform, not a dashboard.
2. A central view of the whole district, live.
3. Department workspaces where each department owns its own data.
4. **One source of truth** — central administration may view and override with authority,
   but data is never duplicated into a second copy.
5. Emergency management is the point: captured anywhere in the district, routed to the
   responsible party, visible centrally, acknowledged under SLA, escalated when silent,
   closed with a complete audit trail.

## 3. Load-bearing decisions

Full reasoning in `docs/adr/`. These are expensive to reverse once a department is
onboarded — challenge them now, not later.

| ADR | Decision | Status |
|---|---|---|
| [0001](docs/adr/ADR-0001-event-log-as-record.md) | The event log is the record; state is a projection | Accepted |
| [0002](docs/adr/ADR-0002-offline-first.md) | Offline is the substrate, not a later phase | Accepted |
| [0003](docs/adr/ADR-0003-declarative-authority.md) | Ownership and override are data, not `if` statements | Accepted |
| [0004](docs/adr/ADR-0004-duty-seats.md) | Route to a duty seat, not to a department | Accepted |
| [0005](docs/adr/ADR-0005-silence-is-a-signal.md) | Absence of reports is never rendered as "normal" | Accepted |
| [0006](docs/adr/ADR-0006-report-vs-incident.md) | One incident, many reports — dedup is a domain concept | Accepted |
| [0007](docs/adr/ADR-0007-boring-stack.md) | Boring, single-node, operable by one person at 02:00 | Accepted |
| [0008](docs/adr/ADR-0008-causal-event-ordering.md) | Events carry a causal sequence, not just timestamps | Accepted |

## 4. Invariants — what must never happen

Full text and test mapping in `docs/01-invariants.md`. Each is a permanent automated test
that blocks release on failure.

- **INV-01** An emergency is never lost.
- **INV-02** Stale data is never rendered as current.
- **INV-03** A notification failure is never invisible.
- **INV-04** An aggregate never hides a critical.
- **INV-05** The UI is never the enforcement layer.
- **INV-06** No sensitive action is unattributable.
- **INV-07** An SLA clock never runs on a client.
- **INV-08** Recovery never produces a notification storm.

## 5. Current state

> **Update this section every session.**

- **Milestone:** M0 — The Spine · **gate PASSED, offline launch working**
- **Phase:** Implementation. 111 tests pass. Remaining before M0 closes: real auth (M0-19),
  the SLA job actually running (M0-29), the intake UI (M0-36), a restore drill (M0-38).
- **Last updated:** 2026-08-01

**The M0 gate is green.** `src/__tests__/spine.e2e.test.ts` proves the central claim of
this project, end to end, with nothing stubbed: a critical emergency reported on a handset
with the network genuinely cut, **reopened with the network still cut**, delivering itself
on reconnect with no operator action, escalating server-side while unacknowledged,
overridden by the control room without erasing the department's own value, and reaching a
closed incident whose history cannot be rewritten. Real Chromium, real IndexedDB, Playwright
cutting the network at the driver, real HTTP, real PostgreSQL.

**Getting a working environment**
```
.\scripts\dev-db.ps1 start     # portable Postgres 17 on port 5433, no elevation needed
cd app && npm install && npm run check
```
Connection strings are in `app/.env` (gitignored). See `docs/05-stack.md`.

**What exists**
- Planning and architecture documents in `docs/` (thesis, invariants, connectivity
  ladder, data model, authority model, stack, open questions, capabilities).
- Seven ADRs recording the load-bearing decisions.
- Milestone plan and an M0 task decomposition in `backlog/`.
- The plain-language capability list in `docs/07-capabilities.md` — the scope document.
  If something is not there or in `backlog/milestones.md`, it is not in scope.
- **A git repository**, with the domain core committed.
- **`app/` — the domain core.** Pure TypeScript, no database, no framework:
  - `src/domain/events.ts` — the event catalog; `occurredAt`/`recordedAt` on every envelope
  - `src/domain/incident.ts` — the fold, deterministic ordering, override provenance
  - `src/domain/authority.ts` — the policy table as data, break-glass, conflict resolution
  - `src/domain/sla.ts` — response deadlines, late-arrival grace, honest measurement
- **`app/db` and `app/src/db` — the event store, on real PostgreSQL:**
  - `db/migrations/0001_event_store.sql` — the table, with **append-only enforced by
    database triggers**. UPDATE, DELETE and TRUNCATE all raise. Not trusted to code.
  - `db/migrations/0002_event_ordering.sql` — causal ordering (`ADR-0008`)
  - `src/db/eventStore.ts` — idempotent append, incident load, sync cursor, late arrivals.
    **There is no update method and no delete method. That is the interface, not an omission.**
- **`app/src/api` — the sync server.** `node:http`, no framework.
  - `protocol.ts` — **strict envelope, permissive payload.** An incomplete report is
    accepted and enriched later; only structurally unusable events are refused, with a
    reason, and one bad event never takes down the batch around it (INV-01).
  - `server.ts` — `POST /sync` (push a held batch), `GET /sync?cursor=` (pull what you
    missed), `GET /health`. **Refuses to start with the auth stub outside development.**
- **`app/src/outbox` — the offline substrate.**
  - `outbox.ts` — durable-first writes. Releases **only** what the server confirms it
    holds; keeps anything ambiguous; marks server-rejected events `blocked` for an operator
    instead of retrying them forever.
  - `adapters/indexeddb.ts` — the store that runs on the handset.
  - `adapters/httpTransport.ts` — the real network transport.
- **`app/web` — the PWA shell and service worker (M0-12).**
  - `src/sw.ts` — caches the shell so the app **opens with no network**. `/sync` and
    `/health` are network-only and must stay that way: a cached "accepted" would tell a
    client its emergency was stored when it was not, and the outbox would then delete it.
  - `src/main.ts` — app shell scaffold. **Connectivity is derived from actual sync
    outcomes, never from `navigator.onLine`** (see below). Real intake UI is still M0-36.
  - Built by `node build.mjs` into `web/dist` (gitignored); served by the sync server.
- **111 tests passing**, including permanent tests for INV-04, INV-06, INV-07, INV-08,
  17 database integration tests, 6 real-browser durability tests, 11 offline-launch tests,
  and the 14-step M0 gate.
- `cd app && npm run check` runs typecheck, lint, format check and tests. **Keep it green.**

**What does not exist yet**
- Real authentication (M0-19). The stub is guarded by a startup check, not implemented.
- The SLA job actually running on a schedule (M0-29). The decision logic is written and
  tested; nothing invokes it.
- The real intake UI and its 15-second budget (M0-36). The current shell is scaffold.
- The lifecycle endpoints (triage, routing, acknowledgement) as HTTP — the domain logic
  exists and is proven, but only the sync endpoints are exposed.
- A performed restore drill (M0-38).
- Verified domain research (department structures, contacts, seat hierarchies) —
  see `docs/06-open-questions.md`. Everything domain-specific in these documents is
  currently **assumption, not verified fact**.
- The Place gazetteer for Bannu.

**Do not fake the database.** Tests run against real PostgreSQL, never a stub. The
properties under test are durability and genuine immutability, and an in-memory fake
cannot demonstrate either — it would let INV-01 be marked proven while proving nothing. If
`TEST_DATABASE_URL` is missing, the integration suite says so loudly rather than skipping
quietly.

**A lesson already paid for — read `ADR-0008` before touching event ordering.** The first
comparator ordered by `(occurred_at, recorded_at, event_id)`. It was deterministic, had a
passing shuffle test, and was **causally wrong**: an offline batch shares a millisecond,
`now()` is transaction-time so `recorded_at` ties too, and ordering fell to a random UUID.
`triaged` folded after `overridden` and silently discarded a district override. Determinism
was never the hard part. Events now carry `clientSeq`, and the SQL `ORDER BY` and the
TypeScript comparator are tested against each other directly.

**Never trust `navigator.onLine`, and never cache `/sync`.** Two rules from M0-12, both
learned from tests rather than reasoning:

- `navigator.onLine` reports whether the browser has *an interface*, not whether anything
  gets through. Chromium reported `true` with Playwright's network cut — exactly what a
  handset on a cell tower with dead backhaul does. The app was showing *"Connected. Reports
  are delivered immediately"* during a total outage. Connectivity is now derived from
  whether a sync actually reached the server. `navigator.onLine` is believed only when it
  says `false`.
- A cached `/sync` response is not a stale page. It tells a client its emergency was
  accepted when it was not, and the outbox — which releases only what the server confirms —
  deletes it. INV-01 violated silently, by a caching layer, with no error anywhere.

**Settled — do not reopen without the owner**
- **No integration with government-issued systems.** The district runs this platform
  independently, by decision of the owner (2026-08-01). Q-01 and Q-02 are resolved. Do not
  spend effort discovering or negotiating external interfaces. Report **export** is
  provided instead, which preserves independence and avoids double work.
- The live consequence: departments already using other systems face **double entry**.
  That is now the top adoption risk. It makes the 15-second rapid-intake budget a hard
  requirement rather than an aspiration, and makes bypass rate the metric that matters most.

**Immediate next actions**
1. **M0-19 — real authentication and seat-scoped sessions.** The largest remaining hole:
   every endpoint currently accepts any caller, and INV-05 is untestable until it does not.
2. M0-29 — the SLA job actually running on a schedule. The decision logic is written and
   tested; nothing invokes it yet.
3. M0-36 — the rapid-intake screen, and the **15-second budget measured with a stopwatch**
   on a mid-range Android handset. It is a requirement, not an aspiration.
4. M0-38 — a restore drill performed by someone who is not the original developer.
5. Q-04 (legal basis for citizen data) remains blocking **for the pilot**, not for the
   build. Nothing before M4 touches real citizen data.

## 6. Repository map

> **Update this section whenever a file or folder is added, removed, or renamed.**

```
Build with Claude/
├── CLAUDE.md                  ← you are here — the living reference
├── AGENTS.md                  ← same rules, mirrored for Codex
├── README.md                  ← orientation for a new reader
├── CHANGELOG.md               ← append-only project history
├── docs/
│   ├── 00-thesis.md           ← why the system is shaped this way
│   ├── 01-invariants.md       ← the eight things that must never happen
│   ├── 02-connectivity-ladder.md ← L0–L4 degraded operation
│   ├── 03-data-model.md       ← entities and the event catalog
│   ├── 04-authority-model.md  ← who owns what, who may override
│   ├── 05-stack.md            ← technology choices and reasoning
│   ├── 06-open-questions.md   ← what we do not know yet
│   ├── 07-capabilities.md     ← plain-language scope list (non-technical readers)
│   └── adr/                   ← architecture decision records
│       ├── README.md          ← index and template
│       └── ADR-0001..0007
├── app/                       ← the application
│   ├── package.json           ← `npm run check` = typecheck + lint + format + test
│   ├── tsconfig.json          ← strict, including noUncheckedIndexedAccess
│   ├── vitest.config.ts       ← db tests run serially against one cluster
│   ├── eslint.config.js
│   ├── .prettierrc.json
│   ├── .env.example           ← copy to .env; .env is gitignored, never commit it
│   ├── build.mjs              ← esbuild for the web client → web/dist (gitignored)
│   ├── db/migrations/         ← forward-only SQL. Correct a mistake by writing the next one
│   ├── web/                   ← the PWA
│   │   ├── index.html         ← app shell
│   │   └── src/sw.ts          ← service worker. NEVER cache /sync
│   │   └── src/main.ts        ← boot; connectivity from sync outcomes, not navigator.onLine
│   └── src/
│       ├── domain/            ← pure logic, no database, no framework
│       │   ├── events.ts      ← the event catalog (ADR-0001)
│       │   ├── incident.ts    ← the fold: events → state, with provenance
│       │   ├── authority.ts   ← the policy table as data (ADR-0003)
│       │   └── sla.ts         ← deadlines and the occurred/recorded split (ADR-0002)
│       ├── db/                ← pool, migration runner, event store
│       ├── api/               ← sync protocol and the node:http server
│       ├── outbox/            ← the offline substrate (ADR-0002)
│       │   └── adapters/      ← IndexedDB store, HTTP transport, browser harness
│       ├── __tests__/         ← spine.e2e.test.ts — THE M0 GATE
│       └── testing/           ← test setup, browser global types
├── scripts/
│   └── dev-db.ps1             ← start/stop the local Postgres
├── backlog/
│   ├── milestones.md          ← M0–M5 with pass/fail gates
│   └── todos.md               ← live task list
└── .claude/
    ├── settings.json          ← Stop hook wiring
    └── rule0-check.ps1        ← the check itself (fails open; nudges once per session)
```

A copy of the same hook lives in the parent folder's `.claude/settings.json`, so Rule 0 is
enforced whether Claude Code is opened on `Nawaz/` or on `Build with Claude/`. Both point
at the one script above. If this folder is ever moved, update the absolute path in both
settings files.

## 7. Engineering rules

**Source of truth**
- Read `docs/00-thesis.md` and the relevant ADR before implementing anything structural.
- When implementation disagrees with these documents, **flag the mismatch** — do not
  silently update the docs to match the code, and do not silently bend the code.
- Never invent domain facts about Bannu, its departments, or its procedures. If it is
  unverified, it goes in `docs/06-open-questions.md` marked as unknown.

**Architecture**
- One source of truth. No second copy of department data for dashboard convenience.
- Never mutate an emergency's state in place. Append an event.
- Never write an authorisation check as a scattered role comparison. Use the authority model.
- Server-side authorisation always. Hiding a button is presentation, not security.
- SLA timers and escalation live on the server. Never on a client.

**Working style**
- Smallest coherent change. No broad rewrites without an ADR.
- Every behaviour change gets a test. Every invariant gets a permanent test.
- Airplane mode is a required test environment, not an optional one.
- No secret, credential, API key, or demo value hardcoded — ever.
- New dependency requires an answer to: *who restarts this when it fails, and how do
  they know it failed?*

**Product**
- The rapid-intake path has a hard budget: **under 15 seconds** from open to submitted on
  a mid-range Android handset over a weak connection. Performance here is a requirement,
  not a nice-to-have — if the system is slower than the phone call it replaces, it loses.
- No AI in the critical path. Summaries and triage suggestions may assist an operator;
  they never route, never close, and never enter the record as fact.

## 8. Definition of Done

A task is not done until all of these hold:

- Acceptance criteria are met and demonstrated, not asserted.
- Tests exist and pass, including any invariant the change touches.
- Authorisation is enforced server-side and tested from outside the UI.
- The action is auditable if it is sensitive.
- Offline behaviour is defined and tested if the change touches a write path.
- No unrelated files changed, no debug code, no hardcoded values.
- **`CLAUDE.md` and `CHANGELOG.md` are updated per Rule 0.**

## 9. Open questions

Live list in `docs/06-open-questions.md`. Anything blocking is marked there. Do not
build past a blocking question by guessing — raise it.

---

*Maintained under Rule 0. If this file looks stale, it is a bug — fix it before doing
anything else.*
