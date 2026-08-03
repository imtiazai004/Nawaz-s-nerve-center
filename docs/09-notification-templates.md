# WhatsApp message templates — drafts for Meta approval

**These are drafts. The district owns the wording, and it should be corrected before anybody
submits it.** They are written down now because approval has a lead time and cannot start
until somebody writes the words — see **R-05**, the longest pole in the project.

---

## Why templates exist at all

WhatsApp will not let a business send free text to somebody who has not messaged them in the
last 24 hours. Every alert this system sends is **business-initiated**, so every alert must
use a template that Meta has approved in advance.

The practical consequences, in the order they will bite:

1. **Nothing can be sent until approval comes through.** Not "it degrades" — the API rejects
   it. This is not a thing that can be worked around at 02:00 on the night it is first needed.
2. **The wording is fixed once approved.** Only the marked variables change. Changing a
   sentence means submitting a new template and waiting again.
3. **Rejection is common and specific.** Meta rejects templates that look like marketing, that
   contain URLs to unverified domains, or whose variables could be filled with anything. The
   drafts below are written to avoid all three.

A template is approved against a **category**. These are all `UTILITY` — a factual
notification about something the recipient is party to — and not `MARKETING`. Getting that
wrong is the most common rejection.

---

## What is deliberately *not* in them

Every one of these lands on a lock screen that anybody standing nearby can read, and travels
through Meta, a gateway and a telephone network on the way. So none of them contains:

- the reporter's name or number
- the caller's location beyond a district-level place name
- the incident id
- anything a person could be identified by

They name the **kind** of emergency and say to open the app. Everything else lives behind the
sign-in, where the authority model can still see who is looking (INV-05).

They are also each **under 160 characters** so that the same words work as an SMS. A Pakistani
gateway charges per 160-character segment, and a split message arrives in pieces.

---

## The four templates

The system sends one notification per **reason** an obligation exists, so there are four. The
names match `templateFor()` in `src/channels/providers.ts`; changing one means changing both.

### 1 · `dnc_routed_v1` — a new emergency

**Category:** `UTILITY` · **Language:** `en` (see R-09 — Urdu and Pashto are not decided)

> **New emergency for {{1}}: {{2}}.**
> Open the District Nerve Center to acknowledge.

| Variable | Filled with | Example |
|---|---|---|
| `{{1}}` | The department the emergency was routed to | `Rescue 1122` |
| `{{2}}` | Severity and category | `critical fire` |

**Why it reads this way.** The department comes first because an officer holding two posts
needs to know which hat this is. Severity comes before category because "critical" is the word
that decides whether they get up.

---

### 2 · `dnc_escalated_v1` — nobody acknowledged it

**Category:** `UTILITY`

> **ESCALATED, not yet acknowledged for {{1}}: {{2}}.**
> Open the District Nerve Center to acknowledge.

| Variable | Filled with | Example |
|---|---|---|
| `{{1}}` | The department | `Rescue 1122` |
| `{{2}}` | Severity and category | `critical fire` |

**Why the shouting.** This one arrives because the deadline passed and nobody picked it up.
Somebody woken at 03:00 has to know in the first three words whether this is new or whether it
is the one that has already been missed. If it reads the same as a new emergency, the
escalation has done nothing.

---

### 3 · `dnc_reassigned_v1` — it is yours now

**Category:** `UTILITY`

> **Reassigned to you, {{1}}: {{2}}.**
> Open the District Nerve Center to acknowledge.

---

### 4 · `dnc_lost_responsibility_v1` — it is no longer yours

**Category:** `UTILITY`

> **No longer yours, {{1}}: {{2}}.**
> No action needed. Open the District Nerve Center for the handover.

**Why this one exists at all**, and why it is not an afterthought: a handover nobody announced
is how two departments each assume the other went. The department losing an incident is told
for the same reason the one gaining it is (`docs/04-authority-model.md`,
`visible_to_owner: yes_and_notify`).

---

## What the district has to do

1. **Correct the wording.** Especially the department name format and whether "District Nerve
   Center" is what the district will actually call this.
2. **Decide the language(s)** — R-09. Meta approves a template per language, and Urdu or
   Pashto versions are separate submissions with their own wait.
3. **Create the Meta business account** and verify a sending number. The number becomes the
   sender every officer in Bannu sees, so it should be one the district is content to publish.
4. **Submit all four**, as `UTILITY`, and expect at least one round of rejection.
5. **Tell me the approved template names** if they differ from the four above.

Nothing in the code changes when approval arrives. The adapters are built and tested; they
read their credentials from the environment and report themselves unconfigured until those
exist (`src/channels/providers.ts`).

---

## The thing worth knowing before relying on any of this

**WhatsApp needs the DC office's internet to be up.** So do the SMS gateway and the telephony
provider. ADR-0011 puts the server in the DC office precisely so that a district internet
failure does not stop work — and on that night, the only rungs of the ladder that still send
anything are `gsm_sms` and `gsm_voice`, which go out over the mobile network from a **modem
plugged into the district's own server**.

That modem is cheap, it is on the R-05 list, and it is the difference between escalation
reaching a human and escalation reaching a log entry.
