# Waiting on the district

**This is the one list. Everything that needs a decision, a number, an account, or a person
is here, and nothing here is blocking me.**

The standing instruction from the owner (2026-08-02) is: *do not wait for any of this — build
the place the answer goes, put a visible placeholder in it, and keep moving.* That is what has
been done in every case below. The **Meanwhile** column says exactly what went in, and the
**Until then** column says what it costs.

**How to use it.** Work down it whenever convenient. Nothing needs to be done in order, and
nothing here stops development. Tell me when one is answered and I will wire in the real value
and strike the row.

**Status:** `OPEN` · `IN HAND` (the district is on it) · `DONE`

---

## Needs a number, a name, or a decision

| # | What is needed | Status | Meanwhile | Until then |
|---|---|---|---|---|
| **R-01** | **Rescue 1122's contact number.** The district's list names Bakht Ullah Wazir as District Emergency Officer with no number | `OPEN` | `1111111`, flagged as a placeholder. Editable from **Administration → Rosters → Rescue 1122** | Alerts to that post are recorded as **failed, loudly**. A stand-in is never dialled and never counted as reached |
| **R-02** | **The rest of the contact list.** 38 of 81 posts are vacant, and the owner has said more rows will follow | `OPEN` | Vacant posts loaded as vacant, flagged on the department card, and **editable by each department itself** | A department with routing signals and no reachable holder is shown as exactly that |
| **R-03** | **Real acknowledgement deadlines** per department (Q-06) | `OPEN` | Install defaults: 5 / 15 / 60 / 240 / 15 minutes. Editable at **Administration → Deadlines** | The board measures against defaults. Inherited values render differently from chosen ones, so nobody mistakes one for a decision |
| **R-04** | **Routing signals** — which department answers for which kind of emergency (ADR-0010) | `OPEN` | None, deliberately | Every emergency lands as **unassigned** on both administrative dashboards until a signal exists. Loud by design |
| **R-13** | **Rescue 1122's own list of response actions** — "on scene", "casualty removed", "made safe", whatever they actually write | `OPEN` | Free text with an honest timestamp, which works | An action log is searchable and countable once the verbs are shared. Inventing the list myself would be a domain fact I made up |
| **R-14** | **The six emergency categories on the intake screen** — currently *road accident, fire, medical, flood, security, other* | `OPEN` | Those six, which are **my guess** | They are the vocabulary every routing signal must match, because a handset can only report one of them. If the district's real categories differ, every signal written against these is written against the wrong words |
| **R-09** | **Urdu, Pashto, or both** (Q-09) | `OPEN` | English | Decides whether right-to-left layout is needed. Much cheaper to do early than to retrofit |
| **R-10** | **Who owns keeping the contact list current?** (the unanswered half of Q-14) | `OPEN` | Every department can now maintain its own, which spreads the work but does not assign it | A directory is wrong within months of nobody owning it, and this system routes emergencies by it |
| **R-11** | **How long are a reporter's details kept?** (Q-11, and the retention half of Q-04) | `OPEN` | Kept indefinitely | Being legally permitted to hold data is not a decision about how long. Media in particular is costly and sensitive |

## Needs money or an account

| # | What is needed | Status | Meanwhile | Until then |
|---|---|---|---|---|
| **R-05** | ~~WhatsApp, SMS and voice: a Meta business account, an SMS gateway, a telephony provider, a GSM modem~~ | **`CLOSED — not needed`** | Nothing. The software does not send messages (ADR-0012 superseded, 2026-08-03). An officer sees the number and rings them | **This was the longest lead time in the project and it is gone.** You do not need an account with Meta, a gateway, a provider or a SIM. What you need instead is what R-04 already asks for: **the numbers on the roster kept current** |
| **R-06** | **A Google Cloud Storage bucket and service account** (P-12, ADR-0011), plus a `BACKUP_PASSPHRASE` the district keeps safe | `OPEN` | Verified local dumps, taken **nightly** since 2026-08-03. The encrypt-and-upload path is built and tested; it refuses to run without a bucket **and** refuses to send anything unencrypted | Backups exist and never leave the building. Fire, flood or theft takes the record with them. Visible on **Administration → Backups**, which says plainly that no copy has ever left the district |
| **R-07** | **The AC Headquarter standby machine, and a network link between the two offices** (M0-54, ADR-0011) | `OPEN` | A single node in the DC office. `/health` now reports `role: "standalone"` and says why, rather than staying quiet about it | A dead DC machine stops the district until it is repaired. **This is the largest remaining gap in ADR-0011** — one machine holds Bannu’s entire emergency record |

## Needs a person and an hour

| # | What is needed | Status | Meanwhile | Until then |
|---|---|---|---|---|
| **R-08** | **A restore drill with a second person** (M0-38). Allah Nawaz Khan plus one other, timed, with what happened written down | `OPEN` | `docs/08-runbook.md`, and a test suite that executes every step against a real cluster on every push | Nobody in Bannu has personally restored this system. That is a different fact from "restore works" |
| **R-12** | **One Rescue 1122 operator, for an hour**, to walk a real incident end to end (the M1 gate) | `OPEN` | I test it myself, which proves it works and not that it is usable | The gate says *a real operator, no developer present*. I cannot sign that off on their behalf |

---

## Questions I would like answered, but have decided for now

Each of these has a working answer in the code. If you disagree with one, say so and I will
change it — none is expensive to reverse today, and all of them get more expensive later.

| # | Question | What I decided, and why |
|---|---|---|
| **D-01** | Should a department be able to create a **district-tier post**? | **No.** A district-tier seat can read every incident in Bannu, so a department able to place one would be granting itself sight of the whole district. Since migration 0010 a post's tier is derived from its office by the database — district only for the two administrative offices — so it is not a choice anybody can make, including the DC |
| **D-02** | Should a department be able to give **its own people logins**? | **Yes**, for people in its own department. The alternative is every account request going through the DC office, which does not scale and ends in shared passwords — worse than what it prevents. It is a separate, confirmed action from adding a contact |
| **D-03** | What happens when two departments hold one incident and their deadlines differ? | **The tighter one governs.** At that moment one of the two is genuinely late, and showing "on time" would be reporting the more comfortable of two true statements |
| **D-04** | Should the system try to **understand** a report and route it? | **No.** Only configured signals route. A model guessing at Urdu free text would be wrong at exactly the wrong moment; unmatched goes to a human, loudly |
| **D-05** | Can the **administration retire itself**? | **No.** Both offices retired would leave the district with no authority and no way back except a database console at 02:00 |
| **D-07** | Should an alert be recorded as *failed* for a channel the district has not bought yet? | **No — skipped.** Until the accounts exist, recording each rung would put five `not_configured` failures on every obligation of every incident: a board permanently reading "nobody reached" for a reason that is a purchase order. The obligation is still visibly unmet, because the in-app attempt stays pending until a human collects it. The *district-level* fact — "nothing can be sent outside the app" — is said once, in the sweep and on the console |
| **D-08** | Should a notification say what the emergency is? | **The kind, and nothing that identifies anybody.** It travels through Meta, a gateway and a telephone network and lands on a lock screen somebody nearby can read. No reporter, no number, no precise location, no incident id — those stay behind the sign-in where the authority model can still see who looked |
| **D-06** | Should **restoring a backup** be a dashboard button? | **Not over the live database.** The dashboard will get backup health, take-now, download, and verify-into-scratch. The production swap stays a deliberate act on the server. *Owner asked for the button — flagged, awaiting a final word* |

---

When one of these is answered: tell me, and I will wire in the real value, strike the row here,
move the question into `docs/06-open-questions.md` as resolved, and log it in `CHANGELOG.md`.
