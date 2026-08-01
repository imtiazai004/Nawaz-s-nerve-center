import { describe, expect, it } from 'vitest';

import { defaultRules, evaluateWrite, resolveConflict } from '../authority.js';
import { foldIncident } from '../incident.js';
import {
  INCIDENT,
  RESCUE,
  controlRoom,
  dc,
  ev,
  policeOperator,
  rescueOperator,
  rescueSupervisor,
} from './fixtures.js';

const rules = defaultRules(RESCUE);
const severityRule = rules.find((r) => r.fieldKey === 'incident.severity')!;
const closureRule = rules.find((r) => r.fieldKey === 'incident.closure')!;

describe('evaluateWrite', () => {
  it('lets the owning department write its own field', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.severity', seat: rescueOperator });
    expect(d).toEqual({ allowed: true, as: 'owner' });
  });

  it('lets a district seat override, with a reason', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: controlRoom,
      reason: 'second reporter confirms casualties',
    });
    expect(d).toEqual({ allowed: true, as: 'override' });
  });

  it('refuses a district override without a reason', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.severity', seat: controlRoom });
    expect(d.allowed).toBe(false);
  });

  it('refuses a seat with no relationship to the field', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
      reason: 'anything',
    });
    expect(d.allowed).toBe(false);
  });

  it('refuses a rule that does not govern the attempted field', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.closure', seat: rescueOperator });
    expect(d.allowed).toBe(false);
  });

  describe('break-glass', () => {
    it('allows a DC-tier seat to act outside the table, with a reason', () => {
      const noAuthority = { ...closureRule, overrideTiers: [] as const };
      const d = evaluateWrite(noAuthority, {
        fieldKey: 'incident.closure',
        seat: dc,
        reason: 'department unreachable during shutdown; closing on radio confirmation',
        breakGlass: true,
      });
      expect(d).toEqual({ allowed: true, as: 'break_glass' });
    });

    it('is not available to a seat without the flag', () => {
      const noAuthority = { ...closureRule, overrideTiers: [] as const };
      const d = evaluateWrite(noAuthority, {
        fieldKey: 'incident.closure',
        seat: controlRoom,
        reason: 'urgent',
        breakGlass: true,
      });
      expect(d.allowed).toBe(false);
    });
  });

  it('generates a decision for every rule in the table', () => {
    // The policy table is data, so every row is exercised rather than hand-picked.
    for (const rule of rules) {
      const owner = evaluateWrite(rule, { fieldKey: rule.fieldKey, seat: rescueOperator });
      const outsider = evaluateWrite(rule, {
        fieldKey: rule.fieldKey,
        seat: policeOperator,
        reason: 'x',
      });
      expect(outsider.allowed).toBe(false);
      if (rule.ownerDepartmentId === RESCUE) expect(owner.allowed).toBe(true);
    }
  });
});

describe('resolveConflict', () => {
  it('higher authority wins over a later timestamp', () => {
    const r = resolveConflict(
      { seat: controlRoom, at: '2026-08-01T10:00:00.000Z' },
      { seat: rescueOperator, at: '2026-08-01T10:05:00.000Z' },
    );
    expect(r).toEqual({ winner: 'a', by: 'authority' });
  });

  it('falls back to time at equal authority', () => {
    const r = resolveConflict(
      { seat: rescueOperator, at: '2026-08-01T10:00:00.000Z' },
      { seat: policeOperator, at: '2026-08-01T10:05:00.000Z' },
    );
    expect(r).toEqual({ winner: 'b', by: 'time' });
  });
});

describe('override provenance (ADR-0003)', () => {
  const events = [
    ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'moderate' }),
    ev('triaged', { severity: 'high', category: 'rta' }, { actorSeatId: rescueOperator.seatId }),
    ev(
      'overridden',
      {
        field: 'severity',
        value: 'critical',
        reason: 'multiple casualties confirmed by second reporter',
      },
      { actorSeatId: controlRoom.seatId, actorPersonId: 'control-1' },
    ),
  ];

  it('the override wins the projection', () => {
    expect(foldIncident(INCIDENT, events).severity?.value).toBe('critical');
  });

  it("the department's own assessment survives underneath", () => {
    const from = foldIncident(INCIDENT, events).severity?.overriddenFrom;
    expect(from?.value).toBe('high');
    expect(from?.setBy.seatId).toBe(rescueOperator.seatId);
    expect(from?.reason).toBe('multiple casualties confirmed by second reporter');
    expect(from?.overriddenBy.seatId).toBe(controlRoom.seatId);
  });

  it('a later department reassessment does not silently undo the override', () => {
    const withReassess = [
      ...events,
      ev(
        'triaged',
        { severity: 'moderate', category: 'rta' },
        {
          actorSeatId: rescueSupervisor.seatId,
        },
      ),
    ];
    expect(foldIncident(INCIDENT, withReassess).severity?.value).toBe('critical');
  });
});
