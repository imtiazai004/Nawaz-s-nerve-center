/**
 * The wall screen's feed — M4-05, ADR-0013.
 *
 * One endpoint, `GET /wall`, read by a television and by nothing else. It returns the state
 * of the district as **numbers about groups**, never a fact about a person.
 *
 * The rule and the reason, because this file is where it will be argued with: a wall screen
 * is read by whoever is standing in the room. A visitor, a contractor, the person who cleans
 * it, anybody who walks past an open door. It is photographed. It cannot ask who is looking,
 * so it cannot be trusted with anything that would matter if the wrong person saw it.
 *
 * The single most requested feature of a control-room display — "just show me which one is
 * unassigned" — is the one it must not have. That request will come from somebody senior, in
 * a hurry, with a good reason. So the boundary is not a convention here: every response is
 * walked through `wallSafetyViolations` before it is sent, and a violation **fails the
 * request** rather than logging a warning. A screen that goes blank gets fixed. A screen that
 * quietly started printing phone numbers does not.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { loadRecentIncidents } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { listDepartments } from '../db/configStore.js';
import {
  listPresence,
  listUtilities,
  resolveWallToken,
  type Presence,
  type Utility,
} from '../db/wallStore.js';
import { weatherPanel, type WeatherPanel } from '../ops/weather.js';
import { replicationHealthSafe } from '../ops/replication.js';
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

export interface WallPanelRow {
  readonly id: string;
  readonly name: string;
  readonly status: string | null;
  readonly label: string;
  readonly freshness: 'fresh' | 'stale' | 'never';
  readonly asOf: string | null;
  readonly ageMinutes: number | null;
  readonly note: string | null;
}

export interface WallFeed {
  readonly asOf: string;
  readonly screen: string;
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
  readonly utilities: readonly WallPanelRow[];
  readonly presence: readonly WallPanelRow[];
  readonly reporting: {
    readonly utilities: { total: number; answering: number; quiet: number };
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
  id: string,
  name: string,
  reading: Aged<UtilityStatus | PresenceStatus>,
  label: string,
  note: string | null,
): WallPanelRow {
  return {
    id,
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

function utilityRows(utilities: readonly Utility[], now: Date): WallPanelRow[] {
  return utilities.map((u) => {
    const reading = age(u.status, u.reportedAt, u.staleMinutes, now);

    return panelRow(u.utilityId, u.name, reading, utilityLabel(reading, hhmm), u.note);
  });
}

function presenceRows(people: readonly Presence[], now: Date): WallPanelRow[] {
  return people.map((p) => {
    const reading = presenceAge(p.status, p.reportedAt, p.untilAt, PRESENCE_STALE_MINUTES, now);

    return panelRow(p.seatId, p.seatTitle, reading, presenceLabel(reading, hhmm), p.note);
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
): Promise<{
  district: WallFeed['district'];
  categories: WallFeed['categories'];
  departments: WallFeed['departments'];
}> {
  const grouped = await loadRecentIncidents(pool, 7, 500);
  const directory = new Map((await listDepartments(pool)).map((d) => [d.departmentId, d.name]));

  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  let openIncidents = 0;
  let today = 0;
  let unassigned = 0;
  let unassessed = 0;
  let overdueUnacknowledged = 0;
  let oldestUnassigned: number | null = null;

  const byCategory = new Map<string, number>();
  const byDepartment = new Map<string, { open: number; unacknowledged: number }>();

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    const live = state.status !== 'resolved' && state.status !== 'closed';

    if (state.occurredAt !== null && new Date(state.occurredAt) >= midnight) today += 1;

    if (!live) continue;

    openIncidents += 1;

    // Nobody has assessed it. Counted separately and never folded into a severity, because
    // "we do not know yet" is not a level of seriousness (ADR-0009).
    if (state.severity === null) unassessed += 1;

    const category = state.category?.value ?? 'other';
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);

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
    categories: [...byCategory.entries()]
      .map(([category, open]) => ({ category, label: categoryLabel(category), open }))
      .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label)),
    departments: [...byDepartment.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)),
  };
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
async function contacts(pool: Pool): Promise<WallFeed['contacts']> {
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
async function districtCondition(pool: Pool, now: Date): Promise<WallFeed['condition']> {
  const [backup, replication, ladder] = await Promise.all([
    pool
      .query<{ last: string | null }>(
        `SELECT max(finished_at) AS last FROM backup_run WHERE status = 'succeeded'`,
      )
      .then((r) => r.rows[0]?.last ?? null)
      .catch(() => null),
    replicationHealthSafe(pool),
    pool
      .query<{ n: string }>('SELECT count(*)::text AS n FROM channel_ladder')
      .then((r) => Number(r.rows[0]?.n ?? '0'))
      .catch(() => 0),
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
    {
      what: 'Alerts leave the building',
      // Rungs configured is the closest honest proxy: with none, every notification stops at
      // the in-app inbox. It does not prove a provider answers — only that one was chosen.
      state: ladder > 0 ? 'ok' : 'critical',
      detail:
        ladder > 0
          ? `${String(ladder)} channel${ladder === 1 ? '' : 's'} configured`
          : 'no — alerts reach the app and nothing else',
    },
  ];
}

export async function buildWallFeed(
  pool: Pool,
  screenLabel: string,
  now = new Date(),
): Promise<WallFeed> {
  const [summary, utilities, presence, weather, published, condition] = await Promise.all([
    districtSummary(pool, now),
    listUtilities(pool),
    listPresence(pool),
    weatherPanel(pool, now),
    contacts(pool),
    districtCondition(pool, now),
  ]);

  const utilityPanel = utilityRows(utilities, now);

  /**
   * Which posts appear on the wall.
   *
   * The administration's own seats — DC, ADCs, ACs, AACs — because those are the officers a
   * person standing in the DC office is trying to find. Plus any other seat that has actually
   * reported, so a department choosing to publish its duty officer's whereabouts is not
   * silently ignored.
   *
   * Capped at twelve. A screen listing all 83 posts is a screen nobody reads, and the twelve
   * that matter would be lost in it.
   */
  const presencePanel = presenceRows(
    presence.filter((p) => p.isAdministration || p.departmentId === null || p.status !== null),
    now,
  ).slice(0, 12);

  return {
    asOf: now.toISOString(),
    screen: screenLabel,
    ...summary,
    utilities: utilityPanel,
    presence: presencePanel,
    reporting: {
      utilities: reportingGap(
        utilityPanel.map((r) => ({
          value: r.status,
          freshness: r.freshness,
          asOf: r.asOf,
          ageMinutes: r.ageMinutes,
        })),
      ),
      presence: reportingGap(
        presencePanel.map((r) => ({
          value: r.status,
          freshness: r.freshness,
          asOf: r.asOf,
          ageMinutes: r.ageMinutes,
        })),
      ),
    },
    weather,
    contacts: published,
    condition,
  };
}

/** Thrown nowhere: violations are returned so the caller can refuse and log deliberately. */
export interface WallReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Serve the feed, or refuse it.
 *
 * A screen may present its token as `Authorization: Bearer …`, as `?token=…` in the URL, or
 * as the `dnc_wall` cookie. The query form exists because a television is configured by
 * typing one URL into a browser that will never be touched again, and requiring a header
 * would mean requiring a person to write JavaScript on a kiosk.
 */
export async function handleWall(
  pool: Pool,
  req: IncomingMessage,
  url: URL,
  identity: Identity | null,
): Promise<WallReply> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const cookie = /(?:^|;\s*)dnc_wall=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const token = bearer ?? url.searchParams.get('token') ?? cookie ?? null;

  let label: string | null = null;

  if (token !== null && token !== '') {
    const screen = await resolveWallToken(pool, decodeURIComponent(token));
    if (screen !== null) label = screen.label;
  }

  /**
   * A signed-in person may also open the wall view.
   *
   * Not a convenience: it is how the two offices check what their screens are showing without
   * walking to the room, and how a new screen is proved to work before its token is issued.
   * It grants nothing extra — the feed is the same aggregate either way.
   */
  if (label === null && identity !== null) label = 'preview';

  if (label === null) {
    return { status: 401, body: { error: 'this screen is not registered' } };
  }

  const feed = await buildWallFeed(pool, label);

  const violations = wallSafetyViolations(feed);

  if (violations.length > 0) {
    // Refusing outright rather than stripping the offending field. Stripping would let a
    // change that started leaking private data ship and keep working, minus one field, with
    // nobody ever finding out. A blank screen in the DC office gets a phone call within the
    // hour (ADR-0013 §1).
    return {
      status: 500,
      body: {
        error: 'refused: this response is not safe to show on a wall',
        violations,
      },
    };
  }

  return { status: 200, body: feed };
}

export function writeWall(res: ServerResponse, reply: WallReply): void {
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}
