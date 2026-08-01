# Stack

**Selection criterion: the 02:00 test.** Not throughput, not elegance, not what is
currently fashionable.

> Can one competent person — possibly the district's own IT staff — understand this well
> enough to fix it at two in the morning with the DC on the phone?

The system's real availability ceiling is set by whoever can repair it under pressure, not
by its design diagram. Every choice below is defensible on those grounds.

> **Status: proposed, not confirmed.** These choices must be validated with whoever will
> actually maintain the system before M0 begins. See `06-open-questions.md` Q-03.

---

## Choices

| Layer | Choice | Reasoning |
|---|---|---|
| **Database** | PostgreSQL — single primary + streaming replica | Event tables, projections, JSONB for evolving payloads, PostGIS for location, and `LISTEN/NOTIFY` for realtime. One dependency doing four jobs. |
| **Backend** | One typed monolith — TypeScript/Node, or Go if the team prefers | Clear internal module boundaries, one deployable, one log stream. Microservices would buy nothing here and cost operability. |
| **Realtime** | Server-Sent Events over an outbox table | Reconnect and replay-from-cursor are trivial with SSE. Websockets add bidirectional complexity this system does not need. No broker to operate. |
| **Background work** | Postgres-backed job queue, same process | SLA timers, escalation firing, notification retries. Durable, inspectable with plain SQL, no Redis to lose. |
| **Client** | PWA — IndexedDB outbox + service worker | Installable on cheap Android handsets, works offline, no app-store review blocking an urgent fix. Native only if push reliability later demands it. |
| **Maps** | MapLibre with pre-cached district tiles | Offline-capable and self-hostable. Tiles for one district are small enough to ship with the app. |
| **Notifications** | Pluggable channel interface — SMS, voice, WhatsApp, push, email | Providers in this region change and fail. The interface is ours; the provider is swappable config with per-channel delivery tracking. |
| **Hosting** | In-country, with a documented on-premise fallback | Citizen data and government sovereignty expectations, plus survivability if international connectivity degrades. |
| **Auth** | Server-side sessions, seat-scoped | Simple, revocable, no token-expiry surprises during an emergency. Revoking a compromised account must be instant. |

---

## Two deliberate non-choices

**No message broker.** The outbox table and Postgres job queue cover every current
requirement and can be replaced later if volume genuinely demands it. Kafka or RabbitMQ
here would add an operational surface nobody in the district can debug, to solve a
throughput problem this system does not have.

**No AI in the critical path.** Summarisation and triage suggestions may assist an
operator, but they never route, never close, and never appear in the record as fact. A
confident wrong summary on a district emergency board is worse than no summary. If AI is
used at all, it is constrained to summarising verified records, and its output is labelled
as derived.

---

## The dependency rule

Every new dependency must answer two questions before it is added:

1. **Who restarts this when it fails?**
2. **How do they know it failed?**

If either answer is "nobody" or "they don't", the dependency is rejected regardless of its
technical merit. Answers are recorded in the ADR that introduces it.

---

## Environments

| Environment | Purpose | Data |
|---|---|---|
| Local | Development, offline testing | Synthetic |
| Staging | Pre-release verification, drills | Synthetic, structurally realistic |
| Production | Live district operations | Real |

No production data in any lower environment, without exception — this system holds
citizen contact details and emergency records.

---

## Operational requirements from day one

These are not "later" items. They are part of M0's definition of done:

- Structured logs with incident and event correlation ids.
- Health endpoint that a monitor can page on.
- Automated backup, and a **restore drill that has actually been performed** by someone
  who is not the original developer — a documented restore procedure that has never been
  executed is not a backup strategy.
- Migration and rollback procedure, tested.
- Secrets in a secret store, never in the repository or the frontend bundle.
