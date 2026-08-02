# Data Model

Deliberately small. A large model at this stage is a sign the domain has not been
understood. Everything here either appears in an emergency's lifecycle or explains who was
allowed to touch it.

This is a **specification sketch**, not a schema. Migration-ready DDL is produced in M0
against the decisions recorded here.

---

## Entities

| Entity | Role in the system | Notes |
|---|---|---|
| `Report` | A single claim that something happened. Cheap, never rejected, never deleted. | Channel (web / SMS / call / radio / walk-in), reporter contact, raw text, media, location capture, `occurred_at`. |
| `Incident` | The authoritative thing in the world. One or more reports link to it. | **Has no mutable status column.** Status is folded from its events. |
| `IncidentEvent` | Append-only. The entire history and the entire audit trail. | Typed — see the event catalog below. |
| `Seat` | An organisational post that holds authority — not a person. | Belongs to a department and a tier (station / tehsil / district / provincial). |
| `DutyAssignment` | Which person holds which seat, over which time range. | Makes "who do I notify right now" answerable; makes handover a logged event. |
| `Person` | A human with credentials. | Holds seats over time; has no authority of their own. |
| `Department` | A registry row, not a code module. | Module config, freshness expectation, routing categories, escalation chain. |
| `AuthorityRule` | Who owns a field, who may override it, whether a reason is required. | Data, administrator-editable, covered by tests. See `04-authority-model.md`. |
| `NotificationAttempt` | One try, on one channel, to one endpoint, with a delivery state. | Never collapsed into a boolean (INV-03). |
| `ContactEndpoint` | A reachable address for a seat or person, per channel. | Phone, WhatsApp, SMS, email, push token. Verified state tracked. |
| `Place` | Gazetteer of tehsils, union councils, villages and landmarks with coordinates. | The unglamorous asset that makes location usable. |
| `Evidence` | Media or documents attached to a report, response action, or closure. | Stored by reference; upload may lag the event it belongs to. |
| `Projection` | Derived read models — district board, department board, metrics. | Rebuildable from the event log at any time. **Never edited directly.** |

**Notice what is not here:** no separate dashboard tables, no per-department incident
tables, no denormalised copies for the central view. The central board and the Rescue 1122
board are two projections of one event log, filtered differently and authorised
differently.

That is the "one source of truth" requirement expressed **structurally** rather than as a
rule people have to remember.

---

## Event catalog

Every event carries, without exception:

```
event_id          uuid, client-generated (idempotency key)
incident_id       uuid
type              enum
occurred_at       timestamptz  — when it happened, per the actor
recorded_at       timestamptz  — when the server first accepted it
actor_person_id   uuid, nullable (null for system events)
actor_seat_id     uuid, nullable — the seat held at the time
source_channel    enum — web / mobile / sms / call / radio / system
payload           jsonb — type-specific
```

| Event | Meaning | Payload notes |
|---|---|---|
| `reported` | A report was linked to this incident | report_id, initial category, location capture |
| `triaged` | Severity and category set or revised | severity, category, reason if revised |
| `routed` | Responsible department(s) assigned | department_ids, rule_id or `manual`, reason |
| `notified` | A notification was **attempted** — not sent, not received | attempt_id, channel, seat, reason |
| `notification_delivered` | An attempt actually reached a human | attempt_id, seat, channel |
| `notification_failed` | An attempt could not be made or did not arrive | attempt_id, seat, channel, **failure** |
| `acknowledged` | A duty seat accepted responsibility | seat_id, elapsed vs SLA |
| `assigned` | Team, vehicle, or resource committed | resource refs |
| `action_logged` | A response action was recorded | free text, evidence refs |
| `escalated` | Moved up the seat hierarchy | from_seat, to_seat, trigger: `sla_breach` / `manual` / `severity` |
| `reassigned` | Responsible department changed | from, to, actor, **reason required** |
| `overridden` | A field was overridden by authority | field, old value, new value, **reason required** |
| `merged` | This incident absorbed another | absorbed_incident_id, reason |
| `unmerged` | A merge was reversed | restored_incident_id, reason |
| `resolved` | Response complete | outcome, evidence refs |
| `closed` | Administratively closed | closure notes, evidence refs |
| `reopened` | Closure reversed | **reason required** |
| `late_arrival_flagged` | Gap between occurred and recorded exceeded threshold | gap duration |

### Rules

- Events are **append-only**. There is no update or delete. A mistake is corrected by a
  new event, not by editing the old one.
- Ordering within an incident is by `occurred_at`, tie-broken by `recorded_at` then
  `event_id`. Replay is deterministic.
- `event_id` is generated on the client so that a retry after an unclear network failure
  is a no-op rather than a duplicate (INV-08).
- An event whose `actor_seat_id` is set records the seat **as held at that moment** — a
  later transfer does not rewrite history.

---

## Projections

Read models, rebuilt by folding events. Each carries `as_of` and its coverage.

| Projection | Serves | Freshness sensitivity |
|---|---|---|
| `incident_current` | Any view of a single incident | Rebuilt on every event |
| `district_board` | Central command view — all active incidents | Must carry coverage per department (INV-02, INV-05) |
| `department_board` | One department's workspace | Scoped by authority |
| `sla_watch` | Incidents approaching or past acknowledgement deadline | Drives the server-side timer job |
| `department_health` | Heartbeat and freshness per department | Drives the "no contact" state (`ADR-0005`) |
| `metrics_daily` | Response times, escalation rates, occurred-to-recorded gaps | Batch; not on the critical path |

**Rebuildability is a tested property**, not an assumption. A milestone gate includes
dropping every projection and rebuilding from the log with identical results.

---

## Location

Layered capture — any one layer is sufficient (see `00-thesis.md`, "no reliable street
addresses"):

1. GPS pin, when the device can provide one
2. Cascading tehsil → union council → village, from `Place`
3. Landmark search against `Place`
4. Free text

Stored as: an optional point geometry, an optional `place_id`, and the free text. The
system records **which layers were captured**, so a downstream consumer knows whether a
pin is a GPS fix or an operator's best guess at a landmark.

---

## Retention and privacy

- Reporter contact details are restricted-read and never appear in exports without
  explicit authority.
- Incident history is retained indefinitely — it is the district's record.
- Media has a separate, shorter retention policy to be decided (see
  `06-open-questions.md`).
- Personal data handling must be confirmed against Pakistani data protection
  requirements — **currently an open question, marked blocking for anything touching
  citizen PII at scale.**
