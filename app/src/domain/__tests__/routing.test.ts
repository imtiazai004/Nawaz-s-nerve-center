/**
 * Routing is the decision that sends help to the wrong place, so the tests here are mostly
 * about what it **refuses** to do.
 *
 * Pure functions, no database. The wiring is tested against a real Postgres in
 * `api/__tests__/admin.test.ts`; this file is about the rules themselves.
 */

import { describe, expect, it } from 'vitest';

import { containsPhrase, normalise, route, tokenise, type RoutingSignal } from '../routing.js';
import { ASSUMED_CATEGORY } from '../assumptions.js';

const RESCUE = '11111111-1111-4111-8111-111111111111';
const POLICE = '22222222-2222-4222-8222-222222222222';
const HEALTH = '33333333-3333-4333-8333-333333333333';

let n = 0;
function signal(
  departmentId: string,
  kind: 'category' | 'keyword',
  pattern: string,
): RoutingSignal {
  n += 1;
  return { signalId: `sig-${String(n)}`, departmentId, kind, pattern };
}

describe('normalise', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalise('  Bazaar   FIRE  ')).toBe('bazaar fire');
  });

  it('leaves non-Latin text alone apart from spacing', () => {
    expect(normalise('  آگ   ')).toBe('آگ');
  });
});

describe('tokenise', () => {
  it('treats punctuation as a separator, so a comma cannot hide a word', () => {
    expect(tokenise('fire, in the bazaar (urgent)')).toEqual([
      'fire',
      'in',
      'the',
      'bazaar',
      'urgent',
    ]);
  });

  it('keeps digits, which appear in real reports', () => {
    expect(tokenise('road 26 accident')).toEqual(['road', '26', 'accident']);
  });

  it('handles Urdu script, because reports arrive in it', () => {
    expect(tokenise('بازار میں آگ')).toEqual(['بازار', 'میں', 'آگ']);
  });
});

describe('containsPhrase', () => {
  it('matches a whole word', () => {
    expect(containsPhrase('fire in the bazaar', 'fire')).toBe(true);
  });

  /**
   * The reason keyword matching is not a substring search. `gas` inside `gasht` and `fire`
   * inside `misfire` are the false positives that route an emergency to a department which
   * has nothing to do with it — and they do it silently.
   */
  it('does not match a word fragment', () => {
    expect(containsPhrase('a misfire was reported', 'fire')).toBe(false);
    expect(containsPhrase('night gasht patrol', 'gas')).toBe(false);
  });

  it('matches a multi-word pattern only when the words are adjacent', () => {
    expect(containsPhrase('a road accident on the bypass', 'road accident')).toBe(true);
    expect(containsPhrase('accident on the ring road', 'road accident')).toBe(false);
  });

  it('is case and spacing insensitive on both sides', () => {
    expect(containsPhrase('ROAD   ACCIDENT', '  road accident ')).toBe(true);
  });

  it('an empty pattern matches nothing rather than everything', () => {
    expect(containsPhrase('anything at all', '   ')).toBe(false);
  });
});

describe('route', () => {
  it('routes on an exact category signal', () => {
    const decision = route({ category: 'fire' }, [signal(RESCUE, 'category', 'fire')]);

    expect(decision.unassigned).toBe(false);
    expect(decision.departmentIds).toEqual([RESCUE]);
    expect(decision.matches[0]?.matchedOn).toBe('category');
  });

  it('routes on a keyword found in the description', () => {
    const decision = route({ category: 'other', description: 'bazaar mein aag lagi hai' }, [
      signal(RESCUE, 'keyword', 'aag'),
    ]);

    expect(decision.departmentIds).toEqual([RESCUE]);
    expect(decision.matches[0]?.matchedOn).toBe('description');
  });

  /**
   * Two departments matching is the correct answer, not a conflict to be resolved. A bazaar
   * fire wants Rescue and Police; picking one would be the system overruling a decision the
   * administration already made twice.
   */
  it('routes to every department whose signal matches', () => {
    const decision = route({ category: 'fire', description: 'crowd is blocking the road' }, [
      signal(RESCUE, 'category', 'fire'),
      signal(POLICE, 'keyword', 'crowd'),
      signal(HEALTH, 'category', 'heatstroke'),
    ]);

    expect(decision.departmentIds).toEqual([RESCUE, POLICE]);
    expect(decision.departmentIds).not.toContain(HEALTH);
  });

  it('lists a department once even when several of its signals match', () => {
    const decision = route({ category: 'fire', description: 'fire and smoke' }, [
      signal(RESCUE, 'category', 'fire'),
      signal(RESCUE, 'keyword', 'smoke'),
    ]);

    expect(decision.departmentIds).toEqual([RESCUE]);
    expect(decision.matches).toHaveLength(2);
  });

  it('reports unassigned when nothing matches, and names the category', () => {
    const decision = route({ category: 'canal breach' }, [signal(RESCUE, 'category', 'fire')]);

    expect(decision.unassigned).toBe(true);
    expect(decision.departmentIds).toEqual([]);
    expect(decision.reason).toContain('canal breach');
  });

  it('reports unassigned with no signals configured at all', () => {
    expect(route({ category: 'fire' }, []).unassigned).toBe(true);
  });

  /**
   * The rule this module exists to enforce, and the one most likely to be "simplified" away.
   *
   * Intake fills a missing category with `unknown` so it can never refuse a report (INV-01).
   * If a category signal could match that placeholder, an administrator typing `unknown`
   * into a form would silently capture every hurried report in the district — and the
   * record would read as though somebody had categorised them. Same error ADR-0009 forbids
   * for severity, one field over.
   */
  it('never satisfies a category signal with an assumed category', () => {
    const decision = route({ category: ASSUMED_CATEGORY }, [
      signal(RESCUE, 'category', ASSUMED_CATEGORY),
    ]);

    expect(decision.unassigned).toBe(true);
    expect(decision.reason).toContain('no category was given');
  });

  it('never satisfies a keyword signal against an assumed category either', () => {
    const decision = route({ category: ASSUMED_CATEGORY }, [
      signal(RESCUE, 'keyword', ASSUMED_CATEGORY),
    ]);

    expect(decision.unassigned).toBe(true);
  });

  /**
   * The other half of that rule. A report with no category still has the reporter's own
   * words, and those are real content — this is what keeps a report typed in a hurry
   * routable at all, rather than sending every one of them to the unassigned queue.
   */
  it('still routes an uncategorised report on its description', () => {
    const decision = route({ category: ASSUMED_CATEGORY, description: 'fire at the bus stand' }, [
      signal(RESCUE, 'keyword', 'fire'),
    ]);

    expect(decision.unassigned).toBe(false);
    expect(decision.departmentIds).toEqual([RESCUE]);
    expect(decision.matches[0]?.matchedOn).toBe('description');
  });

  it('ignores a blank pattern rather than matching everything with it', () => {
    const decision = route({ category: 'fire' }, [signal(RESCUE, 'keyword', '   ')]);
    expect(decision.unassigned).toBe(true);
  });

  it('gives a reason an administrator can act on', () => {
    const decision = route({ category: 'fire' }, [signal(RESCUE, 'category', 'fire')]);
    expect(decision.reason).toBe('matched 1 signal: category "fire" on category');
  });

  it('matches regardless of how the category was capitalised or spaced', () => {
    const decision = route({ category: '  Road   Accident ' }, [
      signal(POLICE, 'category', 'road accident'),
    ]);
    expect(decision.departmentIds).toEqual([POLICE]);
  });

  /**
   * The audit trail ends up holding `reason` and `departmentIds`. A decision that reorders
   * itself between two reads of the same data is not a record.
   */
  it('is deterministic in the order it reports departments', () => {
    const signals = [
      signal(POLICE, 'keyword', 'crowd'),
      signal(RESCUE, 'category', 'fire'),
      signal(HEALTH, 'keyword', 'injured'),
    ];
    const incident = { category: 'fire', description: 'crowd gathering, two injured' };

    expect(route(incident, signals).departmentIds).toEqual([POLICE, RESCUE, HEALTH]);
    expect(route(incident, signals).departmentIds).toEqual([POLICE, RESCUE, HEALTH]);
  });
});
