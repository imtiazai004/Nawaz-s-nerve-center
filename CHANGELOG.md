# Changelog

Append-only project history. **Never edit or delete a past entry.** Newest at the bottom,
so the file reads in the order things actually happened.

Every session that changes anything in this folder appends one entry. Format:

```
## YYYY-MM-DD — <short title>
- **Added:**    <what came into existence>
- **Changed:**  <what was modified, and why>
- **Removed:**  <what was deleted, and why>
- **Decided:**  <ADR-xxxx, if a decision was made>
- **Open:**     <questions raised or resolved>
```

Omit lines that do not apply. Do not write hollow entries to satisfy the rule — if nothing
substantive changed, say so in the session summary instead.

---

## 2026-08-01 — Project established

- **Added:** `Build with Claude/` folder created as the working home for the Claude-led
  design and build track, alongside the existing engineering handbook in the parent folder.
- **Added:** `CLAUDE.md` — the living build reference, with Rule 0 requiring it to be
  updated on every change.
- **Added:** `AGENTS.md` — the same rules mirrored for Codex.
- **Added:** `README.md`, `CHANGELOG.md` (this file).
- **Added:** `docs/00-thesis.md` — the engineering thesis: root idea, seven load-bearing
  decisions, ground truths specific to Bannu, and the reasoning behind the build order.
- **Added:** `docs/01-invariants.md` — the eight things the system must never do, each
  written as a testable prohibition.
- **Added:** `docs/02-connectivity-ladder.md` — five levels of degraded operation from
  full connectivity to total blackout, with the timestamp semantics for each.
- **Added:** `docs/03-data-model.md` — entity sketch and the event catalog.
- **Added:** `docs/04-authority-model.md` — the field-level ownership and override policy.
- **Added:** `docs/05-stack.md` — technology choices, selected for operability.
- **Added:** `docs/06-open-questions.md` — what we do not know yet, with blockers marked.
- **Added:** `docs/adr/` — index, template, and ADR-0001 through ADR-0007.
- **Added:** `backlog/milestones.md` — M0 through M5 with pass/fail gates.
- **Added:** `backlog/todos.md` — M0 decomposed into implementation-sized tasks.
- **Added:** `.claude/settings.json` — Stop hook enforcing Rule 0.
- **Decided:** ADR-0001 event log as the record · ADR-0002 offline as the substrate ·
  ADR-0003 declarative authority · ADR-0004 duty seats over departments · ADR-0005 silence
  is a signal · ADR-0006 report/incident split · ADR-0007 boring operable stack.
- **Open:** All domain facts about Bannu's departments, existing systems, and contacts are
  unverified assumptions. Five blocking questions raised in `docs/06-open-questions.md`,
  the most important being whether Rescue 1122 and Health already run systems we should
  integrate with rather than replace.

## 2026-08-01 — Rule 0 enforcement wired

- **Added:** `.claude/rule0-check.ps1` — Stop hook script. Compares the newest modification
  time under this folder against `CLAUDE.md` and `CHANGELOG.md`; if content is newer, it
  blocks the stop once and names the stale files. Fails open on any error, and nudges at
  most once per session, so a broken hook can never wedge a session or loop.
- **Changed:** `.claude/settings.json` now points at that script via the exec-form `args`
  array rather than a shell string — the folder path contains spaces and must never reach
  a shell parser.
- **Added:** a matching `.claude/settings.json` in the parent `Nawaz/` folder, so Rule 0 is
  enforced whether Claude Code is opened on `Nawaz/` or on `Build with Claude/`. Both
  reference the same script by absolute path.
- **Changed:** `CLAUDE.md` §6 repository map updated to list the script and record the
  dual-settings arrangement, including the note that both paths need updating if this
  folder is ever moved.
- **Verified:** script pipe-tested in both states — blocks when docs are newer than the
  reference, silent on a repeat call within the same session. Both settings files parse and
  resolve to an existing script.

## 2026-08-01 — Independence decided; scope list published

- **Decided:** **No integration with government-issued systems.** Owner's decision. Several
  departments already run government software, and the district wants this platform run
  independently for its own efficiency and control. No API coupling, no dependency on any
  provincial or federal system's availability.
- **Open → Resolved:** Q-01 (does Rescue 1122 already run a dispatch system) and Q-02 (what
  must departments report upward) both closed in `docs/06-open-questions.md`. M1 and M2 are
  unblocked; no interface-discovery work is needed.
- **Changed:** Q-02's answer reframed from integration target to **export target** — the
  system generates the file formats departments must submit upward, without connecting to
  anything. Preserves independence and removes the double-work objection.
- **Open:** New risk recorded, and it is the serious one. Departments already using other
  systems now face **double entry**, which is the most likely cause of adoption failure.
  Two mitigations already in plan: the 15-second rapid-intake budget is now a hard
  requirement rather than an aspiration, and report export turns duplicated work into saved
  work. Bypass rate becomes the decisive adoption metric.
- **Added:** `docs/07-capabilities.md` — plain-language capability list for non-technical
  readers, structured as one emergency's nine-step journey followed by twelve capability
  groups, plus an explicit "deliberately not included" section. This is now the scope
  document: anything not listed there or in `backlog/milestones.md` is out of scope.
- **Added:** published shareable version of the capability list at
  https://claude.ai/code/artifact/3c83fe83-eee2-46c4-b85a-7daacdb3768a
- **Changed:** `CLAUDE.md` §5 gains a "Settled — do not reopen without the owner" subsection
  recording the independence decision and its double-entry consequence; §6 repository map
  updated for the new document; immediate next actions now point at Q-03, Q-04 and Q-05,
  which are the remaining blockers.
