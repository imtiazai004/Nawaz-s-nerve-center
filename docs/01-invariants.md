# Invariants

The eight things this system must never do. Written as prohibitions because prohibitions
are easier to test than aspirations.

Each invariant becomes a **permanent automated test** that runs on every commit and blocks
release on failure. These are not guidelines — they are the definition of the product
working. A build that violates one is broken regardless of what else passes.

---

## INV-01 — An emergency is never lost

Not by a failed network call, a crashed tab, a rejected validation, a dead notification
provider, a duplicate check, or a deployment. Once a reporter presses submit, the record
exists somewhere durable.

**Implications**
- Client writes hit a durable local outbox before any network attempt.
- Validation never rejects an emergency report outright. Incomplete reports are accepted
  and flagged for enrichment; the only hard requirement is that *something* happened.
- Duplicate detection never blocks a submission (see `ADR-0006`).
- Notification failure never cascades into intake failure.

**Tests**
- Submit with the network disabled; verify durable local persistence and eventual sync.
- Kill the client process mid-submit; verify the report survives a restart.
- Force notification provider failure; verify the incident still exists and the failure
  surfaces per INV-03.
- Fuzz the intake payload; verify no input produces a silent drop.

---

## INV-02 — Stale data is never rendered as current

Every value on every screen can name its source and its age. Anything past its freshness
threshold is visually and semantically degraded — never silently.

**Implications**
- Every projection carries `as_of` and the freshness threshold for its source.
- Degradation is not colour-only; it carries text and an accessible state.
- The client knows when its own data is from cache and says so.

**Tests**
- Freeze a department's updates past its threshold; verify every surface showing its data
  degrades, including aggregates that include it.
- Render the board from a stale cache; verify no element claims currency.

---

## INV-03 — A notification failure is never invisible

Every attempt has an observable delivery state. A message that did not reach the duty
officer surfaces on the central board as an unmet obligation, not as a log line.

**Implications**
- `NotificationAttempt` is never collapsed into a boolean on the incident.
- Undelivered critical notifications create a visible, actionable state that requires
  human resolution.
- Provider-level degradation is itself an alert.

**Tests**
- Fail each channel independently; verify the central board shows an unmet obligation.
- Fail all channels; verify escalation still proceeds by other means and the incident is
  flagged as uncontactable.

---

## INV-04 — An aggregate never hides a critical

No average, score, or roll-up may cause a single life-threatening incident to render as
normal. Criticals escape aggregation by rule, not by luck.

**Implications**
- Severity aggregation uses max-severity semantics, never mean.
- **An aggregate reports two numbers: the worst severity anyone assessed, and how many
  nobody has assessed** (`ADR-0009`). Neither is folded into the other. Counting an
  unassessed report as `low` hides it exactly as a mean hides a critical; counting it as
  `critical` hides the real criticals among them.
- Any surface showing a summary also shows the count of open criticals, and that count is
  never suppressed by a filter default.
- "District status: normal" is computable only when no critical is open and coverage is
  complete.

**Tests**
- Inject one critical among many routine incidents; verify every summary surface reflects
  it at the top level.
- Verify no filter, date range, or default view can hide an open critical from the central
  command board.

---

## INV-05 — The UI is never the enforcement layer

Every authorisation decision is made server-side against the policy model. Hiding a button
is presentation, not security.

**Implications**
- Every mutation endpoint authorises independently of how it was reached.
- Authority rules are evaluated server-side from data (see `04-authority-model.md`).

**Tests**
- For every mutation, call it directly with a credential that lacks authority; verify
  refusal.
- Cross-department access attempts by direct API call; verify refusal by default.
- Privilege escalation attempts via ID manipulation (IDOR) on every resource type.

---

## INV-06 — No sensitive action is unattributable

Every override, reassignment, escalation, closure, handover, and bulk notification names
an actor, a seat, a time, and — where policy demands — a reason.

**Implications**
- Attribution is structural: it is a property of the event, not a separate log write.
- Acting on behalf of a seat records both the person and the seat they held at the time.
- Reason-required fields cannot be written without one.

**Tests**
- Attempt each sensitive action without a reason where required; verify refusal.
- Replay an incident's event log; verify every state transition names an actor and seat.

---

## INV-07 — An SLA clock never runs on a client

Acknowledgement deadlines and escalation triggers are server-side scheduled state
transitions. A closed laptop must not stop an escalation.

**Implications**
- Timers live in the durable job queue, not in browser or app memory.
- Client-side countdowns are display only, derived from server-authoritative deadlines.
- Escalation fires whether or not any client is connected.

**Tests**
- Create an incident, close every client, wait past the SLA; verify escalation fired.
- Manipulate client clock; verify no effect on SLA outcome.

---

## INV-08 — Recovery never produces a notification storm

When connectivity returns after an outage, queued events replay with deduplication and
rate limits. Reconnecting must not page forty people about incidents already resolved.

**Implications**
- Replay uses idempotency keys; a re-delivered event is a no-op.
- Notifications for incidents already resolved at replay time are suppressed, and the
  suppression is logged.
- Late arrivals produce one clearly-labelled *late arrival* alert per incident, not a
  retroactive cascade of escalations.
- Per-recipient rate limits apply across all channels.

**Tests**
- Queue 100 events offline across 20 incidents, half since resolved; reconnect and verify
  bounded, deduplicated, correctly-suppressed notification output.
- Replay the same batch twice; verify identical end state and zero additional
  notifications.

---

## Adding an invariant

An invariant is added only when it protects something whose failure would cause real
harm — not for ordinary correctness, which is what tests are for. Adding one requires:

1. A statement written as a prohibition.
2. Its implications for the design.
3. At least one test that would fail without it.
4. An entry in `CHANGELOG.md` and an update to `CLAUDE.md` §4.
