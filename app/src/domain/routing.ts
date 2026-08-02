/**
 * Which department answers for this emergency.
 *
 * ADR-0010: **routing is configuration, not inference.** The administration writes signals
 * against each department — "Rescue answers for fire", "Health answers for heatstroke" —
 * and this module matches an incident against them. Nothing here guesses, and nothing here
 * is clever. A routing rule that needs debugging is a routing rule that sends a fire to the
 * wrong department at 02:00.
 *
 * The two decisions worth arguing about are both about **refusing to guess**:
 *
 *   1. No match produces `unassigned`, not a best effort. It goes to both administrative
 *      dashboards for a human to assign (ADR-0005 — the absence is the signal).
 *   2. An **assumed** category never satisfies a category signal. Intake fills a missing
 *      category with `unknown` so it can never refuse a report (INV-01); treating that
 *      placeholder as a value an administrator can route on would turn "nobody told us"
 *      into "somebody said unknown". Same error ADR-0009 forbids for severity.
 */

import type { Uuid } from './events.js';
import { ASSUMED_CATEGORY } from './assumptions.js';

export type SignalKind = 'category' | 'keyword';

export interface RoutingSignal {
  readonly signalId: Uuid;
  readonly departmentId: Uuid;
  readonly kind: SignalKind;
  /** Stored normalised. `normalise` is applied again here so a hand-written row still works. */
  readonly pattern: string;
}

export interface RoutableIncident {
  readonly category: string;
  readonly description?: string | undefined;
}

export interface SignalMatch {
  readonly signalId: Uuid;
  readonly departmentId: Uuid;
  readonly kind: SignalKind;
  readonly pattern: string;
  /** Where it matched — shown to the administrator so a wrong route is explainable. */
  readonly matchedOn: 'category' | 'description';
}

export interface RoutingDecision {
  /** Departments to route to, deduplicated, in a stable order. Empty when unassigned. */
  readonly departmentIds: readonly Uuid[];
  readonly matches: readonly SignalMatch[];
  /** True when no signal matched. The incident needs a human, and says so. */
  readonly unassigned: boolean;
  /** Plain language, for the audit trail and for the administrator's screen. */
  readonly reason: string;
}

/**
 * Lowercase, trim, collapse runs of whitespace.
 *
 * Applied to both the pattern and the text, so matching never depends on how carefully
 * somebody typed into a form at speed.
 */
export function normalise(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Split into comparable tokens.
 *
 * Anything that is not a letter or a digit is a separator, which keeps punctuation from
 * hiding a word: `fire,` and `(fire)` both tokenise to `fire`. Unicode-aware, because
 * reports arrive in Urdu and Pashto as often as in English.
 */
export function tokenise(text: string): readonly string[] {
  return normalise(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Does the pattern occur in the text as a whole word, or as a contiguous phrase?
 *
 * Whole words rather than substrings, and the reason is false positives that matter: `gas`
 * inside `gasht`, `fire` inside `misfire`. A substring match is silently wrong, and silently
 * wrong routing is the failure this whole project exists to prevent.
 *
 * Multi-word patterns match as a phrase, so `road accident` requires those two words next to
 * each other rather than anywhere in the report.
 */
export function containsPhrase(text: string, pattern: string): boolean {
  const needle = tokenise(pattern);
  if (needle.length === 0) return false;

  const hay = tokenise(text);
  const first = needle[0]!;

  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (hay[i] !== first) continue;
    let all = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Match an incident against the district's live routing signals.
 *
 * Multiple departments matching is **correct, not a conflict**. A bazaar fire wants Rescue
 * and Police both; picking one would be the system overruling a decision the administration
 * already made twice.
 */
export function route(
  incident: RoutableIncident,
  signals: readonly RoutingSignal[],
): RoutingDecision {
  const category = normalise(incident.category);
  const categoryIsAssumed = category === ASSUMED_CATEGORY;
  const description = incident.description ?? '';

  const matches: SignalMatch[] = [];

  for (const signal of signals) {
    const pattern = normalise(signal.pattern);
    if (pattern === '') continue;

    if (signal.kind === 'category') {
      // See the header: a placeholder is not an assessment, so it cannot be routed on.
      if (!categoryIsAssumed && category === pattern) {
        matches.push({ ...signal, pattern, matchedOn: 'category' });
      }
      continue;
    }

    // A keyword may match the stated category or the reporter's own words. The description
    // is real content even when the category is a placeholder, so it is searched either way
    // — this is what keeps a hurried report routable at all.
    if (!categoryIsAssumed && containsPhrase(category, pattern)) {
      matches.push({ ...signal, pattern, matchedOn: 'category' });
    } else if (description !== '' && containsPhrase(description, pattern)) {
      matches.push({ ...signal, pattern, matchedOn: 'description' });
    }
  }

  if (matches.length === 0) {
    return {
      departmentIds: [],
      matches: [],
      unassigned: true,
      reason: categoryIsAssumed
        ? 'no category was given and no keyword matched the report text'
        : `no routing signal matches category "${category}"`,
    };
  }

  // Deduplicated, first-match order. Stable output matters: this string ends up in an
  // event payload, and an audit trail that reorders itself between reads is not one.
  const departmentIds: Uuid[] = [];
  for (const m of matches) {
    if (!departmentIds.includes(m.departmentId)) departmentIds.push(m.departmentId);
  }

  return {
    departmentIds,
    matches,
    unassigned: false,
    reason: `matched ${String(matches.length)} signal${matches.length === 1 ? '' : 's'}: ${matches
      .map((m) => `${m.kind} "${m.pattern}" on ${m.matchedOn}`)
      .join(', ')}`,
  };
}
