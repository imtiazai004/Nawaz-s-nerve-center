/**
 * The wall screen's rules about age and about privacy — M4, ADR-0013.
 *
 * Two things are being pinned here, and they are the two things that will be argued with.
 *
 * **A report expires.** Every panel on a control-room display looks equally authoritative,
 * so the only defence against a green dot from nine hours ago is that the code refuses to
 * call it green.
 *
 * **The screen carries nothing private.** This boundary erodes under pressure from somebody
 * senior with a good reason, which is why the rule is a function with a test rather than a
 * paragraph in a document.
 */

import { describe, expect, it } from 'vitest';
import {
  age,
  presenceAge,
  presenceLabel,
  reportingGap,
  utilityLabel,
  wallSafetyViolations,
  type PresenceStatus,
  type UtilityStatus,
} from '../wall.js';

const now = new Date('2026-08-03T12:00:00Z');
const clock = (iso: string): string => new Date(iso).toISOString().slice(11, 16);

describe('how old a report is', () => {
  it('calls a recent report fresh', () => {
    const r = age('normal', '2026-08-03T11:50:00Z', 240, now);

    expect(r.freshness).toBe('fresh');
    expect(r.ageMinutes).toBe(10);
    expect(r.value).toBe('normal');
  });

  it('calls an old report stale, and still carries what it said', () => {
    // The value survives. The *screen* chooses not to lead with it, but a caller asking
    // "what was the last thing anybody said about the gas" deserves an answer.
    const r = age('down', '2026-08-03T04:00:00Z', 240, now);

    expect(r.freshness).toBe('stale');
    expect(r.value).toBe('down');
    expect(r.ageMinutes).toBe(480);
  });

  it('separates never-reported from long-ago-reported', () => {
    // Different failures, different fixes. Stale means somebody stopped updating; never
    // means nobody was ever asked to.
    expect(age(null, null, 240, now).freshness).toBe('never');
    expect(age('normal', '2026-01-01T00:00:00Z', 240, now).freshness).toBe('stale');
  });

  it('is fresh exactly at the threshold and stale one minute past it', () => {
    expect(age('normal', '2026-08-03T08:00:00Z', 240, now).freshness).toBe('fresh');
    expect(age('normal', '2026-08-03T07:59:00Z', 240, now).freshness).toBe('stale');
  });

  it('treats a report from the future as age zero rather than negative', () => {
    // A handset with a wrong clock. "Updated -3 minutes ago" reads as a bug and hides the
    // value behind it.
    const r = age('normal', '2026-08-03T12:30:00Z', 240, now);

    expect(r.ageMinutes).toBe(0);
    expect(r.freshness).toBe('fresh');
  });

  it('treats an unparseable timestamp as nothing reported', () => {
    expect(age('normal', 'yesterday afternoon', 240, now).freshness).toBe('never');
  });
});

describe('what the screen says', () => {
  it('names the status when the report is fresh', () => {
    expect(utilityLabel(age('degraded', '2026-08-03T11:55:00Z', 240, now), clock)).toBe('Degraded');
    expect(presenceLabel(age('field', '2026-08-03T11:55:00Z', 240, now), clock)).toBe('In field');
  });

  it('does not contain the status at all once it is stale', () => {
    // Not "Normal (stale)". A parenthetical after a word somebody has already read is a
    // qualifier nobody sees at four metres. The stale form is a different sentence.
    const label = utilityLabel(age('normal', '2026-08-03T02:00:00Z', 240, now), clock);

    expect(label).not.toMatch(/normal/i);
    expect(label).toBe('no report since 02:00');
  });

  it('says so plainly when nobody has ever reported', () => {
    expect(utilityLabel(age<UtilityStatus>(null, null, 240, now), clock)).toBe('not reported');
    expect(presenceLabel(age<PresenceStatus>(null, null, 240, now), clock)).toBe('not reported');
  });
});

describe('a presence report can name its own end', () => {
  it('expires at the stated time even while the general rule would call it fresh', () => {
    // "In the field until 11:00" said at 10:30. Half an hour old, well inside any staleness
    // rule — and no longer true. Without this, somebody gets sent to find him.
    const r = presenceAge('field', '2026-08-03T10:30:00Z', '2026-08-03T11:00:00Z', 600, now);

    expect(r.freshness).toBe('stale');
  });

  it('holds until the stated time arrives', () => {
    const r = presenceAge('field', '2026-08-03T10:30:00Z', '2026-08-03T14:00:00Z', 600, now);

    expect(r.freshness).toBe('fresh');
    expect(r.value).toBe('field');
  });

  it('still applies the general rule when no end was given', () => {
    const r = presenceAge('office', '2026-08-01T09:00:00Z', null, 600, now);

    expect(r.freshness).toBe('stale');
  });

  it('ignores an unparseable end rather than expiring on it', () => {
    // Refusing to believe a good report because its optional field is malformed would be a
    // worse failure than ignoring the field.
    const r = presenceAge('office', '2026-08-03T11:50:00Z', 'tomorrow', 600, now);

    expect(r.freshness).toBe('fresh');
  });
});

describe('whether the district is reporting at all', () => {
  it('counts the panels that have gone quiet', () => {
    const gap = reportingGap([
      age('normal', '2026-08-03T11:50:00Z', 240, now),
      age('down', '2026-08-01T11:50:00Z', 240, now),
      age(null, null, 240, now),
    ]);

    expect(gap).toEqual({ total: 3, answering: 1, quiet: 2 });
  });

  it('says nothing is quiet when there is nothing to report', () => {
    expect(reportingGap([])).toEqual({ total: 0, answering: 0, quiet: 0 });
  });
});

describe('nothing private reaches the wall (ADR-0013 §1)', () => {
  it('passes a payload of aggregates', () => {
    expect(
      wallSafetyViolations({
        incidentsToday: 4,
        unassigned: 2,
        departments: [{ name: 'Rescue 1122', open: 3 }],
        utilities: [
          { name: 'Electricity (PESCO)', status: 'normal', asOf: '2026-08-03T11:50:00Z' },
        ],
      }),
    ).toEqual([]);
  });

  it('catches a phone number wherever it is nested', () => {
    const found = wallSafetyViolations({
      panels: [{ rows: [{ label: 'call 0333-1234567 for the DEO' }] }],
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a phone number');
  });

  it('catches a coordinate pair', () => {
    const found = wallSafetyViolations({ where: '32.98561, 70.60413' });

    expect(found[0]).toContain('a coordinate');
  });

  it('catches a forbidden field even when its value looks harmless', () => {
    // `description` is where the reporter's own words live. "fire at the shop" identifies
    // nobody until you know which shop, and the person reading the wall usually does.
    const found = wallSafetyViolations({ incident: { description: 'fire' } });

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('not permitted');
  });

  it('reports every violation, not the first', () => {
    // A caller fixing these one release at a time is a caller who ships three of them.
    const found = wallSafetyViolations({
      a: { phone: '1' },
      b: 'reach him on 0928-610001',
    });

    expect(found).toHaveLength(2);
  });

  it('is not confused by nulls, numbers or empty objects', () => {
    expect(wallSafetyViolations({ a: null, b: 4, c: {}, d: [], e: undefined })).toEqual([]);
  });

  it('does not flag an ordinary four-digit emergency number', () => {
    // 1122, 15 and 16 are published, national, and the entire point of the contacts panel.
    // A rule that caught them would be turned off by the first person it inconvenienced.
    expect(wallSafetyViolations({ contacts: ['1122', '15', '16'] })).toEqual([]);
  });
});

describe('a uuid is not a phone number', () => {
  it('does not flag an id, however unlucky its digits', () => {
    // This fired in production terms: the dashboard began returning 500 for every caller
    // because one seeded row drew an id containing a run that reads as a Pakistani number,
    // and the error named a phone number that was not there.
    const unlucky = [
      '0f8a1b2c-0207-4f84-9207-00f846478123',
      '92345678-1234-4321-8765-092345678901',
      'a02acee3-97a7-4658-a207-00f84647a54c',
    ];

    for (const id of unlucky) expect(wallSafetyViolations({ id })).toEqual([]);
  });

  it('still flags a real number that merely sits beside one', () => {
    // The exemption is for a string that *is* a uuid, not for anything containing one.
    const found = wallSafetyViolations({
      note: 'a02acee3-97a7-4658-a207-00f84647a54c — call 0333-1234567',
    });

    expect(found).toHaveLength(1);
  });
});
