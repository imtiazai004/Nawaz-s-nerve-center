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

## 2026-08-01 — Rule 0 hook false positive fixed

- **Changed:** `.claude/rule0-check.ps1` compared content timestamps against the **earlier**
  of `CLAUDE.md` and `CHANGELOG.md`, on the reasoning that both must be current. That was
  wrong, and it produced a false positive the first time it mattered: updating `CLAUDE.md`,
  then `backlog/todos.md`, then `CHANGELOG.md` is a correct sequence, but the earlier
  reference timestamp made `todos.md` look unattended. Now compares against the later of
  the two.
- **Why it matters:** Rule 0 is not an ordering constraint. It asks whether the reference
  was brought current before finishing, and a later write to either file is evidence of
  that. A hook that cries wolf gets ignored, and an ignored hook enforces nothing.
- **Open:** accepted limitation — updating only `CHANGELOG.md` and forgetting `CLAUDE.md`
  will not be caught. Judged cheaper than false positives.
- **Verified:** tested in three states — silent when the reference is current, flags a
  doc changed without a reference update, silent again once the reference is updated.

## 2026-08-01 — The M0 gate passes: the offline spine works end to end

- **Added:** `app/src/api/protocol.ts` — the sync wire protocol. Validation is deliberately
  asymmetric: the **envelope is strict** (without a usable id and timestamp an event cannot
  be stored or ordered at all) and the **payload is permissive** (a reporter under stress
  who omits fields has still told us something happened — INV-01). A malformed event is
  partitioned out with a reason and never takes down the batch around it, because during an
  outage a device may hold the only record of several emergencies.
- **Added:** `app/src/api/server.ts` — `POST /sync`, `GET /sync?cursor=`, `GET /health`.
  Plain `node:http`, no framework (ADR-0007). **Refuses to start when `authMode` is the
  development stub and `NODE_ENV` is anything else** — "shipped with the auth stub still in
  place" is a routine compromise, and a comment does not prevent it.
- **Added:** `app/src/outbox/outbox.ts` — the offline substrate. `enqueue()` returns once
  **durable**, not once sent, so the UI may say "saved" and never "delivered". Releases
  only events the server confirms it holds; anything ambiguous stays queued. Server-rejected
  events become `blocked` and surface to an operator rather than being retried forever —
  not lost, but not buried either.
- **Added:** `app/src/outbox/adapters/indexeddb.ts` and `httpTransport.ts` — the store and
  transport that run on the handset.
- **Added:** 6 real-browser durability tests. Real Chromium, real IndexedDB, assertions
  made **after an actual page reload**. A test that never reloads is testing a Map with
  extra steps, and `fake-indexeddb` would have passed every one of them while proving
  nothing.
- **Added:** `app/src/__tests__/spine.e2e.test.ts` — **the M0 gate, and it passes.** 14
  steps, nothing stubbed at any layer: a critical emergency captured with Playwright cutting
  the network at the driver, proven committed to storage rather than memory, surviving a
  full document teardown, delivering itself on reconnect with no operator action, escalating
  server-side while unacknowledged, overridden by the control room without erasing Rescue's
  own assessment, resolved and closed — then proof the history cannot be rewritten and that
  any past moment can be reconstructed as it was seen then.
- **Fixed:** a test-infrastructure fault worth recording. Two suites launch Chromium, and
  under vitest's default worker-thread pool a browser teardown took the shared worker down
  with it. The run reported `Test Files 7 passed (8)` and `Tests 90 passed (100)` — **ten
  results silently missing behind a run that looked fine.** Now one forked process per file.
  A crash in one file must never be able to hide results in another.
- **Changed:** `tsconfig.json` adds the `DOM` lib for the browser-side adapter. Server code
  must not reach for `document` or `window`; nothing enforces that yet beyond review.
- **Open:** **M0-12, the service worker, is the one gap keeping M0 from closing.** The
  outbox survives everything, but the *app* cannot yet be opened with no network — the
  browser must fetch the document. A handset closed during a shutdown would hold a safe but
  unreachable report. Documented inline at the exact test step where it bites.
- **Open:** two other gate items remain honestly unticked — unauthorised direct-API refusal
  (only sync endpoints exist; real auth is M0-19) and a performed restore drill (M0-38).
- **Changed:** `backlog/todos.md` — M0-13 to M0-17 `DONE`, new M0-41 and M0-42, and the gate
  checklist now shows five ticks and three honest blanks.
- **Verified:** `npm run check` green — typecheck, lint, formatting, **100/100 tests**.
  Committed as `f12e925`. `app/.env` confirmed unstaged.

## 2026-08-01 — M0-12: the app opens with no network

- **Added:** `app/web/src/sw.ts` — the service worker. Closes the last structural gap in
  M0: before this, a handset that closed the browser during a shutdown could not reach the
  app at all, so a queued report was safe on disk and completely unreachable.
- **Added:** `app/web/index.html` and `app/web/src/main.ts` — app shell scaffold. Explicitly
  not the real intake UI, which is M0-36; this exists to prove offline launch. Two of its
  behaviours are not scaffold and must survive: the connectivity rung is always stated
  rather than implied, and a queued entry never renders as delivered.
- **Added:** `app/build.mjs` — esbuild for the web client. No new dependency; esbuild
  already ships with vitest (ADR-0007).
- **Changed:** `src/api/server.ts` serves static assets, with `sw.js` sent `no-cache` so a
  broken service worker can always be replaced — the component responsible for offline
  behaviour must never be the one you cannot fix. Path traversal is refused.
- **Decided:** `/sync` and `/health` are **network-only, never cached, under any
  circumstances.** A cached `/sync` response is not a stale page — it tells a client its
  emergency was accepted when it was not, and the outbox (which releases only what the
  server confirms) then deletes it. INV-01 violated silently by a caching layer, with no
  error anywhere. Two tests pin this.
- **Fixed:** a real UI defect the tests caught. The shell trusted `navigator.onLine`, which
  Chromium reports as `true` while Playwright has the network cut — exactly what a handset
  attached to a cell tower with dead backhaul does. The app displayed **"Connected. Reports
  are delivered immediately."** during a total outage, which is INV-02 applied to
  connectivity itself. Connectivity is now derived from whether a sync actually reached the
  server; `navigator.onLine` is believed only when it says `false`, since a browser
  reporting no interface is trustworthy. Pinned by test 3b, which asserts the browser
  claims online while the UI correctly says offline.
- **Changed:** M0 gate step 4 restored to the real test. It previously had to restore the
  network before reloading, because without a service worker the reload failed with
  `ERR_INTERNET_DISCONNECTED`. It now reopens the handset **with the network still cut**.
- **Fixed:** `scripts/dev-db.ps1 start` held the calling shell open indefinitely — postgres
  inherited the console's stdout handle, so the shell never returned even though the server
  was up, which looks exactly like a hang. Now launched detached with redirected output and
  polled for readiness; returns in ~1.4s.
- **Added:** `app/build.d.mts` so the two e2e suites can import the build script.
- **Changed:** `.gitignore` excludes `web/dist/`.
- **Open:** M0-19 (real authentication) is now the largest remaining hole — every endpoint
  accepts any caller, and INV-05 cannot be tested until it does not.
- **Verified:** `npm run check` green — typecheck, lint, formatting, **111/111 tests**
  across 9 files. Committed as `5d6a8a9`. `app/.env` and `web/dist` confirmed unstaged.

## 2026-08-01 — M0-19: real authentication, and INV-05 finally enforceable

- **Added:** `app/db/migrations/0003_identity.sql` — `person`, `seat`, `duty_assignment`,
  `session`. A partial unique index enforces one current holder per seat: two people
  simultaneously holding "DPO Bannu" would make *"who do I notify right now"* unanswerable,
  which is the question the model exists to answer.
- **Added:** `app/src/auth/passwords.ts` — scrypt from `node:crypto`. No new dependency,
  which matters under ADR-0007. Parameters are stored inside the hash so they can be raised
  later without invalidating existing passwords. The minimum is length, not complexity
  theatre — a policy demanding symbols produces passwords written inside a duty register.
- **Added:** `app/src/auth/sessions.ts` — server-side sessions, chosen in `05-stack.md`
  precisely because **revocation must be instant**. The token is never stored, only its
  SHA-256, so a leaked database hands out no live sessions. Login gives one answer for
  every failure mode: distinguishing "no such number" from "wrong password" hands an
  attacker the list of real officers.
- **Decided:** the seat is **re-resolved from the roster on every request**, never cached in
  the session row. Ending a duty assignment removes authority on the very next request,
  with no cleanup step for anyone to forget — ADR-0004 made operational. A person holding
  no seat may authenticate and do nothing.
- **Fixed (security):** **actor identity is now stamped from the session and whatever the
  client claimed is discarded.** Without this, any authenticated user could submit an event
  claiming to be the DC seat, and the audit trail — which *is* the record under ADR-0001 —
  would have preserved the lie faithfully. Same principle already applied to `recorded_at`:
  facts a client is not entitled to assert are assigned by the server.
- **Fixed (security):** `verifyPassword` **accepted any password against a corrupted hash
  row.** Base64-decoding garbage yields an empty buffer; scrypt asked for a zero-length key
  returns an empty buffer too; and `timingSafeEqual(empty, empty)` is `true`. A single bad
  row would have opened that account to anyone. Now rejects stunted salts and keys, and
  absurd scrypt parameters, before deriving anything. Found by a test that fed in
  deliberately malformed hashes.
- **Fixed:** `Outbox.sync()` returned a fabricated `{ offline: false }` to an overlapping
  caller — inventing a connectivity answer nothing had measured, and feeding the UI the
  same lie as the earlier `navigator.onLine` bug. Overlapping callers now join the run in
  progress and receive its real result. The old test had quietly encoded the bug in its
  assertion (`a.pushed + b.pushed === 1`), which only held because the second caller was
  handed an empty result.
- **Added:** 25 auth tests. Every refusal is exercised **by direct HTTP call**, never
  through a browser — a control that only holds when you use the app is not a control, and
  an attacker uses curl. Covers: unauthenticated push and pull, garbage and oversized
  tokens, disabled accounts, identical responses for wrong-password and unknown-number,
  impersonation, seatless users, authority ending with a duty assignment, instant
  revocation, killing every session for a compromised account, expiry, and the absence of
  any plaintext token in the database.
- **Added:** `app/src/testing/seed.ts` — test identities, because there is no longer a way
  into `/sync` without a session.
- **Changed:** `sync.test.ts`, `spine.e2e.test.ts` and `offlineLaunch.e2e.test.ts` now
  authenticate. The browser suites sign in through the real `/auth/login` endpoint and rely
  on the session cookie, so there is no test-only path past authentication.
- **Fixed:** a flaky assertion in offline-launch test 9. Restoring the network at the end of
  the previous test fires the browser's `online` event, starting a sync that the next call
  legitimately joins. The test now drives the outbox until a sync actually begins while
  offline. Verified stable across repeated runs.
- **Open:** the app still has **no login screen**. The browser tests call `/auth/login`
  directly, which is honest for a test but unusable by an operator.
- **Verified:** `npm run check` green twice in a row — typecheck, lint, formatting,
  **137/137 tests** across 10 files. Committed as `6200ce8`.

## 2026-08-01 — M0-29: the escalation loop actually runs

- **Added:** `app/src/jobs/escalation.ts`. `domain/sla.ts` has known *when* to escalate
  since the first day, but nothing invoked it — so INV-07 held of a function and not of a
  running system, and a closed laptop still stopped an escalation. This is the thing that
  watches.
- **Decided:** **the escalation rule is never duplicated in SQL.** The query narrows
  candidates to open, unacknowledged incidents and nothing more; `checkEscalation` decides.
  A rule expressed twice drifts, and a district would end up escalating by one rule and
  reporting by another.
- **Added:** the seat ladder. Escalation walks station → tehsil → district → provincial,
  preferring a seat in the same department and falling back to the department-agnostic
  control-room seats. A missing tier is skipped rather than stalling on.
- **Decided:** a **vacant post never swallows an escalation** (ADR-0004). It escalates to
  the unheld seat anyway and is flagged `no_duty_holder`, which is a materially different
  situation from a missed deadline and must be distinguishable to whoever reviews it.
- **Added:** `app/src/jobs/scheduler.ts` — an interval loop behind a **Postgres advisory
  lock**, so two instances cannot both escalate the same incident. Deliberately *not* a job
  queue: SLA escalation is a periodic scan, not a set of enqueued items, and building a
  queue to hold one recurring task would be operational surface bought for nothing
  (ADR-0007). A failed pass never kills the loop — a loop that dies after one bad database
  moment is worse than none, because everyone still believes it is watching.
- **Fixed (correctness):** **the scan could starve an emergency indefinitely.** The
  candidate query took an arbitrary `LIMIT` of the open set with no ordering, so once a
  district had more open incidents than the cap, *which* ones got scanned was down to
  whatever order Postgres happened to return — an incident could lose that lottery on every
  single pass and sit unescalated forever, with nothing anywhere reporting a problem. Now
  ordered oldest-first, so the most overdue is always seen, and `truncated` is reported on
  the outcome and logged at `warn` rather than silently absorbed by a `LIMIT`.
- **Added:** `app/src/main.ts` — the process entry point. One process runs the API, serves
  the client and drives the escalation loop (ADR-0007's single deployable). Shutdown is
  ordered: stop escalating, stop accepting requests, release the pool — reversing it could
  leave a pass writing to a closed pool mid-escalation. Structured JSON logs from the start,
  because whoever debugs this at 02:00 will be reading a file, not attaching a debugger.
- **Changed:** SLA targets are injectable into the scheduler. They are operational
  commitments the departments and the DC office make, not engineering constants (Q-06) —
  and `PLACEHOLDER_SLA` is a guess that the loop is now running on.
- **Added:** 18 escalation tests. Time is driven by passing `now` to the pass rather than
  backdating rows: `recorded_at` is server-assigned and the table is append-only, so there
  is no way to fabricate "the server has known about this for 30 minutes" — which is
  correct, and is exactly what makes the audit trail trustworthy.
- **Changed:** the scheduler test now asserts only that passes are *invoked* and stop
  cleanly. Conflating that with escalation outcomes forced a zero-minute target, which every
  incident then trips as a "late arrival" — so nothing escalated and the test proved the
  opposite of its name.
- **Fixed:** a sync test paged to "the end of the log" to get a cursor, which stopped
  working once the shared test log grew past the per-request limit — it was taking the end
  of the first page. Now uses an empty push, which returns the server's true position.
- **Open:** Q-06 is now load-bearing. The escalation loop is live and running on guessed
  deadlines; real targets need agreeing with each department.
- **Verified:** `npm run check` green **four consecutive times** — typecheck, lint,
  formatting, **155/155 tests** across 11 files. Committed as `2f8d26f`.

## 2026-08-01 — A login screen, and the states around it told honestly

- **Added:** sign-in and sign-out in the app shell. The app previously had no way to
  authenticate at all — the browser tests called `/auth/login` directly, which is fine for
  a test and unusable by an operator.
- **Changed:** there are now **three** connectivity states, not two — connected, no
  connection, and **signed out**. A 401 is the server saying no, which is a different fact
  from being unreachable and needs a different action from the operator. Telling someone
  the network is down when their session expired sends them hunting for signal on a working
  connection while the report sits undelivered.
- **Added:** `AuthRequiredError` in `outbox.ts` and `authRequired` on `SyncResult`. Queued
  events are kept on a 401 exactly as when offline — being signed out must never cost an
  emergency.
- **Decided:** **an emergency can be recorded whether or not anyone is signed in.** This is
  the one place the app is deliberately more permissive than the server. A duty officer
  whose session expired overnight, on a handset with no signal, *cannot* sign in, and
  refusing them would lose the emergency outright (INV-01). Nothing is weakened: the server
  still requires a session to accept anything, so the report waits in the outbox. The trade
  is that it is then attributed to whoever delivered it rather than whoever typed it —
  the honest available answer, since that person is identifiable and accountable and the
  alternative was no record at all. Reasoning is written at the handler in `main.ts`.
- **Fixed:** the service worker would have **cached `/auth/me`**, which is a GET like any
  other. On a shared handset that means showing the previous holder as signed in after a
  shift change, and attributing their reports to someone who has gone home — not a
  staleness bug, a false record. `/auth` is now network-only alongside `/sync` and
  `/health`.
- **Fixed:** the offline-login notice trusted `navigator.onLine` — **the same flaw already
  fixed for the status line, in a new place.** Chromium reports `true` with the network
  cut, so the notice never appeared and the sign-in form stayed enabled with nothing behind
  it. Now keyed on measured reachability. `CLAUDE.md` gains a standing instruction not to
  read `navigator.onLine` at all.
- **Changed:** a person holding no seat now sees "no current duty assignment" beside their
  name. Signed in with no authority to act (ADR-0004) is the difference between an operator
  understanding why a report will not send and assuming the system is broken.
- **Added:** 15 login tests covering wrong credentials without leaking which part was
  wrong, sign-in, persistence across reload, a session revoked mid-use, capture while
  signed out, delivery on the next sign-in, attribution, server-side session death after
  logout, offline sign-in, and the absence of any `/auth` response in the cache.
- **Fixed:** two of those tests waited on an empty outbox to infer delivery, which races
  the submit that empties it. They poll the database instead.
- **Verified:** `npm run check` green **three consecutive times** — typecheck, lint,
  formatting, **170/170 tests** across 12 files. Committed as `3848261`.

## 2026-08-01 — M0-36: rapid intake, and the budget actually measured

- **Added:** the rapid-intake screen. The thesis makes intake speed a **correctness
  property**, not polish: a system slower than the phone call it replaces loses to the
  phone, operators stop entering things, and the central board goes quietly false.
- **Measured, not asserted.** The budget test throttles the CPU **4×** to approximate a
  mid-range Android handset — measuring on a developer machine would prove nothing about
  the device this runs on. The clock starts when the screen is usable and stops when the
  report is **durably stored**, not when the network confirms it, because the operator's
  job is done at the point the emergency cannot be lost. **Result: ~800ms against a
  15,000ms budget**, stable across runs.
- **Decided: submit first, enrich after.** The critical path is two taps and a button with
  **no typing at all**. Place and description are offered only once the report is already
  safe, and are **appended as a second event** rather than edited in — what the reporter
  first said and what they added afterwards are both history (ADR-0001). This is what makes
  the budget reachable, and it is the same principle as "an incomplete report is accepted
  and enriched later, never refused" (INV-01).
- **Decided: nothing on the critical path blocks.** Not the network, and not GPS.
  `web/src/location.ts` starts watching for a position the moment the screen opens and
  attaches whatever has arrived by submit time. An operator indoors on an old handset may
  never get a fix, and waiting for one would spend the whole budget on coordinates that
  matter far less than the report itself. Tested with geolocation permission denied.
- **Added:** layered location capture — GPS, free text, any one sufficient. **Which layers
  actually produced something is recorded**, so a downstream consumer can tell a GPS fix
  from an operator's best guess rather than treating every location as equally certain.
- **Changed:** category and severity are tiles backed by radio inputs, so the groups stay
  keyboard- and screen-reader-navigable. Severity carries its meaning in the **label**,
  never colour alone (INV-04). Tap targets are 60px+, the submit button 76px — sized for a
  hand in a hurry, and asserted in a test rather than eyeballed.
- **Changed:** the three existing browser suites moved off the old select-and-text form.
  They now identify a report by its **incident id**, captured from the page after submit,
  rather than by a typed field — which decouples them from the intake form's shape and
  stops the next UI change from breaking three unrelated suites.
- **Open:** M0's last gate item is M0-38, the restore drill, which needs a second person.
  **M1 — Rescue 1122 in full — can begin**, and that is where the dashboard and department
  workspaces start.
- **Verified:** `npm run check` green **three consecutive times** — typecheck, lint,
  formatting, **180/180 tests** across 13 files, intake measured at 771–818ms each run.
  Committed as `d52060d`.

## 2026-08-01 — Bookkeeping corrected: the gate is green, the task list is not finished

No behaviour changed. This entry records three places where the documents had drifted from
the code, all found by reading the todo list against the source rather than trusting it.

- **Fixed:** M0-38 (the restore drill) was described in both `CLAUDE.md` §5 and
  `backlog/todos.md` as "needs a second person, not more code". Only half true — **M0-37,
  the automated backup, does not exist**, so there is nothing to restore from. The drill is
  blocked on code first and a person second. This mattered: it made the last open gate item
  look like a scheduling problem when part of it is unwritten work.
- **Fixed:** the header of `src/domain/__tests__/invariants.test.ts` claimed INV-01, 02, 03
  and 05 all "get their tests when persistence and the API land in M0". Two of those have
  since landed and the header never caught up — **INV-01 is proven by `spine.e2e.test.ts`**
  and **INV-05 by the 25 direct-HTTP refusals in `auth.test.ts`**, neither of which a pure
  domain test could demonstrate. The header now names where each invariant is guarded, and
  narrows the honest gap to INV-02 (needs the boards, M0-33…35) and INV-03 (needs a
  notification channel, M0-32 — there is nothing to test until it exists).
- **Fixed:** M0-03 was listed as flatly `TODO` with acceptance "health endpoint returns
  dependency status" — which `api/server.ts` already does, querying the database and
  answering 503 when it is down. Status stays `TODO` because the other half, **correlation
  ids, does not exist and the API server logs no requests at all**. The note now says which
  half is done, so the next session does not rebuild the finished part.
- **Changed:** `CLAUDE.md` §5 and `todos.md` no longer read as though M0 is one item from
  finished. The **architecture gate** passed and that is what unblocks M1; the **task list**
  is ~60% done, with eighteen of forty-eight open — the lifecycle as HTTP (M0-24…28, 30, 31),
  notifications (M0-32), all three boards (M0-33…35), backup and restore (M0-37, 38) and CI
  (M0-04). The gate passes with the lifecycle endpoints unbuilt because it appends events
  through `/sync` directly; that is legitimate proof of the architecture and is now stated
  plainly instead of being an unexplained gap between two documents.
- **Changed:** the M0 gate checklist said "seven of eight" while listing nine boxes. Eight
  of nine.

## 2026-08-01 — The lifecycle becomes reachable: M0-24…28, 30, 31, 49

The largest open block in M0. Triage, routing, acknowledgement, reassignment, resolution and
closure have existed as proven domain logic since week one and were reachable only by a
client appending raw events through `/sync`. That is right for a device replaying what it
captured offline and wrong for an operator action, because **a raw append trusts the caller
to have checked their own authority.** These are the endpoints that do not.

- **Added:** `src/api/lifecycle.ts` and ten routes — `POST /incidents`, `GET /incidents/:id`,
  and `/triage`, `/route`, `/acknowledge`, `/actions`, `/reassign`, `/override`, `/resolve`,
  `/close`. Every command asks the policy table via `governedFields()`, which names the rows
  a command touches; all of them must permit it. **No command compares a role** — that was
  the point of ADR-0003 and it would have been quietly abandoned the moment eight handlers
  started checking tiers by hand.
- **Added: intake that cannot refuse (M0-24, INV-01).** Every other endpoint here can say
  no. This one cannot, because the thing on the other end of it is someone saying an
  emergency is happening, and a validation error returned to a caller under stress is an
  emergency the system chose to lose. An empty body, a severity of `"apocalyptic"`, even
  unparseable JSON all produce a stored report. What the server had to supply is returned
  and recorded as `assumed`, so a placeholder is never mistaken for a reporter's judgement —
  the same idea as recording which location layers actually produced a fix.
- **Decided:** intake refuses exactly one thing — an `occurredAt` **in the future**. A clock
  skewed forward would push the SLA deadline out and quietly buy the incident extra time
  before it escalates. The report is still accepted; only the claim is dropped.
- **Decided:** an unstated severity becomes `high`, not `low` and not `critical`. `low`
  would let an unassessed emergency sink below routine work, which is INV-04 by the back
  door; `critical` teaches operators to discount the top of the scale. **Open as Q-16** —
  whether the domain should carry an explicit `unknown` instead. That is an ADR, not a
  patch: it touches `SEVERITY_ORDER`, every SLA target, and every screen that sorts.
  **Due before M0-33**, because a placeholder that looks like an assessment is a worse
  failure on a board than in a database.
- **Added: a policy row, `incident.acknowledgement`** (M0-28), rather than a bespoke check.
  It is not a simple ownership question — the escalation ladder deliberately moves an
  unacknowledged incident to a district seat when a department stays silent (ADR-0004,
  ADR-0005), and that seat must then be able to take it. A district acknowledgement
  therefore requires a reason: acknowledgement stops the SLA clock, and the control room
  stopping another department's clock is precisely the act that must be explainable
  afterwards. `docs/04-authority-model.md` updated; the per-row generated test covers it
  automatically, which is what making authority data buys.
- **Added: read scoping, enforced server-side** (M0-49). Cross-department reads are denied
  by default. Tehsil and above read everything — they hold the routing and override
  authority, and authority over a value you may not look at is guesswork. **A refused read
  answers 404, never 403**, because confirming an incident exists is itself a disclosure
  about another department's operations. An unrouted incident is readable by anyone: nobody
  owns it yet, and an emergency nobody may see is an emergency nobody picks up (INV-01).
- **Decided:** closing an incident that was never resolved is refused. Closure completeness
  is one of the metrics this system exists to be honest about, and an incident closed with
  no recorded outcome is the failure it measures. A response action *is* still accepted
  after closure — a crew debrief logged the next morning is a fact that happened.
- **Fixed, and this one is worth reading.** Adding `/incidents` to the service worker's
  `NEVER_CACHE` list was correct — a cached incident is an emergency shown as unacknowledged
  while a crew is already on the way, on the screen used to decide whether to send anyone
  (INV-02). But it was checked **before** the navigation branch, so an operator opening the
  app at `/incidents/<id>` during an outage got `ERR_INTERNET_DISCONNECTED` instead of the
  app. **The same URL is two different things**: a navigation is a person opening the app and
  must always resolve to the shell; a `fetch` is data and must never be served stale. The URL
  cannot tell them apart — `request.mode` can. Caught by the existing M0-12 suite, whose
  "unknown path" case happens to be `/incidents/<uuid>`; tests 11 and 12 there now pin both
  halves on purpose, because fixing either alone reintroduces the other.
- **Open:** Q-17 — the policy table lets a department emit `overridden` on its own field.
  Fully attributable, so nothing can be forged, but `overridden` is meant to record someone
  *else's* authority. Pinned by a test as current behaviour so a change to it is deliberate.
- **Open:** M0-32 is now the only lifecycle gap, and it is load-bearing rather than
  cosmetic. Reassignment and district acknowledgement both owe the owning department a
  notification that nothing sends, and INV-03 has no test until a channel exists.
- **Changed:** M0-35 moves to `DOING`. The data behind incident detail is served — state and
  full history in one response, because provenance must be renderable without a second
  request. The screen is not built.
- **Verified:** `npm run check` green three consecutive times — typecheck, lint, formatting,
  **222/222 tests** across 14 files, including 40 new lifecycle tests made entirely of direct
  HTTP calls. Nothing in this change is exercised through a browser, because an authority
  rule that only holds when you use the app is not a rule (INV-05).

## 2026-08-02 — The district gets a board (M0-33), and severity learns to say "I don't know"

The point at which this stops being a spine and becomes something an operator looks at.

- **Decided: `ADR-0009` — "unassessed" is a value, never a level.** Resolves **Q-16**, and
  the timing was not incidental: the question was theoretical until something rendered
  severity, and then it was not. Intake cannot refuse a report (INV-01), so it had been
  assuming `high` and recording `assumed: ['severity']` in the payload. Defensible in a
  database and indefensible on a screen — **an assumption and an assessment look identical
  once they are both just the word HIGH in a list.**
  - `Severity = AssessedSeverity | 'unknown'`. `SEVERITY_ORDER` still holds only the four
    real levels, because a rank is precisely what `unknown` does not have.
  - **Aggregates now return two numbers** — `{ worst, unassessed }` — and fold neither into
    the other. Counting an unassessed report as `low` hides it exactly as a mean hides a
    critical; counting it as `critical` hides the real criticals among them. INV-04 gains a
    second half in `docs/01-invariants.md` and a permanent test.
  - The urgency the old guess expressed moved to `PLACEHOLDER_SLA.unknown`, which is the
    `high` deadline. Same escalation behaviour, no false claim about who judged what.
  - Triage cannot set `unknown`. Triage is the act of assessing; revising an assessment to
    "no assessment" is not a thing an operator does.
- **Added: `src/api/board.ts` and `GET /incidents` (M0-33).** Folded on demand from the same
  event log. **There is no board table**, so there is nothing that can drift from the record
  (root idea #4, ADR-0001). `loadRecentIncidents` fetches every event for the window in one
  query rather than one per incident — the district's live view must not get slower exactly
  as the district gets busier — and the SQL narrows by recency only. **It does not decide
  what is open**; the fold does. That rule is why the escalation logic did not end up
  written twice, and it applies here for the same reason.
- **Added: the board screen**, and the thing it does that matters most is admit ignorance.
  Every response carries `asOf`, every row carries `lastRecordedAt`, and after 30 seconds
  without reaching the server the header becomes **"NOT LIVE — do not act on this without
  checking"**. INV-02 in the one place it is easiest to violate: a board that quietly keeps
  showing its last good data during an outage is worse than a blank screen, because someone
  decides *not* to send a crew on the strength of a screen saying a crew is already going.
  Rows deliberately stay on screen while offline — the last known picture is still useful.
  It is the *unlabelled* version that is dangerous.
- **Decided:** ordering for attention is not the same question as ranking for aggregation,
  and this is the one place they legitimately differ. `attentionRank` sorts an unassessed
  report just above `critical` — it could be anything, so it does not wait behind assessed
  work — while the summary still counts it separately. **Ordered, never relabelled.**
- **Added:** severity is spelled out in words on every row (`unassessed`, not a colour), and
  a district override shows the department's own value beside it rather than burying it in a
  detail view (ADR-0003, INV-04).
- **Changed:** M0-34 moves to `DOING` rather than `TODO`. `buildBoard` already scopes by the
  caller's seat and the cross-department tests already prove a station seat is never *sent*
  its neighbours' rows — what is missing is a department-framed screen, not a second query.
  Writing one would create the second source of truth this whole design exists to avoid.
- **Fixed:** the Rule 0 stop hook fired on every session that ended by running the tests,
  because `npm run check` rebuilds `web/dist` as its last act and five regenerated artifacts
  looked like undocumented changes. It now filters through `git check-ignore`. Two things
  had to be got right and neither was obvious: git **C-quotes** paths containing spaces, and
  every path here has them, so the first version compared `"D:\a b\x.js"` against a plain
  path and silently matched nothing; and PowerShell terminates piped lines with CRLF, which
  git keeps as part of the pathname and escapes back out as a literal `\r`. A check that
  cries wolf every session teaches everyone to dismiss it, which costs more than the false
  positive itself. Verified in both directions: rebuilt output alone does not block, a real
  source change still does and still names the file.
- **Observed, not fixed:** one run exited with `Worker exited unexpectedly` and reported
  246/248. Not reproduced in four subsequent full runs. Worth recording because it is the
  same shape as the fault that once hid ten results behind a green run — but note the
  difference: `pool: 'forks'` meant it **failed loudly instead of passing falsely**, which
  is the property that was bought. If it returns, it is a real bug in a teardown, not noise.
- **Verified:** `npm run check` green **three consecutive times** — typecheck, lint,
  formatting, **248/248 tests across 16 files**.

## 2026-08-02 — Incident detail (M0-35): the authority model, finally visible

The acceptance criterion for this screen was always a sentence rather than a feature list —
**every value answers "who set this, when, why"** — and until now nothing had ever rendered
it. `ADR-0003` has been true in the data since week one and invisible to every human being.

- **Added:** the incident detail screen. An override shows the district's value **and the
  department's underneath it**, with the reason and both seats named. That is the whole of
  ADR-0003 in one paragraph of markup: nobody can be blamed for a figure they did not enter,
  and nobody can quietly rewrite a department's assessment.
- **Added:** an actor directory on `GET /incidents/:id`. Events carry person and seat **ids**
  and a uuid does not answer "who" — so names are resolved server-side and returned with the
  history rather than fetched per row. Display leads with the **seat**, then the person:
  authority attaches to the post (ADR-0004), so "the District Control Room overrode this" is
  the operationally meaningful sentence and the individual is the supporting detail.
- **Decided:** an event with no actor reads **"the system"**, not a blank. *Nobody did this,
  the deadline did* is a real and important distinction — escalation is the system keeping a
  promise, and a blank would read as missing data.
- **Added:** any event that reached the server 15m or more after it happened shows that gap
  on the timeline. Not a diagnostic curiosity (ADR-0002): an emergency that took two hours to
  surface is an operational risk regardless of how fast the response was afterwards, and this
  is the only screen where anyone will see it.
- **Known limitation, stated rather than discovered later:** actor names resolve from
  **today's** roster. The event still records the person and the seat held at the time — that
  is in the log and cannot change — but renaming a seat retitles it throughout history. The
  alternative is denormalising names into every event, which trades a display quirk for
  permanent duplication. Right trade for M0; recorded so the next person does not find it by
  surprise.
- **Added:** M0-51 — a **department registry**. Surfaced by building this screen: there is no
  `department` table at all, `seat.department_id` is a bare uuid, and so departments render
  as raw ids everywhere. Invisible while one department exists, and the first thing M2's gate
  ("adding a fifth department is a configuration exercise measured in hours") will need.
- **Changed:** M0-35 `DOING` → `DONE`. M0-34 remains `DOING` and deliberately so — the
  department board is already *served* by `buildBoard`, scoped by the caller's seat, and the
  cross-department tests prove a station seat is never sent its neighbours' rows. What is
  missing is a department-framed screen. **Writing a second endpoint for it would create the
  second source of truth this design exists to avoid.**
- **Open:** M0-32 is now the next thing, and the argument for it is no longer "it is on the
  list". It is the last piece of the lifecycle genuinely *absent* rather than merely
  unrendered — reassignment and district acknowledgement each owe a department a notification
  that nothing sends — and INV-03 is the only invariant with no test at all.
- **Verified:** `npm run check` green three consecutive times — typecheck, lint, formatting,
  **258/258 tests across 17 files**.

## 2026-08-02 — M0-32: notifications, and the eighth invariant finally has a test

INV-03 has been the one invariant with nothing guarding it since the first day. It is now
the one with tests in two places, and the lifecycle is closed: capture, route, notify,
acknowledge, escalate, override, close — every step reachable, authorised and observable.

- **Added:** `domain/notifications.ts`, `jobs/notify.ts`, `api/notifications.ts`, and two
  new event types — `notification_delivered` and `notification_failed`.
- **The order of operations is the whole design, and it looks redundant until it isn't.**
  Obligations are derived from **state**; `notified` is appended **before** delivery is
  attempted; only then is the outcome recorded. A crash between attempting and recording
  therefore leaves a **pending** attempt, which the board shows as unmet — the correct
  answer, because we genuinely do not know whether anyone was told. Attempting first and
  recording afterwards would leave nothing at all, and INV-03 would be defeated by a process
  dying quietly rather than by anybody's mistake.
- **Decided: three states, never two.** Queued is not delivered. An attempt stays `pending`
  until the seat holder's client actually collects it. A system that reports "sent" as
  "delivered" is telling the control room an officer knows about an emergency when nothing
  has established that — and the control room will act on it.
- **Decided: a vacant post fails loudly**, the same rule ADR-0004 already forces on
  escalation and for the same reason. Nobody is coming, so somebody has to be told that
  nobody is coming. A skipped notification would have been the quietest possible failure.
- **Decided: failures and silences are counted separately, on the board.** "Could not notify
  the duty seat" needs a roster fixed; "notified, nobody has picked it up" needs a phone
  answered. One number would leave the control room unable to tell which, and INV-03's
  wording — *an unmet obligation, not a log line* — is satisfied by neither if they are
  merged into something ambiguous.
- **Decided: no inbox table.** The inbox is a query over the event log — attempts for my
  seat with nothing settling them — so there is no second store to drift from the record
  (root idea #4). Same reasoning as the board having no board table.
- **Decided: in-app only, and said plainly rather than glossed.** Q-07 (which channels
  actually work in Bannu) is unanswered, so no vendor is assumed and none is invented. **An
  officer who is not looking at the app is not reached.** That is a real gap, it is M3's to
  close, and `NotificationChannel` is the seam SMS and voice slot into without touching any
  of the ledger around them. Q-07 has moved up the priority list as a result: the thing that
  would make an SMS trustworthy is now built and waiting for a channel to put under it.
- **Fixed:** `reassigned` events were being written with `fromDepartmentIds: []`. Found by
  building the notification rules, which need to know **who is losing an incident** in order
  to tell them — and a handover nobody announced is how two departments each assume the
  other went. The event now records both sides; the fold falls back to current state for the
  events already written that way, so no history is lost.
- **Added:** `reassignedFrom` on the projection, for the same reason. A handover has two
  sides and the state could previously only describe one.
- **Changed: M0-39 is `DONE` — all eight invariants have permanent tests.** Not true of any
  previous milestone report. The invariant file's header now names where each one lives,
  including the two that cannot be domain tests (INV-01 in the spine gate, INV-02 on the
  board screen) so nobody re-adds a stub for them.
- **Verified:** `npm run check` green three consecutive times — typecheck, lint, formatting,
  **280/280 tests across 18 files**.

## 2026-08-02 — M0-37: a backup, and a restore that has actually been run

The last engineering item on the M0 gate. What remains of M0-38 is a person and a stopwatch.

- **Added:** `app/src/ops/backup.ts`, `restore.ts`, migration `0004_backup_ledger.sql`, and
  `docs/08-runbook.md`. In TypeScript rather than a shell script because the hosting decision
  is still open (P-08) — a PowerShell-only backup would have been a Windows commitment made
  by accident — and because a backup nobody has tested is the least trustworthy component in
  any system, so it belongs where the test suite can reach it.
- **The round trip is real.** 17 tests run `pg_dump` against the live cluster, write a file,
  replay it into a genuinely separate database with `psql`, and then **fold the restored
  events and compare**. Counting rows proves the data arrived; folding proves the *system*
  arrived — ordering, payloads, provenance. A restore that got the count right and the order
  wrong would pass a row count and fail an audit (ADR-0008).
- **Decided: the attempt is recorded before the dump starts.** Same shape as a notification
  attempt (M0-32), same reason: a process killed mid-dump leaves a visible `running` row
  rather than no row at all, and a gap in that table is the one thing nobody would notice.
- **Decided: a dump is verified, not assumed.** `pg_dump` exiting 0 is not evidence — an
  empty file, a truncated file and a file full of errors can all exit 0. Size, checksum and
  **the event count inside the file** are checked, and a dump holding fewer events than the
  live database is recorded as a **failure**, not a warning. INV-01 does not stop applying
  because the failure happened during maintenance.
- **Decided: never restore in place.** The target is always named by the caller. A tool whose
  easiest path overwrites production is a tool that eventually overwrites production, at
  02:00, by someone who meant to type something else.
- **Decided: `ON_ERROR_STOP=1` is mandatory.** Without it `psql` reports success after
  replaying a dump that half-failed — you get a database, it is missing things, and nothing
  said so. That is the single most dangerous default in the whole procedure.
- **Added: `verifyRestoredIntegrity`, which checks the triggers and not just the rows.** A
  restore that brings back the data but not the append-only guard gives you a database where
  the event log **can be edited**, and nobody finds out until an audit. The data would be
  back and the whole of ADR-0001 would be gone.
- **Caught while writing it, worth recording.** The first version of that integrity probe ran
  `UPDATE ... WHERE false`. The guard is a **row-level** trigger, so a probe matching no rows
  fires nothing — it reported a perfectly healthy restore as broken. It now targets a real
  row, inside a transaction that is **always** rolled back, so that on the one database where
  the check matters — the one missing its guard — the probe cannot itself be the thing that
  rewrites history.
- **Caught before shipping, and the more dangerous of the two.** `/health` was briefly wired
  to return **503 when the backup was stale**. A load balancer would have taken the node out
  of rotation and stopped the district reporting emergencies — because a dump was old. It
  reports `degraded: true` at status 200 instead. **INV-01 outranks a stale backup**, and
  liveness and the backup obligation are different questions that now get different answers.
- **Open:** nothing schedules the backup yet. `runBackup` is written, tested and callable;
  wiring it to a timer is a deployment decision that waits on **P-08 (hosting)** — which has
  therefore moved from a theoretical question to one blocking something concrete.
- **Open:** M0-38 is now a scheduling problem rather than an engineering one. The runbook is
  written for someone who did not build this, and every step in it has been executed by the
  test suite against a real cluster. **It still needs a second person**, and a restore
  procedure only ever performed by its author is a document, not a backup strategy.
- **Verified:** typecheck, lint, formatting, **297/297 tests across 19 files** — green on six
  of seven consecutive runs. Stated precisely rather than rounded up, because of the next
  point.
- **Open — the intermittent worker crash is now a pattern, not a one-off.** `Worker exited
  unexpectedly` has appeared **twice in roughly twelve full runs** (246/248 in the M0-33 pass,
  285/297 here), and four deliberate attempts to reproduce it immediately afterwards were all
  clean. It is not correlated with the new suite as far as can be told from two samples.
  Recorded rather than dismissed: it is the same shape as the fault that once hid ten results
  behind a green run. The difference remains that `pool: 'forks'` makes it **fail loudly
  instead of passing falsely**, which is the property that was bought.
  **This is now the strongest argument for M0-04 (CI):** one person running the suite by hand
  a dozen times is not a sample size, and characterising an intermittent fault needs
  hundreds of runs nobody has to remember to start.
- **Open — P-09, a new question: where does this repository live?** There is no git remote;
  everything is on one disk. Raised because it **blocks M0-04 (CI)** — a workflow written for
  a service nobody has chosen is speculative work — and because a project with no off-machine
  copy is one disk failure from being gone, which is a poor look for the week the backup
  system was built.

## 2026-08-02 — P-09 resolved, M0-04 done, and CI immediately earned its keep

- **Resolved: P-09.** The repository is on GitHub, private, at
  `imtiazai004/Nawaz-s-nerve-center`, branch `main`. Everything up to this point existed on
  one disk.
  **Recorded because the two get conflated: this says nothing about where the application
  runs.** P-08 is still open, and on-premise remains a live and arguably better option — the
  system is offline-first because *Bannu's* connectivity is unreliable, and a cloud server
  turns a district internet outage into every handset and the control room losing sight of
  their own system at once. A server in the DC office keeps the local network working.
- **Added: `.github/workflows/ci.yml` (M0-04).** One job, running the same command a
  developer runs, against a **real PostgreSQL 17 and a real Chromium**. Slower than a mocked
  build; that is the point — the properties under test are durability and genuine
  immutability, and a stand-in demonstrates neither. ~1m25s.
- **Added: a missing `TEST_DATABASE_URL` under `CI` is now a hard failure rather than a
  skip.** Locally the skip is a kindness — you can run the domain tests with no cluster. In
  CI it is a trap: one broken secret would drop every integration suite and the build would
  go **green with roughly fifty tests instead of 297**, reporting success having proven
  almost nothing.
- **Fixed: `esbuild` was a phantom dependency.** `build.mjs` imported it directly while it
  was only present as a transitive dependency of vitest — it resolved because npm hoisted
  another package's internals to the top level. It would have broken on a vite bump or a
  stricter package manager, and it would have broken **the build**, at a moment nobody was
  touching the build. Declaring it installs nothing extra; it dedupes to the same copy.
- **Fixed: two `eventStore` cursor tests found "the end of the log" by paging
  `loadSince(pool, 0, 10_000)`.** That is the end of the log right up until the log has more
  than ten thousand events in it — and the test database crossed 11,000 this week. Not a
  regression: a test that was always going to fail eventually, on a day unrelated to whatever
  change happened to trigger it. Added `currentCursor()`, which `server.ts` was already doing
  inline with duplicated SQL.

**CI found two more faults on its first run, and both were invisible locally.**

- **`pg_dump` resolved to version 16 against a 17 server.** `/usr/bin/pg_dump` on Debian is
  `pg_wrapper`, which *chooses* a version, and with client 16 on the runner image it chose 16
  even though 17.10 had installed correctly. Fixed by pointing `PG_BIN` at
  `/usr/lib/postgresql/17/bin` — the seam `ops/backup.ts` already had for the portable local
  cluster — and the workflow now **asserts** the version instead of printing it, so a wrapper
  change fails where the cause is obvious rather than six steps later as a confusing test
  failure.
- **The login suite had a stale-state race.** `reportEmergency` waited for `#sent` to become
  visible — but `#sent` stays visible after the first report, so the wait returned instantly
  and `lastIncidentId()` could still be the *previous* report's. Test 8 then asserted "this
  was not stored while signed out" against test 5's incident, which had been legitimately
  stored. It passed locally on timing and failed on CI's empty database. It now waits for the
  id to **change**, which does not depend on how fast the machine is. `rapidIntake` reloads
  the page between reports and never had this — checked rather than assumed.
- **The lesson worth keeping:** both faults were state- and timing-dependent, and a developer
  machine with a fat database and a warm cache is the environment least likely to show them.
  That is the argument for CI, and it made it on the first run.
- **Verified:** the full suite passes against a **freshly created database with `CI=true`** —
  the exact condition that exposed both — 297/297 across 19 files, and green on GitHub.
- **Known and benign:** GitHub warns that `actions/checkout@v4` and `actions/setup-node@v4`
  target Node 20 and are forced onto Node 24. Not a failure; recorded so the next person does
  not go looking.

## 2026-08-02 — M0-51: the department registry, and the district's contact list

The district supplied its contact list: 81 posts across ~79 offices, 43 with mobile numbers.
This is the first verified domain data in the project — everything about Bannu until now was
explicitly marked assumption.

- **Incident, recorded first because it is mine.** The contact document was placed inside the
  repository folder and an over-broad `git add -A` committed it in `1d15b77`, which was
  pushed. Personal mobile numbers of ~40 named district officials are therefore in the
  repository's history. It is now untracked and `*.docx` is gitignored, but **untracking does
  not remove it from history** — that needs a rewrite and a force-push, which is the owner's
  decision and is pending. The lesson is not "be careful with `git add -A`"; it is that a
  repository shared with a human collaborator will receive files nobody told the tooling
  about, and the ignore rules have to lead rather than follow.
- **Added:** migration `0005_department_registry.sql`. `department` table, and
  `seat.department_id` is now a **real foreign key** — it was a bare uuid referencing nothing,
  which is why departments could never be named on a screen.
- **Added:** the migration **backfills before it constrains**. Every pre-existing
  `department_id` points at nothing, so the foreign key could not be added against the table
  as it stood. The orphans get a department named `Unregistered department (a1b2…)` rather
  than being nulled or deleted: an id that was never a department is a real gap, and a row
  saying so on a board is a prompt to fix it. Nulling would have erased the evidence.
- **Added:** `ops/directory.ts`. Idempotent — the district has more contacts coming.
- **Decided: a directory entry is not an account.** `person.password_hash` is now nullable
  and loaded people have none, so they can be notified and cannot sign in. Creating logins
  for ~80 officials who have not been told the system exists would be ~80 credentials nobody
  is watching, with passwords nobody chose. `login()` already failed closed on a null hash;
  there is now a test pinning it rather than leaving it to the comparison happening to miss.
- **Decided: conflicts are reported, never resolved.** The loader returns `problems` and the
  caller must read them. It found one on the real list immediately — see Q-19.
- **Decided: nothing is inferred.** The department is the row's own "Department/Office"
  value, verbatim. `ADC (General)` is plainly a post under the DC Office and `DSP City` under
  the DPO, but *how Bannu is organised* is a fact to confirm, not one to derive from a
  spreadsheet column. Recorded as **Q-18**.
- **Changed:** the board and the incident detail screen now show department **names**.
  Correcting an earlier claim in this changelog and in `CLAUDE.md`: departments were not
  being rendered as uuids, they were not being rendered **at all**. The uuid would have
  appeared the moment anything tried.
- **Changed:** every test that invented a department uuid now creates a real department row,
  via `seedDepartment`/`ensureDepartment`. Seven suites. That the old behaviour worked is
  precisely the bug — the database accepted an id that meant nothing.
- **Open — Q-18, and it is the most consequential thing on the list.** Every loaded seat
  defaults to `district` tier because the source has no tier column, and **the escalation
  ladder walks tiers**. On this data it cannot escalate correctly. Also unresolved: which
  offices are posts inside larger departments, and which of the ~79 are emergency responders
  at all (routing should not offer Fisheries or the Press Club).
- **Open — Q-19.** `03338887171` is listed for both `ADC (Finance & Planning) — Yousaf
  Haroon` and `TMA Bannu — Yousaf Khan`. Different names, one number: a typo and a shared
  handset need opposite fixes, so neither was loaded over the other and TMA Bannu is absent
  until it is resolved. Two smaller ones: `AAC Bakakhel` carries the designation `AAC Miryan`,
  and **Rescue 1122 has no contact number at all** — which is awkward, since Rescue 1122 is
  the entire subject of M1.
- **Changed:** Q-14 is now partially answered. The directory exists and the district has it.
  The unanswered half is the expensive one: **who keeps it current**, given the system routes
  emergencies by it.
- **Verified:** 310/310 tests across 20 files, on the working database **and** on a freshly
  created one with `CI=true` — the migration's backfill path only runs on the former.

## 2026-08-02 — The ignore rule that ignored nothing

Small change, recorded because it is a near-miss on a privacy control rather than a tidy-up,
and because it was found after the M0-51 entry above was already written.

- **Fixed:** the `.gitignore` rule added minutes earlier to keep the district's contact list
  out of the repository **matched nothing**. A gitignore pattern containing a slash is
  anchored to the directory holding the `.gitignore`, so `db/seed/*.json` covered only
  `<root>/db/seed/` — and the real file is at `app/db/seed/`. Now `**/db/seed/*.json`, with
  `!**/db/seed/*.example.json` for the committed placeholder.
- **Why it matters more than its size:** the numbers had already reached the repository once
  through an over-broad `git add -A`. The rule written to stop it happening again would have
  let it happen again, and nothing would have complained — **an ignore rule that matches
  nothing is indistinguishable from one that works** until you look. Caught by running
  `git check-ignore -v` before committing rather than by reading the pattern and believing it.
- **Changed:** `CLAUDE.md` gains both halves as a standing lesson — keep real contact data out
  of the repository, and verify ignore rules with `git check-ignore -v` instead of trusting
  them. It sits beside the other "verify, do not assume" entries (`navigator.onLine`, cached
  `/sync`, the `WHERE false` integrity probe), because it is the same mistake wearing
  different clothes.
- **Open:** unchanged and still the owner's decision — commit `1d15b77` continues to hold the
  contact list in history. Removing it needs a rewrite and a force-push.

## 2026-08-02 — Q-19 resolved: a phone number identifies an account, not a person

- **Resolved: Q-19.** The owner confirmed that `03338887171` genuinely covers two posts —
  `ADC (Finance & Planning) — Yousaf Haroon` and `TMA Bannu — Yousaf Khan`. An office handset
  serving two offices is ordinary here, so **the schema was wrong, not the data**. A directory
  that refuses to describe the district it describes is not a directory.
- **Added:** migration `0006_shared_handsets.sql`. `person.phone` was `UNIQUE`, which made
  the district's reality unrepresentable — but `phone` is also the login identifier, and
  dropping uniqueness outright would leave "who is signing in?" with two candidates and no
  rule for choosing. So uniqueness **moved to where it is load-bearing**: a person who can
  authenticate (`password_hash IS NOT NULL`) must own their number; a directory contact —
  notifiable, no credentials — may share one.
- **Changed:** `login()` now selects only rows with a password hash. Without it the query
  could return the contact row and the account row and pick arbitrarily between them.
- **Changed:** the loader matches a row to a person by **name and number**, not number alone.
  Matching on phone would have handed the second post to whichever officer was inserted
  first — silently, and looking entirely correct. There is a test for exactly that.
- **Changed:** the loader now returns `notes` as well as `problems`. A **problem** means a row
  did not load; a **note** means it did and somebody should still look. A shared handset is
  real *and* is precisely the shape a mistyped digit takes, so it loads and stays visible
  rather than becoming silent on the second run.
- **Decided, both accepted as given by the owner:** `AAC Bakakhel` keeps the designation
  `AAC Miryan` from the source — it is the district's document, and quietly correcting it
  would put a change in the roster that nobody in Bannu made. And **Rescue 1122 loads with a
  vacant post**, having no number in the list.
- **Open, and worth restating rather than filing away:** Rescue 1122 being vacant is not a
  small gap. M1 is entirely about Rescue 1122, notifications reach a seat through its holder,
  and a vacant seat is what the escalation ladder is built to surface rather than swallow.
  **M1 cannot demonstrate a full incident lifecycle until that number exists.**
- **Verified:** the real list reloaded cleanly and idempotently — the second run added exactly
  one person and one assignment (the previously-blocked TMA Bannu row) and nothing else, with
  both officers correctly attached to their own posts. 313/313 tests across 20 files.

## 2026-08-02 — A CI flake, and a budget that was measuring the wrong thing

- **Correction to the previous session summary:** CI was reported as green on `eafb446`. It
  was not — that run failed and the claim was made without checking. Recorded because an
  unverified green is worse than a red one.
- **Fixed:** `rapidIntake.e2e.test.ts` waited on `#submit` to decide the app was ready.
  `#submit` is in the **static HTML**, so it appears the moment the document parses, before
  `boot()` has opened IndexedDB and published `__dnc`. Under the 4× CPU throttle the gap was
  wide enough for CI to hit `Cannot read properties of undefined (reading 'store')`. Same
  class as the login race found yesterday: **waiting on something that is already true.**
  There is now a `waitForReady()` that waits for `__dnc`.
- **Fixed, and this one is the more interesting half.** Moving the clock past `waitForReady()`
  made the measured intake time drop from ~800ms to **264ms** — and nothing had got faster.
  The measurement had simply stopped counting the load. The thesis asks for *"under 15
  seconds **from open** to submitted"*, and an operator standing at a road accident is waiting
  through startup exactly as much as through the taps. The clock now starts **before**
  `page.reload()`, so it covers load, boot and interaction. **509ms at 4× throttle**, against
  a 15,000ms budget.
  The lesson is the one this project keeps relearning: a green number is not evidence until
  you know what it measured. A fix that improves a metric by narrowing it is not a fix.
- **Verified:** 313/313 tests across 20 files.
