# Milestones

**Sequencing principle:** prove the hardest and most uncertain thing first, with real code,
while it is still cheap to be wrong. Documents that have never been tested against a
running system are hypotheses — and the riskiest hypothesis here is the offline emergency
path. So that is what gets built in week one.

Every milestone has a **pass/fail gate**. A gate is not "the code is written" — it is a
demonstrable outcome. If a gate fails, the milestone reopens. Do not proceed because
something runs.

---

## M0 — The Spine · weeks 1–3

One thin vertical slice, end to end, with nothing decorative.

A report submitted with the device in airplane mode; queued locally; synced on reconnect;
routed to one department; acknowledged by a duty seat under a server-side SLA; visible on
a central view; reassigned once by the control room; and the whole chain reconstructable
from the event log.

No styling beyond legibility. No second department. No map. No notifications beyond one
channel. **The point is to prove the architecture, not to look like a product.**

> **Gate** — The slice runs offline, and audit replay reproduces the incident's state at
> any past timestamp. Projections can be dropped and rebuilt with identical results.
> Escalation fires with every client closed.
>
> **If this is not working, nothing else starts.**

Tasks: [`todos.md`](todos.md)

---

## M1a — The administration console · **new, and now the critical path**

Added 2026-08-02 after the owner settled how the district is organised (**ADR-0010**). This
was not in the original plan because the original plan assumed a four-tier hierarchy that
does not exist here.

Two offices — **DC** and **AC Headquarter Bannu** — are the authority for the whole district.
Everything else is a department reporting to them. That makes their console the product, not
a supporting screen, and it makes almost every remaining "waiting on the district" question
into build work instead:

- **Departments as editable data** — create, rename, retire; set contact numbers and people.
  Seeded from the district's list, editable from day one. (Was M2's gate; arrives here.)
- **Routing signals per department** — the categories each department answers for, so a
  bazaar fire reaches Rescue without anyone typing a department name.
- **Unassigned emergencies, loudly** — anything the signals do not match appears on both
  administrative dashboards marked unassigned, for a human to assign. Never guessed, never
  quiet (ADR-0005).
- **SLA targets as configuration** — per department and severity, set by the administration.
  Replaces `PLACEHOLDER_SLA`, which the board currently renders to operators as though it
  were a fact (Q-06).
- **District-wide performance view** — every department's data and responsiveness, which is
  the thing the two offices exist to see.
- **Backup visibility** — see backup health and history, take one on demand, download it.
  **Restoring over the live database is deliberately not a dashboard button** — see the note
  in `docs/08-runbook.md` and the open question with the owner.

> **Gate** — a DC or AC Headquarter operator adds a department, gives it a contact and a
> routing signal, and an emergency in that category reaches it **without a developer
> touching anything**.

---

## M1 — Rescue 1122, in full · weeks 4–7

One department taken all the way down: intake, triage, duty roster, dispatch, resource and
team assignment, response action logging, escalation, closure with evidence, post-incident
report.

Depth before breadth. The real shape of a department workspace can only be discovered by
building one properly — four built shallowly in parallel produce four mini-apps and a
wrong abstraction that then has to be unwound.

Also lands here: the Place gazetteer for Bannu, and bilingual UI foundations.

**Blocked by:** Q-01 (does Rescue already run a dispatch system?).

> **Gate** — A real Rescue operator completes a full incident lifecycle without a
> developer present, and beats the stopwatch on rapid intake: **under 15 seconds** from
> open to submitted on a mid-range Android handset over a weak connection.

---

## M2 — Multiplication · weeks 8–12

Police, Health, and C&W/Utilities added.

The test is not that they work. It is **how they were added.** If department three required
new code paths rather than registry configuration and authority rules, M1's abstraction
failed — and it gets fixed here, rather than repeated four more times.

> **Gate** — Adding a fifth department is a configuration exercise measured in hours,
> demonstrated live in front of the team.

---

## M3 — The Ladder · weeks 13–16

Rungs L2 through L4 of `docs/02-connectivity-ladder.md` implemented and drilled.

SMS ingress and egress. Voice escalation. Blackout paper log generation and catch-up
ingestion. Replay deduplication and rate limiting. Late-arrival handling. Heartbeat and
coverage semantics across every projection.

**Blocked by:** Q-07 (which notification channels actually work in Bannu), Q-10
(provincial escalation path).

> **Gate** — A staged blackout drill, network pulled for two hours, ends with zero lost
> incidents, honest timestamps, and no notification storm on recovery.

---

## M4 — Pilot in one tehsil · weeks 17–20

Live with Rescue plus one more department, in one tehsil, with the control room.
Multi-department drills.

**Full parallel running against existing paper and phone practice** — because the parallel
record is the only way to measure the bypass rate honestly. Gazetteer completed with local
input. Bilingual UI validated with actual operators. Real SLA targets set with departments
(Q-06).

**Blocked by:** Q-04 (legal basis for citizen data), Q-05 (formal system owner).

> **Gate** — Bypass rate under 20% and falling, and operators choose the system over the
> phone unprompted.

---

## M5 — Hardening and handover · weeks 21–24

Adversarial security review against cross-department access and authority bypass. Backup
and a **genuinely executed** restore drill — not a documented one. Monitoring that pages a
real person. Control-room failover tested.

And the deliverable that decides whether this survives year two: a **named local
maintainer** who has been trained, has the runbook, and has fixed something themselves
under supervision.

> **Gate** — Restore-from-backup performed successfully by someone who is not the original
> developer.

---

## What is deliberately not in this plan

Recorded so nobody assumes they were forgotten:

- **Public citizen reporting portal** — large scope, trust implications, and it multiplies
  the deduplication problem. Decide after the pilot (Q-13).
- **AI summarisation** — see `docs/05-stack.md`. Constrained assistance only, never in the
  critical path, and not before the deterministic system is proven.
- **Advanced analytics and trend dashboards** — needs real historical data first. Building
  analytics on synthetic data produces charts that mean nothing.
- **Native mobile apps** — PWA first. Revisit only if push reliability demands it.
- **Radio integration** — operator-transcribed for v1 (Q-12).
- **Non-emergency department modules** (revenue, agriculture, education routine
  reporting) — real, and out of scope until the emergency spine is proven in production.

## Metrics

Built in M0, watched from M1. A metric introduced at the end measures nothing but the end.

| Metric | Tells us | Weight |
|---|---|---|
| **Bypass rate** — emergencies handled but never entered | Whether the platform reflects reality or a filtered subset of it | **Decisive** |
| Time to acknowledge, p50 / p90 | Whether routing and notification reach a human who acts | Critical |
| Time to first response action | Whether acknowledgement is real or a button pressed to stop a timer | Critical |
| Department heartbeat compliance | How much of the district the board can actually see | High |
| Notification delivery rate by channel | Which channels can be trusted for escalation | High |
| Occurred-to-recorded gap distribution | The district's real connectivity picture, measured | High |
| Escalation rate and cause | Whether SLAs are calibrated or simply being missed | Standard |
| Closure completeness | Incidents closed with evidence vs abandoned or closed blank | Standard |

**Bypass rate decides everything.** Every other number can look excellent while the system
quietly fails, because a platform capturing only the easy incidents will show fast
acknowledgements, clean closures, and a calm green board — while the district's real
emergencies continue moving over the phone.

It is also the only metric that **cannot be gathered from inside the system**, which is
exactly why projects skip it. Measuring it requires deliberately reconciling against the
world outside, during the pilot, on purpose.
