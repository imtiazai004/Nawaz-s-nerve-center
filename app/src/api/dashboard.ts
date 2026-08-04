/**
 * The dashboard — M4.
 *
 * **One feed for one app.** The same endpoint answers a phone in a moving vehicle, a desk PC
 * in the AC Headquarter, and a large screen on an office wall. What differs between them is
 * the layout the browser chooses, and nothing else — no second page, no second codebase, and
 * no second set of numbers that can drift from the first.
 *
 * It is **scoped to whoever asked**. The two administrative offices get the district; a
 * department gets its own work. Both get the facts that belong to everybody — the weather,
 * the utilities, the published emergency numbers — because a department planning around a
 * power cut needs to know about the power cut.
 *
 * What it returns is a **summary**: counts, and panels that carry their own age. Rows live on
 * the board, where the authority model scopes them per incident. A dashboard that started
 * listing individual emergencies would be a second board, drifting from the first.
 *
 * One rule survives from the display design and is worth keeping: **a large screen in an
 * office is read by whoever is in the room.** So this response carries no reporter, no phone
 * number, no address and no coordinate, and `wallSafetyViolations` checks that on the way out
 * rather than trusting it. The check is cheap and the boundary is one careless join away.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { loadRecentIncidents } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { listDepartments } from '../db/configStore.js';
import {
  listFacts,
  listPresence,
  listUtilities,
  liveAlerts,
  type Presence,
  type Utility,
} from '../db/wallStore.js';
import { weatherPanel, type WeatherPanel } from '../ops/weather.js';
import { replicationHealthSafe } from '../ops/replication.js';
import { availabilityFor } from '../db/resourceStore.js';
import { summarise } from '../domain/resources.js';
import { computePerformance } from './performance.js';
import {
  age,
  presenceAge,
  presenceLabel,
  reportingGap,
  utilityLabel,
  wallSafetyViolations,
  type Aged,
  type PresenceStatus,
  type UtilityStatus,
} from '../domain/wall.js';

/** How long a presence report stays believable when it named no end of its own. */
const PRESENCE_STALE_MINUTES = 720;

export interface PanelRow {
  /**
   * No id.
   *
   * The dashboard shows aggregates; nothing on it is a thing to open. Sending a row id would
   * be sending a handle to something, which is the first step towards a screen that lets a
   * room click through to an emergency (ADR-0013 §1).
   */
  readonly name: string;
  readonly status: string | null;
  readonly label: string;
  readonly freshness: 'fresh' | 'stale' | 'never';
  readonly asOf: string | null;
  readonly ageMinutes: number | null;
  readonly note: string | null;
}

export interface Dashboard {
  readonly asOf: string;
  /** Whose dashboard this is — "District", or the department's own name. */
  readonly scope: string;
  readonly isAdministration: boolean;
  readonly district: {
    readonly openIncidents: number;
    readonly today: number;
    readonly unassigned: number;
    readonly overdueUnacknowledged: number;
    readonly unassessed: number;
    readonly oldestUnassignedMinutes: number | null;
  };
  readonly categories: readonly {
    readonly category: string;
    readonly label: string;
    readonly open: number;
  }[];
  /**
   * The district's own condition, in the three sentences its administration is answerable for.
   *
   * This is on a wall screen deliberately. Every one of these is a thing that fails silently
   * and stays failed for months because the only place it was visible was a console somebody
   * had to remember to open. On the wall, in the room where the two offices sit, it is read
   * by accident — which is the only reliable way any of it gets fixed (R-05, R-06, R-07).
   */
  readonly condition: readonly {
    readonly what: string;
    readonly state: 'ok' | 'pending' | 'critical';
    readonly detail: string;
  }[];
  readonly departments: readonly {
    readonly name: string;
    readonly open: number;
    readonly unacknowledged: number;
  }[];
  readonly utilities: readonly PanelRow[];
  /**
   * Markets, schools, the hospital, the roads.
   *
   * The same shape as a utility and reported the same way, because they *are* the same kind
   * of fact: a name, a state, a note and an age. One mechanism rather than four (migration
   * 0017).
   */
  readonly services: readonly PanelRow[];
  readonly presence: readonly PanelRow[];
  /**
   * How each kind of emergency stands right now — the prototype's "Emergency Situation".
   *
   * Derived from the log on every request; nothing is stored. A status word rather than a
   * count alone, because "Fire · 3 open, one unacknowledged" is read at a glance and "3" is
   * not.
   */
  readonly situation: readonly {
    readonly category: string;
    readonly label: string;
    readonly state: 'ok' | 'pending' | 'critical';
    readonly status: string;
    readonly open: number;
    readonly lastAt: string | null;
  }[];
  /** Tehsils, union councils, population, area. Null where the district has not said. */
  readonly facts: readonly { readonly label: string; readonly value: string | null }[];
  /**
   * What the district can send, and what is already out.
   *
   * The prototype had no panel for this because it had no fleet behind it. It belongs beside
   * the emergency counters for an obvious reason: "4 open" and "2 ambulances available" are
   * the same decision, and reading them on two different screens is how somebody sends a unit
   * that is already committed.
   */
  readonly resources: {
    readonly total: number;
    readonly available: number;
    readonly committed: number;
    readonly outOfService: number;
    /** Named so the panel can say whose fleet this is: a department's, or the district's. */
    readonly scope: string;
  };
  /**
   * How quickly emergencies are being taken up, over seven days.
   *
   * A median rather than a mean: one incident acknowledged four hours late drags a mean into
   * meaninglessness, and it is the typical case a duty roster is judged on.
   *
   * `null` where nothing has been acknowledged — never zero. Zero minutes is the best
   * possible performance and no data is not performance at all (ADR-0005).
   */
  readonly performance: readonly {
    readonly name: string;
    readonly open: number;
    readonly overdue: number;
    readonly medianAckMinutes: number | null;
  }[];
  /**
   * Emergencies where somebody was supposed to be told and demonstrably was not.
   *
   * INV-03 on the home screen. It is a count of **unmet obligations**, not of log lines, and
   * it is the one number here that means the system itself failed rather than the district.
   */
  readonly notificationsUnmet: number;
  /** Live advisories: VIP movement, road closures, weather warnings (two offices issue them). */
  readonly alerts: readonly {
    readonly tag: string;
    readonly message: string;
    readonly issuedAt: string;
    readonly untilAt: string;
  }[];
  readonly reporting: {
    readonly utilities: { total: number; answering: number; quiet: number };
    readonly services: { total: number; answering: number; quiet: number };
    readonly presence: { total: number; answering: number; quiet: number };
  };
  readonly weather: WeatherPanel;
  readonly contacts: readonly { readonly title: string; readonly number: string }[];
}

function hhmm(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/**
 * The words on the report form, so the wall says the same thing the handset does.
 *
 * Resolved here rather than in the browser because the district may add a category the
 * display has never heard of, and a screen that renders the raw code for that one is a screen
 * reading "rta" next to "Fire". Anything unmapped falls back to the code itself, capitalised.
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  rta: 'Road accident',
  fire: 'Fire',
  medical: 'Medical',
  flood: 'Flood',
  security: 'Security',
  other: 'Other',
};

function categoryLabel(code: string): string {
  return CATEGORY_LABELS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

function panelRow(
  name: string,
  reading: Aged<UtilityStatus | PresenceStatus>,
  label: string,
  note: string | null,
): PanelRow {
  return {
    name,
    // A stale value is not sent as a status. The screen would render it, somebody would style
    // it green, and the label saying "no report since 02:00" would be the small text under a
    // large green word. Withholding it here makes that mistake impossible downstream.
    status: reading.freshness === 'fresh' ? (reading.value as string) : null,
    label,
    freshness: reading.freshness,
    asOf: reading.asOf,
    ageMinutes: reading.ageMinutes,
    note: reading.freshness === 'fresh' ? note : null,
  };
}

function utilityRows(utilities: readonly Utility[], now: Date): PanelRow[] {
  return utilities.map((u) => {
    const reading = age(u.status, u.reportedAt, u.staleMinutes, now);

    return panelRow(u.name, reading, utilityLabel(reading, hhmm), u.note);
  });
}

function presenceRows(people: readonly Presence[], now: Date): PanelRow[] {
  return people.map((p) => {
    const reading = presenceAge(p.status, p.reportedAt, p.untilAt, PRESENCE_STALE_MINUTES, now);

    return panelRow(p.seatTitle, reading, presenceLabel(reading, hhmm), p.note);
  });
}

/**
 * Fold the district down to counts.
 *
 * Deliberately not `buildBoard`. That function takes a seat and evaluates read authority per
 * incident, which is exactly right for a person and meaningless for a television — there is
 * no seat to evaluate. Reaching for it would have meant inventing a seat for the wall to
 * borrow, which is the "sign the TV in as the DC" mistake ADR-0013 §2 rejects, arriving
 * through a side door.
 *
 * So this reads the same events and counts them, and never produces a row.
 */
async function districtSummary(
  pool: Pool,
  now: Date,
  onlyDepartmentId: string | null,
): Promise<{
  district: Dashboard['district'];
  notificationsUnmet: number;
  categories: Dashboard['categories'];
  situation: Dashboard['situation'];
  departments: Dashboard['departments'];
}> {
  const grouped = await loadRecentIncidents(pool, 7, 500);
  const directory = new Map((await listDepartments(pool)).map((d) => [d.departmentId, d.name]));

  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  let openIncidents = 0;
  let notificationsUnmet = 0;
  let today = 0;
  let unassigned = 0;
  let unassessed = 0;
  let overdueUnacknowledged = 0;
  let oldestUnassigned: number | null = null;

  const byCategory = new Map<
    string,
    { open: number; unacknowledged: number; unassigned: number; lastAt: string | null }
  >();
  const byDepartment = new Map<string, { open: number; unacknowledged: number }>();

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);

    /**
     * A department counts only what is its own.
     *
     * Including an unassigned emergency deliberately: it is nobody's, and a department that
     * cannot see the pile waiting to be assigned cannot offer to take one. The two offices
     * see everything, which is what `onlyDepartmentId === null` means.
     */
    if (
      onlyDepartmentId !== null &&
      state.responsibleDepartmentIds.length > 0 &&
      !state.responsibleDepartmentIds.includes(onlyDepartmentId)
    ) {
      continue;
    }

    const live = state.status !== 'resolved' && state.status !== 'closed';

    if (state.occurredAt !== null && new Date(state.occurredAt) >= midnight) today += 1;

    if (!live) continue;

    openIncidents += 1;

    // Nobody has assessed it. Counted separately and never folded into a severity, because
    // "we do not know yet" is not a level of seriousness (ADR-0009).
    if (state.severity === null) unassessed += 1;

    const category = state.category?.value ?? 'other';
    const bucket = byCategory.get(category) ?? {
      open: 0,
      unacknowledged: 0,
      unassigned: 0,
      lastAt: null as string | null,
    };
    bucket.open += 1;
    if (state.acknowledgedAt === null) bucket.unacknowledged += 1;
    if (state.responsibleDepartmentIds.length === 0) bucket.unassigned += 1;
    if (state.occurredAt !== null && (bucket.lastAt === null || state.occurredAt > bucket.lastAt)) {
      bucket.lastAt = state.occurredAt;
    }
    byCategory.set(category, bucket);

    if (state.responsibleDepartmentIds.length === 0) {
      unassigned += 1;

      if (state.occurredAt !== null) {
        const minutes = Math.max(
          0,
          Math.floor((now.getTime() - new Date(state.occurredAt).getTime()) / 60_000),
        );
        oldestUnassigned =
          oldestUnassigned === null ? minutes : Math.max(oldestUnassigned, minutes);
      }
    }

    if (state.acknowledgedAt === null) overdueUnacknowledged += 1;

    /**
     * Somebody was owed an alert and did not get one.
     *
     * A failed attempt, or one still pending with nobody having collected it. Counted per
     * incident rather than per attempt: three failed rungs against one duty officer is one
     * emergency nobody is coming to, not three problems (INV-03).
     */
    if (
      state.notifications.some((n) => n.state === 'failed') ||
      (state.notifications.length > 0 && state.notifications.every((n) => n.state === 'pending'))
    ) {
      notificationsUnmet += 1;
    }

    for (const id of state.responsibleDepartmentIds) {
      const name = directory.get(id) ?? 'unknown department';
      const row = byDepartment.get(name) ?? { open: 0, unacknowledged: 0 };
      row.open += 1;
      if (state.acknowledgedAt === null) row.unacknowledged += 1;
      byDepartment.set(name, row);
    }
  }

  return {
    district: {
      openIncidents,
      today,
      unassigned,
      overdueUnacknowledged,
      unassessed,
      oldestUnassignedMinutes: oldestUnassigned,
    },
    notificationsUnmet,
    categories: [...byCategory.entries()]
      .map(([category, b]) => ({ category, label: categoryLabel(category), open: b.open }))
      .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label)),
    situation: situationFrom(byCategory),
    departments: [...byDepartment.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)),
  };
}

/**
 * Turn the per-category counts into the sentence the prototype's cards carry.
 *
 * The wording is chosen so the three states are distinguishable **without the colour** — one
 * man in twelve cannot separate the red from the green, and this is read by whoever is on
 * duty (INV-04).
 *
 * "Normal" here means *no open emergencies of this kind*, not "nothing to worry about". The
 * district's categories are listed whether or not anything is open, so an empty board reads
 * as six calm cards rather than as a blank panel that might mean the page failed to load.
 */
const WATCHED: readonly string[] = ['fire', 'flood', 'rta', 'medical', 'security', 'other'];

function situationFrom(
  byCategory: ReadonlyMap<
    string,
    { open: number; unacknowledged: number; unassigned: number; lastAt: string | null }
  >,
): Dashboard['situation'] {
  const keys = [...new Set([...WATCHED, ...byCategory.keys()])];

  return keys
    .map((category) => {
      const b = byCategory.get(category) ?? {
        open: 0,
        unacknowledged: 0,
        unassigned: 0,
        lastAt: null,
      };

      // Ordered worst first: an unassigned emergency is with nobody at all, which outranks
      // one that is merely unacknowledged, which outranks one being worked.
      const [state, status]: ['ok' | 'pending' | 'critical', string] =
        b.unassigned > 0
          ? ['critical', 'With nobody']
          : b.unacknowledged > 0
            ? ['pending', 'Not acknowledged']
            : b.open > 0
              ? ['ok', 'Being handled']
              : ['ok', 'Normal'];

      return {
        category,
        label: categoryLabel(category),
        state,
        status,
        open: b.open,
        lastAt: b.lastAt,
      };
    })
    .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}

/**
 * The published emergency numbers.
 *
 * These are the ones printed on posters and answered by a control room — 1122, 15, 16. They
 * are on the wall because a wall is where they belong, and they are safe there for exactly
 * the reason the officers' mobiles are not: a district publishes them on purpose.
 *
 * Read from the departments that have a contact number, so the district edits them where it
 * edits everything else, and never from a list in this file.
 */
async function contacts(pool: Pool): Promise<Dashboard['contacts']> {
  const rows = await pool.query<{ name: string; contact_phone: string | null }>(
    `SELECT name, contact_phone
       FROM department
      WHERE retired_at IS NULL AND contact_phone IS NOT NULL AND contact_phone <> ''
      ORDER BY is_administration DESC, name
      LIMIT 8`,
  );

  return (
    rows.rows
      // A short published number is a public number. Anything longer is somebody's line, and
      // the safety check would refuse the whole response over it — correctly.
      .filter((r) => /^[0-9]{2,5}$/.test((r.contact_phone ?? '').trim()))
      .map((r) => ({ title: r.name, number: r.contact_phone!.trim() }))
  );
}

/**
 * Whether the district's own machinery is working.
 *
 * Three facts, each one a thing that fails quietly:
 *
 *   * **the record is being copied** — a backup that stopped running looks exactly like one
 *     that is running, right up until somebody needs it
 *   * **there is a second machine** — one server holds Bannu's entire emergency record
 *     (R-07), and nothing about a working system says so
 *   * **alerts can leave the building** — until the accounts exist, an alert reaches the app
 *     and nothing else, which an officer not looking at the app cannot know (R-05)
 *
 * All three are already computed elsewhere and already visible in a console. The point of
 * repeating them here is that a console is opened on purpose and a wall is read by accident.
 */
async function districtCondition(pool: Pool, now: Date): Promise<Dashboard['condition']> {
  const [backup, replication] = await Promise.all([
    pool
      .query<{ last: string | null }>(
        `SELECT max(finished_at) AS last FROM backup_run WHERE status = 'succeeded'`,
      )
      .then((r) => r.rows[0]?.last ?? null)
      .catch(() => null),
    replicationHealthSafe(pool),
  ]);

  const hours =
    backup === null ? null : Math.floor((now.getTime() - new Date(backup).getTime()) / 3_600_000);

  return [
    {
      what: 'Record backed up',
      state: hours === null ? 'critical' : hours > 36 ? 'critical' : hours > 24 ? 'pending' : 'ok',
      detail:
        hours === null
          ? 'never — no successful backup has been taken on this machine'
          : hours < 1
            ? 'within the last hour'
            : `${String(hours)} hours ago`,
    },
    {
      what: 'Second machine',
      state: replication.role === 'primary' && replication.ok ? 'ok' : 'critical',
      detail:
        replication.role === 'standalone'
          ? 'none — one machine holds the district’s whole record'
          : replication.role === 'primary'
            ? `${String(replication.connectedStandbys)} standby connected`
            : replication.role,
    },
  ];
}

export interface Viewer {
  /** What the heading says this dashboard is: "District" or the department's own name. */
  readonly scope: string;
  /**
   * Null means **the whole district**, and it is only ever reached by a district-tier seat.
   * It must never be reached by a caller who simply has no department, which is what a
   * person holding no post looks like — see `viewerFor`.
   */
  readonly departmentId: string | null;
  readonly isAdministration: boolean;
  /**
   * False only for a caller holding no post. Nothing may be built from such a viewer; it
   * exists so that a missing seat is a value this module can refuse rather than a null that
   * reads, one branch later, as "the district".
   */
  readonly seated: boolean;
}

/**
 * What the district can send.
 *
 * A department gets its own fleet. The two offices get the sum of every department's, which is
 * the only figure that answers "is there anything left in the district" — the question asked
 * at the moment a second emergency arrives.
 */
async function resourcePanel(pool: Pool, viewer: Viewer): Promise<Dashboard['resources']> {
  const departments =
    viewer.departmentId !== null
      ? [viewer.departmentId]
      : (await listDepartments(pool))
          .filter((d) => d.retiredAt === null)
          .map((d) => d.departmentId);

  let total = 0;
  let available = 0;
  let committed = 0;
  let outOfService = 0;

  for (const id of departments) {
    const summary = summarise(await availabilityFor(pool, id));
    total += summary.total;
    available += summary.available;
    committed += summary.committed;
    outOfService += summary.outOfService;
  }

  return { total, available, committed, outOfService, scope: viewer.scope };
}

/**
 * How quickly emergencies are being taken up.
 *
 * Reuses the console's own calculation rather than a second one — a dashboard that computed
 * its own median would eventually disagree with the performance table, in front of the
 * officer whose department it is about.
 */
async function performancePanel(pool: Pool, viewer: Viewer): Promise<Dashboard['performance']> {
  const report = await computePerformance(pool, { days: 7 });

  return (
    report.departments
      .filter((d) => !d.retired)
      .filter((d) => viewer.departmentId === null || d.departmentId === viewer.departmentId)
      // Whoever is furthest behind, first. A performance panel sorted alphabetically is one
      // where the department that needs attention is wherever the alphabet put it.
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open)
      .slice(0, 8)
      .map((d) => ({
        name: d.name,
        open: d.open,
        overdue: d.overdue,
        medianAckMinutes: d.medianAckMinutes,
      }))
  );
}

export async function buildDashboard(
  pool: Pool,
  viewer: Viewer,
  now = new Date(),
): Promise<Dashboard> {
  const [
    summary,
    utilities,
    presence,
    weather,
    published,
    facts,
    alerts,
    resources,
    performance,
    condition,
  ] = await Promise.all([
    districtSummary(pool, now, viewer.departmentId),
    listUtilities(pool),
    // A department sees where its own posts are; the offices see the administration's.
    listPresence(pool, viewer.departmentId),
    weatherPanel(pool, now),
    contacts(pool),
    listFacts(pool),
    liveAlerts(pool),
    resourcePanel(pool, viewer),
    performancePanel(pool, viewer),
    /**
     * Whether the record is backed up, whether there is a standby, whether alerts can leave
     * the building — the two offices only.
     *
     * Not secrecy: it is that these are **theirs to fix**. A department shown three red rows
     * it can do nothing about learns to ignore red rows, and that habit costs something the
     * day one of them is about its own work (ADR-0005).
     */
    viewer.isAdministration ? districtCondition(pool, now) : Promise.resolve([]),
  ]);

  // One table, two panels. The split is data, so the district can add a fifth kind of thing
  // to watch without a release (migration 0017).
  const utilityPanel = utilityRows(
    utilities.filter((u) => u.panel === 'utility'),
    now,
  );
  const servicePanel = utilityRows(
    utilities.filter((u) => u.panel === 'services'),
    now,
  );

  const gapOf = (rows: readonly PanelRow[]): { total: number; answering: number; quiet: number } =>
    reportingGap(
      rows.map((r) => ({
        value: r.status,
        freshness: r.freshness,
        asOf: r.asOf,
        ageMinutes: r.ageMinutes,
      })),
    );

  /**
   * Which posts appear.
   *
   * For a department: its own, all of them — that is its roster and it is short.
   *
   * For the two offices: the administration's seats — DC, ADCs, ACs, AACs — because those are
   * the officers somebody standing in the DC office is trying to find. Plus any other seat
   * that has actually reported, so a department publishing its duty officer's whereabouts is
   * not silently ignored.
   *
   * Capped at twelve for the district view. A panel listing all 83 posts is a panel nobody
   * reads, and the twelve that matter would be lost in it.
   */
  const presencePanel = viewer.isAdministration
    ? presenceRows(
        presence.filter((p) => p.isAdministration || p.departmentId === null || p.status !== null),
        now,
      ).slice(0, 12)
    : presenceRows(presence, now);

  return {
    asOf: now.toISOString(),
    scope: viewer.scope,
    isAdministration: viewer.isAdministration,
    ...summary,
    utilities: utilityPanel,
    services: servicePanel,
    presence: presencePanel,
    facts: facts.map((f) => ({ label: f.label, value: f.value })),
    alerts: alerts.map((a) => ({
      tag: a.tag,
      message: a.message,
      issuedAt: a.issuedAt,
      untilAt: a.untilAt,
    })),
    reporting: {
      utilities: gapOf(utilityPanel),
      services: gapOf(servicePanel),
      presence: gapOf(presencePanel),
    },
    weather,
    contacts: published,
    resources,
    performance,
    condition,
  };
}

export interface DashboardReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Who is asking, and therefore what this dashboard is about.
 *
 * The two administrative offices see the district. Everybody else sees their own department.
 * A **seat** holding no department at all — a control-room seat — sees the district too,
 * because that is what its work is; it simply has no departmental version to fall back to.
 *
 * **This used to key on `departmentId === null`, and that was a cross-department read leak.**
 * Two entirely different callers have a null department: a control-room seat, which should
 * see the district, and a person holding **no seat at all** — relieved of their post, or
 * granted a login and never given one — who should see nothing. The test that was supposed to
 * cover this hand-built its `Identity` and defaulted it to `seatId: null, departmentId: null,
 * tier: 'district'`, so it asserted the district view for precisely the shape that had to be
 * refused. Losing your post *widened* your view, which is the opposite of what re-resolving
 * the seat on every request is for.
 *
 * Two changes close it. Callers without a seat are refused before they reach here (see
 * `requireSeat` in `server.ts`), and the decision below keys on **tier**, which a database
 * trigger derives from the seat's office (migration 0010) and no caller can assert. Tier says
 * what the null department only implied.
 */
export function viewerFor(identity: Identity): Viewer {
  // Defence in depth. The router refuses these, and this is not the place to decide what a
  // caller with no post may see — it is the place to be sure we never guess "the district".
  if (identity.seatId === null || identity.tier === null) {
    return { scope: 'None', departmentId: null, isAdministration: false, seated: false };
  }

  if (identity.tier === 'district') {
    return {
      scope: 'District',
      departmentId: null,
      isAdministration: identity.isAdministration,
      seated: true,
    };
  }

  return {
    scope: identity.departmentName ?? 'My department',
    departmentId: identity.departmentId,
    isAdministration: false,
    seated: true,
  };
}

export async function handleDashboard(
  pool: Pool,
  req: IncomingMessage,
  identity: Identity,
): Promise<DashboardReply> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };

  const feed = await buildDashboard(pool, viewerFor(identity));

  const violations = wallSafetyViolations(feed);

  if (violations.length > 0) {
    /**
     * Refuse outright rather than strip the offending field.
     *
     * Stripping would let a change that started leaking private data ship and keep working,
     * minus one column, with nobody ever finding out. A dashboard that goes blank in the DC
     * office gets a phone call within the hour.
     *
     * The reason this check exists at all: this same response is what appears on a large
     * screen in an office, where it is read by whoever happens to be in the room.
     */
    return {
      status: 500,
      body: { error: 'refused: this response is not safe to display', violations },
    };
  }

  return { status: 200, body: feed };
}

export function writeDashboard(res: ServerResponse, reply: DashboardReply): void {
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}
