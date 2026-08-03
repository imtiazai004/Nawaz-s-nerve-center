# ADR-0013 — The wall screen is a public place

**Status:** Accepted · 2026-08-03
**Source:** project owner, 2026-08-03, supplying a working HTML prototype of a control-room
display and asking why the built system did not look like it.
**Builds on:** ADR-0001 (the log is the record), ADR-0005 (silence is a signal), ADR-0009
(unassessed is a value, not a severity), ADR-0012 (what an alert may say in the open).

## Context

Everything built so far is a **tool**: a thing a named person signs into, on a handset or a
desk, to do something. Report an emergency. Acknowledge one. Send a fire tender. Every screen
assumes a person with a session and an authority.

The prototype is not that. It is a **display** — a screen on the wall of the DC office and the
AC Headquarter, on all day, that nobody operates and everybody reads. It answers one question:
*what is the state of the district right now?*

That is a genuinely different thing, and the project did not have it. It should.

But a display on a wall breaks four assumptions the rest of the system is built on, and each
one has to be answered before a single pixel is drawn.

## Decision

### 1. A wall screen is read by people who have no authority at all

The tool asks "who are you, and what may you see?" and ADR-0003 answers it per person. A wall
screen cannot ask. It is read by whoever is standing in the room: a visitor, a contractor, the
person who cleans it, anybody who walks past an open door. It is read over shoulders and
photographed on phones.

**So the wall screen carries aggregates and never a particular person.**

| Shows | Never shows |
|---|---|
| "Incidents today: 4" | who reported them |
| "2 unassigned, oldest 11 minutes" | any reporter's phone number |
| "Rescue 1122 · 3 open" | any caller's name |
| "Fire · elevated" | any address or coordinate |
| the district's published emergency numbers | any officer's personal mobile |
| "AAC Domel · in field" | where in the field |

This is the same reasoning as ADR-0012 applied to a different surface. There, an alert lands on
a lock screen somebody nearby can read, so it carries the *kind* of emergency and nothing that
identifies anybody. Here the surface is a wall instead of a lock screen, and the answer is the
same. **Nothing on the wall screen is private, because there is no way to make it private.**

The consequence worth naming: an officer who wants to know *which* emergency is unassigned must
pick up a handset and sign in. That is not friction to be designed away. That is the authority
model working on a surface that cannot enforce it.

### 2. A wall screen signs in as a screen, not as a person

The obvious way to build this is to sign the TV in as the DC once and leave it. That is the DC's
account, unlocked, in a room with a door — and every action taken from it would be attributed
to the DC in a log that exists precisely to answer "who".

**A display gets its own identity: a wall token, issued by the two offices, tied to a room.**
It can read the aggregate feed and can do nothing else — no POST, no acknowledgement, no
configuration, no incident detail. If the token leaks, what leaks is a screen of numbers that
was already visible through a window.

The token is issued from **Administration → Wall screens**, is shown once, and is revocable. A
screen that has stopped calling home is listed as such, because a dark TV in the corner of the
AC's office is exactly the kind of failure nobody reports.

### 3. Every number carries its own age

The prototype writes `Incidents Today: 2` and `Electricity (PESCO): Normal` in the same
typeface, with the same weight, side by side. One of those is counted from the event log a
second ago. The other is a thing somebody typed at some point, possibly last Tuesday.

A wall screen is the most dangerous place in the system for that confusion, because it is the
one screen people trust without touching. A room full of officers looking at a green dot that
went stale nine hours ago is worse than a room with no screen at all — they would have phoned
somebody.

**So each panel states when it was last true**, and a panel that has gone quiet says so instead
of continuing to show its last value as though it were current:

- counted from the log → live, and the screen says so
- reported by a department (utilities, presence) → "PESCO · normal · **updated 14 min ago**",
  and past a threshold the district sets, the value greys and reads **"not reported since
  09:40"** rather than "normal"
- fetched from outside (weather) → the time of the fetch, and on failure the age of what is
  being shown

This is ADR-0005 on a wall. A stale green dot is silence wearing the costume of an answer.

### 4. Nothing on the wall screen is entered on the wall screen

The prototype has an **Edit** button on every panel and a password in the JavaScript. Both
follow from having no backend: the display has to be its own admin because there is nowhere
else for the data to live.

Here there is somewhere else. Utilities are reported by the utility departments, presence is
set by the officer or their office, incidents are folded from the log. **The wall screen is
read-only, in the strong sense: it has no write path at all**, not a hidden one, not a
privileged one. What it shows was entered somewhere that knows who entered it.

## What this rejects, and why

**Signing the TV in as a person.** Rejected in §2. The log's answer to "who" is the whole
project; an always-signed-in shared account is a hole in it that never closes.

**Showing incident detail on the wall.** Rejected in §1. The most requested feature of a
control-room display is the one it must not have.

**A single "last updated" clock for the whole screen.** Rejected in §3. It is the honest-looking
version of the lie: it makes the freshest panel and the stalest panel look equally current. Each
panel owns its own age.

**Keeping the prototype's editing model.** Rejected in §4. A password in a file that anyone
viewing the page can read is not a weaker version of authentication; it is the absence of it
wearing its clothes.

## Consequences

- A new read-only aggregate endpoint, `GET /wall`, authenticated by wall token, returning only
  what §1 permits — and a permanent test that asserts the response contains **no phone number,
  no personal name and no coordinate**, because this is exactly the boundary that erodes.
- Two new things the district reports and the system did not previously hold: **utility status**
  and **officer presence**. Both are department-owned data, edited where the roster is edited,
  consistent with the owner's instruction that a department manages its own people and contacts.
- Weather is fetched **by the server**, never the browser. Beyond the obvious (no key in a
  kiosk), it means one fetch serves every screen, and a district with no internet shows one
  honest "last fetched" rather than each TV failing separately.
- The tool screens get the display's visual standard, but not its layout. A wall is read at four
  metres by someone not touching it; a handset is read at forty centimetres in the rain by
  someone holding it one-handed. Same colours, same type, different geometry.
