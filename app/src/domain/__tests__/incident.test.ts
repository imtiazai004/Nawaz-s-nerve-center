import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { IncidentEvent } from '../events.js';

import { foldIncident, districtSeverity } from '../incident.js';
import { INCIDENT, RESCUE, POLICE, controlRoom, ev, shuffle } from './fixtures.js';

describe('foldIncident', () => {
  it('derives status and values from the event log alone', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('triaged', { severity: 'high', category: 'rta' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }),
      ev('action_logged', { note: 'ambulance dispatched' }),
      ev('resolved', { outcome: 'casualties shifted to DHQ' }),
      ev('closed', { notes: 'road cleared' }),
    ];

    const state = foldIncident(INCIDENT, events);

    expect(state.status).toBe('closed');
    expect(state.severity?.value).toBe('high');
    expect(state.responsibleDepartmentIds).toEqual([RESCUE]);
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.actions).toHaveLength(1);
    expect(state.resolution).toBe('casualties shifted to DHQ');
    expect(state.eventCount).toBe(7);
  });

  it('is deterministic regardless of the order events arrive in', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'moderate' }),
      ev('triaged', { severity: 'high', category: 'rta' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }),
      ev('resolved', { outcome: 'done' }),
    ];

    const inOrder = foldIncident(INCIDENT, events);
    for (const seed of [1, 7, 42, 99]) {
      expect(foldIncident(INCIDENT, shuffle(events, seed))).toEqual(inOrder);
    }
  });

  it('ignores events belonging to another incident', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'low' }),
      ev('closed', { notes: 'not ours' }, { incidentId: 'inc-9999' }),
    ];

    expect(foldIncident(INCIDENT, events).status).toBe('reported');
  });

  describe('point-in-time replay', () => {
    const events = [
      ev(
        'reported',
        { reportId: 'rep-1', category: 'rta', severity: 'high' },
        {
          occurredAt: '2026-08-01T14:02:00.000Z',
          recordedAt: '2026-08-01T16:40:00.000Z',
        },
      ),
      ev(
        'acknowledged',
        { seatId: 'seat-rescue-duty' },
        {
          occurredAt: '2026-08-01T16:45:00.000Z',
          recordedAt: '2026-08-01T16:45:00.000Z',
        },
      ),
    ];

    it('knownAt answers "what did the control room see then"', () => {
      // At 15:00 the report had happened but had not yet synced.
      const seen = foldIncident(INCIDENT, events, { knownAt: '2026-08-01T15:00:00.000Z' });
      expect(seen.eventCount).toBe(0);
    });

    it('happenedBy answers "what was actually true then"', () => {
      const truth = foldIncident(INCIDENT, events, { happenedBy: '2026-08-01T15:00:00.000Z' });
      expect(truth.eventCount).toBe(1);
      expect(truth.status).toBe('reported');
    });
  });
});

describe('district aggregation', () => {
  it('never lets a calm average hide an open critical (INV-04)', () => {
    const routine = Array.from({ length: 20 }, (_, i) =>
      foldIncident(`inc-r${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'x', severity: 'low' },
          {
            incidentId: `inc-r${i}`,
          },
        ),
      ]),
    );

    const critical = foldIncident('inc-crit', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'inc-crit',
        },
      ),
    ]);

    expect(districtSeverity([...routine, critical])).toEqual({ worst: 'critical', unassessed: 0 });
  });

  it('excludes closed incidents from the district picture', () => {
    const closed = foldIncident('inc-c', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'inc-c',
        },
      ),
      ev('closed', { notes: 'handled' }, { incidentId: 'inc-c' }),
    ]);

    const open = foldIncident('inc-o', [
      ev('reported', { reportId: 'ro', category: 'x', severity: 'low' }, { incidentId: 'inc-o' }),
    ]);

    expect(districtSeverity([closed, open])).toEqual({ worst: 'low', unassessed: 0 });
  });

  describe('unassessed reports (ADR-0009)', () => {
    const unassessed = (id: string): ReturnType<typeof foldIncident> =>
      foldIncident(id, [
        ev(
          'reported',
          { reportId: `r-${id}`, category: 'unknown', severity: 'unknown' },
          { incidentId: id },
        ),
      ]);

    it('counts an unassessed incident instead of ranking it', () => {
      const low = foldIncident('inc-low', [
        ev(
          'reported',
          { reportId: 'rl', category: 'x', severity: 'low' },
          { incidentId: 'inc-low' },
        ),
      ]);

      expect(districtSeverity([low, unassessed('u1'), unassessed('u2')])).toEqual({
        worst: 'low',
        unassessed: 2,
      });
    });

    it('never lets an unassessed report masquerade as a level', () => {
      // Both available lies, refused. Counting it as `low` hides an emergency nobody has
      // looked at; counting it as `critical` drowns the ones somebody has.
      const summary = districtSeverity([unassessed('u1')]);
      expect(summary.worst).toBeNull();
      expect(summary.unassessed).toBe(1);
    });

    it('reports both numbers when the district has criticals and unassessed at once', () => {
      const critical = foldIncident('inc-crit', [
        ev(
          'reported',
          { reportId: 'rc', category: 'flood', severity: 'critical' },
          { incidentId: 'inc-crit' },
        ),
      ]);

      expect(districtSeverity([critical, unassessed('u1')])).toEqual({
        worst: 'critical',
        unassessed: 1,
      });
    });
  });
});

describe('reassignment', () => {
  it('moves responsibility without duplicating the incident', () => {
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev(
        'reassigned',
        {
          fromDepartmentIds: [RESCUE],
          toDepartmentIds: [POLICE],
          reason: 'law and order, not medical',
        },
        { actorSeatId: controlRoom.seatId },
      ),
    ]);

    expect(state.responsibleDepartmentIds).toEqual([POLICE]);
    expect(state.incidentId).toBe(INCIDENT);
  });

  /**
   * The incident's start comes from the report, and from nothing else.
   *
   * M1-04 let an action state when it actually happened — a crew writes up an hour of work at
   * once, and "on scene" belongs at the time they arrived. The fold used to take the earliest
   * `occurredAt` of **any** event, so a backdated action moved the incident's start and every
   * SLA deadline measured from it: an incident could become overdue, or stop being overdue,
   * because somebody wrote their notes up honestly.
   *
   * Found by the M1 gate, in the post-incident report's own timings.
   */
  describe('when the emergency happened', () => {
    const incidentId = 'inc-backdated';
    const reportedAt = '2026-08-03T10:00:00.000Z';

    function event(over: Record<string, unknown>): IncidentEvent {
      return {
        eventId: randomUUID(),
        incidentId,
        recordedAt: '2026-08-03T10:30:00.000Z',
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        ...over,
      } as unknown as IncidentEvent;
    }

    it('is the report time, not the earliest event', () => {
      const state = foldIncident(incidentId, [
        event({
          type: 'reported',
          occurredAt: reportedAt,
          clientSeq: 1,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        }),
        event({
          // Backdated an hour before the report, which is unusual and legitimate: a crew can
          // be on scene before anybody thinks to report it.
          type: 'action_logged',
          occurredAt: '2026-08-03T09:00:00.000Z',
          clientSeq: 2,
          payload: { note: 'on scene' },
        }),
      ]);

      expect(state.occurredAt).toBe(reportedAt);
    });

    it('is the earliest report when an incident has more than one', () => {
      // One incident, many reports (ADR-0006). The emergency started when the first person
      // said so, not when the second confirmed it.
      const state = foldIncident(incidentId, [
        event({
          type: 'reported',
          occurredAt: '2026-08-03T10:05:00.000Z',
          clientSeq: 2,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'high' },
        }),
        event({
          type: 'reported',
          occurredAt: reportedAt,
          clientSeq: 1,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        }),
      ]);

      expect(state.occurredAt).toBe(reportedAt);
    });

    it('is null when nothing has been reported yet', () => {
      // Rather than borrowing a time from some other event and presenting it as the moment
      // an emergency began.
      const state = foldIncident(incidentId, [
        event({ type: 'action_logged', occurredAt: reportedAt, payload: { note: 'orphan' } }),
      ]);

      expect(state.occurredAt).toBeNull();
    });
  });
});
