# Build with Claude

Planning, architecture, and build reference for the **District Nerve Center — Bannu**:
a district-wide operational platform for emergency response and government department
coordination in Bannu, Khyber Pakhtunkhwa.

This folder is the working home for the Claude-led design and build track. It sits
alongside the original engineering handbook in the parent folder.

---

## Start here

| If you are | Read |
|---|---|
| New to the project | [`docs/00-thesis.md`](docs/00-thesis.md) — why the system is shaped this way |
| An AI agent about to work here | [`CLAUDE.md`](CLAUDE.md) or [`AGENTS.md`](AGENTS.md) — **read fully before touching anything** |
| Looking for what's next | [`backlog/todos.md`](backlog/todos.md) |
| Wondering why a decision was made | [`docs/adr/`](docs/adr/) |
| Wondering what changed and when | [`CHANGELOG.md`](CHANGELOG.md) |

## The one-paragraph version

Any emergency reported anywhere in Bannu — by any channel, on any network condition,
including none — must enter the system, reach the responsible duty officer, appear in the
central command view, be acknowledged under a server-enforced SLA, escalate if it is not,
and remain traceable through response to closure. Departments own their own data; central
administration can view everything and override some of it with recorded authority. There
is one record, not two copies being synchronised.

## How this folder works

**`CLAUDE.md` is the reference, and it is alive.** Every session that changes anything here
updates it and appends to `CHANGELOG.md` — additions, removals, decisions, reversals, all
of it. This is enforced by a hook in `.claude/settings.json`, not left to memory.

The changelog is append-only, deliberately. The project's own history is an event log,
mirroring the architecture it describes: current state is what you get by folding the
entries, and the past stays readable. Six months in, the question that matters most is
*"why did we do it that way?"* — and that answer only survives if nobody edited it away.

## Status

**Planning and architecture. No application code yet.**

Milestone M0 (the offline emergency spine) has not started. Domain facts about Bannu's
departments and existing systems are **unverified assumptions** until the blocking
questions in [`docs/06-open-questions.md`](docs/06-open-questions.md) are resolved.
