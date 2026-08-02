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

### Q-14 · Existing officer and contact directories `PARTIALLY ANSWERED 2026-08-02`
**A list exists and the district supplied it** — 81 posts across ~79 offices, with 43
contact numbers. Loaded via `db/seed/directory.json` (gitignored). More to follow, so the
loader is idempotent.

The remaining half of the question is unanswered and is the expensive half: **who keeps it
current?** A directory is wrong within months of nobody owning it, and this system routes
emergencies by it. Still needs an owner before the pilot.

### Q-18 · How is Bannu actually organised? `HIGH`
Raised by loading the contact list (M0-51), which the loader deliberately refused to guess
at. Three distinct gaps:

**1. Which offices are posts within a larger department?** The source has one column,
"Department/Office", and it mixes both. `ADC (General)` is plainly a post in the DC Office;
`DSP City` sits under the DPO; the four `AAC` entries are tehsil posts under the district
administration. The registry currently holds each row as its own department, verbatim,
because inventing the hierarchy would put a structure in the system that nobody in Bannu
agreed to. **Needed before M2**, whose gate is "adding a fifth department is a configuration
exercise" — that is meaningless if the first eighty are misfiled.

**2. What tier is each seat?** Not in the source, so every loaded seat defaults to
`district`. **This matters more than it sounds:** the escalation ladder walks tiers
(`nextSeatUp`), so a roster where everything is one tier cannot escalate. AACs are tehsil;
station-level posts exist under Police and Rescue. **Needed before escalation is trusted in
the pilot.**

**3. Which departments respond to emergencies?** ~79 offices are loaded, and most —
Fisheries, Auqaf, Sports, Press Club — are not emergency responders. Routing should not
offer them. Needs a marked subset.

### Q-19 · Two officers, one mobile number `OPEN`
The supplied list gives **03338887171** to both `ADC (Finance & Planning) — Yousaf Haroon`
and `TMA Bannu — Yousaf Khan`. Different names, one number. Either a transcription error or
a genuinely shared handset, and those need opposite fixes, so the loader reported it and
loaded neither pairing over the other. The TMA Bannu row is **not in the system** until this
is resolved.

Two smaller ones from the same list:
- `AAC Bakakhel` has the designation `AAC Miryan` — almost certainly a copy-paste, but it is
  the district's document and not ours to correct.
- **Rescue 1122 has no contact number.** Bakht Ullah Wazir is named as District Emergency
  Officer with no number, and Rescue 1122 is the entire subject of M1.

### Q-15 · Secondary control room location `OPEN`
`00-thesis.md` flags the control room as a single point of failure. Where the secondary
site is, and who has access, needs an answer before go-live.

### Q-16 · Should severity have an explicit `unknown`? `RESOLVED 2026-08-02`
**Answer: yes — as a value, never as a level.** See `ADR-0009`.

Decided when the central board was built, which is exactly when it stopped being
theoretical: the old behaviour assumed `high`, and a board would have rendered that as
somebody's assessment. Aggregates now report two numbers — worst assessed, and how many are
unassessed — and neither is folded into the other. The urgency the old guess expressed moved
to the SLA target for `unknown`, where it does not lie on a screen.

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
