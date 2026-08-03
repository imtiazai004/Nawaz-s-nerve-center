/**
 * What a wall screen shows, and when it stops claiming to know — M4, ADR-0013.
 *
 * Pure logic, no database, no clock of its own. Everything here takes `now` as an argument
 * for the same reason the rest of the domain does: a rule about staleness that reads the
 * system clock cannot be tested at the boundary, and the boundary is the only interesting
 * part.
 *
 * The one idea worth holding on to: **a report has an age, and past a threshold it stops
 * being an answer.** The prototype this came from writes `Electricity (PESCO): Normal` in
 * the same typeface as a live incident count, and there is no way to tell that one was
 * counted a second ago and the other typed last Tuesday. On a screen people trust without
 * touching, that is the most expensive confusion in the system — a room full of officers
 * looking at a green dot from nine hours ago is worse off than a room with no screen, because
 * they would have picked up a phone.
 *
 * So nothing here returns a bare status. It returns a status **and** what is known about how
 * much that status is worth.
 */

/** How a utility is doing, as reported by whoever is answerable for it. */
export type UtilityStatus = 'normal' | 'degraded' | 'down';

/** Where an officer is. `field` and `leave` are different in kind, not in degree. */
export type PresenceStatus = 'office' | 'field' | 'leave';

/**
 * What the screen may say about a panel's value.
 *
 * `fresh` — reported recently enough to be worth acting on
 * `stale` — reported, but too long ago to assert; the screen shows *when*, not *what*
 * `never` — nobody has ever reported this
 *
 * `stale` and `never` are separate because they call for different actions. A stale reading
 * means somebody stopped updating; an absent one means nobody was ever asked to.
 */
export type Freshness = 'fresh' | 'stale' | 'never';

export interface Aged<T> {
  readonly value: T | null;
  readonly freshness: Freshness;
  /** When the value was last reported. `null` exactly when `freshness` is `never`. */
  readonly asOf: string | null;
  /** Whole minutes since `asOf`, floored. `null` when nothing has been reported. */
  readonly ageMinutes: number | null;
}

/**
 * Decide whether a report still speaks for the present.
 *
 * A future `reportedAt` is treated as age zero rather than as a negative age. It happens —
 * a handset with a wrong clock, a report backdated by a minute — and the alternative is a
 * panel that reads "updated -3 minutes ago", which looks like a bug and hides the value.
 */
export function age<T>(
  value: T | null,
  reportedAt: string | null,
  staleMinutes: number,
  now: Date,
): Aged<T> {
  if (value === null || reportedAt === null) {
    return { value: null, freshness: 'never', asOf: null, ageMinutes: null };
  }

  const then = new Date(reportedAt).getTime();

  if (Number.isNaN(then)) {
    return { value: null, freshness: 'never', asOf: null, ageMinutes: null };
  }

  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));

  return {
    // The value is still carried when stale. The screen chooses not to lead with it; a
    // caller asking "what was the last thing anybody said" deserves an answer either way.
    value,
    freshness: minutes > staleMinutes ? 'stale' : 'fresh',
    asOf: reportedAt,
    ageMinutes: minutes,
  };
}

/**
 * How a panel reads a stale value out loud.
 *
 * Deliberately not "Normal (stale)". A parenthetical after a word people already read is a
 * qualifier nobody sees at four metres. The stale form **does not contain the status at
 * all** — it is a different sentence, about time, and that is the point.
 */
export function utilityLabel(reading: Aged<UtilityStatus>, clock: (iso: string) => string): string {
  if (reading.freshness === 'never') return 'not reported';
  if (reading.freshness === 'stale') return `no report since ${clock(reading.asOf!)}`;

  return { normal: 'Normal', degraded: 'Degraded', down: 'Down' }[reading.value!];
}

export function presenceLabel(
  reading: Aged<PresenceStatus>,
  clock: (iso: string) => string,
): string {
  if (reading.freshness === 'never') return 'not reported';
  if (reading.freshness === 'stale') return `not reported since ${clock(reading.asOf!)}`;

  return { office: 'In office', field: 'In field', leave: 'On leave' }[reading.value!];
}

/**
 * A presence report can carry its own end, and the end wins.
 *
 * "In the field until 14:00" is a claim that expires at 14:00 whatever the district's general
 * staleness rule says. Without this, an officer who honestly said "back at two" reads as
 * present at six, and somebody gets sent to find him.
 */
export function presenceAge(
  status: PresenceStatus | null,
  reportedAt: string | null,
  untilAt: string | null,
  staleMinutes: number,
  now: Date,
): Aged<PresenceStatus> {
  const base = age(status, reportedAt, staleMinutes, now);

  if (base.freshness !== 'fresh' || untilAt === null) return base;

  const ends = new Date(untilAt).getTime();

  if (!Number.isNaN(ends) && now.getTime() > ends) {
    return { ...base, freshness: 'stale' };
  }

  return base;
}

/**
 * Whether the whole district is reporting at all.
 *
 * A wall screen full of "not reported" panels has failed, and it has failed quietly — every
 * individual panel is telling the truth. This counts the failure so the screen can say it
 * once, in a sentence, rather than leaving a person to notice that eleven small greyed boxes
 * add up to something.
 */
export function reportingGap(readings: readonly Aged<unknown>[]): {
  readonly total: number;
  readonly answering: number;
  readonly quiet: number;
} {
  const answering = readings.filter((r) => r.freshness === 'fresh').length;

  return { total: readings.length, answering, quiet: readings.length - answering };
}

/**
 * The privacy rule of ADR-0013 §1, as a function rather than as a paragraph in a document.
 *
 * A wall screen is read by whoever is in the room. This is the boundary that erodes: the
 * single most requested feature of a control-room display is the one it must not have, and
 * it will be requested by somebody senior, in a hurry, with a good reason. So the rule is
 * executable and a test walks the real response through it.
 *
 * It looks for the shapes that identify a person rather than for particular fields, because
 * a field-name allowlist protects only against the mistakes somebody already thought of.
 */
/**
 * A uuid, exactly.
 *
 * Checked *before* the shapes below, and it is not a nicety. A uuid is 32 hex characters, so
 * some of them contain a run that reads as a Pakistani number — `…-0207-00f846…` is one
 * digit away. This fired for real: the dashboard started returning 500 for every caller
 * because one seeded utility happened to draw an unlucky id, and the error blamed a phone
 * number that was not there.
 *
 * Skipping them is safe in the direction that matters: a uuid identifies a row, not a person,
 * and nothing in this system encodes a number as one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN: readonly { readonly what: string; readonly re: RegExp }[] = [
  // Pakistani mobile and landline forms, with or without separators or country code.
  { what: 'a phone number', re: /(\+?92|0)\s?\d{2,4}[\s-]?\d{6,8}/ },
  // Bare coordinates. Two signed decimals with three or more places, next to each other.
  { what: 'a coordinate', re: /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/ },
];

/** Field names that carry a private value even when its shape is innocent. */
const FORBIDDEN_KEYS: readonly string[] = [
  'phone',
  'contactPhone',
  'reporterName',
  'reporterPhone',
  'fullName',
  'personId',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'address',
  'description',
];

/**
 * Returns the reasons a payload may not go on a wall, or an empty array.
 *
 * Empty means it passed. It never throws: the caller decides whether a violation is a refused
 * response or a failed test, and both are wanted in different places.
 */
export function wallSafetyViolations(payload: unknown): string[] {
  const found: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      if (UUID.test(node)) return;

      for (const rule of FORBIDDEN) {
        if (rule.re.test(node)) found.push(`${path} looks like ${rule.what}`);
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`);
      });
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(key)) {
          found.push(`${path}.${key} is not permitted on a wall screen`);
          continue;
        }
        walk(value, `${path}.${key}`);
      }
    }
  };

  walk(payload, '$');

  return found;
}
