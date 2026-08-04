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

## 2026-08-02 — M0-03: correlation ids, and a log that can be followed

The last unblocked code item in M0. The server logged nothing per request, so "I filed a
report at 14:20 and it vanished" had no answer — and ADR-0007's whole premise is a system
one person can operate at 02:00.

- **Added:** `src/obs/log.ts`. One JSON object per line on stdout: `journalctl`, `grep` and
  `jq` all work on it, and there is no logging framework for anyone to configure, break, or
  have to understand at 02:00.
- **Added:** a correlation id on every request, returned in `x-correlation-id` so an operator
  can quote it, and **accepted** from the caller so a client retrying a held batch produces
  one story in the log rather than four unrelated ones.
- **Decided: the id lives in `AsyncLocalStorage`, not in a parameter.** A deliberate
  exception to this project's usual preference for the explicit option, and worth stating
  why: threading a context argument through the event store, the fold, the authority check
  and the notifier is dozens of signatures, and every one is a place for a future change to
  forget it. This makes *every line carries the id* true **by construction** rather than by
  discipline, for one stdlib import and no dependency.
- **Decided: nothing sensitive is logged, ever.** Bodies are never logged at all —
  `/auth/login` carries a phone number and a password, and the way to guarantee those never
  surface is to have no code path that could write them. Field names matching
  `password`/`phone`/`token`/`authorization`/`secret`/`credential`/`apikey` are redacted by
  substring, case-insensitively, at any depth, so `reporterPhone` and `PASSWORD_HASH` are
  both caught. Actor and seat **ids** are logged: "who did this" is the question a log exists
  to answer, and those ids are already in the audit trail.
- **Decided: an inbound correlation id is sanitised, not trusted.** It is echoed into a
  response header and into every log line, so an unchecked value is a header-splitting and
  log-forging primitive. Anything outside `[A-Za-z0-9._-]{1,64}` is replaced with a fresh
  id — quietly, because a malformed header is not worth failing an emergency report over.
- **Decided: routine successes are filtered.** Monitoring polls `/health` continuously and
  the PWA refetches its own assets on every launch. Logging those at `info` would bury the
  requests anyone ever looks for, and a log nobody can read is a log nobody reads. They are
  logged when they fail, which is the case that matters.
- **Added:** each scheduler tick runs under its own correlation id and `job: 'scheduler'`, so
  the escalations and notifications one pass produced are one traceable story — and an
  escalation at 02:14 is distinguishable from one a request caused.
- **Changed:** `main.ts` dropped its own private `log()` in favour of the shared one, so
  there is one logger rather than two that will drift.
- **Changed:** tests run at `LOG_LEVEL=error` (`testing/loadEnv.ts`), because request logging
  in twenty-one suites buried the output someone is actually reading. `VITEST_LOG_LEVEL=info`
  turns it back up.
- **Verified:** 332/332 tests across 21 files, including real request lines observed from the
  live server — caller's id echoed, no body, and the routine `/health` 200 correctly absent.
- **Open:** with this done there is **no unblocked M0 code item left**. What remains needs a
  person (M0-38), a deployment decision (M0-37 scheduling, M0-05), or a thing that does not
  exist yet (M0-11 needs a payload v2). M1 is the work now, and it stalls on **Q-18** (tiers)
  and Rescue 1122's number.

## 2026-08-02 — M0-34: the department board and the seat inbox, and two tests that were grading their own homework

- **Added: the seat inbox**, and it closes a loop that had been open at its last step. Until
  now **nothing in the browser ever called `/notifications`** — attempts were created, stayed
  `pending` for ever, and the central board carried them as unmet obligations permanently.
  M0-32 built the ledger and the delivery semantics; this is the part with a human in it.
- **Decided: delivery is recorded when the operator says they have seen it, never on render.**
  Marking items delivered because a list drew them would make "delivered" mean "the tab was
  open", which is exactly the overclaim INV-03 exists to prevent. The consequence is
  deliberate: an unopened notification keeps the board red until somebody acts.
- **Changed: the department board is the same `buildBoard`, the same projection, the same
  query.** Scoping falls out of the seat, so there is nothing that could disagree with the
  district view. What differs is the label — and it now **names** the department.
- **Fixed: the board said "your department" to everyone, including the district control
  room.** It read `identity.departmentId`, which the client's `Identity` interface did not
  declare, so `undefined === null` was false every time. It shipped, and nothing objected.
- **Fixed, and this is the one that matters: `web/` was never in `tsconfig.json`.** The PWA —
  service worker, offline logic, intake, everything an operator touches — is built by
  esbuild, which **strips** types without checking them. So the operator-facing half of the
  system had no type safety at all, for months, silently. Turning it on immediately produced
  seven errors including the bug above. `include` is now `["src", "web/src", "build.mjs"]`,
  and `npm run lint` covers `web/src` too.
- **Fixed: `board.e2e.test.ts` had been asserting less than it claimed.** Its `seedIncident`
  helper routed each incident by calling the API **as the signed-in station officer**, who
  has no authority to route — every call returned **403 and was thrown away**. The tests
  passed regardless, because an *unrouted* incident is readable by everyone (deliberate: an
  emergency nobody may see is an emergency nobody picks up). So *"lists live incidents scoped
  to the seat"* was green while proving nothing whatsoever about scoping. Routing now goes
  through a district-tier seat and **the status is asserted**.
  A test helper that ignores a status code is a test that grades its own homework, and it
  took building something that genuinely needed the routing to have happened to notice.
- **Removed:** `lastClientSeq` in the web client — assigned, incremented, never read. The
  outbox owns sequencing; a second counter beside it only suggested otherwise.
- **Verified:** 336/336 tests across 21 files.
- **Open:** with M0-34 done, **every M0 task that is code is complete.** What remains needs a
  person (M0-38), a deployment decision (M0-37, M0-05, both on P-08), or something that does
  not exist yet (M0-11 needs a payload v2). M1 stalls on **Q-18** and Rescue 1122's number.

## 2026-08-02 — The outbox could hold a report indefinitely while saying "delivered immediately"

Found by a CI-only failure in the enrichment test, which turned out not to be a test problem.

- **Fixed:** `runSync` reads the queue **once, at the start**. Anything enqueued while a sync
  was already in flight therefore missed that batch — and the caller got the in-flight run's
  result, which correctly reported the server as reachable. Nothing was wrong with that
  answer, and **nothing would ever have sent the report**: it sat in the outbox until the
  next `online` event, the next submit, or an app restart, while the status line said
  *"Connected. Reports are delivered immediately."*
  Not lost, but not delivered, and indistinguishable from delivered on screen. That is the
  same shape as the failures INV-01 keeps turning up, and the third time this project has
  found a connectivity claim that nothing had actually established.
- **Added:** `enqueue` marks that it landed mid-run, and `sync` chains **one** follow-up run
  when it did. Deliberately not a loop: the flag is cleared before the follow-up, so a run
  that itself receives new work chains once more and no further.
- **Decided:** a follow-up run happens only when the server was actually reached. Chaining on
  an offline or refused result would busy-loop against a dead network — which in Bannu is the
  normal state, not an exception. There is a test for that specifically, because it is the
  obvious thing to get wrong while fixing the first half.
- **Verified:** 338/338 tests across 21 files. The two new outbox tests drive the race
  deterministically with a transport hook rather than hoping for the timing that CI happened
  to produce.

## 2026-08-02 — `npm start` had never worked

Asked whether the app could be opened on localhost. Answering that honestly took two fixes,
and the first is the most uncomfortable finding in this project so far.

- **Fixed: `npm start` had never worked.** Not regressed — never, not once. It ran
  `node --experimental-strip-types src/main.ts`, and type stripping does **not** remap a
  `.js` import specifier to the `.ts` file beside it. Every import in this codebase is
  written with `.js`, which is correct for compiled ESM and is exactly what `tsc` resolves —
  there simply was no compile step. **Vitest resolves those specifiers itself**, which is why
  338 tests, three consecutive green runs and a green CI all passed against an application
  that could not be launched.
  `npm start` is now `node build.mjs` → `tsc -p tsconfig.build.json` → `node dist/main.js`.
  The most boring option, and the one the import style already assumed.
- **Fixed: `app/.env` was only ever read by the test setup.** The process started, found no
  `DATABASE_URL`, and exited. `CLAUDE.md` and `docs/05-stack.md` both name that file as where
  configuration lives, and the application had never read it. `main.ts` loads it when present
  — absent is not an error, because a real deployment passes real environment variables.
- **Added: `src/__tests__/deployable.e2e.test.ts`.** It compiles the real artifact, runs it
  the way a district server would, and waits for `/health` to answer with `db: "up"`. Every
  other test in this repository proves the system is *correct*; this is the only one that
  proves it can be *turned on*.
- **The lesson, and it is not "add a smoke test".** Both faults were invisible to 340 tests,
  to CI, and to every green run — and both surfaced within ninety seconds of somebody trying
  to **use** the thing. A test suite verifies the code it imports. It cannot verify the way
  the code is launched, and this project had been treating a green suite as if it could.
  It is the same argument as M0-38: a restore procedure nobody has performed is a document,
  and an application nobody has started is a library.
- **Verified:** 340/340 tests across 22 files, and the server observed serving the real PWA
  on `localhost:3000` against the dev database — sign-in, rapid intake, the district board
  showing named departments from the district's own contact list, and incident detail.

## 2026-08-02 — The district answers: two offices, and almost every open question becomes build work

The owner settled how Bannu is organised, and the answer is simpler than the architecture
assumed. Most of what was "waiting on the district" turns out to be screens we have not
built rather than facts we were missing.

- **Decided: `ADR-0010` — the ladder has two rungs.** The **DC Office** and the **AC
  Headquarter Bannu Office** are the authority for the whole district; every other department
  reports to them. There is no third rung. This **supersedes the four-tier hierarchy** in
  `ADR-0004`, which was a generic guess made before anyone had said how the district works.
  Resolves **Q-18**, which was the highest-value open question in the project.
- **Decided: routing is configuration, not inference.** Each department carries **routing
  signals** — the categories it answers for — set by the administration. A bazaar fire
  reaches Rescue; heatstroke reaches Health. Anything unmatched is **not guessed at**: it
  appears on both administrative dashboards marked *unassigned*, for a human to assign
  (ADR-0005). Deterministic rules as data, consistent with ADR-0003 and with the standing ban
  on anything inferring its way into the critical path.
- **Added: M1a, the administration console**, in `backlog/milestones.md`, and it is now the
  critical path. Departments as editable data, routing signals, SLA targets as configuration,
  unassigned alerts, district-wide performance, backup visibility. **M2's gate — "adding a
  department is a configuration exercise" — arrives a milestone early**, as a consequence of
  this model rather than as work.
- **The correction worth naming:** several items were being reported to the owner as *waiting
  on you* when they were in fact *waiting on us to build the screen where you would enter it*.
  SLA targets, Rescue 1122's missing number, which departments respond to what — none of
  those needed to be gathered first. **Do not wait for data. Build the place it goes.**
- **Resolved: Q-06** — the DC and AC offices set SLA targets inside the software. Reclassified
  from a question to a build task. Until that screen exists the board still renders
  `PLACEHOLDER_SLA` to operators as fact, so it is closed as a question and open as work.
- **Resolved: Q-04** — the district administration is legally empowered to record, hold, act
  on and respond to any emergency in the district. **The pilot is unblocked.** Retention
  limits and read-access rules remain ours to design: permission to hold data is not a
  decision about how long, or who may look.
- **Answered in intent: Q-07** — wire up WhatsApp, SMS and voice, with the user choosing per
  notification. The ledger from M0-32 already treats channels as pluggable. What the answer
  does not supply is accounts, templates and money — and it **collides with P-08**: a server
  with no internet cannot send WhatsApp at all, and can only send SMS or place calls through
  a GSM modem attached to the machine. That coupling is now the most consequential open item.
- **Closed: Q-10** — nothing escalates above the district administration. Out of scope.
- **Dropped: Q-08 / P-06** — no gazetteer work. Location capture already functions without
  one (M0-48).
- **Resolved: P-07** — **Allah Nawaz Khan, AC Headquarter Bannu** is the named technical
  person, and the natural candidate for the M0-38 restore drill.
- **Decided: P-10 — the contact list stays in git history.** The owner is content; the
  repository is private. Recorded so nobody reopens it later as an oversight.
- **Open, and raised rather than assumed:** the owner asked for **restore from the
  administrative dashboard**. Backup visibility, taking one on demand and downloading it are
  straightforward. **Restoring over the live database from a web button is not**, and
  `ops/restore.ts` refuses in-place restores by design — a mis-click or a stolen session
  would replace the district's record. A safer split is proposed in the summary to the owner.

## 2026-08-02 — Deployment and notification policy settled

- **Decided:** `ADR-0011` — one record on district hardware. PostgreSQL primary in the **DC
  office**, warm standby in the **AC Headquarter office**, server reachable from outside so
  field handsets sync from anywhere, **nightly** encrypted dumps to Google Cloud Storage.
- **Decided:** `ADR-0012` — notifications walk a ladder: WhatsApp, then a voice call, then
  SMS, with the in-app inbox always in parallel. The ladder is configuration edited by the
  administration, not code.
- **Changed:** `ADR-0010` gains two clarifications from the owner — the **AACs and TMOs are
  departments**, not administration, and the **DC and AC Headquarter dashboards are
  identical**. Neither office outranks the other; a later "super-admin" would contradict this.
- **Open:** `Q-07` resolved. `P-08` resolved and closed — it had been carried since the start
  as a deployment-time fork and was blocking backup scheduling.
- **Added:** `P-11` (procure WhatsApp/SMS/voice/GSM — the longest lead time in the project,
  because Meta must pre-approve alert templates), `P-12` (GCS bucket), `M0-53` (schedule and
  upload the nightly backup), `M0-54` (streaming replication with lag on `/health`).
- **Three points where the owner's answer was taken and then extended**, each recorded with
  its reasoning rather than applied silently: *weekly* cloud upload became **nightly**
  (weekly risks losing seven days of emergency record); *systems in both offices* became
  **one primary and one standby** (two primaries produce two irreconcilable histories of the
  same district); and the notification ladder gained a **GSM modem** rung (the server's own
  internet is a dependency the answer did not account for, and ADR-0011 exists precisely so
  a district outage does not stop work).

## 2026-08-02 — M1a: the administration console

- **Added:** routing signals (`domain/routing.ts`), the config store and its append-only
  `config_event` log (`db/configStore.ts`), the administration API (`api/admin.ts`), the
  district performance view (`api/performance.ts`), the console itself (`web/src/admin.ts`),
  and migration `0007_administration.sql`.
- **Changed:** intake now routes automatically and records the result — **including when the
  result is nobody.** An unmatched emergency appends an empty `routed` event rather than
  leaving an absence to be inferred, and appears as unassigned on both administrative
  dashboards. SLA targets move out of `PLACEHOLDER_SLA` and into a table the administration
  edits; the board and the escalation job both read it.
- **Open:** `Q-06` closed — not by gathering numbers, but by building the screen the district
  sets them on.
- **Gate:** M1a passes. In a real browser, an operator adds a department, gives it a routing
  signal, and an emergency reported by a different officer reaches it. **This was M2's gate**
  and it arrives a milestone early, as a consequence of ADR-0010 rather than as work.
- **Three bugs the tests found, all mine, all silent in production:**
  1. `targetsFor` merged a department override into the district default by taking whichever
     was *tighter*. A department given more time than the district kept the district's
     deadline — the administration set 999 minutes and the board went on measuring 240.
  2. `setSlaTarget` shared one parameter array between an INSERT and an UPDATE referencing
     different placeholders, so **changing** an existing deadline failed every time while
     **setting** a new one worked. Every test written until then happened to create rather
     than change; the browser test edited a value that already existed, and found it.
  3. The console painted whichever request returned last, so a slow response from a tab the
     operator had left landed on top of the tab they were now on.
- **Tests:** 340 → 410, across 26 files.

## 2026-08-02 — Placeholders that admit what they are; the district's own list of gaps

- **Decided (owner, 2026-08-02):** stop waiting on missing district data. Build the screen,
  put a placeholder in, record the gap, keep moving. Added to `CLAUDE.md` §7 as a standing
  engineering rule, with its necessary other half: **a placeholder must be visibly a
  placeholder.** A stand-in that renders like a real value is worse than the gap it filled,
  because the gap was at least still asking.
- **Added:** `CLAUDE.md` §5b — one table of everything genuinely waiting on the district
  (R-01…R-09), what was put in meanwhile, and what the consequence is until it arrives.
  Explicitly not a list of blockers.
- **Added:** migration `0008_placeholder_contacts.sql`. `person.placeholder` marks a contact
  number as a stand-in. Rescue 1122's District Emergency Officer is filled with `1111111`
  so the roster is complete and editable — and the notifier **never dials it, never counts
  it as reached**, and reports `placeholder_contact` rather than the misleading
  `no_duty_holder`. The post is filled; the number is not real; both facts are visible.
- **Open:** `R-01` recorded. The Rescue 1122 gap no longer blocks M1.
- **Requirement raised:** departments must be able to edit **their own** contacts and people,
  not only the two administrative offices. Routing signals and SLA deadlines stay with the
  administration — a department that can edit its own routing could quietly stop receiving
  night-time calls, and nobody would see it happen.

## 2026-08-02 — The roster: a department maintains its own people

- **Requirement (owner, 2026-08-02):** every department must be able to edit its own data —
  add somebody, remove somebody, see the list — **not** the routing signals the two offices
  assign. Confirmed explicitly when I put the reading back to them.
- **Added:** migration `0009_roster.sql`, `db/rosterStore.ts`, `api/roster.ts`,
  `web/src/roster.ts`. Posts, people, assignments and handovers. One component, two doors:
  a department officer opens "My department"; the two offices reach any department from a
  new **Rosters** tab in the console.
- **Changed:** `person` gains `removed_at` and `created_by_seat_id`; `seat` gains
  `retired_at`. Nothing is deleted — past events name the seat that acted and the person who
  held it, and both must keep resolving (ADR-0001).
- **Held back deliberately:** routing signals, SLA deadlines, creating and retiring
  departments, and placing a post above station tier all stay with the two offices. The tier
  restriction is the non-obvious one — `evaluateRead` widens at tehsil, so a department able
  to place its own tehsil post could grant itself sight of every incident in the district.
- **INV-03 hole found and closed, by the roster tests.** `runNotifyPass` handled "this
  department has no post to notify" by incrementing a counter in its return value and writing
  **nothing to the incident**. The board therefore showed such an emergency as notified. A
  counter in a return value is precisely the log line the invariant forbids. The attempt is
  now recorded against the department, fails with `no_post`, and counts as an unmet
  obligation like any other. The console makes this easy to reach: creating a department
  gives it zero posts, and a routing signal is the very next click.
- **A phone number must never reach `config_event`.** Retiring a post logged the whole post,
  holder and number included, into a table that is rendered on a screen and copied into every
  backup leaving the district. Now summarised. Pinned by a test.
- **Tests:** 410 → 450, across 28 files.

## 2026-08-02 — Two rungs in the database, and what that exposed

- **Added:** migration `0010_two_tiers.sql`. `Tier` collapses from
  `station | tehsil | district | provincial` to `department | district`, matching ADR-0010.
- **This was filed as cosmetic and was not.** The district's contact list has no tier column,
  so `ops/directory.ts` defaulted **all 83 loaded posts to `district`** — and `evaluateRead`
  widened at tehsil. In the district's real roster, cross-department access was denied to
  nobody: the Education duty officer could read Rescue 1122's incidents. A default I
  introduced, not a fact the district gave, which is why the migration corrects it rather
  than reporting it.
- **Changed:** tier is now **derived from the department** — `district` iff the office is
  administrative or the seat belongs to no department — and a trigger enforces it. A tier that
  can drift out of step with `is_administration` is a silent widening of who may read what.
- **Fixed:** `nextSeatUp` could not see the administration. It only considered seats in the
  incident's own department or with no department at all, so once migration 0010 moved every
  district-tier post into one of the two offices, an escalation out of a department could
  only reach the DC if somebody had happened to create a department-agnostic seat. It also
  now prefers a **held** seat at the rung above before any empty one, and orders candidates
  deterministically — an arbitrary escalation target makes "why did it go there?"
  unanswerable afterwards.
- **Fixed:** `departmentsForConsole` ran **one query per department** to fetch routing
  signals. The comment immediately below it explains why `loadSlaConfiguration` reads its
  whole table at once; I wrote that comment and then did the opposite one function later. Now
  four queries whatever the district's size.
- **Added:** `scripts/reset-test-db.mjs` and `npm run test:reset`. The local test database is
  never cleaned and had reached **1528 departments** where Bannu has 79, which is how the N+1
  was found — a browser test began timing out rendering a screen no real district produces. A
  test database that drifts that far lies in both directions. CI is unaffected; it starts a
  fresh container every run.
- **Added:** `backlog/for-the-district.md` — the single list of everything waiting on the
  owner, at their request. `CLAUDE.md` §5b now points at it rather than duplicating it.
- **Added:** `backlog/week-of-2026-08-02.md` — this week's plan, written before starting.

## 2026-08-02 — The configuration sweep (W-01)

- **Added:** `src/ops/integrity.ts`, `npm run sweep`, and `GET /admin/integrity`, surfaced at
  the top of the console's Departments tab. Eleven checks, each written as *how the district
  can be misconfigured such that an emergency reaches nobody and nothing anywhere says so*.
- **It reports and never fixes.** Every finding is a decision for the district or a fact
  somebody has to look at; a sweep that quietly corrected things would destroy the evidence
  that anything was wrong, and would make the next report look clean while the district was
  still misconfigured. A test pins that it changes no rows.
- **Findings are graded by consequence, not tidiness** — `blocking` means an emergency will
  reach nobody, and every finding states what it costs rather than only how many there are. A
  test fails any finding whose consequence is shorter than a sentence or hedges with "may
  cause".
- **First run against the district's real data: 0 blocking, 3 serious, 1 note.** 77
  departments no routing signal points at (R-04), 37 posts nobody holds (R-02), Rescue 1122's
  stand-in number (R-01), and the shared handset from Q-19. Everything it found was already
  on the district's list, which is the result worth having: no unknown structural damage
  under the roster loaded before routing existed.
- **Tests:** 451 → 463.

## 2026-08-03 — Something to send, and sending it (M1-02, M1-03)

- **Added:** migration `0011_resources.sql`, `domain/resources.ts`, `db/resourceStore.ts`,
  `api/resources.ts`, and `/fleet` + `POST /incidents/:id/dispatch` + `.../release`.
  Vehicles, teams and equipment in one table, because to dispatch they are one thing: a unit
  a department commits to an emergency. Only teams have members.
- **No status column, deliberately.** Whether an ambulance is committed is a fold over the
  event log — assigned to an incident nobody has closed. A stored status would be a second
  copy free to drift, and the way it drifts is a screen saying a vehicle is free while the
  log says it is at a road accident. A test asserts the column does not exist. *Out of
  service* **is** stored, because a vehicle in the workshop is not a fact about any incident;
  it requires a reason, in the API and in a CHECK constraint.
- **Added the `released` event.** `assigned` only ever added, so a vehicle stayed committed to
  every incident it had ever attended until each one closed — meaning "what can Rescue send
  right now" degraded over a shift into a list of things that all looked busy, wrong in the
  direction that stops help going out.
- **A committed unit can still be sent, with a warning.** A district with one ambulance and
  two road accidents has to be able to move it; refusing would be software overruling the
  only person who can see both scenes. The warning is careful about what it does **not**
  claim: dispatching here does not stand the unit down from the other incident, because that
  would be one screen deciding about an emergency it is not looking at. It shows as committed
  to both, which is the truth.
- **Dispatch is all-or-nothing.** If any named unit cannot go, none do — a partial dispatch
  leaves an operator believing they sent three things when two went, and the one that did not
  go is the one they would have replaced.
- **Tests:** 463 → 498.

## 2026-08-03 — When it happened, and what was photographed (M1-04, M1-05)

- **Changed:** `log_action` accepts an `occurredAt`. An operator logs "on scene" ten minutes
  after arriving and a crew writes up an hour of work at once; recording all of it as
  happening when somebody found time to type would put a lie into the record a post-incident
  report is folded from. `recordedAt` stays server-assigned and is never the caller's — a
  client that could set it could rewrite how long the district took. A stated time in the
  future is ignored.
- **Added:** evidence. Migration `0012_evidence.sql`, `ops/evidence.ts`,
  `api/evidenceRoutes.ts`, `POST /incidents/:id/evidence` and `GET /evidence/:id`.
  `resolved` and `closed` have carried an optional `evidenceIds` since migration 0001 and
  those ids referenced nothing; this is the thing they point at.
- **The bytes are on disk, not in the database.** Photographs inside the nightly dump would
  take it from megabytes to gigabytes and the thing that then fails is the restore, at 02:00.
  ADR-0011 also sends that dump out of the district, and every photograph of every emergency
  crossing that boundary nightly is a far larger disclosure than the contact list — it would
  have happened without anybody deciding it.
- **Two rules about not trusting an upload**, each with a test that tries to break it. The
  client never chooses the path: a filename is a label, recorded and displayed and never
  joined onto anything. The declared content type never decides how the file is served:
  everything goes back as `application/octet-stream`, `nosniff`, as an attachment — because
  an operator's browser executing an "image" somebody uploaded is the obvious way into a
  control room, and `image/svg+xml` is a script.
- **A file whose hash no longer matches is still served**, with `x-integrity: MISMATCH`. It
  may be the only photograph of the scene; refusing would turn a detectable problem into a
  missing one. What must never happen is presenting it as verified.
- **Raw body, not multipart** — see the header of `api/evidenceRoutes.ts`. Hand-rolling a
  multipart parser in `node:http` is where the interesting bugs live, and adding a framework
  to avoid writing one is the dependency ADR-0007 exists to refuse.
- **Three test bugs of mine, all the same shape**: assertions that assumed a fresh database.
  A `UNIQUE` path reused between runs, two `examples` lists capped at ten, and a board
  summary capped at 500 incidents. Fixed to assert the actual claim rather than a total.
- **Tests:** 498 → 520.

## 2026-08-03 — The shift screen (M1-01)

- **Added:** `web/src/workspace.ts` and a **My shift** tab. Three sections in the order
  somebody under pressure needs them: *needs you now*, *in hand*, *what you can send*.
- **Everything on it already existed as an endpoint.** What did not exist was one place
  answering "what needs me now" — and an operator with four tabs open is an operator who has
  to remember which tab the overdue thing was in. Acknowledge, dispatch, log and resolve all
  happen inline: anything that requires leaving the list to do is a reason not to do it.
- **Scoped to the department, and that is a decision rather than a filter.** The board shows
  a department every *unrouted* incident, because an emergency nobody may see is an emergency
  nobody picks up (INV-01). That is right for the board and wrong for a screen headed *needs
  you now* — since ADR-0010 there is somebody who owns an unassigned emergency, and burying a
  duty officer's own work under the district's teaches them to stop reading the list. Caught
  by the browser test, which found a Rescue officer's shift screen full of other people's
  emergencies.
- **Empty states say so in words** — *nothing is waiting*, *no vehicles are recorded for this
  department*. A blank area and a screen that failed to load look identical, and reading the
  second as the first is how somebody concludes there is no emergency when there is.
- **Polling stops when the operator leaves the screen**, with a test that watches for
  requests over twelve seconds and expects none. The district runs one server, and it is also
  handling emergencies.
- **Tests:** 520 → 533.

## 2026-08-03 — The post-incident report (M1-06)

- **Added:** `domain/report.ts`, `api/report.ts`, `GET /incidents/:id/report` (JSON) and
  `?format=text` (plain text), plus a button on the incident detail screen.
- **Folded from the event log. Nothing is typed.** If an operator retypes what the system
  already knows, the retyped version becomes a second account of the same night, free to
  disagree with the first. Q-01 established that departments already run other systems and
  Q-02 turned that into an export target — this produces the account a department submits
  upward, so the platform **replaces** work instead of adding to it. That is the strongest
  answer to the double-entry problem that kills adoption.
- **Every duration is measured from `occurredAt`.** An hour a report spent on a handset with
  no signal reads as an hour; measuring from arrival would render an outage as speed
  (ADR-0002). The arrival gap is stated as its own fact, per entry as well as overall.
- **It ends with "what this record does not contain".** No acknowledgement, nothing sent, no
  actions logged, no evidence, no outcome, notifications that failed — each named with its
  consequence. This is the section a hand-written report always omits, and a review handed a
  document with the holes removed reads a clean response. A test fails any gap whose
  explanation is shorter than a phrase.
- **An override shows both values.** What the department originally assessed stays in the
  document beside what replaced it, with the reason (ADR-0003) — a report that kept only the
  winner would be the system taking a side.
- **Plain text as well as JSON**, because it can be pasted into an email, a register or a
  form, and a district office should never need this software installed to read what it
  produced.
- **A test-fixture bug of mine**, worth noting because the system was right and the test was
  wrong: several tests built a complete incident using the same ambulance name, and the
  second collided with the first. Two live units with one name in a department is refused —
  correctly, because it makes a radio call ambiguous — and the dispatch that followed then
  had nothing to send.
- **Tests:** 533 → 552.

## 2026-08-03 — The M1 gate, and the two bugs it found (M1-07)

- **Added:** `src/__tests__/m1gate.e2e.test.ts`. One emergency walked from a field officer's
  handset to a post-incident report — DC configures Rescue from the console, a throttled
  handset reports it, the system routes it, Rescue is notified, the duty officer
  acknowledges and dispatches from the shift screen, logs backdated actions, attaches a
  photograph, stands the ambulance down, resolves, closes, and the account writes itself.
  Nothing stubbed.
- **Rapid intake re-measured: 1.8s against a 15s budget**, at 4× CPU throttle, clock started
  before the page load. A shell budget is asserted too (123 KB of 160 KB) because the app a
  field officer downloads now carries the administration console and the roster editor.

### Two real bugs, and this is what the gate was for

- **An emergency reported from a handset was never routed.** Auto-routing lived only in
  `intake()` — the `POST /incidents` path. The field path writes to the outbox and pushes to
  `/sync`, which appended raw events and routed nothing. So every emergency captured *the way
  the product is meant to be used* arrived unrouted, nobody was notified, and it sat on the
  board as "not yet routed" until a human happened to look. The routing tests passed, the
  intake tests passed, and the one journey nobody had walked end to end was the only journey
  that matters. Fixed in `handlePush`, idempotent by inspection so a replayed batch cannot
  route twice — pinned by a test.
- **A backdated action moved the incident's start time.** M1-04 let an action say when it
  actually happened; the fold took `occurredAt` from the earliest event of *any* kind, so a
  crew logging "on scene" before the report shifted the emergency's start — and every SLA
  deadline measured from it. An incident could become overdue, or stop being overdue, because
  somebody wrote their notes up honestly. `occurredAt` now comes from the `reported` event
  alone. Found in the report's own timings, where "Happened" and "Reported" were twelve
  minutes apart on an incident reported the moment it happened.
- **Also corrected:** a `waitForFunction` with an async callback in `login.e2e` — it resolves
  on the Promise object rather than its value, so it succeeded instantly and proved nothing.
  The same trap I had already documented in `admin.e2e`, walked into again.
- **Open:** `R-13` (Rescue's own list of response actions) and `R-14` (the six intake
  categories are **my guess**, and they are the vocabulary every routing signal must match).
- **Tests:** 552 → 570.

## 2026-08-03 — Alerts that leave the building, and a record that survives it (Block 3, Block 4)

### Notifications (M3-01…04)

- **Added:** migration `0013_channel_ladder.sql`, `domain/channels.ts`, `src/channels/`,
  `db/channelStore.ts`, an **Alerts** tab on the console, and
  `docs/09-notification-templates.md`.
- The ladder is an **order**, held as rows and edited by the two offices: WhatsApp → voice →
  SMS → the two GSM rungs. A seat's own ladder **replaces** the district default rather than
  merging, so "stop phoning this post at night" is sayable — the same mistake `targetsFor`
  shipped with for SLA overrides, avoided this time.
- **The in-app inbox is deliberately not a rung.** It always happens, in parallel. Putting it
  in the ladder would let a district configure a seat whose only notification is one nobody
  looks at.
- **An unconfigured provider fails; an unconfigured rung is skipped.** Those differ, and the
  difference is D-07: recording each rung would put five `not_configured` failures on every
  obligation of every incident, and a board permanently reading "nobody reached" for a reason
  that is a purchase order is a board people stop reading. The obligation is still visibly
  unmet, because the in-app attempt stays pending until a human collects it. The district-level
  fact is said once, in the sweep and on the console.
- **The ladder does not restart after a success**, and every rung is its own recorded attempt.
  Without the first, a message delivered by WhatsApp at 02:00 would be followed by a phone
  call thirty seconds later, aimed at somebody already driving (INV-08).
- **A `clientSeq` bug fixed on the way:** every notification append took `state.eventCount + 1`,
  so two obligations produced two events with the same sequence and a five-rung ladder
  produced ten sharing two. Ordering then fell to a random event id — deterministic, and
  causally wrong, which is exactly what ADR-0008 exists to prevent.

### Operations (M0-53…55)

- **Added:** `jobs/nightly.ts`, `ops/offsite.ts`, `ops/replication.ts`, `api/backups.ts`,
  migration `0014_offsite_backup.sql`, and a **Backups** tab.
- **P-08 finally cashed.** The backup has been built and verified for weeks with nothing
  scheduling it. It now runs nightly, encrypted with AES-256-GCM before it leaves the
  district, and **refuses to upload at all without a passphrase** rather than sending every
  reporter's phone number in Bannu out in the clear.
- **It polls rather than sleeping until 02:00.** A district server gets rebooted, loses power,
  and is occasionally a laptop somebody closed; a timer set eight hours out is a timer that
  never fires, and nobody notices a backup that did not happen.
- **`/health` reports replication.** A single node says `standalone` and says why. Reported,
  never enforced — a 503 because a standby is behind would stop the district reporting
  emergencies, and INV-01 outranks a lagging standby.
- **The console shows local freshness and off-site freshness as two separate questions.**
  Collapsing them into one green tick would let somebody believe a fire is survivable when it
  is not. There is no restore-over-live button, and the screen says why (D-06).

### Two bugs, both caught rather than shipped

- **The nightly job dumped `DATABASE_URL` and verified against the pool** — a different
  database in this repository. `runBackup`'s event-count check caught it, which is that check
  earning its keep; the caller now states which database it means.
- **The server would not start.** `main.ts` passes the backup job as a getter because the job
  is built after the server, and `createSyncServer` read it eagerly at construction — a
  temporal dead zone error that took the process down with "Cannot access 'nightly' before
  initialization". Caught by `deployable.e2e.test.ts`, which exists because `npm start` had
  once never worked at all while 338 tests passed. It has now caught this class of thing twice.

### Documentation (W-02, W-03)

- **ADR-0004 amended, not rewritten.** Its four-tier ladder is gone; seats and duty
  assignments are untouched and are what made that a migration rather than a rewrite. The old
  text stays with an amendment note — the ADR log is corrected by appending.
- Tier drift also removed from `00-thesis.md` and `03-data-model.md`. The provincial-rung risk
  in the thesis is marked closed as out of scope (Q-10) while noting the risk itself has not
  gone away, only our claim to be addressing it.
- `08-runbook.md` gains the nightly run, the off-site copy, and **how to decrypt a `.sql.enc`
  file** — a backup nobody can decrypt is not a backup.
- **Tests:** 570 → 631.

---

## 2026-08-03 — The prototype becomes the product

The owner supplied a working HTML prototype of a district control-room dashboard and asked
that the software be built on it. This entry covers a full day's work, **two corrections from
the owner**, and one design I got badly wrong before getting it right.

### The two corrections, because they are the important part

**First, I built the wrong thing.** The prototype was shared to say *the things in it belong
in our app*; I read it as *build the thing in it* and produced a separate wall screen at
`/display`, with its own page, its own script and its own kind of credential. The owner:

> ye software just mobile ya laptop k lye nhe hai … ye mobile, laptop ya barre screen sub pr
> fit and zabardast chalega … **tum multiple screens bana kr complecated and messy naa banao**

All of it was reversed the same day (migration 0016). What survived was the reasoning that had
nothing to do with the split — nothing private on a screen a room can read, and every value
carrying its own age.

**Second, I mistook restraint for quality.** The dashboard was honest and nearly empty: eleven
panels reading "not reported". I was satisfied with it because it was true. It is impossible
to judge a design on, and the owner was right to ask for mock data.

### Added

- **`GET /dashboard`** — one feed, scoped to whoever asked. The two offices get the district;
  a department gets its own work plus the facts that belong to everybody. The same endpoint
  answers a phone, a desk PC and a screen on an office wall.
- **The dashboard itself**, carrying every panel the prototype had and the ones this system
  grew that it never had: district counters, Emergency Situation, weather, alerts, district
  status, district services, public utilities, officer presence, published numbers, live
  emergencies by kind, what can be sent, response over seven days, and — for the two offices —
  whether this system's own machinery is working.
- **The Status screen** — where everything the dashboard shows is typed. One screen for four
  kinds of statement, scoped: a department reports the services it answers for and the posts
  it holds; the two offices also issue advisories and set the district's standing facts.
- **Utility and service reports, presence reports, advisories, district facts, live weather**
  (migrations 0015, 0017). Weather is fetched **server-side** from Open-Meteo every fifteen
  minutes: one fetch serves every screen, no key is ever in a kiosk browser, and a district
  with no line shows one honest "last fetched" instead of each screen failing differently.
- **`npm run demo` / `npm run demo:clear`** — plausible district data behind every panel,
  everything marked `(demo)` and the mark visible on screen.
- **ADR-0013** — one application on every size of screen.

### Changed

- **One application, three shapes.** Phone, laptop, office screen — same markup, laid out by
  CSS at three widths. The client reads the viewport in exactly one place, to choose which
  screen somebody *lands* on after signing in, and that picks a starting screen rather than a
  layout.
- **The whole app wears the prototype's control-room palette.** Thirty-four hardcoded colour
  literals became tokens first, which is why the flip is one block rather than a hunt. Two
  departures from the prototype, both deliberate: no web font (that request fails on a
  district line and takes the layout with it), and every state still carries a word as well as
  a colour (INV-04).
- **Every screen is now cards** — board, shift, inbox, roster, console. The board was a
  four-column table that lost two columns on a phone and read as a ruled list on a wall.
- **The 48–64rem caps are gone** from the board, console, shift and roster. On a 1920px screen
  those were a narrow ribbon with a metre of empty paper either side — the complaint that
  started this.
- **Every dashboard panel leads somewhere.** A situation card opens the board filtered to that
  kind; a department row filters to that department; a utility row opens Status. The dashboard
  deliberately grows no detail view of its own — a second one would drift from the board's.
- **`districtPerformance` split into a gate and a calculation**, so a department can be shown
  its own row without being handed everybody else's, and without a second median that would
  eventually disagree with the console's table.
- **Category codes and raw minute counts** now go through one module. The board said "rta"
  beside "Fire" and "1641m past deadline" where a person says "1 day"; both were always there
  and were simply small enough to overlook until the text got larger.

### Removed

- **`/display`, its script, and the `wall_screen` table** (migration 0016). All of it existed
  only because I had split the app in two.

### Decided

- **ADR-0013** — one application, on every size of screen. Amended the same day it was
  written, and the amendment is the record of the first correction above.
- **Nothing on the dashboard is private**, checked on every response rather than trusted, and
  a violation fails the request rather than stripping the field. A leak that ships minus one
  column is a leak nobody finds.
- **Advisories are issued by the DC and AC Headquarter offices only** (owner, 2026-08-03). A
  board any department could post to is a board nobody can trust, and the district plans
  around what is on it.
- **Markets, schools, the hospital and the roads are not four new things.** Each is a name, a
  state, a note and an age — exactly what `utility` already held. One `panel` column rather
  than four tables, four endpoints and four console screens, so the district can add a fifth
  kind of thing to watch without a release.

### Six defects, four of them latent and serious

- **The service worker was caching `/status` and `/dashboard`.** An officer assigned a service
  to a department, the write succeeded, and the screen kept reading "nobody assigned" — the
  reload after the write was answered from cache. A save that appears to do nothing is the one
  outcome that stops people trusting a form. The dashboard was quietly worse: counts and a
  weather reading from whenever the page was last online, while its own "as of" clock ticked
  forward. INV-02, by a caching layer.
- **The wall-safety check flagged UUIDs as phone numbers.** A uuid is 32 hex characters, so
  some contain a run that reads as a Pakistani number — and a violation refuses the whole
  response, so the dashboard returned 500 for every caller and blamed a number that was not
  there. It fired on a seeded row drawing an unlucky id.
- **The shell budget weighed the development build** — sourcemaps, no minification, 40% larger
  than anything the district downloads. It failed at 168 KB while the real shell was 123 KB. A
  budget that fails on a file nobody downloads teaches everybody to raise the budget. It now
  builds production and measures that; `build.mjs` reads `NODE_ENV` per build rather than once
  at import, which is why the first attempt silently kept measuring the wrong file.
- **`page.waitForFunction(async …)`, third occurrence.** An async callback returns a Promise,
  which is always truthy, so the wait returns on the first poll and the assertions race the
  work. It passed for weeks and stopped the day the server had more to do.
- **One panel throwing blanked the six after it** — four numbers and five empty boxes, no
  error, and indistinguishable from a quiet district.
- **`#boot { display: grid }` beat the browser's `[hidden]` rule**, so a screen read
  "Connecting…" with the real display sitting below the fold, correct data on it.

### Open

- R-13: which point the district actually wants the weather taken at.
- R-15: real values for tehsils, union councils, population, area.
- Published emergency numbers beyond 1122, 15 and 16.

- **Tests:** 631 → 700.

---

## 2026-08-03 — Notifications: the software does not make the call

A second correction from the owner, and a large removal.

> es ka ye matlab nhe hai k software call karega, jis k lye tum nai itne saare chez deye hue
> hain … ju banda alert jare karega ya escalate karega … un ko mutalqa number mil jaye and us
> pr click kare tou contact karne ka channel selection mai ho … es mai Meta business account,
> telephony ya SMS gateway ki koi zarurt nhe hai

M3 built a ladder of providers — WhatsApp Business, a voice provider, an SMS gateway, a GSM
modem in the DC office — and four message templates for Meta to approve. **None of it was
asked for.** What was wanted is far simpler and is a better design.

### Added

- **`GET /contacts/department/:id`** — the numbers, behind a session. The duty officer's
  mobile first, the department's office line second: the post is who is on duty now, and the
  office is what to try when nobody is.
- **"Reach them"** on the incident detail, on live work in the shift screen, and on the
  console's department cards — wherever somebody assigns or escalates. It opens WhatsApp, the
  dialler, or messages **on the officer's own handset**, and a human has the conversation.

### Decided

- **Nothing is recorded when somebody opens a channel** (owner's decision). The panel says so
  rather than implying otherwise: no tick, nothing reading "notified". What happened is that
  an app opened.
- A **stand-in number is shown struck through with its channels disabled**. Dialling one
  reaches nobody, and finding that out at 02:00 is the failure this system exists to prevent.
- A **short published number** (1122, 15, 16) offers Call and SMS but not WhatsApp.
- **Any signed-in officer may read a department's numbers**, deliberately not scoped further:
  the person who needs to ring Rescue at 02:00 is whoever is awake. The line that is not
  crossed is the dashboard, which a room can read (ADR-0013 §1).

### Why this is better, not merely smaller

A chain of providers fails in ways nobody sees — a template unapproved, a gateway out of
credit, a modem with no signal — and every one of those is discovered on the night it matters.
An officer who dialled a number knows within ten seconds whether it rang.

### Still to come

The provider machinery — adapters, the channel ladder, the Administration → Alerts tab, the
Meta template drafts, `channel_ladder`, ADR-0012 — is removed in the next entry. The in-app
inbox stays: it needs no provider, and it is what INV-03 is measured against.

---

## 2026-08-03 — The provider ladder removed

The other half of the previous entry. ~1,900 lines deleted, and one of the district's
procurement items closed by not needing it.

### Removed

- **`src/channels/`** — the WhatsApp, voice, SMS and GSM adapters, and their tests.
- **`src/domain/channels.ts`**, **`src/db/channelStore.ts`**, **`src/jobs/__tests__/ladder.test.ts`**.
- **`docs/09-notification-templates.md`** — the four message templates drafted for Meta.
- **The ladder inside `runNotifyPass`.** The in-app inbox above it is untouched.
- **`GET`/`PUT /admin/ladder`** and the **Administration → Alerts** tab that configured it.
- **`channel_ladder`** (migration 0018).
- **Two integrity checks** — `no-way-out-of-the-building` and `ladder-partly-configured`.
  Both asked whether a provider was configured, and there are no providers.
- **"Alerts leave the building"** from the dashboard's *This system* panel. The software
  sends nothing, so there is nothing about sending that can be quietly broken.

### Changed

- **ADR-0012 marked superseded**, with the reasoning and the owner's own words appended
  rather than the original text being edited. The ADR log is corrected by appending.
- **R-05 closed as not needed.** It asked the district for a Meta business account with
  approved templates, an SMS gateway, a telephony provider and a GSM SIM — and it was the
  longest lead time in the project. It is gone. What matters instead is R-04: the numbers on
  the roster kept current, because those are what an officer now dials.

### What survives, and why it was the right part all along

**The in-app inbox and the obligation ledger** (M0-32). Every notification a post is owed is
still written **before** anything is attempted, still appears in that post's "Waiting for you",
and still counts on the board as unmet until a human collects it. That is INV-03 — *a
notification failure is never invisible* — and it needs no provider.

The in-app channel was also the only one whose "delivered" ever meant anything: a human
collected the message, rather than a queue accepted it. Everything removed here could only ever
report that something had been handed to somebody else.

- **Tests:** 700 → 662. Thirty-eight of them tested machinery that no longer exists.

---

## 2026-08-03 — CLAUDE.md's own gap list had gone stale

No code changed. This entry exists because Rule 0 makes a drifted `CLAUDE.md` a bug in its
own right, and §5's **"What does not exist yet"** had become the most misleading part of the
file: it named four things as missing that were built, tested and recorded as done a few
lines above it.

### Changed

- **§5 "What does not exist yet" rewritten.** It claimed there was no CI (M0-04, green on
  every push), no `department` table (M0-51, migration 0005), no correlation ids (M0-03), no
  backup at all (M0-37/53, nightly since today), no department-board screen (M0-34) and no
  reports (M1-06) — and it listed the Place gazetteer as pending research after the owner had
  dropped it (P-06). Replaced with what is actually missing, grouped by **what would close
  it**: one functional gap (no department has a routing signal, R-04), placeholders awaiting
  real values, work blocked on a bucket/a machine/a person, two code items, and a section for
  things **decided against** so nobody "fixes" them back.
- **§5 "Immediate next actions" rewritten.** It led with four resolved questions — Q-18
  (ADR-0010), P-08 (ADR-0011), Q-07 (moot; the software sends nothing) and Q-08 (dropped).
  Now four items, and it points at `backlog/for-the-district.md` rather than restating it,
  per §5b.
- **§6 repository map corrected to the filesystem.** It still listed **`src/channels/`** and
  **`domain/channels.ts`**, both deleted with the provider ladder in the previous entry; it
  listed `ops/` twice; it put `reset-test-db.mjs` and `demo-data.mjs` at the top level when
  both live in `app/scripts/`, and omitted `sweep.mjs` entirely. Added what had never been
  mapped: `domain/wall.ts`, `domain/notifications.ts`, `db/wallStore.ts`,
  `db/resourceStore.ts`, `jobs/nightly.ts`, and `api/report.ts`, `resources.ts`,
  `evidenceRoutes.ts`, `backups.ts`. Added `Department Contact Number.docx` with the note
  that `*.docx` is what keeps it out of git.
- **"Seven ADRs" → thirteen**, one superseded and two amended.
- **`Last updated` 2026-08-02 → 2026-08-03**, which was itself the visible symptom: two
  2026-08-03 decisions were recorded in the file above a line saying it was current as of the
  day before.

### Decided

- **A gap list that names solved problems is worse than no gap list**, because the next
  session works from it and rebuilds what is already there. A note saying so is left at the
  top of the rewritten §5 block, so the next person to find it stale knows it has drifted
  before and why that matters.

### Open

- Nothing new. The rewrite **resolved no question and built nothing** — it only stopped the
  file from misreporting. R-01…R-14 are unchanged and remain in
  `backlog/for-the-district.md`.

---

## 2026-08-03 — The task list had the same disease as CLAUDE.md

No code changed. The previous entry fixed `CLAUDE.md`; this one fixes
`backlog/todos.md`, which was drifting the same way and in one place contradicted
itself outright.

### Changed

- **M0-53 and M0-54 each appeared twice, once `DONE` and once `TODO`.** Both duplicates
  removed. A task list that answers "is the nightly backup built?" with both yes and no is
  worse than one that answers wrongly, because there is nothing to correct — you cannot tell
  which row is the claim. Replaced with one note saying what is true: **the code is done for
  both; what is missing is a bucket (R-06) and a machine (R-07)**, and those are tracked once,
  in `for-the-district.md`.
- **M0-37 `DOING` → `DONE`.** Its note still read *"nothing schedules it yet"* long after
  M0-53 scheduled it nightly.
- **The M0 gate-check note** claimed the open item needed *"an automated backup (M0-37, which
  does not exist yet and is code)"*. It needs only a person now (R-08).
- **"What remains open in M0"** named M0-04 (CI), M0-03 (correlation ids) and M0-51 (the
  department registry) as outstanding and said scheduling waited on P-08 — all four done a day
  or more earlier. The true list is three items, two of them half-done by choice.
- **P-11 `TODO` → `DROPPED`.** It asked the district to procure a Meta business account,
  approved templates, an SMS gateway, a telephony provider and a GSM SIM. The software sends
  nothing (ADR-0012 superseded). R-05 closed with it.
- **M3-01…04 collapsed into one struck-through row marked `REMOVED`.** All four were `DONE`
  and all four were deleted days later. **Left in place rather than deleted** so nobody reads
  their absence as "never built" and builds them again — the failure mode this whole log
  exists to prevent.
- **Q-18 and Q-19 marked answered** (ADR-0010 + migration 0010; migration 0006). The file
  still carried *"the escalation ladder cannot work until Q-18 is answered"*.
- **Q-08 and Q-06 struck from "what M1 needs".** Q-08 was dropped by the owner; Q-06 became a
  screen (M1a-04) rather than a number.
- **"M1 starts next" retitled**, and "M1 and beyond" rewritten — it predicted that planning
  far ahead produces fiction, and **M1a proved it right by not existing in any plan**. The
  rule is kept for that reason rather than retired as out of date.

### Added

- **An M4/M5 section**, which the file had never had, though `CLAUDE.md` names M4/M5 as the
  current milestone. **No `M4-xx` ids were invented** — that work landed as blocks, and the
  section points at the four changelog entries and ADR-0013 that are its real record. Covers
  the one-app decision, the dashboard, Status, wall safety, "Reach them", server-side weather
  and the demo data.

### Open

- **`R-13` has two different meanings.** *The prototype becomes the product* raised R-13 as
  "which point the district wants the weather taken at"; `for-the-district.md` already had
  R-13 as "Rescue 1122's own list of response actions". **One id, two things.**
- **`R-15` was raised in that same entry and never added to `for-the-district.md`** — real
  values for tehsils, union councils, population and area.
- Both are recorded in `todos.md` and **deliberately not fixed here**: §5b calls
  `for-the-district.md` *the one list*, so renumbering a row on it is the owner's call, not
  mine.

---

## 2026-08-03 — One id, two questions: R-13 resolved

`R-13` had been issued twice on the same day, to two unrelated questions, and `R-15` had been
issued and never written down. Small, and exactly the kind of thing that sends somebody to ask
a district officer the wrong question.

### Changed

- **The weather-point question is now `R-16`.** It had been raised as `R-13` in *The prototype
  becomes the product*, hours after the M1 gate entry had already given `R-13` to **Rescue
  1122's own list of response actions**.
- **The rule used, and the one to use again: the row numbered first keeps the number.** The
  append-only log settles which that was without anybody having to remember. Renumbering the
  older row would invalidate whatever the owner had already written down — and the numbers on
  that list exist precisely so they can be quoted in a conversation this repository never sees.
- `src/ops/weather.ts` cites `R-16`, with a note saying what it used to cite. The only code
  change in this entry, and it is a comment.

### Added

- **`R-15` and `R-16` on `backlog/for-the-district.md`**, which is where they should have been
  from the moment they were raised. `R-15` — tehsils, union councils, population and area — had
  been referenced by **migration 0017** and by the dashboard for a day while being absent from
  the one list a district officer is asked to work down. The list now runs **R-01…R-16, no gaps
  and no repeats.**
- **A second amendment on `ADR-0013`**, recording the renumber. **The `R-13` citation in its
  Consequences section is left as it was**, with the amendment above it — the ADR log is
  corrected by appending, not by making the past look like it always agreed. `CHANGELOG.md`
  line 1704 likewise still reads `R-13`, because a past entry is never edited.

### Open

- Both questions are still unanswered — only correctly numbered. `R-15` renders as blanks in
  the district-facts panel; `R-16` means the weather is read at Bannu city's published
  coordinates, a **default and not a finding**, overridable by `WEATHER_LAT` / `WEATHER_LON`
  without a release.

- **Tests:** 662 pass, 42 files. Typecheck, lint and format clean.

---

## 2026-08-04 — The M5 security review: losing your post widened your view

The adversarial review M5 asks for (`milestones.md`), run against the authority surface rather
than a diff. It found one real cross-department read leak, reachable by an ordinary handover.

### The finding

**`/dashboard` and `/status` decided their scope from `departmentId === null`.** Two entirely
different callers satisfy that null:

- a **control-room seat**, which belongs to no department and should see the district, and
- a person holding **no seat at all** — relieved of their post, or granted a login and never
  given one — who should see nothing.

The second was handed the first's answer. Proved through the real path — real person,
department, duty assignment, `login()`, `resolveSession` — rather than a hand-built identity:

```
RELIEVED VIEW => {"scope":"District","departmentId":null,"isAdministration":false}
```

What that exposed: district counters, **every department's performance row**, live emergencies
by kind, and — through `listPresence(pool, null)` on `/status` — **every seat in every
department and who was on duty**.

**It is reachable by an ordinary act.** A handover relieves the outgoing holder, whose session
is deliberately not revoked because the seat is re-resolved on every request (ADR-0004). That
design exists to *narrow* authority the moment a post changes hands. Here it widened it.

### Why it survived

- `/sync`, `/incidents`, `/admin`, `/roster`, `/notifications` and `/fleet` had always refused
  a seatless caller. **The two routes that had not are the two that leaked** — the check was
  four lines repeated at each route, and the leak was where somebody had not written them.
- **The test encoded the bug.** `dashboard.test.ts`'s `officer()` helper defaulted to
  `seatId: null, departmentId: null, tier: 'district'` — an identity the database cannot
  produce — so every scoping assertion in a file whose own header warns that *getting this
  wrong in the generous direction is a read leak* was made against precisely the shape that
  had to be refused. Same class as the old `Outbox.sync()` test that asserted its own bug.

### Changed

- **`requireSeat(res, identity)`** in `api/server.ts`, applied to `/dashboard` and `/status`,
  and `/incidents` refactored onto it. One helper rather than the same four lines at each
  route, for the reason above.
- **`viewerFor` keys on `tier`, not on a null department.** Tier is derived by migration
  0010's trigger from the seat's office and cannot be asserted by a caller; it says what the
  null department only implied. Behaviour is unchanged for every seated identity.
- **`Viewer` gained `seated`**, so a missing seat is a value this module can refuse rather
  than a null that reads, one branch later, as "the district".
- **The `officer()` fixture now derives `tier` the way the database does** and is seated by
  default, with a separate `holdsNoPost()` for the case that must be refused.

### Added

- Five tests. Two refuse `/dashboard` and `/status` to a seatless caller **by direct HTTP,
  never through the UI** (INV-05); one pins that a **seat with no department still gets the
  district**, which is the legitimate case the leak was hiding behind; two pin `viewerFor` at
  the unit level.
- A standing note in `CLAUDE.md` §7: **a null is not a scope.** Third time this project has
  been bitten by an absent value read as a permissive one — after the four-value `Tier` that
  defaulted every loaded post to `district`, and `navigator.onLine`.

### Open

- The review covered the authority surface — every route's session gate, scope derivation and
  cross-department reads. **It did not cover** the evidence file path, rate limiting, or
  session fixation; those are the next passes.
- Nothing was deployed at the time of the finding (R-06 and R-07 are open), so this was never
  a live exposure. It had to be closed before the pilot, not after.

- **Tests:** 662 → 667, 42 files. `npm run check` green.

---

## 2026-08-04 — Security review, second pass: evidence, rate limiting, sessions

The passes the first entry listed as not yet done. One fix, one finding left open with a
recommendation, and one area that came back clean.

### Changed

- **The evidence download decides authority before touching the disk.** `download` called
  `fetchEvidence` first — which reads the whole file and hashes it — and only then asked
  whether the caller could read the incident. Up to 20 MB of disk read and a SHA-256 over it
  for a request about to be refused, aimable by any signed-in officer at files they have no
  authority for, on the single machine that is also taking emergency reports. It now looks up
  the row with `find`, authorises, and reads bytes only once the answer is yes. **`upload` had
  stated this rule for itself all along**; the download path had simply missed it.

### Added

- One test, pinned **without mocking**: delete the file from disk, request as an outsider, and
  assert the refusal is the authority one rather than "missing from disk". Confirmed to fail
  against the old ordering before the fix was restored — a test that passes both ways proves
  nothing.

### Open

- **There is no rate limiting anywhere in the system**, and `/auth/login` is unauthenticated
  and runs a scrypt derivation on every attempt — including for numbers with no account, which
  is deliberate so that response time reveals nothing. `passwords.ts` sets a deliberately low
  10-character minimum and justifies it by saying *"real protection here comes from rate
  limiting and instant revocation"*. Revocation exists. Rate limiting does not.
- **Recorded with the answer that must not be used: an account lockout.** The district's
  numbers are semi-public and the roster says who holds which post, so a lockout is a denial of
  service an attacker can aim at a named officer — ten wrong passwords against the Rescue duty
  officer at 01:50 locks out the person the system exists to reach. INV-01 outranks a
  failed-login counter. The shape that fits: progressive delay per number and per source, a cap
  on concurrent scrypt work so login cannot starve intake, and attempts recorded where the
  console can show them. **Needs a decision before it is built.**

### Clean

- **Session handling.** No fixation route: the token is generated server-side at login
  (`randomBytes(32)`), never accepted from the client. `HttpOnly`, `SameSite=Strict`, `Secure`
  in production. Only the SHA-256 is stored, compared with `timingSafeEqual` as belt and braces
  over an already-exact lookup. Revocation is instant and `revokeAllForPerson` exists. The
  identity — seat, tier, department, administration — is re-resolved from the roster on every
  request and never trusted from the session row.
- **The evidence path itself.** The client never chooses the storage path; the filename is kept
  as a label and percent-encoded into `content-disposition`; content types are an allow-list;
  everything is served `application/octet-stream` with `nosniff` and a sandbox CSP regardless of
  what the device declared; the size cap is applied while reading rather than after.

- **Tests:** 667 → 668, 42 files. `npm run check` green.

---

## 2026-08-04 — M0-05: the secret store was a decision nobody had written down

The last M0 item that was code. It had sat at `DOING` for days with the note *"real secret
store pending deployment"* — but P-08 and ADR-0011 answered the deployment weeks ago, and the
answer makes a secrets manager the wrong tool rather than a pending one.

### Decided

- **The secret store is `app/.env` on the district's own machine, and that is the design.**
  ADR-0011 puts one server in the DC office; ADR-0007 requires it be operable by one person at
  02:00. A managed secrets service would add a network dependency, an account, and a renewal
  nobody is watching — to protect a file that sits on the same disk as the database it
  unlocks, behind the same door. What such a file actually needs is to be **out of git,
  readable only by the service user, and verified at boot**, and the last of those was the
  part that did not exist.

### Added

- **`src/config.ts` — one configuration check at boot.** Every value used to be read at its
  point of use, so a mistake surfaced inside the backup job at 02:00, or in an escalation
  pass, or on a screen. Now it surfaces in one log line before anything starts.
- **The split between refusing and warning is the whole design.** A refusal is reserved for a
  configuration that is broken or unsafe: no `DATABASE_URL`, or a production deployment still
  holding the example connection string, or an example `BACKUP_PASSPHRASE` — which would
  encrypt every off-site copy with a passphrase published in this repository. **Everything
  that merely leaves the district less protected warns and keeps running**, because a process
  that will not start is a district that cannot report an emergency. INV-01 outranks a missing
  bucket exactly as it outranks a stale backup on `/health`.
- 11 tests, and the ones that matter assert the *warnings*: a district with no cloud bucket
  starts perfectly well, and a bucket set without a passphrase warns rather than refuses. One
  asserts the boot line carries no secret **and nothing derived from one** — not the value, not
  its length — because `obs/log.ts` redacting by key name is the second line of defence, not
  the first.

### Changed

- **`.env.example` rewritten.** It documented **5 of the 16** values the code actually reads,
  omitted **both secrets** (`BACKUP_PASSPHRASE`, `GCS_TOKEN`), still opened with *"Nothing here
  is used yet: the domain core is pure logic with no database and no network"*, described
  `DATABASE_URL` as *"not provisioned yet — gated on Q-03"*, and advertised `SMS_PROVIDER_KEY`
  and `WHATSAPP_PROVIDER_KEY` — machinery deleted with the provider ladder, which would have
  sent an operator off to procure accounts that R-05 closed as not needed. Now every value,
  grouped, each saying what happens when it is absent, with the `chmod 600` the file needs.

### What was already right

- The runbook already covers the passphrase properly — where to keep it, that a lost one makes
  every off-site copy unreadable, and how to decrypt a dump before restoring. No change needed.
- `obs/log.ts` already redacts secrets by key name at any depth, and bodies are never logged.

- **Tests:** 668 → 679, 43 files. `npm run check` green.

---

## 2026-08-04 — The export that independence was promised on

Capability group 9 named an export and there was none. This is not a feature from a list: it
is the mitigation the district was promised when Q-01 and Q-02 settled that the system would
integrate with **nothing** government-issued. The stated price of that independence is double
entry — which `CLAUDE.md` calls the top adoption risk — and the stated compensation was
export. The risk had been live for weeks with its mitigation unbuilt.

### Added

- **`GET /export/incidents.csv`** — every incident the caller may see, as a spreadsheet.
  `?days=` between 1 and 366, default 30.
- **`src/api/exportCsv.ts`**, and it deliberately has no query of its own. It is
  `buildBoard`, with the caller's seat and `includeClosed`. A second query would eventually
  disagree with the board about a district's own emergencies, and then two documents would
  disagree about what happened — the same rule that stopped M0-34 becoming a second endpoint.
- **19 tests.** 17 on the file itself, and two on the board's own integration suite —
  written there on purpose, because the risk is not that the formatting is wrong, it is that a
  file departments email to each other might answer a wider question than the screen does. A
  department gets its own incidents in the CSV and **not** its neighbour's, asserted over HTTP.

### What it refuses to do

- **It never truncates quietly.** Past `EXPORT_LIMIT` it returns 413 and says to ask for a
  shorter period. A short file is worse than no file: nobody counts rows before submitting a
  report upward, so the numbers would simply be wrong and nothing would say so. Same reasoning
  as a `pg_dump` holding fewer events than the live database being recorded as a **failure**
  rather than a warning.
- **It carries no citizen contact detail** (capability 12) — true by construction rather than
  by filtering, because `BoardRow` has never held a reporter's name, number or location. The
  test asserts it against the column list anyway, matched on whole name parts rather than
  substrings, so that adding one to the board for a good reason cannot quietly add it here.
- **It cannot be turned into a payload.** Every text field originates as something typed into
  the administration console, and Excel, LibreOffice and Sheets all execute a leading `=`, `+`,
  `-` or `@`. A department named `=HYPERLINK(...)` would otherwise become a live formula in
  whatever office opened the file — the district's own data, weaponised by the export that
  exists to be trusted. Fields are prefixed with an apostrophe; the cell still reads correctly.
- **It says `unassessed` in words** (ADR-0009). A spreadsheet has no colour to fall back on,
  which is the case that rule was always really about.
- Written with a byte order mark and CRLF, so Excel reads Urdu and Pashto department names
  instead of mojibake. The literal U+FEFF is written as an escape — lint caught it as
  irregular whitespace, correctly: an invisible character in source is invisible in review too.

### Open

- **R-17 added to `backlog/for-the-district.md`:** what each department actually submits
  upward, and on what form. The generic file is the 80% case; matching a real form is the rest,
  and it is domain knowledge that cannot be invented here. One example of each is enough.

- **Tests:** 679 → 698, 44 files. `npm run check` green.

### A note on the run

One test run in this session failed with `ECONNREFUSED 127.0.0.1:5433` across a whole file.
That was the local Postgres having stopped, not the code — `scripts/dev-db.ps1 start` and the
suite went green. Recorded because a whole-file failure that names a port is worth recognising
on sight rather than debugging.

---

## 2026-08-04 — The CI job's name had been wrong for 400 tests

Found while verifying that CI had genuinely run the suite rather than a fraction of it — the
check `CLAUDE.md` insists on, because *"if CI and local can disagree about what green means,
the one nobody is watching wins."*

### Changed

- **The CI job was named `typecheck · lint · format · 297 tests`.** The run it was attached to
  had just executed **698**. The number is hand-written in `ci.yml` and had not been touched
  since the suite was a little over a third of its current size.
- **Removed the count rather than corrected it.** A number that has to be edited by hand every
  time somebody adds a test is wrong by default and right only by accident. The job is now
  `typecheck · lint · format · tests`, and the run's own summary is the honest count.

### Why this was worth stopping for

The workflow exists because a green build that quietly ran fewer tests than it should is the
failure this project fears most — `loadEnv.ts` makes a missing `TEST_DATABASE_URL` a hard
failure under CI for exactly that reason. **A job label that overstates coverage is that same
failure wearing a different hat**: somebody glancing at a passing check would have concluded
the suite was a third of its real size, or — worse, in the other direction — that 297 was the
number to expect and 698 meant something had gone wrong.

Verified on this run: **44 files, 698 tests, all passed**, read out of the job log rather than
taken from the label.

---

## 2026-08-04 — Full-history search, and the timestamp it nearly used

Capability group 9 named "full-history search". The board shows the last seven days, so
everything older was reachable **only by already knowing its incident id** — a post-incident
report about something from March could be produced by whoever had written the id down, and by
nobody else. A record you cannot look anything up in is a filing cabinet with no drawer labels.

### Added

- **`GET /search`** — `?q=` free text, `?from=` `?to=`, `?status=`, `?limit=`. Matches the
  reporter's own words, the place, and the category, case-insensitively.
- **`src/api/search.ts`**, and **`projectIncidents` split out of `buildBoard`.** Search needs a
  different *selection* — the board asks "what arrived lately", search asks "what happened
  during the floods", and no one query serves both. What must not differ is everything after
  the selection: the fold, `evaluateRead`, `toRow`. Board, export and search now share that
  one projection, so no two of them can describe the same emergency differently.
- **Migration 0019** — `incident_event (occurred_at, incident_id)`.
- 10 tests.

### The mistake this nearly shipped with

**The first implementation ranged on `recorded_at`**, because that is what the board's loader
uses and it is the indexed column. It passed its tests.

It was wrong, and the tests were wrong with it. `append` assigns `recorded_at` server-side and
**ignores whatever a client sends** — correctly, since a device with a wrong clock must not be
able to misreport when we *learned* of something. So every incident a test seeds has
`recorded_at` of now, whatever date it claims to have happened. **Every "find something old"
assertion was passing because the data was not old in the column being filtered.**

The real failure is worse than a bad test. A report captured on a handset with no signal in
March and delivered in August has `occurred_at` in March and `recorded_at` in August. Ranging
on arrival files that emergency under the day the network came back — so **the district's worst
weeks, the ones where devices were offline longest, would be exactly the weeks that searched
emptiest.** That is ADR-0002 inverted by a column name.

The project's own rule already said which to use: *measurement uses `occurred_at`, escalation
firing uses `recorded_at`*. Search is measurement.

Fixed, indexed, and pinned by a test that seeds an incident which happened 200 days ago and
arrived seconds ago, then asserts a one-week window **does not** contain it. Confirmed to fail
against the `recorded_at` version before the fix was restored.

### Two things it refuses to do

- **It will not let an absence read as a fact** (ADR-0005, applied to a query). The response
  echoes the resolved window, because "no results" and "no results in the fortnight you
  happened to search" are different statements and only the response can tell them apart.
- **Truncation is its own field**, not implied by a full page: "exactly 200 results" and "at
  least 200 results" are different answers, and only one means somebody should narrow.

An over-wide range is **clamped, not refused** — somebody asking for ten years wants everything
there is, and an error teaches them to stop using search rather than to pick a better date.

- **Tests:** 698 → 708, 45 files. `npm run check` green.

---

## 2026-08-04 — Two capabilities that no officer could reach

`/search` and `/export/incidents.csv` had shipped the day before: written, tested, CI green —
and with **nothing in the client calling either of them.** No tab, no button, no link. Every
test passed and no officer in Bannu could do either thing.

**An endpoint with no door is not a capability.** It is the shape that lets a scope list look
complete while the district still cannot do the work, and it was mine to notice before
declaring capability 9 answered rather than after.

### Added

- **A Search tab**, with the words box, a happened-after/happened-before range and a status
  filter. The dates say *happened*, not *recorded*, on the label as well as in the query.
- **An export link on the board** — a plain `<a download>`, because the browser already knows
  how to download a file and a fetch-and-blob would only take that away from it. It says what
  it is next to it: opens in Excel, carries no reporter's name, number or location.
- **`web/src/incidentRow.ts` — one row renderer**, moved out of `main.ts` and now used by the
  board and by search. The same reason `projectIncidents` was split out of `buildBoard`: one
  projection on the server deserves one renderer on the client. Two would drift within a month
  and then an emergency would read `unassessed` on one screen and something else on the other
  (INV-04), or show its unmet notification on the board and silently not in the search result
  somebody found it through (INV-03). A browser test asserts the two rows are **byte-identical**.
- **7 browser tests**, in real Chromium. The one that matters most is that a search finding
  nothing **says what window it looked at** — "nothing matched" and "nothing matched in the
  fortnight you happened to pick" are different statements about the district, and an operator
  reading the first when the truth is the second concludes an emergency never happened.
  ADR-0005, applied to a query.

### Changed

- **`/search` and `/export` added to the service worker's `NEVER_CACHE`** — from the day they
  shipped, unlike `/dashboard` and `/status`, which had to be added after the fact. A cached
  search is a cached board arriving by a route that looks harmless, and it is often the *last*
  look somebody takes before writing a post-incident report, so a stale one becomes a stale
  document. A cached CSV is worse: it leaves the building, gets emailed on, and is read months
  later by somebody with no way to know when it was true.

### Open

- The Search tab is offered to everybody signed in and scoped server-side, like the board. It
  has no results-per-page control and no sort — deliberate for now; both are guesses about how
  people will use it, and the honest way to settle them is to watch somebody try.

- **Tests:** 708 → 715, 46 files. `npm run check` green.

---

## 2026-08-04 — Guessing is slowed. Nobody is ever locked out.

The gap the security review left open, and the one where the obvious answer is the harmful one.

`passwords.ts` sets a deliberately low ten-character minimum and justifies it by saying *"real
protection here comes from rate limiting and instant revocation"*. Revocation existed. Rate
limiting did not.

### Decided — what this deliberately is not

**An account lockout.** The district's numbers are semi-public and the roster says who holds
which post. A lockout is a denial of service an attacker can aim at a **named officer**: ten
wrong passwords against the Rescue duty officer's number at 01:50 would lock out precisely the
person the system exists to reach, and they would find out at the moment it mattered. **INV-01
outranks a failed-login counter**, exactly as it outranks a stale backup on `/health`.

So nothing added here ever refuses. It delays, and the delay is **capped at five seconds** —
because an uncapped backoff is a lockout wearing a different name. An officer facing four
minutes at 02:00 has been locked out in every sense that matters.

### Added

- **`src/auth/throttle.ts`.** Four attempts free, then each costs more, to a hard ceiling.
- **Two keys, because there are two attacks.** Per number catches somebody working on one
  officer; per source catches one password sprayed across all 79 offices, where no single
  number ever accumulates enough failures to be noticed. **A success clears the number and
  deliberately not the source** — an attacker who finally guesses one weak password must not
  have the evidence of the spray erased by the attack working.
- **A cap on concurrent scrypt work.** The real exposure was never guessing, it was CPU:
  `/auth/login` is unauthenticated and burns a deliberately-expensive derivation per request,
  *including for numbers with no account* — which is on purpose, so response time reveals
  nothing. On one machine in the DC office that is also accepting emergency reports, that is a
  cheap way to make the district stop answering. Login can now queue for the CPU; intake never
  waits behind it (INV-01). Saturation answers 503 with `Retry-After` — transient, about the
  server, never a state attached to anybody's account.
- 15 tests. The ones that matter assert **bounds**, not speed: the throttle never refuses
  however many failures pile up, the delay is capped, an honest fumble is not slowed at all,
  and — over real HTTP — **the real officer still signs in after a sustained run of wrong
  passwords**, in under eight seconds, asserted where somebody changing a constant will see it.

### Two things that would have quietly broken it

- **The source is taken from the socket, never from `X-Forwarded-For`.** That header is written
  by whoever is asking, so trusting it would let an attacker send a different value on every
  request and never accumulate a single failure. **A rate limiter an attacker can opt out of is
  worse than none, because it is believed.** If a reverse proxy is ever put in front of this,
  that is the line to change, deliberately, with the proxy's address pinned.
- **`withScryptSlot` returns a discriminated result, not `T | null`.** `login` already returns
  null for a wrong password, so collapsing the two would make "the server is busy" and "that
  password is wrong" the same value — and the caller would have to guess, which ends with a
  failed sign-in counted as an attack or an attack counted as a typo. Caught while wiring it,
  after a first version that used a `null` sentinel and a load heuristic to tell them apart.

### Housekeeping

- **The local test database was reset.** It had drifted to 333 departments; Bannu has 79. The
  suite runs in 111s rather than 205s as a result — the drift had been quietly doubling it.

- **Tests:** 715 → 730, 47 files. `npm run check` green.
