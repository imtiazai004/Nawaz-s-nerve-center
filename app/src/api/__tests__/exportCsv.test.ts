/**
 * The spreadsheet export — capability group 9.
 *
 * Three properties, and only one of them is about CSV formatting.
 *
 * **It carries no citizen contact detail** (capability 12), and that is asserted against the
 * real column list rather than trusted, so that adding a reporter's number to the board
 * cannot quietly add it to a file departments email around.
 *
 * **It cannot be turned into a payload.** Every text field in here originates as something
 * somebody typed into the administration console, and a spreadsheet executes a leading `=`.
 *
 * **It never truncates quietly.** A short file is worse than no file, because nobody counts
 * rows before submitting a report upward.
 */

import { describe, expect, it } from 'vitest';
import { buildExport, COLUMNS, EXPORT_LIMIT, toCsv } from '../exportCsv.js';
import type { Board, BoardRow } from '../board.js';

function boardRow(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    incidentId: '11111111-1111-1111-1111-111111111111',
    status: 'reported',
    severity: 'critical',
    assessed: true,
    overriddenFrom: null,
    category: 'road accident',
    responsibleDepartmentIds: ['22222222-2222-2222-2222-222222222222'],
    responsibleDepartments: ['Rescue 1122'],
    occurredAt: '2026-08-04T09:00:00.000Z',
    lastRecordedAt: '2026-08-04T09:05:00.000Z',
    acknowledgedAt: null,
    escalationCount: 0,
    overdue: false,
    overdueByMinutes: 0,
    notificationsFailed: 0,
    notificationsUndelivered: 0,
    unassigned: false,
    targetMinutes: 15,
    ...overrides,
  } as BoardRow;
}

function board(rows: readonly BoardRow[]): Board {
  return { asOf: '2026-08-04T10:00:00.000Z', summary: {}, incidents: rows } as unknown as Board;
}

describe('the incident export', () => {
  describe('what it must never contain', () => {
    /**
     * Capability 12: citizen contact details are excluded from general exports.
     *
     * Pinned against the column list itself. The export is built from `BoardRow`, which has
     * never held a reporter's name, number or location — so this passes today by construction.
     * It is here for the day somebody adds one of those to the board for a good reason and
     * does not think about the file that departments email to each other.
     */
    it('has no column for a reporter, a number, or a location', () => {
      const forbidden = ['phone', 'reporter', 'caller', 'name', 'contact', 'lat', 'lon', 'place'];

      // Matched on whole name parts, not as substrings — `escalations` contains "lat", and a
      // check that fires on that is a check somebody deletes rather than fixes. Same reason
      // routing signals match on whole words (M1a-01).
      for (const column of COLUMNS) {
        for (const part of column.split('_')) {
          expect(forbidden).not.toContain(part);
        }
      }
    });

    it('would catch a reporter column if one were ever added', () => {
      // The guard above only means something if it fails on the thing it is guarding against.
      const forbidden = ['phone', 'reporter', 'caller', 'name', 'contact', 'lat', 'lon', 'place'];
      const hypothetical = 'reporter_phone';

      expect(hypothetical.split('_').some((part) => forbidden.includes(part))).toBe(true);
    });

    it('carries no coordinate or phone number in a rendered file', () => {
      const csv = toCsv([boardRow()]);

      expect(csv).not.toMatch(/\+92|03\d{9}/);
      expect(csv).not.toMatch(/\b\d{2}\.\d{4,}\b/);
    });
  });

  describe('what a spreadsheet does with it', () => {
    /**
     * A department named `=HYPERLINK("http://…","click")` is a live formula in whatever
     * office opens the file. The district's own data, turned into a payload, delivered by
     * the export that exists to be trusted.
     */
    it('neutralises a field that would otherwise be a formula', () => {
      const csv = toCsv([
        boardRow({ responsibleDepartments: ['=HYPERLINK("http://evil","payroll")'] }),
      ]);

      expect(csv).toContain(`"'=HYPERLINK`);
      expect(csv).not.toContain('"=HYPERLINK');
    });

    it.each(['=cmd', '+1', '-1', '@SUM(A1)'])('neutralises a leading %s', (value) => {
      expect(toCsv([boardRow({ category: value })])).toContain(`"'${value}"`);
    });

    it('leaves ordinary text alone', () => {
      expect(toCsv([boardRow({ category: 'road accident' })])).toContain('"road accident"');
    });

    it('escapes a quote by doubling it, not by stripping it', () => {
      const csv = toCsv([boardRow({ responsibleDepartments: ['The "old" office'] })]);

      expect(csv).toContain('"The ""old"" office"');
    });

    it('starts with a byte order mark so Excel reads Urdu correctly', () => {
      // Without one, Excel reads UTF-8 as the local codepage and every non-Latin department
      // name arrives as mojibake — useless for the district this is built for.
      expect(toCsv([])).toMatch(/^\uFEFF/);
    });
  });

  describe('what it says about severity', () => {
    it('writes the word unassessed rather than a severity nobody chose', () => {
      // ADR-0009, and a spreadsheet has no colour to lean on — which is the case that rule
      // was always really about.
      const csv = toCsv([boardRow({ assessed: false, severity: 'unknown' })]);

      expect(csv).toContain('"unassessed"');
    });
  });

  describe('when there is too much', () => {
    it('refuses rather than handing back a file that quietly left emergencies out', () => {
      const reply = buildExport(board([]), 30, true);

      expect(reply.status).toBe(413);
      expect(reply.error).toMatch(/shorter period/);
      expect(reply.body).toBe('');
    });

    it('exports normally when the cap was not reached', () => {
      const reply = buildExport(board([boardRow()]), 30, false);

      expect(reply.status).toBe(200);
      expect(reply.contentType).toMatch(/text\/csv/);
      expect(reply.filename).toBe('incidents-2026-08-04-last-30-days.csv');
    });

    it('has a cap high enough to be a real answer for a district', () => {
      // Bannu is 79 offices. A cap so low that an ordinary month refuses would teach
      // everybody to export in fragments and stitch them together by hand.
      expect(EXPORT_LIMIT).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('the shape of the file', () => {
    it('writes a header row and one line per incident', () => {
      const csv = toCsv([boardRow(), boardRow()]);
      const lines = csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(COLUMNS.join(','));
    });

    it('joins several responsible departments rather than dropping any', () => {
      // Several departments answering one emergency is the correct answer (ADR-0010).
      const csv = toCsv([boardRow({ responsibleDepartments: ['Rescue 1122', 'Police'] })]);

      expect(csv).toContain('"Rescue 1122; Police"');
    });
  });
});
