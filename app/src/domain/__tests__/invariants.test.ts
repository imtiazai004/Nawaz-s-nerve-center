/**
 * Permanent tests for the invariants in docs/01-invariants.md.
 *
 * These are not ordinary unit tests. Each one guards something whose failure would cause
 * real harm in a district emergency, and a build that breaks one is broken regardless of
 * what else passes. Do not delete or weaken a test here to make a change go through —
 * if an invariant genuinely needs to change, that is an ADR and an owner decision.
 *
 * Four invariants are guarded here, at the domain layer: INV-04, INV-06, INV-07, INV-08.
 *
 * Two more are guarded elsewhere, because they are properties of the running system and a
 * pure-domain test cannot demonstrate either:
 *   - INV-01 (an emergency is never lost) — `src/__tests__/spine.e2e.test.ts`, real
 *     Chromium with the network cut, real IndexedDB, real PostgreSQL.
 *   - INV-05 (the UI is never the enforcement layer) — `src/auth/__tests__/auth.test.ts`,
 *     every refusal made by direct HTTP call, never through a rendered page.
 *
 * Two are still uncovered and stay listed here so the gap is visible rather than forgotten:
 *   - INV-02 (stale data is never rendered as current) — needs the boards, M0-33..35.
 *   - INV-03 (a notification failure is never invisible) — needs a notification channel
 *     with tracked delivery state, M0-32. There is nothing to test until that exists.
 */

import { describe, expect, it } from 'vitest';

import { foldIncident, districtSeverity } from '../incident.js';
import { evaluateWrite, defaultRules } from '../authority.js';
import { checkEscalation } from '../sla.js';
import {
  INCIDENT,
  RESCUE,
  controlRoom,
  dc,
  policeOperator,
  rescueOperator,
  ev,
} from './fixtures.js';

const severityRule = defaultRules(RESCUE).find((r) => r.fieldKey === 'incident.severity')!;
const actionsRule = defaultRules(RESCUE).find((r) => r.fieldKey === 'incident.actions')!;

describe('INV-04 — an aggregate never hides a critical', () => {
  it('one open critical dominates any number of routine incidents', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      foldIncident(`i${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'x', severity: 'low' },
          { incidentId: `i${i}` },
        ),
      ]),
    );
    const critical = foldIncident('crit', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'crit',
        },
      ),
    ]);
    expect(districtSeverity([...many, critical])).toEqual({ worst: 'critical', unassessed: 0 });
  });

  it('does not hide an unassessed incident behind a level either (ADR-0009)', () => {
    // The other half of the same invariant. A summary that folded unassessed reports into
    // `low` would hide them exactly as an average hides a critical — and folding them into
    // `critical` would hide the real criticals among them.
    const unassessed = Array.from({ length: 20 }, (_, i) =>
      foldIncident(`u${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'unknown', severity: 'unknown' },
          { incidentId: `u${i}` },
        ),
      ]),
    );
    const low = foldIncident('lo', [
      ev('reported', { reportId: 'rl', category: 'x', severity: 'low' }, { incidentId: 'lo' }),
    ]);

    expect(districtSeverity([...unassessed, low])).toEqual({ worst: 'low', unassessed: 20 });
  });
});

describe('INV-06 — no sensitive action is unattributable', () => {
  it('refuses an override without a reason', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.severity', seat: controlRoom });
    expect(d.allowed).toBe(false);
  });

  it('refuses break-glass without a reason, even for the DC', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.closure',
      seat: dc,
      breakGlass: true,
    });
    expect(d.allowed).toBe(false);
  });

  it('records the acting seat as held at that moment, not as held today', () => {
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev(
        'acknowledged',
        { seatId: rescueOperator.seatId },
        {
          actorSeatId: rescueOperator.seatId,
          actorPersonId: 'officer-departed-since',
        },
      ),
    ]);
    expect(state.acknowledgedBySeatId).toBe(rescueOperator.seatId);
  });
});

describe('INV-07 — an SLA clock never runs on a client', () => {
  it('escalates an unacknowledged critical with every client offline', () => {
    // No client participated: the only inputs are stored timestamps and server time.
    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T10:00:00.000Z',
      recordedAt: '2026-08-01T10:00:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T10:06:00.000Z',
    });
    expect(verdict.shouldEscalate).toBe(true);
  });

  it('does not escalate once acknowledged', () => {
    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T10:00:00.000Z',
      recordedAt: '2026-08-01T10:00:00.000Z',
      acknowledgedAt: '2026-08-01T10:03:00.000Z',
      now: '2026-08-01T11:00:00.000Z',
    });
    expect(verdict.shouldEscalate).toBe(false);
  });
});

describe('INV-08 — recovery never produces a notification storm', () => {
  it('a late-arriving incident gets a grace window, not instant retroactive escalation', () => {
    // Reported 14:02, synced 16:40 after an outage. Escalating immediately on arrival
    // would page the duty officer about every queued incident at once.
    const onArrival = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T14:02:00.000Z',
      recordedAt: '2026-08-01T16:40:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T16:40:00.000Z',
    });

    expect(onArrival.lateArrival).toBe(true);
    expect(onArrival.shouldEscalate).toBe(false);
    // ...but the metrics still tell the truth about how long it really took.
    expect(Math.round(onArrival.overdueByMinutes)).toBe(153);
  });

  it('escalates after the grace window if still unacknowledged', () => {
    const later = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T14:02:00.000Z',
      recordedAt: '2026-08-01T16:40:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T16:55:00.000Z',
    });
    expect(later.shouldEscalate).toBe(true);
  });

  it('replaying the same events twice changes nothing', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: rescueOperator.seatId }),
    ];

    const once = foldIncident(INCIDENT, events);
    const twice = foldIncident(INCIDENT, [...events, ...events]);

    expect(twice).toEqual(once);
    expect(twice.eventCount).toBe(3);
  });
});

describe('cross-department access is denied by default', () => {
  it('refuses a police seat writing a Rescue-owned field', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
      reason: 'looks worse to me',
    });
    expect(d.allowed).toBe(false);
  });

  it('refuses anyone overriding an append-only field, including the DC', () => {
    for (const seat of [controlRoom, dc, policeOperator]) {
      const d = evaluateWrite(actionsRule, {
        fieldKey: 'incident.actions',
        seat,
        reason: 'correcting the record',
        breakGlass: true,
      });
      expect(d.allowed).toBe(false);
    }
  });
});
