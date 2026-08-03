/**
 * The department workspace — M1-01. The screen a duty officer lives in for a shift.
 *
 * Everything on it already existed as an endpoint. What did not exist was **one place that
 * answers "what needs me now"**, and the difference matters more than it sounds: an operator
 * with four tabs open is an operator who has to remember which tab the overdue thing was in.
 *
 * Three sections, in the order somebody under pressure needs them:
 *
 *   1. **Needs you now** — unacknowledged work and unseen messages, merged and ranked. Acting
 *      happens here, inline. Anything that requires leaving this list to do is a reason to
 *      not do it.
 *   2. **Live work** — what the department is already on, and what is committed to each one.
 *   3. **What you can send** — the fleet, with why anything unavailable is unavailable.
 *
 * Two rules the whole file follows.
 *
 * **The list is never empty when there is nothing wrong.** An empty "needs you now" says so
 * in words — *nothing is waiting* — because a blank area is indistinguishable from a screen
 * that failed to load, and the second one is how an operator concludes there is no emergency
 * when there is (ADR-0005, INV-02).
 *
 * **Every count is a link into the thing it counts.** A number an operator cannot act on is
 * a number they learn to scroll past.
 */

import { categoryWords, duration } from './words.js';
import { reachButton } from './contact.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface WorkspaceIdentity {
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly seatTitle: string | null;
}

interface BoardRow {
  incidentId: string;
  status: string;
  severity: string;
  assessed: boolean;
  category: string;
  responsibleDepartmentIds: string[];
  responsibleDepartments: string[];
  occurredAt: string | null;
  acknowledgedAt: string | null;
  overdue: boolean;
  overdueByMinutes: number;
  targetMinutes: number;
  unassigned: boolean;
  escalationCount: number;
  notificationsFailed: number;
  notificationsUndelivered: number;
}

interface Board {
  asOf: string;
  incidents: BoardRow[];
}

interface InboxItem {
  attemptId: string;
  incidentId: string;
  reason: string;
  attemptedAt: string;
  category: string;
  severity: string;
}

interface Unit {
  resource: {
    resourceId: string;
    kind: string;
    name: string;
    identifier: string | null;
    outOfServiceReason: string | null;
    members: { fullName: string }[];
  };
  blockedBy: string[];
  commitments: { incidentId: string; category: string; severity: string }[];
}

interface Fleet {
  departmentId: string;
  units: Unit[];
  summary: { total: number; available: number; committed: number; outOfService: number };
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function ago(iso: string | null, from: number): string {
  if (iso === null) return '—';
  const mins = Math.floor((from - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${String(hours)}h ${String(mins % 60)}m ago` : `${String(Math.floor(hours / 24))}d ago`;
}

export interface Workspace {
  show(identity: WorkspaceIdentity): Promise<void>;
  stop(): void;
}

export function mountWorkspace(onOpenIncident: (incidentId: string) => void): Workspace {
  const body = el('shiftBody');
  const error = el('shiftError');

  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let who: WorkspaceIdentity | null = null;

  function fail(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  async function api<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      // Left on screen deliberately: the shift view must never blank itself because one
      // refresh failed. What it must do is stop claiming to be current (INV-02).
      fail('Cannot reach the server. What is below is the last thing it said.');
      return null;
    }

    const raw = await res.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
    if (!res.ok) {
      fail((parsed as { error?: string }).error ?? `The server refused that (${String(res.status)}).`);
      return null;
    }
    error.hidden = true;
    return parsed as T;
  }

  function act(label: string, onClick: () => void, primary = false): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'act primary' : 'act';
    b.textContent = label;
    b.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return b;
  }

  /**
   * The incidents that are **this department's**.
   *
   * The board deliberately shows a department more than this: an unrouted emergency is
   * readable by any seat, because an emergency nobody is permitted to see is an emergency
   * nobody picks up (INV-01, `evaluateRead`). That is the right rule for the board and the
   * wrong one for this screen.
   *
   * "Needs you now" has to mean *you*. Since ADR-0010 there is somebody who owns an
   * unassigned emergency — the two administrative offices, loudly, on their own dashboards —
   * so showing every unrouted incident in Bannu here would bury a duty officer's own work
   * under the district's, and the first thing they would learn is to stop reading the list.
   */
  function ours(board: Board): BoardRow[] {
    const departmentId = who?.departmentId ?? null;
    if (departmentId === null) return [];
    return board.incidents.filter((r) => r.responsibleDepartmentIds.includes(departmentId));
  }

  //--------------------------------------------------------------------------
  // Needs you now
  //--------------------------------------------------------------------------

  /**
   * One ranked list, merged from two sources.
   *
   * An unacknowledged incident and an unread message about that same incident are the same
   * obligation seen from two directions, and showing them as two rows would have an operator
   * acknowledge the incident and then wonder what the message was.
   */
  function needsYouNow(board: Board, inbox: InboxItem[], fleet: Fleet | null, at: number): HTMLElement {
    const section = document.createElement('section');
    section.id = 'needsYou';

    const mine = ours(board).filter((r) => r.acknowledgedAt === null);
    const unreadFor = new Set(inbox.map((i) => i.incidentId));

    const rows = [...mine].sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      const inboxA = unreadFor.has(a.incidentId) ? 0 : 1;
      const inboxB = unreadFor.has(b.incidentId) ? 0 : 1;
      if (inboxA !== inboxB) return inboxA - inboxB;
      return (a.occurredAt ?? '') < (b.occurredAt ?? '') ? -1 : 1;
    });

    section.append(text('h3', 'sectionhead', 'Needs you now'));

    if (rows.length === 0) {
      // In words. A blank area is indistinguishable from a screen that failed to load, and
      // that is how somebody concludes there is no emergency when there is.
      section.append(
        text('p', 'quiet', 'Nothing is waiting for you. Everything current has been picked up.'),
      );
      return section;
    }

    for (const row of rows) {
      const card = document.createElement('article');
      card.className = 'work';
      card.dataset['incident'] = row.incidentId;
      card.dataset['overdue'] = String(row.overdue);
      card.tabIndex = 0;
      card.addEventListener('click', () => {
        onOpenIncident(row.incidentId);
      });

      const head = document.createElement('header');
      const sev = text('span', 'sev', row.assessed ? row.severity : 'unassessed');
      sev.dataset['level'] = row.severity;
      head.append(sev, text('span', 'cat', categoryWords(row.category)));
      if (row.overdue) {
        head.append(
          text('span', 'flag', `${duration(row.overdueByMinutes)} past a ${duration(row.targetMinutes)} deadline`),
        );
      }
      if (unreadFor.has(row.incidentId)) head.append(text('span', 'flag msg', 'message waiting'));
      card.append(head);

      card.append(text('p', 'meta', `reported ${ago(row.occurredAt, at)}`));

      const actions = document.createElement('div');
      actions.className = 'actions';

      actions.append(
        act(
          'Acknowledge',
          () => {
            void (async () => {
              const done = await api('POST', `/incidents/${row.incidentId}/acknowledge`, {});
              if (done !== null) await refresh();
            })();
          },
          true,
        ),
      );

      // Dispatch, inline. Sending something is the point of acknowledging, and making an
      // operator navigate away to do it is how a unit ends up not sent.
      if (fleet !== null) {
        const sendable = fleet.units.filter(
          (u) => !u.blockedBy.includes('retired') && !u.blockedBy.includes('out_of_service'),
        );
        if (sendable.length > 0) {
          const picker = document.createElement('select');
          picker.className = 'send';
          picker.setAttribute('aria-label', 'Send a unit');
          picker.append(new Option('Send…', ''));
          for (const u of sendable) {
            const committed = u.commitments.length > 0 ? ' (already out)' : '';
            picker.append(new Option(u.resource.name + committed, u.resource.resourceId));
          }
          picker.addEventListener('click', (e) => {
            e.stopPropagation();
          });
          picker.addEventListener('change', () => {
            if (picker.value === '') return;
            void (async () => {
              const sent = await api<{ warnings: string[] }>(
                'POST',
                `/incidents/${row.incidentId}/dispatch`,
                { resourceIds: [picker.value] },
              );
              // A warning is shown after the fact because the action succeeded — it is
              // information, not a refusal. See `domain/resources.ts`.
              if (sent !== null && sent.warnings.length > 0) fail(sent.warnings.join(' '));
              if (sent !== null) await refresh();
            })();
          });
          actions.append(picker);
        }
      }

      card.append(actions);
      section.append(card);
    }

    return section;
  }

  //--------------------------------------------------------------------------
  // Live work
  //--------------------------------------------------------------------------

  function liveWork(board: Board, fleet: Fleet | null, at: number): HTMLElement {
    const section = document.createElement('section');
    section.id = 'liveWork';
    section.append(text('h3', 'sectionhead', 'In hand'));

    const rows = ours(board).filter((r) => r.acknowledgedAt !== null);
    if (rows.length === 0) {
      section.append(text('p', 'quiet', 'Nothing in hand.'));
      return section;
    }

    // Which units are on which incident, so a row can say "Ambulance 3 is there" without a
    // second request per incident.
    const onIncident: Record<string, string[]> = {};
    for (const u of fleet?.units ?? []) {
      for (const c of u.commitments) (onIncident[c.incidentId] ??= []).push(u.resource.name);
    }

    for (const row of rows) {
      const card = document.createElement('article');
      card.className = 'work';
      card.dataset['incident'] = row.incidentId;
      card.tabIndex = 0;
      card.addEventListener('click', () => {
        onOpenIncident(row.incidentId);
      });

      const head = document.createElement('header');
      const sev = text('span', 'sev', row.assessed ? row.severity : 'unassessed');
      sev.dataset['level'] = row.severity;
      head.append(sev, text('span', 'cat', categoryWords(row.category)), text('span', 'state', row.status));

      /**
       * The numbers for everybody else who holds this.
       *
       * On live work rather than on "needs you now": the officer who has already taken an
       * emergency is the one who needs to ring the other department about it. Their own
       * department is excluded — they do not need a button to reach themselves.
       */
      for (const [i, id] of row.responsibleDepartmentIds.entries()) {
        if (id === who?.departmentId) continue;
        head.append(reachButton(id, `Reach ${row.responsibleDepartments[i] ?? 'them'}`));
      }

      card.append(head);

      const sent = onIncident[row.incidentId] ?? [];
      card.append(
        text(
          'p',
          'meta',
          sent.length === 0
            ? `acknowledged ${ago(row.acknowledgedAt, at)} · nothing sent yet`
            : `acknowledged ${ago(row.acknowledgedAt, at)} · ${sent.join(', ')}`,
        ),
      );

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        act('Log what happened', () => {
          const note = prompt('What was done?');
          if (note === null || note.trim() === '') return;
          void (async () => {
            const done = await api('POST', `/incidents/${row.incidentId}/actions`, { note });
            if (done !== null) await refresh();
          })();
        }),
        act('Resolve', () => {
          const outcome = prompt('What was the outcome?');
          if (outcome === null || outcome.trim() === '') return;
          void (async () => {
            const done = await api('POST', `/incidents/${row.incidentId}/resolve`, { outcome });
            if (done !== null) await refresh();
          })();
        }),
      );
      card.append(actions);
      section.append(card);
    }

    return section;
  }

  //--------------------------------------------------------------------------
  // What you can send
  //--------------------------------------------------------------------------

  function whatYouCanSend(fleet: Fleet): HTMLElement {
    const section = document.createElement('section');
    section.id = 'canSend';
    section.append(text('h3', 'sectionhead', 'What you can send'));

    if (fleet.units.length === 0) {
      // A department with nothing to send is not a tidy empty state. It is the reason a
      // dispatch will not happen tonight.
      section.append(
        text('p', 'quiet warn', 'No vehicles, teams or equipment are recorded for this department.'),
      );
      return section;
    }

    const tallies = document.createElement('div');
    tallies.className = 'tallies';
    const tally = (kind: string, label: string, value: number): HTMLElement => {
      const node = document.createElement('span');
      node.className = 'tally';
      node.dataset['kind'] = kind;
      node.append(text('b', '', String(value)), document.createTextNode(label));
      return node;
    };
    tallies.append(
      tally('available', 'ready', fleet.summary.available),
      tally('committed', 'out', fleet.summary.committed),
      tally('outofservice', 'off the run', fleet.summary.outOfService),
    );
    section.append(tallies);

    for (const u of fleet.units) {
      if (u.blockedBy.includes('retired')) continue;

      const row = document.createElement('div');
      row.className = 'unit';
      row.dataset['unit'] = u.resource.resourceId;
      row.dataset['state'] = u.blockedBy.includes('out_of_service')
        ? 'off'
        : u.commitments.length > 0
          ? 'out'
          : 'ready';

      row.append(text('span', 'uname', u.resource.name));
      if (u.resource.identifier !== null) {
        row.append(text('span', 'uid', u.resource.identifier));
      }

      // Why, in words, every time. "Unavailable" sends an operator to find out; the reason
      // lets them decide what to send instead.
      if (u.blockedBy.includes('out_of_service')) {
        row.append(
          text('span', 'why', `off the run — ${u.resource.outOfServiceReason ?? 'no reason given'}`),
        );
      } else if (u.commitments.length > 0) {
        row.append(
          text('span', 'why', `out at ${u.commitments.map((c) => c.category).join(', ')}`),
        );
      } else {
        row.append(text('span', 'ready', 'ready'));
      }

      if (u.resource.kind === 'team' && u.resource.members.length > 0) {
        row.append(text('span', 'crewlist', u.resource.members.map((m) => m.fullName).join(', ')));
      }

      section.append(row);
    }

    return section;
  }

  //--------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    generation += 1;
    const mine = generation;

    const [board, inboxReply, fleet] = await Promise.all([
      api<Board>('GET', '/incidents'),
      api<{ notifications: InboxItem[] }>('GET', '/notifications'),
      // A department-agnostic seat has no fleet of its own, and a 404 here is an expected
      // answer rather than a failure — so it is asked for and allowed to come back empty.
      api<Fleet>('GET', '/fleet'),
    ]);

    if (mine !== generation) return;
    if (board === null) return;

    const at = Date.parse(board.asOf);
    const inbox = inboxReply?.notifications ?? [];

    const wrap = document.createElement('div');
    wrap.id = 'shift';

    const stale = Date.now() - at > 30_000;
    const asOf = text(
      'p',
      'asof',
      stale
        ? `NOT LIVE — last reached the server ${ago(board.asOf, Date.now())}`
        : `Live as of ${new Date(at).toLocaleTimeString()}`,
    );
    asOf.dataset['stale'] = String(stale);
    wrap.append(asOf);

    wrap.append(needsYouNow(board, inbox, fleet, at));
    wrap.append(liveWork(board, fleet, at));
    if (fleet !== null) wrap.append(whatYouCanSend(fleet));

    body.replaceChildren(wrap);
  }

  return {
    async show(identity: WorkspaceIdentity): Promise<void> {
      who = identity;
      el('shiftWho').textContent =
        identity.departmentName === null
          ? (identity.seatTitle ?? 'your shift')
          : `${identity.departmentName} — ${identity.seatTitle ?? 'duty'}`;

      await refresh();

      if (timer !== null) clearInterval(timer);
      // Polled, like the board. M0 has no realtime transport, and a shift screen that
      // silently stops updating is exactly what the staleness line above is there to expose.
      timer = setInterval(() => void refresh(), 10_000);
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
