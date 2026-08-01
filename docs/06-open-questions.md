# Open Questions

**Everything domain-specific in this repository is currently assumption, not verified
fact.** The architecture documents are sound as engineering; the claims they make about
Bannu's departments, systems, and procedures are not yet sourced.

Do not build past a **blocking** question by guessing. Raise it.

**Status legend:** `BLOCKING` — work stops · `HIGH` — decide before the milestone that
needs it · `OPEN` — track, resolve when convenient · `RESOLVED` — with evidence and date.

---

## Blocking

### Q-04 · What is the legal basis for holding citizen emergency data? `BLOCKING`

The system stores reporter identity, contact details, location, and health-adjacent
information. Pakistan's data protection framework, plus any KP government or district
policy, governs retention, access, export, and cross-border hosting.

**Needed:** applicable law, district policy, retention limits, who may lawfully access
reporter PII.
**Blocks:** anything touching citizen PII at scale — so, the pilot.

---

## High

### Q-06 · What are the real acknowledgement SLA targets? `HIGH`

Currently unspecified. These are operational commitments, not engineering choices — they
must come from the departments and the DC office, and they will differ by severity and by
department. Guessing produces either constant false escalation or SLAs so loose they mean
nothing.

**Needed for:** M0 (a placeholder is acceptable), M4 (real values required).

### Q-07 · Which notification channels are actually reliable in Bannu? `HIGH`

WhatsApp Business API availability, template approval, and consent requirements. SMS
gateway options and their delivery rates. Whether automated voice calls are viable.
Assumptions here directly affect whether escalation works.

**Needed for:** M3.

### Q-08 · Does the Place gazetteer exist anywhere already? `HIGH`

Revenue department records, election commission data, PDMA mapping, or survey data may
already contain Bannu's union councils and villages with coordinates. Building this from
scratch is weeks of work; obtaining it is a phone call.

**Needed for:** M1.

### Q-09 · Urdu, Pashto, or both? `HIGH`

Affects translation scope and whether bidirectional layout is required from the start.
Should be answered by asking actual operators, not assumed.

**Needed for:** M1 UI work.

### Q-10 · What is the escalation path above the district? `HIGH`

Which provincial seats, under what conditions, through what channel. Even a v1 that only
notifies and flags needs to know who it is notifying.

**Needed for:** M3.

---

## Open

### Q-11 · Media retention policy `OPEN`
Photos and video from incidents. Storage cost and privacy both argue for a shorter
retention than the incident record itself. Needs a decision, not a default.

### Q-12 · Radio integration `OPEN`
Whether radio traffic can feed the system directly at L3/L4, or whether it stays
operator-transcribed. Probably the latter for v1.

### Q-13 · Public-facing reporting `OPEN`
Whether citizens report directly, or only through departments and the control room. Large
scope and trust implications. Explicitly out of MVP scope until decided.

### Q-14 · Existing officer and contact directories `OPEN`
Whether a current, maintained directory of district officers exists, or whether the
platform becomes its home. If the latter, keeping it current is an ongoing operational
burden that needs an owner.

### Q-15 · Secondary control room location `OPEN`
`00-thesis.md` flags the control room as a single point of failure. Where the secondary
site is, and who has access, needs an answer before go-live.

### Q-16 · Should severity have an explicit `unknown`? `OPEN`
Raised by building the intake endpoint (M0-24), which cannot refuse a report and therefore
has to record *something* when nobody stated a severity. It currently assumes `high` and
records `assumed: ['severity']` in the payload, so a placeholder is distinguishable from a
reporter's judgement.

That works, but it encodes a judgement in a field meant to carry someone else's. The
alternative is a fifth value — `unknown` — which is honest but touches `SEVERITY_ORDER`,
`worstSeverity`, every SLA target, INV-04's "an aggregate never hides a critical", and every
screen that sorts by severity. It is an ADR, not a patch.

**Decide before:** M1 puts severity on a board that operators triage from. A placeholder
that looks like an assessment is a worse failure on a screen than in a database.

### Q-17 · May a department emit `overridden` on its own field? `OPEN`
The policy table makes the owning department allowed on its own fields, so
`POST /incidents/:id/override` succeeds for the owner as well as the district. It is fully
attributable — `actorSeatId` is the department's own seat, so nobody can manufacture the
appearance of a district decision — but `overridden` is meant to record *someone else's*
authority being exercised, and a department revising its own call should arguably triage
again instead.

Pinned by a test as current behaviour so that changing it is deliberate. Low urgency, real.

---

## Resolved

### Q-03 · Who maintains this after handover? `RESOLVED 2026-08-01`
### Q-05 · Who owns this system, formally? `RESOLVED 2026-08-01`

**Answer: the district administration — the DC office and/or the AC Headquarter office.**
Source: project owner, 2026-08-01.

Both questions have the same answer, so they are resolved together.

This is a good answer for a reason worth naming: it is an **office, not a person**. Offices
survive transfers, which is precisely the logic behind `ADR-0004`. "The DC office owns
this" remains true after every posting order; "Officer X owns this" would not.

**Consequences**
- `05-stack.md` is **confirmed**, not merely proposed. DC/AC office IT is exactly the
  small-team profile the stack was chosen for, so the answer validates the existing
  choice rather than changing it. The dependency rule in that document — *who restarts
  this when it fails, and how do they know it failed* — now has an addressee.
- The authority model can be finalised: the DC seat is the district-tier authority and the
  break-glass holder.
- M0 unblocked. Local PostgreSQL 17 provisioned; see `05-stack.md`.

**Deliberately carried forward rather than treated as answered**
Two practical items sit underneath the organisational answer, and both belong to M5
handover rather than to the build:
- Whether a **named technical person** exists today, or the office needs to designate one.
  The office owning it and someone being able to restore a backup at 02:00 are different
  facts.
- **Hosting budget and its source**, which decides cloud VM versus on-premise in the DC
  office. The system is being built so either works, so this is a deployment-time fork,
  not a blocker now.

### Q-01 · Does Rescue 1122 already run a dispatch system? `RESOLVED 2026-08-01`

**Answer: yes, several departments run government-issued systems — and it does not matter.**
Source: project owner, 2026-08-01.

The district's explicit intent is a platform they run **independently of government-issued
software**, for their own efficiency and their own control. Integration is therefore
**not a requirement and not a goal.** No API coupling, no dependency on a provincial or
federal system's availability, no shared schema.

**Consequences**
- M1 is unblocked. Build Rescue 1122's workspace on our own model.
- Do not spend effort discovering, negotiating, or reverse-engineering external interfaces.
- **New risk introduced, and it is the serious one:** departments already using another
  system now face double entry. That is the single most likely cause of adoption failure —
  it does not make this system wrong, it makes speed and usefulness non-negotiable. Two
  mitigations, both already in the plan:
  1. The 15-second rapid-intake budget (`00-thesis.md`) is now a hard requirement, not an
     aspiration. If this system is slower than what they already tolerate, it loses.
  2. **Report export** (see Q-02) — the system produces the formats departments must submit
     upward, so it *replaces* work rather than adding it.
- Bypass rate (`backlog/milestones.md`) becomes even more important as the adoption canary.

### Q-02 · What must each department already report upward? `RESOLVED 2026-08-01`

**Answer: still worth knowing — but as an export target, not an integration target.**
Source: project owner, 2026-08-01, following from Q-01.

Departments retain their existing upward reporting obligations. This platform does not
connect to those systems, but it **can generate the formats they need to submit**, as
files, on demand. That is export, not integration: no coupling, no dependency, no loss of
independence — and it turns the platform from extra work into saved work.

**Consequences**
- M2 no longer blocked on interface discovery.
- Collect required report *formats* per department during M1/M2 onboarding — a lightweight
  task, not a research phase.
- Report export becomes a named capability (see `07-capabilities.md`, group 9).

---

When resolving: move the question here, state the answer, cite the source and date, and
update every document the answer affects. Log it in `CHANGELOG.md`.
