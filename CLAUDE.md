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
| [0009](docs/adr/ADR-0009-unassessed-is-not-a-severity.md) | "Unassessed" is a value, never a level; aggregates report two numbers | Accepted |
| [0010](docs/adr/ADR-0010-two-rung-ladder.md) | Two rungs: departments report to the DC and AC HQ offices. No third tier | Accepted |
| [0011](docs/adr/ADR-0011-deployment-topology.md) | One record on district hardware: DC primary, AC HQ standby, nightly encrypted copy to Google Cloud | Accepted |
| [0012](docs/adr/ADR-0012-notification-channel-ladder.md) | Notifications walk a ladder — WhatsApp, then a call, then SMS; in-app always | **Superseded 2026-08-03** |
| [0013](docs/adr/ADR-0013-one-app-every-screen.md) | One application, on every size of screen. Nothing private on a screen a room can read | Accepted · amended same day |

**ADR-0012 was superseded on 2026-08-03**, by the owner. It decided that the system would
send alerts down a ladder of providers — WhatsApp Business, a voice provider, an SMS gateway,
a GSM modem. None of that was ever asked for. What was wanted:

> ju banda alert jare karega ya escalate karega etc etc un ko mutalqa number mil jaye and us
> pr click kare tou contact karne ka channel selection mai ho … es mai Meta business account,
> telephony ya SMS gateway ki koi zarurt nhe hai

So the system **hands an officer the number** and opens WhatsApp, the dialler or messages on
their own handset. A human has the conversation. This is smaller *and better*: a chain of
providers fails in ways nobody sees — a template unapproved, a gateway out of credit, a modem
with no signal — and every one of those is discovered on the night it matters. An officer who
dialled a number knows within ten seconds whether it rang.

**ADR-0013 was amended on the day it was written.** It originally decided a separate wall
screen at `/display`, because I read "the prototype's things belong in our app" as "build the
prototype". The owner corrected it, the whole thing was reversed, and the amendment is left in
place as the record — see the note below on how the ADR log is corrected.

**ADR-0004 was amended on 2026-08-03**, not superseded: its four-tier ladder is gone
(ADR-0010) and everything else it decided — seats, duty assignments, authority-attaches-to-
the-post — is exactly what made that a migration rather than a rewrite. The old text is left
in place with an amendment note, because the ADR log is corrected by appending, not by making
the past look like it always agreed.

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

- **Milestone:** M4/M5 — **the product now looks and behaves like the district's own
  prototype**, on every size of screen.
- **Phase:** Implementation. 738 tests pass on every push.
- **A cross-department read leak was found and closed by the M5 security review
  (2026-08-04).** `/dashboard` and `/status` decided their scope from `departmentId === null`,
  which is true both of a control-room seat *and* of somebody holding **no post at all** — so
  a relieved officer was handed the district view instead of nothing. **Losing a post widened
  what its former holder could see**, inverting the reason the seat is re-resolved on every
  request. Both routes now go through `requireSeat`, and `viewerFor` keys on **tier**, which a
  database trigger derives and no caller can assert. See the note in §7.
- **The evidence download decided authority after reading the file** (same review). Up to
  20 MB off disk plus a SHA-256, then the refusal — on the one machine that is also taking
  emergency reports. `upload` had always stated the opposite rule for itself. Fixed by looking
  up the row first, authorising, and only then touching the disk.
- **Rate limiting existed nowhere, and now does** (`auth/throttle.ts`, closed 2026-08-04).
  `passwords.ts` had set a deliberately low 10-character minimum and justified it by saying
  *"real protection here comes from rate limiting and instant revocation"* — revocation
  existed, the other half did not. The sharper risk was never guessing but **CPU**: every
  attempt costs a scrypt derivation, including for numbers with no account (deliberate, to
  avoid a timing oracle), on the one machine also accepting emergency reports. **It is a
  delay and never a lockout, and the reasoning in §7 is the part to read before changing any
  constant in that file.**
- **M0, M1a and M1 are done; M3's notification work and M0's operations work landed with
  them (2026-08-03).** One emergency now goes from a field officer's handset to a
  post-incident report with nothing stubbed — see `src/__tests__/m1gate.e2e.test.ts`, which
  is the M1 gate and also prints what it does **not** prove.
- **What remains open is almost entirely other people's**, and it is all in
  [`backlog/for-the-district.md`](backlog/for-the-district.md): accounts (R-05, R-06),
  hardware (R-07), and two things that need a person for an hour (R-08 the restore drill,
  R-12 a Rescue operator walking the gate). The only code items left are M0-05 secrets and
  M0-11 payload versioning, which needs a payload v2 to exist before a v2 reader means
  anything.
- **Deployment is settled (ADR-0011, 2026-08-02).** PostgreSQL runs on a machine in the **DC
  office** — the district's record lives on district hardware. The **AC Headquarter office
  runs a warm standby** of the same database: two machines, **one record**. Two independent
  primaries would give Bannu two divergent histories and no way to merge them. The server is
  reachable from outside so field handsets sync from anywhere, and **nightly** encrypted
  dumps go to Google Cloud. A rented database was rejected: it would take the control room
  down with the district's internet line.
- **Notification policy was reversed by the owner (2026-08-03). ADR-0012 is superseded.**
  The software does **not** send anything. It hands an officer the relevant number — the duty
  officer's mobile first, the department's office line second — and a click opens WhatsApp,
  the dialler or messages **on that officer's own handset**. No Meta business account, no
  telephony provider, no SMS gateway, no GSM modem. Nothing is recorded when a channel is
  opened; the panel says so rather than implying otherwise. The **in-app inbox stays** — it
  needs no provider, and it is what INV-03 is measured against. **The provider machinery is
  deleted** (migration 0018): the adapters, the ladder, the Alerts tab, the Meta templates and
  `channel_ladder`. **R-05 is closed as not needed** — the district no longer has to procure a
  Meta account, a gateway, a provider or a SIM, which was the longest lead time in the project.

- **The product's shape is settled (ADR-0013, 2026-08-03), and it came from the owner's own
  prototype.** One application, one set of markup, laid out by CSS at three widths: one column
  on a phone, two on a laptop, three and larger type on an office screen. The client reads the
  viewport in exactly one place — to choose which screen somebody *lands* on after signing in
  — and that picks a starting screen, never a layout. There is no second page for large
  screens; there was, for half a day, and reversing it is recorded in the ADR.

- **The dashboard is the home of the product, not an add-on.** It carries every panel the
  prototype had and the ones this system grew that it never had. It is **scoped to whoever
  asked**: the two offices see the district, a department sees its own work — the same panels,
  not a thinner version. Only "this system" (backup, standby, alerts) is administration-only,
  because those are theirs to fix and three red rows a department cannot act on teach it to
  ignore red rows.

- **Nothing private ever reaches the dashboard**, because it is also what appears on a large
  screen in an office where a room can read it. Every response is walked through
  `wallSafetyViolations` and a violation **fails the request** rather than stripping the
  field — a leak that ships minus one column is a leak nobody finds.
- **The district's structure is now settled (ADR-0010, 2026-08-02), and it is simpler than
  the model assumed.** Two offices — **DC** and **AC Headquarter Bannu** — are the authority
  for the whole district. Every other department reports to them. **The ladder has two rungs
  and there is no third.** The four-tier hierarchy in ADR-0004 was a generic guess; it is
  superseded.
- **The administration console is built (M1a, 2026-08-02) and its gate has passed.** In a
  real browser, an operator adds a department, gives it a routing signal, and an emergency
  reported by a different officer arrives at a department that did not exist a minute
  earlier — no developer, no restart, no code naming it. That was scheduled as M2's gate and
  arrives a milestone early because ADR-0010 made it fall out of the design.
- **Routing is configuration.** Each department carries signals — a category, or a keyword
  matched on whole words — and several departments matching one emergency is the correct
  answer, not a conflict. **Nothing is guessed:** no match appends an *empty* `routed` event,
  so "we looked and found nobody" is a recorded fact with a timestamp rather than something
  inferred from an absence, and it appears on both administrative dashboards as unassigned.
- **Configuration has its own append-only log** (`config_event`). The same argument as
  ADR-0001, applied to settings: a settings table holding only the current value cannot
  answer *why was this not flagged late?* six weeks later.
- **The roster is editable by the department that owns it (M1a-10, 2026-08-02).** Owner's
  requirement: a department maintains **its own people and posts** from its own screen —
  add, remove, change a number, hand a post over. The two offices reach every department's
  roster from the console. **Routing signals and SLA deadlines are deliberately not
  included**, and the owner confirmed that reading: a department able to edit its own routing
  could quietly remove the signal that sends it night-time fire calls, and nothing on any
  screen would show it. One component, two doors — `web/src/roster.ts`.
- **Adding a contact and granting a login stay separate acts.** The district's list is ~80
  officials the system must be able to *notify*; that is not ~80 people who should have
  credentials.
- **Almost every question that was "waiting on the district" is now build work.** SLA targets
  (Q-06), department structure (Q-18), Rescue's missing number, which departments respond —
  all of them are things the administration sets in the software rather than facts to be
  gathered first. **Do not wait for data. Build the screens that let them enter it.**
- **The district's contact list is loaded** — 79 offices, 81 posts, 40 officers, 38 posts
  vacant. It is the **starting content** for the registry, not the final word: every row is
  editable by the two offices.
- **Repository:** `github.com/imtiazai004/Nawaz-s-nerve-center`, private, branch `main`.
  **This says nothing about where the application runs** — P-08 is still open, and
  on-premise remains a live option for a district whose internet is the unreliable part.
- **Last updated:** 2026-08-03

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
npm start                      # build web + compile server + run on PORT (default 3000)
```
Connection strings are in `app/.env` (gitignored). See `docs/05-stack.md`.

**`npm start` compiles.** It is `node build.mjs` (the PWA) then `tsc -p tsconfig.build.json`
(the server, into `dist/`) then `node dist/main.js`. It used to be
`node --experimental-strip-types src/main.ts`, which **never worked**: type stripping does
not remap a `.js` import specifier to the `.ts` beside it, and every import here is written
with `.js` because that is what compiled ESM needs. Vitest resolves those specifiers itself,
so 338 tests passed against an application that could not be launched. `src/__tests__/
deployable.e2e.test.ts` now builds the real artifact, runs it, and waits for `/health` —
because nothing else could have caught this, and nothing had.

The same day, the same shape: the process started and exited with `DATABASE_URL is not set`,
because `app/.env` — named here and in `docs/05-stack.md` as where configuration lives — was
only ever read by the **test** setup. `main.ts` loads it now, if it exists.

**What exists**
- Planning and architecture documents in `docs/` (thesis, invariants, connectivity
  ladder, data model, authority model, stack, open questions, capabilities).
- Thirteen ADRs recording the load-bearing decisions — one superseded (0012), two amended
  (0004, 0013). The log is corrected by appending, never by editing the past.
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
  - **`lifecycle.ts` — the incident lifecycle as commands (M0-24…28, 30, 31, 49).**
    `POST /incidents` (intake), `GET /incidents/:id`, and `/triage`, `/route`,
    `/acknowledge`, `/actions`, `/reassign`, `/override`, `/resolve`, `/close`.
    - **A raw append through `/sync` trusts the caller to have checked their own authority.
      A command does not.** That is the whole reason this module exists: `/sync` is right
      for a device replaying what it captured offline, and wrong for an operator action.
    - Every command asks the policy table — `governedFields()` names the rows a command
      touches, and all of them must permit it. **No command compares a role.**
    - `POST /incidents` **cannot refuse** (INV-01). Empty body, nonsense severity,
      unparseable JSON — all accepted, with `assumed` recording what the server supplied so
      a placeholder is never mistaken for a reporter's judgement. The one thing it will not
      take is a **future** `occurredAt`, which would push the SLA deadline out and quietly
      buy the incident extra time before it escalates.
    - **A read the caller has no authority for is a 404, not a 403.** Confirming an incident
      exists is itself a disclosure about another department's operations.
    - Closing an unresolved incident is refused. An incident closed with no recorded outcome
      is exactly what the closure-completeness metric exists to catch.
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
  - `src/main.ts` — sign-in, rapid intake, outbox queue. **Connectivity is derived from
    actual sync outcomes, never from `navigator.onLine`** (see below), and there are
    **three** states, not two: connected, no connection, and **signed out**.
  - `src/location.ts` — layered location capture. **Never blocks**: GPS is watched from the
    moment the screen opens and whatever has arrived by submit is attached. Which layers
    actually produced something is recorded, so a GPS fix is distinguishable from an
    operator's best guess rather than every location looking equally certain.
  - **Submit first, enrich after (M0-36).** The critical path is two taps and a button with
    no typing; place and description are offered only once the report is already safe, and
    are **appended as a second event** rather than edited in. Measured at ~800ms against
    the 15,000ms budget with the CPU throttled 4× — the budget is a requirement, because a
    system slower than the phone call it replaces loses to the phone.
  - **An emergency can be recorded whether or not anyone is signed in.** Deliberate, and
    the one place the app is more permissive than the server. A duty officer whose session
    expired overnight on a handset with no signal *cannot* sign in, and refusing them would
    lose the emergency (INV-01). The server still requires a session to accept anything, so
    the report waits in the outbox; the trade is attribution to whoever delivered it rather
    than whoever typed it. Do not "tighten" this without reading the note in `main.ts`.
  - Built by `node build.mjs` into `web/dist` (gitignored); served by the sync server.
- **`app/src/auth` — authentication and seat-scoped sessions (M0-19).**
  - `passwords.ts` — scrypt from `node:crypto`, no dependency. Rejects stunted salts and
    keys before deriving anything (see the security note below).
  - `sessions.ts` — server-side sessions. **The token is never stored**, only its SHA-256,
    so a leaked database hands out no live sessions. Revocation is instant.
  - The seat is re-resolved from the roster on **every** request, never cached in the
    session. An officer relieved of a post loses authority on the next request, with no
    cleanup step for anyone to forget (ADR-0004).
  - `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`. `/sync` requires a session.
- **`app/src/jobs` — escalation, actually running (M0-29).**
  - `escalation.ts` — scans open unacknowledged incidents **oldest first**, walks the seat
    ladder, appends the escalation event. **The escalation rule is never duplicated in
    SQL**: the query narrows candidates, `checkEscalation` decides. A vacant post never
    swallows an escalation — it escalates anyway, flagged `no_duty_holder`.
  - `scheduler.ts` — interval loop behind a **Postgres advisory lock**, so two instances
    cannot both escalate. Not a job queue: this is a periodic scan, and a queue to hold one
    recurring task would be operational surface bought for nothing.
- **`app/src/main.ts`** — one process runs the API, the client and the escalation loop
  (ADR-0007's single deployable), with ordered shutdown: stop escalating, stop accepting,
  release the pool.
- **738 tests passing** across 48 files, including **17 backup/restore tests that run a real
  `pg_dump` → `psql` round trip** against the real cluster and fold the restored events to
  prove the system came back, not just the rows. **Every one of the eight invariants now has a
  permanent test**, and the invariant file's header names where each lives — four at the
  domain layer, INV-01 in the spine gate, INV-05 in the auth refusals, INV-02 on the board
  screen, INV-03 in both places. Plus 17 database integration tests, 25 auth tests, 43
  lifecycle tests, 12 board and 7 board-browser tests, 10 incident-detail browser tests,
  **16 notification tests**, 18 escalation tests, 6 real-browser durability tests, 13
  offline-launch tests, 15 login tests, 10 rapid-intake tests, and the 14-step M0 gate.
- `cd app && npm run check` runs typecheck, lint, format check and tests. **Keep it green.**
- **CI runs exactly that command on every push** (`.github/workflows/ci.yml`), against a real
  PostgreSQL 17 and a real Chromium — ~1m25s. If CI and local can disagree about what green
  means, the one nobody is watching wins.
  - **A missing `TEST_DATABASE_URL` under `CI` is a hard failure, not a skip**
    (`src/testing/loadEnv.ts`). Otherwise one broken secret drops every integration suite and
    the build goes green having run fifty tests instead of 297.
  - **`PG_BIN` is set to `/usr/lib/postgresql/17/bin`.** `/usr/bin/pg_dump` on Debian is
    `pg_wrapper`, which picks a version, and it picked 16 against the 17 server. The workflow
    asserts the version rather than printing it.
- **`cd app && npm run test:reset` when the local run goes red for no reason you changed.**
  The local test database is never cleaned, so every run leaves its departments and events
  behind. Twice now it has drifted past 1500 departments — Bannu has 79 — and the console's
  browser tests began timing out rendering a screen no district will ever produce, taking the
  backup round trip with them. Four red tests, none of them about the code. The run now warns
  about this once, before the first file (`src/testing/globalSetup.ts`). CI never sees it: the
  workflow starts a fresh cluster every time.

- **`app/src/api/board.ts` — the central board (M0-33).** `GET /incidents`, folded on demand
  from the same event log. **There is no board table**, so it cannot fall out of step with
  the record (root idea #4).
  - **It always says how old it is.** `asOf` on the response, `lastRecordedAt` on every row,
    and the screen turns to *"NOT LIVE — do not act on this without checking"* once it has
    not reached the server in 30s. A board that keeps showing its last good data during an
    outage, unlabelled, is worse than a blank screen: someone decides not to send a crew
    because the screen says a crew is already going (INV-02).
  - **The summary is two numbers, never one** — worst assessed, and how many are unassessed
    (ADR-0009). The row says the word `unassessed`; colour only repeats what the text
    already says (INV-04).
  - Scoped by seat, server-side. Rows a seat may not see are **not sent**, not hidden.
  - `attentionRank` is the one place ordering and aggregation legitimately differ: an
    unassessed report sorts just above `critical` in the queue, because it could be
    anything, while still being counted separately in the summary. Ordered, never relabelled.
  - **M0-34, the department board, is this same function with the same arguments.** The
    scoping falls out of the seat. Do not write a second endpoint with a second query.

- **Incident detail (M0-35).** The screen the authority model exists for: **every value
  answers "who set this, when, why"** without a second request.
  - An override shows the district's value *and* the department's underneath it, with the
    reason and both seats named. ADR-0003 is invisible until something renders it this way.
  - **Actors are named by seat, then person** (ADR-0004) — a uuid does not answer "who", and
    the post is the operationally meaningful half. `readIncident` returns an actor directory
    with the events so the screen never has to ask twice.
  - An event nobody performed reads **"the system"**. *Nobody did this, the deadline did* is
    a real distinction; a blank would read as missing data.
  - The occurred/recorded gap is shown on any event that arrived 15m+ late — the district's
    connectivity picture, not noise (ADR-0002).
  - **Known limitation:** actor names are resolved from *today's* roster. The event still
    records the person and seat held at the time and that cannot change, but renaming a seat
    retitles it throughout history. The alternative is denormalising names into every event.
    Right trade for M0; a real limitation, not an oversight.

- **`app/src/jobs/notify.ts` + `src/domain/notifications.ts` + `src/api/notifications.ts` —
  notifications with tracked delivery (M0-32, INV-03).**
  - **The order of operations is the design.** Obligations are derived from *state*, the
    `notified` event is appended **before** delivery is attempted, and only then is the
    outcome recorded. A crash in between leaves a **pending** attempt, which the board shows
    as unmet — the correct answer, because we genuinely do not know whether anyone was told.
    Attempting first would leave nothing, and INV-03 would fall to a process dying quietly.
  - **Three states, never two.** Queued is not delivered. An attempt stays pending until the
    seat holder's client actually collects it via `POST /notifications/:id/seen`.
  - **A vacant post fails loudly**, exactly as in escalation (ADR-0004). Nobody is coming, so
    somebody has to be told that nobody is coming.
  - **Failures and silences are counted separately, on the board.** One needs a roster fixed,
    the other needs a phone answered.
  - **There is no inbox table.** The inbox is a query over the event log — attempts for my
    seat with no outcome yet — so nothing can disagree with the record.
  - **The channel is in-app only.** Q-07 (which channels actually work in Bannu) is
    unanswered, so no vendor is assumed. An officer not looking at the app is **not reached**
    — a real gap, M3's to close. `NotificationChannel` is the seam SMS and voice slot into.

- **`app/src/ops` — backup and restore (M0-37), with the round trip actually executed.**
  - `backup.ts` — records the attempt in `backup_run` **before** `pg_dump` runs, so a
    process killed mid-dump leaves a visible `running` row rather than nothing. Same shape
    as a notification attempt, same reason.
  - **A dump is verified, not assumed.** `pg_dump` exiting 0 proves nothing: size, checksum
    and the event count *inside the file* are checked, and a dump holding fewer events than
    the live database is recorded as a **failure**, not a warning.
  - Plain SQL, not the custom format — readable, greppable, replayable with `psql` alone
    (ADR-0007).
  - `restore.ts` — **never restores in place.** The target is always named by the caller. A
    tool whose easiest path overwrites production eventually overwrites production.
    `ON_ERROR_STOP=1` is mandatory: without it `psql` reports success after replaying a dump
    that half-failed.
  - `verifyRestoredIntegrity` checks the **triggers**, not just the rows. A restore that
    brings back the data but not the append-only guard gives you a database where the event
    log can be edited, and nobody finds out until an audit.
  - **`/health` reports `degraded`, never a failing status code, when the backup is stale.**
    A 503 would take the node out of a load balancer and stop the district reporting
    emergencies because a dump was old. INV-01 outranks a stale backup. Monitor `degraded`.
  - `docs/08-runbook.md` is the human version, written for whoever performs M0-38.

- **`app/src/ops/directory.ts` + migration 0005 — the department registry (M0-51).**
  - `seat.department_id` is now a **real foreign key** to a `department` table. It used to be
    a bare uuid referencing nothing, which the database happily accepted.
  - The district's contact list loads through `db/seed/directory.json` — **gitignored**. Real
    officers' mobile numbers do not go in a repository: git history is permanent, and a
    private repo can be shared or gain a collaborator later. Same rule as `.env`.
  - **A directory entry is not an account.** People load with a null `password_hash`, meaning
    they can be notified and cannot sign in. Creating logins for ~80 officials who have not
    been told the system exists would be ~80 credentials nobody is watching.
  - **Conflicts are reported, never resolved.** A seat already held is not reassigned by an
    import, because a handover is a deliberate act. The loader returns `problems` (did not
    load) and `notes` (loaded, look at it), and the caller is expected to read both.
  - **A phone number identifies an account, not a person** (migration 0006, Q-19). Two
    officers genuinely share `03338887171`, which is ordinary here — so uniqueness moved to
    where it is load-bearing: a person who can authenticate must own their number, a
    directory contact may share one. `login()` considers only rows with a password hash, so
    "who is signing in?" still has exactly one answer. Shared handsets are still surfaced as
    a note on every load, because a mistyped digit looks identical.
  - **Nothing is inferred.** The department is the row's own "Department/Office" value,
    verbatim. That `ADC (General)` sits under the DC Office is a fact about Bannu, not
    something this code may decide — see **Q-18**, which also covers the tier gap that
    currently stops the escalation ladder working on real data.

- **`app/src/obs/log.ts` — structured logs with a correlation id (M0-03).**
  - One JSON line per request: method, path, status, duration, correlation id. Returned in
    `x-correlation-id` so an operator can quote it, and **accepted** from the caller so a
    retried batch is one story in the log rather than four unrelated ones.
  - **The id lives in `AsyncLocalStorage`, not in a parameter.** A deliberate exception to
    this project's preference for the explicit option: threading a context argument through
    the event store, the fold, the authority check and the notifier is dozens of signatures
    and dozens of chances to forget. This makes "every line carries the id" true by
    construction, for one stdlib import.
  - **Nothing sensitive is logged.** Bodies never; `password`/`phone`/`token`/`authorization`
    and friends redacted by substring at any depth. Actor and seat **ids** are logged, because
    "who did this" is what a log is for and those ids are already in the audit trail.
  - An inbound id is **sanitised, not trusted** — it is echoed into a header and into every
    line, so an unchecked value is a header-splitting primitive.
  - **Routine successes are filtered.** Monitoring polls `/health` and the PWA refetches its
    own assets; logging those at `info` would bury the requests anyone cares about.
  - Each scheduler tick gets its own id and `job: 'scheduler'`, so an escalation at 02:14 is
    traceable and distinguishable from one a request caused.
  - Tests run at `error`. `VITEST_LOG_LEVEL=info` turns them up.

- **The department board and the seat inbox (M0-34).** The board is the **same** `buildBoard`
  and the same projection — scoping falls out of the seat, so there is no second query to
  disagree with the first. What differs is the label, and it now **names** the department
  instead of saying "your department".
  - **The inbox is the receiving half of M0-32.** Until it existed nothing in the browser
    ever called `/notifications`: attempts were created, stayed `pending` for ever, and the
    board carried them as unmet obligations permanently. The loop was open at its last step —
    the one with a human in it.
  - **Delivery is recorded when the operator says they have seen it**, never on render.
    "The tab was open" is not "somebody knows" (INV-03).

**What does not exist yet**

> This list was rewritten on 2026-08-03. It had drifted badly — it still claimed CI, the
> department registry, correlation ids and backups did not exist, when all four were built
> and named as done elsewhere in this same file. **A gap list that names solved problems is
> worse than none**, because the next session works from it and rebuilds what is there.

**The one functional gap in the software**
- **No department has a routing signal (R-04).** The matcher, the storage, the console screen
  and the empty-`routed` event all exist and are tested — what does not exist is a single
  configured signal. Until the district writes one, **every emergency lands unassigned** on
  both administrative dashboards. That is the designed behaviour, not a bug, and it is loud
  on purpose (ADR-0005). It is still the difference between a system that routes and one
  that does not.

**Real values, where a visible placeholder stands today** — all in §5b, none blocking
- Rescue 1122's number (R-01), the 38 vacant posts (R-02), real acknowledgement deadlines
  (R-03), and the six intake categories (R-14), which are **my guess** and are the vocabulary
  every routing signal must match.

**Built, and waiting on something that is not code**
- **Off-site backup never leaves the building (R-06).** Nightly verified dumps have run since
  2026-08-03 and the encrypt-and-upload path is tested; it **refuses to run without a bucket
  and refuses to send anything unencrypted**. No copy has ever left the district, and
  Administration → Backups says exactly that.
- **One node, no standby (R-07, M0-54).** `/health` reports `role: "standalone"` and says
  why. This is the largest remaining gap in ADR-0011: one machine holds Bannu's record.
- **Nobody in Bannu has performed a restore (R-08, M0-38).** Different fact from "restore
  works" — the round trip runs against a real cluster on every push. It needs a second
  person, an hour and a stopwatch.
- **The M1 gate's operator half (R-12).** I can prove it works; I cannot prove it is usable.

**The one code item left**
- **M0-11 payload versioning.** `payload_version` is on every row; there is no v2 reader,
  and there is nothing for one to read until a payload v2 exists. Do not write it early.
- ~~M0-05 secrets~~ — **done 2026-08-04.** The secret store is `app/.env` on the district's
  own machine, **by decision rather than by default** (ADR-0007, ADR-0011): one server in the
  DC office, operable by one person at 02:00. A secrets manager would add a network
  dependency, an account and a renewal nobody watches, to protect a file on the same disk as
  the database it unlocks. What that file needed was to be out of git, `chmod 600`, and
  **checked at boot** — `src/config.ts`, whose rule is that a refusal is reserved for a
  configuration that is broken or unsafe, and everything that merely leaves the district less
  protected warns and keeps running. A process that will not start is a district that cannot
  report an emergency.

**Not gaps — decided against, do not "fix" these**
- **The software sends no messages, ever** (ADR-0012 superseded, owner, 2026-08-03). An
  officer not looking at the app is reached by a human who dials the number the app hands
  them. **Q-07 is moot**: no channel is procured, so none can be missing. The in-app inbox
  and the obligation ledger stay, and INV-03 is measured against them.
- **No map and no Place gazetteer** (P-06, owner: *do not go to that depth*). Layered
  location capture already works without one (M0-48).
- **No second screen for large displays** (ADR-0013). One app, laid out by CSS. There was
  one for half a day; reversing it is in the ADR.
- **Language is English (R-09).** Urdu/Pashto is an open decision, not an omission — but it
  decides whether right-to-left layout is needed, and that is much cheaper now than later.

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
- **`/auth` is never cached either.** `/auth/me` is a GET, so it would otherwise be cached
  like anything else — and on a shared handset that shows the previous holder as signed in
  after a shift change, attributing their reports to someone who has gone home. Not a
  staleness bug; a false record.
- **`navigator.onLine` has now caused the same bug twice** — once in the status line, once
  in the offline-login notice. If you are about to read it, don't. Use measured
  reachability; believe `onLine` only when it says `false`.
- **`/incidents` is two different things at the same URL, and the service worker's check
  order is load-bearing.** Adding `/incidents` to `NEVER_CACHE` was correct — a cached
  incident is an emergency shown as unacknowledged while a crew is on the way (INV-02) — but
  it was checked *before* the navigation branch, so an operator opening the app at
  `/incidents/<id>` during an outage got `ERR_INTERNET_DISCONNECTED` instead of the app. A
  navigation to that URL is **a person opening the app** and must always resolve to the
  shell; a `fetch` of the same URL is data and must never be served stale. The URL alone
  does not tell them apart — `request.mode` does. Caught by the M0-12 suite, which happened
  to navigate to `/incidents/<uuid>` as its "unknown path" case. Tests 11 and 12 there now
  pin both halves deliberately, because a fix for either one alone reintroduces the other.

**Real contact data never enters the repository, and verify the rule rather than trusting
it.** Both halves were learned the hard way on 2026-08-02:

- The district's contact document was placed in the repository folder and an over-broad
  `git add -A` committed and pushed it. ~40 officials' personal mobile numbers are in
  history at `1d15b77`. Untracking does not remove them; that needs a rewrite and a
  force-push. **When a human collaborator shares files, the ignore rules have to lead rather
  than follow** — the tooling will not be told a new file is sensitive.
- The first fix silently did nothing. **A gitignore pattern containing a slash is anchored to
  the directory holding the `.gitignore`**, so `db/seed/*.json` matched only
  `<root>/db/seed/` while the real file was at `app/db/seed/`. It needs `**/`. One more
  minute and the numbers would have been committed a second time by the rule written to
  prevent exactly that. **Always confirm with `git check-ignore -v <path>`**; an ignore rule
  that matches nothing looks identical to one that works.

**Never invent a connectivity answer, and never trust a claimed identity.** Two more from
M0-19, both found by tests:

- `Outbox.sync()` used to return a fabricated `{ offline: false }` to an overlapping
  caller — a connectivity claim nothing had measured. Same class of failure as the
  `navigator.onLine` bug. Overlapping callers now join the run in progress and receive its
  real result. **Either measure it, or return the measurement someone else is taking.**
- **Actor identity is stamped from the session, never read from the payload.** Without
  this, any authenticated user could submit an event claiming to be the DC seat, and the
  audit trail — which *is* the record (ADR-0001) — would preserve the lie faithfully. Same
  principle as `recorded_at`: facts a client is not entitled to assert are assigned by
  the server.
- One more, worth remembering when touching `passwords.ts`: base64-decoding garbage yields
  an empty buffer, scrypt asked for a zero-length key returns one too, and
  `timingSafeEqual(empty, empty)` is `true`. A single corrupted hash row would have
  accepted **any password for that account**.

**A null is not a scope. Never let "no department" mean "the district."** Found by the M5
security review, 2026-08-04, and it is the third time this project has been bitten by an
absent value being read as a permissive one — after the four-value `Tier` that defaulted every
loaded post to `district`, and `navigator.onLine`.

- `viewerFor` decided scope with `identity.isAdministration || identity.departmentId === null`.
  **Two completely different callers satisfy that null**: a control-room seat, which should see
  the district, and a person holding **no seat at all** — relieved of their post, or granted a
  login and never given one. The second got the first's answer.
- The blast radius was `GET /dashboard` (district counters, every department's performance row,
  live emergencies) and `GET /status`, whose `listPresence(pool, null)` returns **every seat in
  every department**. `/sync`, `/incidents`, `/admin`, `/roster`, `/notifications` and `/fleet`
  had always refused a seatless caller; the two that had not were the two that leaked.
- **Reachable by an ordinary act.** A handover relieves the outgoing holder, whose session is
  deliberately not revoked because the seat is re-resolved per request (ADR-0004). That design
  is meant to *narrow* authority the instant a post changes hands. Here it widened it.
- **The test encoded the bug.** `dashboard.test.ts`'s own `officer()` helper defaulted to
  `seatId: null, departmentId: null, tier: 'district'` — an identity the database cannot
  produce — so every scoping assertion in the file was made against the exact shape that had
  to be refused. Same failure as the old `Outbox.sync()` test. **A fixture that drifts from
  the schema proves nothing**; derive it the way the database does, or seed a real row.
- **The fix has two halves, and the second is the one that lasts:** `requireSeat` refuses a
  seatless caller at the router, and `viewerFor` now keys on **tier**, which migration 0010's
  trigger derives from the seat's office and no caller can assert. Tier says what the null
  department only implied.

**Rate limiting exists now (2026-08-04), and it is a delay — never a lockout.** `auth/throttle.ts`.
The reasoning below is why, and it is the part to read before changing any constant in that file.

- **A lockout is a denial of service an attacker can aim at a named officer.** The district's
  numbers are semi-public and the roster says who holds which post. Ten wrong passwords against
  the Rescue duty officer's number at 01:50 would lock out exactly the person the system exists
  to reach. **INV-01 outranks a failed-login counter**, the same way it outranks a stale backup.
- **The real exposure is CPU, not guessing.** `/auth/login` is unauthenticated and performs a
  scrypt derivation on every attempt — including for numbers with no account, deliberately, so
  the response time reveals nothing. On one machine in the DC office that is also accepting
  emergency reports, that is a cheap way to make the district stop answering.
- The shape that fits this system, and the shape that was built: **progressive delay** per
  number *and* per source, a **cap on concurrent scrypt work** so login can never starve
  intake, and counters that name nobody — **never** a state that stops a duty officer signing
  in. Four attempts are free; past that each costs more, to a **hard ceiling of five seconds**,
  because an uncapped backoff is a lockout wearing a different name.
- **Two keys, because there are two attacks.** Per number catches somebody working on one
  officer; per source catches one password sprayed across all 79 offices, where no single
  number ever accumulates enough failures to be noticed. A success clears the **number** and
  deliberately not the source: an attacker who finally guesses one weak password must not have
  the evidence of the spray erased by the attack working.
- **The source comes from the socket, never from `X-Forwarded-For`.** That header is written by
  whoever is asking, so trusting it would let an attacker send a different value every request
  and never accumulate a failure. **A rate limiter an attacker can opt out of is worse than
  none, because it is believed.** If a reverse proxy is ever put in front of this, that is the
  line to change, deliberately, with the proxy's own address pinned.
- **In memory, per server.** ADR-0011 deploys one node; a table would mean a write per failed
  attempt, adding load exactly when under load. A restart clears the counters and costs an
  attacker one restart's worth of delay, which is not the difference between safe and unsafe.

**Settled — do not reopen without the owner**
- **No integration with government-issued systems.** The district runs this platform
  independently, by decision of the owner (2026-08-01). Q-01 and Q-02 are resolved. Do not
  spend effort discovering or negotiating external interfaces. Report **export** is
  provided instead, which preserves independence and avoids double work.
- The live consequence: departments already using other systems face **double entry**.
  That is now the top adoption risk. It makes the 15-second rapid-intake budget a hard
  requirement rather than an aspiration, and makes bypass rate the metric that matters most.
- **The export that decision promised now exists (2026-08-04).** `GET /export/incidents.csv`
  returns every incident the caller may see, as a spreadsheet. **It is the board** — same
  `buildBoard`, same seat, same authority — because a second query would eventually disagree
  with the screen about a district's own emergencies, and then two documents would disagree.
  It **refuses rather than truncating**: a short file is worse than no file, because nobody
  counts rows before submitting a report upward. It carries **no citizen contact detail**
  (capability 12) — true by construction, since `BoardRow` has never held one, and pinned by
  a test so that adding one to the board cannot quietly add it to a file departments email
  around. Every text field is neutralised against formula injection, because a department
  name is operator-typed text and a spreadsheet executes a leading `=`.
- **What that export still does not solve is R-17**: the actual forms departments submit
  upward. A generic file leaves somebody retyping, which is the risk above in a smaller form.
- **Full-history search landed with it (2026-08-04).** `GET /search`. The board is the last
  seven days; before this, an emergency from March could be turned into a post-incident report
  by somebody who had written its id down and by nobody else — a record with no way to look
  anything up in it. **It ranges on `occurred_at`, never on arrival**, and that is
  load-bearing: a report captured offline in March and delivered in August would otherwise be
  filed under the day the network came back, so the district's worst weeks — when devices were
  offline longest — would be exactly the weeks that searched emptiest (ADR-0002). Migration
  0019 indexes it. Board, export and search now share **one** projection (`projectIncidents`)
  and differ only in which incidents they select, so no two of them can describe the same
  emergency differently.
- **The shell is now the binding constraint on the client, and office screens no longer ship
  in it (2026-08-04).** The M1 gate holds the shell to 160 KB from `docs/00-thesis.md` — what a
  field officer downloads at a scene on a weak connection. Adding the report screen pushed it
  to 167 KB, and the gate caught it. **The budget was already at 159/160 before that**: one
  kilobyte of headroom, which nothing had said out loud.
  **The answer was not a bigger number.** An officer standing at a road accident has no use
  for a post-incident report or for search, and both need a connection anyway — so both are
  built as **their own entry points with their own stylesheets** (`report.js`/`report.css`,
  `search.js`/`search.css`) and fetched on first use. The shell went back to **159 KB** with
  two more screens in the product than before. **Not `splitting: true`**: that needs ESM output
  and hashed chunk names, and the service worker names the shell's files explicitly so the app
  opens with no network. A tidier build config is not worth trading a known offline boot for.
  **The follow-up landed the same day: the console, the roster and the Status screen are now
  one lazy `office.js`** — one bundle rather than three, because `admin.ts` already imports
  `roster.ts` and splitting them would put a second copy of the roster in one of the files.
  **The shell is 131 KB against 160**, from 159 before any of this, with four more screens in
  the product.
- **`dashboard.ts` stays in the shell, deliberately.** It is the *landing* screen on a laptop
  or an office display — the client reads the viewport in exactly one place and sends anybody
  not holding a phone straight to it (ADR-0013). Making it lazy would put a fetch in front of
  the first screen every office user sees, on every sign-in, to reclaim 10 KB of a budget that
  now has 29 KB spare. **Lazy-loading is for screens somebody chooses to open, not the one
  they land on.**
- **Both got a screen the next day, and shipping without one was the mistake.** `/search` and
  `/export/incidents.csv` existed for a day with **nothing in the client calling either** —
  fully tested, CI green, and unreachable by any officer. **An endpoint with no door is not a
  capability**, and "it's in the API" is the shape that lets a scope list look complete while
  the district cannot do the thing. Search is a tab; export is a plain download link on the
  board. The row renderer is now shared too (`web/src/incidentRow.ts`) — one projection on the
  server deserves one renderer on the client, or an incident found in March reads differently
  from the same incident live.

**Immediate next actions**

Rewritten 2026-08-03. The previous list led with **Q-18** (answered by ADR-0010), **P-08**
(answered, ADR-0011), **Q-07** (moot — the software sends nothing) and **Q-08** (dropped by
the owner). All four were resolved and the list had not caught up. Kept short deliberately:
the detail lives in §5b and **must not be copied here**.

1. **R-04 — routing signals.** The single highest-value thing anyone can do, and it needs no
   code. One signal on one department turns "every emergency is unassigned" into a system
   that routes. Do **R-14** (confirm the six categories) in the same conversation — a signal
   written against a category the district does not use is written against the wrong word.
2. **Everything else waiting on the district is in
   [`backlog/for-the-district.md`](backlog/for-the-district.md).** Work down it in any order.
   The two with the longest tail are **R-06** (a bucket, so backups leave the building) and
   **R-07** (the standby machine); the two needing only an hour of a person's time are
   **R-08** (restore drill) and **R-12** (a Rescue operator walking the M1 gate).
3. **In code, there are two items and neither is urgent:** M0-05 secrets, which the
   deployment decides, and M0-11 payload versioning, which needs a payload v2 to exist first.
4. **Q-04** (legal basis for citizen data) is answered for the build and remains a **pilot**
   question: retention limits and read-access rules are still ours to design (R-11).

## 5b. What is waiting on the district

**One list, one file: [`backlog/for-the-district.md`](backlog/for-the-district.md).** Twelve
items needing a number, a decision, an account or a person, plus six decisions I made on the
district's behalf that they may reverse.

**Do not duplicate that list here.** Two copies of it would disagree within a week, which is
the failure this whole project is built to avoid.

**Two bookkeeping faults in that file were found and fixed on 2026-08-03.** `R-13` had named
two different things, and `R-15` had been raised and never added. **The rule applied — and the
one to apply again — is that the row given a number first keeps it**, because renumbering the
older row invalidates whatever the owner has already written down. So `R-13` stays Rescue
1122's response actions, the weather-point question became **`R-16`**, and `R-15` (tehsils,
union councils, population, area) is on the list. The list now runs **R-01…R-16** with no
gaps and no repeats; `ADR-0013` carries an amendment noting the renumber.

**The standing rule, from the owner (2026-08-02):** *do not wait for any of it.* Build the
place the answer goes, put a **visibly** fake placeholder in it, add a row to that file, and
keep moving. See §7 for both halves of that rule — the second half is not optional.

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
│   ├── 08-runbook.md          ← restore procedure, for whoever is on the phone at 02:00
│   └── adr/                   ← architecture decision records
│       ├── README.md          ← index and template
│       └── ADR-0001..0013     ← 0012 superseded; 0004 and 0013 amended in place
├── .github/workflows/ci.yml   ← CI (M0-04). Real Postgres 17, real Chromium, `npm run check`
├── Department Contact Number.docx ← the district's list. Gitignored by `*.docx`. NEVER commit
├── app/                       ← the application
│   ├── package.json           ← `npm run check` = typecheck + lint + format + test
│   ├── tsconfig.json          ← strict; checks src, web/src and build.mjs
│   ├── tsconfig.build.json    ← emits the server to dist/. `npm start` needs a real compile
│   ├── vitest.config.ts       ← db tests run serially against one cluster
│   ├── eslint.config.js
│   ├── .prettierrc.json
│   ├── .env.example           ← copy to .env; .env is gitignored, never commit it
│   ├── build.mjs              ← esbuild for the web client → web/dist (gitignored)
│   ├── scripts/               ← these live under app/, not the top-level scripts/
│   │   ├── reset-test-db.mjs  ← `npm run test:reset`. The local test DB drifts; this clears it
│   │   ├── sweep.mjs          ← `npm run sweep` — the configuration sweep
│   │   └── demo-data.mjs      ← `npm run demo` / `demo:clear`. All of it says "(demo)"
│   ├── db/migrations/         ← forward-only SQL, 0001–0019. Correct a mistake by adding one
│   ├── web/                   ← the PWA. ONE app: phone, laptop and office screen (ADR-0013)
│   │   ├── index.html         ← app shell + all CSS. The palette is one block at the top
│   │   ├── theme.css          ← shared tokens
│   │   └── src/sw.ts          ← service worker. NEVER cache /sync, /dashboard, /status
│   │   └── src/main.ts        ← boot; connectivity from sync outcomes, not navigator.onLine
│   │   └── src/dashboard.ts   ← the dashboard (M4). Every panel leads to an existing screen
│   │   └── src/status.ts      ← where the district states its own condition (M4). LAZY
│   │   └── src/contact.ts     ← "Reach them" (M5). Opens WhatsApp/dialler/SMS. Sends nothing
│   │   └── src/words.ts       ← category names and durations, in one place
│   │   └── src/incidentRow.ts ← ONE row renderer. Board and search, never two
│   │   └── src/search.ts      ← the search screen. LAZY — not in the shell
│   │   └── src/report.ts      ← the post-incident report + the PDF. LAZY, with report.css
│   │   └── src/workspace.ts   ← the shift screen (M1-01)
│   │   └── src/office.ts      ← barrel: admin + roster + status, ONE lazy bundle
│   │   └── src/admin.ts       ← the administration console (M1a). LAZY, via office.js
│   │   └── src/roster.ts      ← the roster (M1a-10). One component, two doors. LAZY
│   └── src/
│       ├── domain/            ← pure logic, no database, no framework
│       │   ├── events.ts      ← the event catalog (ADR-0001)
│       │   ├── incident.ts    ← the fold: events → state, with provenance
│       │   ├── authority.ts   ← the policy table as data (ADR-0003)
│       │   ├── assumptions.ts ← what the system fills in when nobody said
│       │   ├── routing.ts     ← signals → departments (ADR-0010). Never guesses
│       │   ├── notifications.ts ← obligations derived from state (M0-32, INV-03)
│       │   ├── wall.ts        ← `wallSafetyViolations`. A violation FAILS the request
│       │   ├── resources.ts   ← what a department can send, and whether it can now
│       │   ├── report.ts      ← the post-incident report, folded from the log (M1-06)
│       │   └── sla.ts         ← deadlines and the occurred/recorded split (ADR-0002)
│       ├── db/                ← pool, migration runner, event store
│       │   ├── eventStore.ts  ← append, load, cursor. NO update method, NO delete method
│       │   ├── configStore.ts ← departments, signals, SLA targets + the config log (M1a)
│       │   ├── resourceStore.ts ← vehicles, teams, equipment (M1-02). No status column
│       │   ├── wallStore.ts   ← what the district says about its own condition
│       │   └── rosterStore.ts ← who holds which post, and how to reach them (M1a-10)
│       ├── auth/              ← scrypt passwords, seat-scoped sessions (M0-19)
│       │   └── throttle.ts    ← login delay + scrypt cap. A delay, NEVER a lockout
│       ├── jobs/              ← escalation.ts, notify.ts, scheduler.ts, nightly.ts
│       ├── obs/               ← structured logs + correlation ids (M0-03)
│       ├── ops/               ← backup, restore, offsite, replication, evidence,
│       │                        integrity, weather, the department directory
│       ├── config.ts         ← the boot configuration check (M0-05). Warns ≫ refuses
│       ├── main.ts            ← process entry: API + client + escalation loop
│       ├── api/               ← sync protocol and the node:http server
│       │   ├── lifecycle.ts   ← commands: intake, triage, route, ack, close (M0-24…31)
│       │   ├── board.ts       ← the central board projection (M0-33). No board table
│       │   ├── admin.ts       ← the administration console API (M1a). The gate is here
│       │   ├── performance.ts ← every department side by side (M1a). Folded, not stored
│       │   ├── roster.ts      ← posts, people, handovers (M1a-10). Two audiences, one gate
│       │   ├── dashboard.ts   ← the dashboard feed (M4). Scoped to whoever asked
│       │   ├── status.ts      ← where the district states its own condition (M4)
│       │   ├── contacts.ts    ← the numbers, so a human can ring them (M5). Sends nothing
│       │   ├── exportCsv.ts   ← incidents out, as a spreadsheet. The board, not a 2nd query
│       │   ├── summary.ts     ← what happened over a chosen period. Same medians as console
│       │   ├── search.ts      ← full-history search. Ranges on occurred_at, never arrival
│       │   ├── report.ts      ← the post-incident report endpoint (M1-06)
│       │   ├── resources.ts   ← dispatch and stand-down (M1-03)
│       │   ├── evidenceRoutes.ts ← photographs and files (M1-05). Bytes on disk, hash in DB
│       │   ├── backups.ts     ← Administration → Backups (M0-55). No restore-over-live
│       │   └── notifications.ts ← the seat's inbox (M0-32). No inbox table either
│       ├── outbox/            ← the offline substrate (ADR-0002)
│       │   └── adapters/      ← IndexedDB store, HTTP transport, browser harness
│       ├── __tests__/         ← spine.e2e.test.ts — THE M0 GATE; m1gate.e2e.test.ts — M1's
│       └── testing/           ← test setup, browser global types
├── scripts/
│   └── dev-db.ps1             ← start/stop the local Postgres
├── backlog/
│   ├── milestones.md          ← M0–M5 with pass/fail gates
│   ├── for-the-district.md    ← THE ONE LIST of what waits on the district. Never duplicate
│   ├── week-of-2026-08-02.md  ← a week's working notes
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
- **Do not wait for data. Build the place it goes.** A missing fact is a missing screen far
  more often than it is a missing answer, and the owner has said so explicitly. Put a
  placeholder in, add a row to §5b, and keep moving.
- **A placeholder must be visibly a placeholder.** This is the other half of the rule above
  and it is not optional. A stand-in value that renders like a real one is worse than the
  gap it filled, because the gap was at least asking to be closed — see `person.placeholder`
  in migration 0008, which fills a post and is still never dialled and never counted as
  reached.

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
