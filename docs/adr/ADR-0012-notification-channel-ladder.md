# ADR-0012 — Notifications walk a ladder: WhatsApp, then a phone call

**Status:** Accepted · 2026-08-02
**Resolves:** Q-07. Builds on `M0-32` (the delivery ledger) and `ADR-0005` (silence is a
signal).
**Source:** project owner, 2026-08-02.

## Context

Q-07 asked which notification channels are actually reliable in Bannu. The owner's answer:

> **WhatsApp is first priority.** If WhatsApp is not reachable, it should redirect to a
> **direct call** on the phone network. And the user should be able to choose to route a
> notification to another channel when they need to.

The delivery ledger built in M0-32 already records every attempt with its channel and outcome,
and already treats the channel as pluggable, so the shape was right. What was missing was the
policy: which channel, in what order, and who decides.

## Decision

### A notification is an obligation, not a message

The system owes a seat an alert. **The channel is how it discharges the obligation, and it
keeps trying down a ladder until one succeeds or the ladder runs out.** Every rung is recorded
in the ledger, so "we told them" is always answerable with which channel, at what time, and
whether it landed.

### The default ladder

1. **WhatsApp** — first, per the owner.
2. **Voice call** — when WhatsApp does not reach them.
3. **SMS** — a written record that survives a missed call.
4. **In-app inbox** — always, in parallel. Already built. Costs nothing and needs no provider.

The ladder is **configuration**, edited from the administrative dashboards (ADR-0010), not
code. A seat may set its own preference; a specific notification may override it, which is the
per-notification choice the owner asked for.

### Two different internets, and only one of them is optional

This distinction decides what actually works, and it was not in the question:

- **The recipient's internet.** WhatsApp needs the officer's handset to have data. If they do
  not, the ladder falls to a voice call. **This is exactly what the owner described, and it is
  fully buildable.**
- **The server's internet.** The DC office machine must reach Meta and the telephony provider
  to send anything at all. If the district's line is down, WhatsApp cannot be sent, and neither
  can a call placed through an internet telephony provider.

So there is a rung below all of them:

5. **GSM modem or SIM gateway** — a small device with a SIM card, attached to the DC server.
   It sends SMS and places calls over the **mobile network**, needing no internet on either
   end. It is the only channel that survives an internet outage in the district.

Given ADR-0011 puts the server in the DC office precisely so a district internet failure does
not stop work, a ladder that goes entirely dark in that failure would be incoherent. **The GSM
modem is recommended, not optional dressing** — the hardware is cheap and it is the difference
between escalation reaching a human and escalation reaching a log entry.

### Failure is loud

A notification that exhausts the ladder is **not** marked delivered and **not** left quiet. It
surfaces as undelivered on both administrative dashboards, which is the behaviour already
built and tested (`notificationsUndelivered`, `UNDELIVERED_AFTER_MINUTES`). ADR-0005 applies:
the absence of a delivery is the signal.

## Consequences

**Good**

- One policy, expressed as data, covers "WhatsApp first", "call if they are unreachable", and
  "send this one by SMS instead" without three code paths.
- The ledger already answers the question that matters after an incident: *did the message
  reach them, and how do we know?*

**Costs and real-world prerequisites**

These have lead time and cost money. They are not engineering blockers — the adapters can be
built and tested against fakes — but nothing reaches a real phone until they exist:

- **WhatsApp Business API** — a Meta business account, a verified sending number, and
  **pre-approved message templates**. Alerts are business-initiated, so Meta must approve the
  wording in advance. This is the longest lead time in the list, and the templates must be
  drafted before approval can start.
- **SMS gateway** — an account with a Pakistani provider.
- **Voice** — a telephony provider, or the GSM modem.
- **GSM modem** — hardware, a SIM, and a slot in the DC office server.

**Rejected**

- *Waiting for accounts before building.* The channels go behind an interface with a fake
  implementation, exactly as the in-app channel already is. Provisioning happens in parallel.
- *Best-effort delivery with no ledger.* An unrecorded attempt is indistinguishable from no
  attempt, and this system exists because things get lost quietly.
