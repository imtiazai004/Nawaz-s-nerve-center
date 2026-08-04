/**
 * App shell boot: sign-in, rapid intake, outbox queue.
 *
 * Four behaviours here are load-bearing and must survive into anything that replaces this:
 *
 *   1. The connectivity rung is always stated, never implied — and "signed out" is a
 *      distinct state from "no signal", because they need different actions from the user.
 *   2. A queued entry never renders as delivered. "Saved" and "sent" are different words
 *      and the difference can matter to someone's life.
 *   3. An emergency can be recorded whether or not anyone is signed in (see the submit
 *      handler).
 *   4. **Submit first, enrich after.** The critical path is two taps and a button, with no
 *      typing and nothing blocking on the network or on GPS. Detail is offered only once
 *      the report is already safe. This is what makes the fifteen-second budget reachable,
 *      and the budget is a requirement — if this is slower than the phone call it replaces,
 *      the district keeps using the phone.
 */

import { Outbox } from '../../src/outbox/outbox.js';
import { IndexedDbOutboxStore, requestPersistence } from '../../src/outbox/adapters/indexeddb.js';
import { HttpTransport } from '../../src/outbox/adapters/httpTransport.js';
import type { IncidentEvent } from '../../src/domain/events.js';
import { buildCapture, describeFix, startLocationWatch, type Fix } from './location.js';
// Types only — erased at build time, so naming them here does not pull the office screens
// into the shell. The values arrive from `/office.js` when somebody opens one.
import type { AdminConsole } from './admin.js';
import type { RosterHost, RosterPanel } from './roster.js';
import type { StatusPanel } from './status.js';
import { mountWorkspace, type Workspace } from './workspace.js';
import { createDashboard, startClock } from './dashboard.js';
import { ago, incidentRow } from './incidentRow.js';
import { reachButton } from './contact.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Mirrors `Identity` in `src/auth/sessions.ts`, which is what `/auth/me` returns.
 *
 * It used to declare three of these fields, and the board read `departmentId` off it anyway
 * — `undefined === null` is false, so the district control room was labelled "your
 * department" and nobody noticed. That compiled because `web/` was not in the tsconfig at
 * all. It is now; see the note there.
 */
interface Identity {
  personId: string;
  fullName: string;
  seatId: string | null;
  seatTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  /**
   * The DC Office and the AC Headquarter Bannu Office (ADR-0010).
   *
   * Decides whether the Administration tab is offered. It decides nothing else: every
   * `/admin` request is checked server-side against the caller's department, so this is a
   * courtesy to the operator and not a control (INV-05).
   */
  isAdministration: boolean;
}

function deviceId(): string {
  const KEY = 'dnc-device-id';
  let id = localStorage.getItem(KEY);
  if (id === null) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

function checkedValue(name: string): string | null {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return input?.value ?? null;
}

async function boot(): Promise<void> {
  // Ask the browser not to evict an unreported emergency under storage pressure. Best
  // effort — it may refuse, and the app works either way.
  void requestPersistence();

  const store = await IndexedDbOutboxStore.open();
  const outbox = new Outbox({
    store,
    transport: new HttpTransport({ baseUrl: location.origin, deviceId: deviceId() }),
  });

  const status = el('status');
  const entries = el('entries');
  const count = el('count');
  const reportForm = el<HTMLFormElement>('report');
  const submit = el<HTMLButtonElement>('submit');
  const where = el('where');
  const sent = el('sent');
  const sentDetail = el('sentDetail');
  const loginForm = el<HTMLFormElement>('login');
  const loginView = el('loginView');
  const loginError = el('loginError');
  const offlineLoginNote = el('offlineLoginNote');
  const who = el('who');
  const whoName = el('whoName');

  type Reachability = 'unknown' | 'reachable' | 'unreachable' | 'refused';
  let reachability: Reachability = 'unknown';
  let identity: Identity | null = null;
  let fix: Fix | null = null;
  /** The incident just reported, so enrichment can be attached to it. */
  let lastIncidentId: string | null = null;

  /**
   * Connectivity is derived from whether we actually reached the server — never from
   * `navigator.onLine`, which reports whether the browser has *an interface*, not whether
   * anything gets through. A handset on a tower with dead backhaul reports `true` while
   * nothing reaches the control room. The negative is still trustworthy, so `false` is
   * believed and `true` is not.
   */
  function paintStatus(): void {
    const state =
      reachability === 'refused'
        ? 'signedout'
        : navigator.onLine === false || reachability === 'unreachable'
          ? 'offline'
          : reachability === 'reachable'
            ? 'online'
            : 'unknown';

    status.dataset['state'] = state;
    status.textContent =
      state === 'online'
        ? 'Connected. Reports are delivered immediately.'
        : state === 'offline'
          ? 'No connection. Reports are saved on this device and sent automatically when signal returns.'
          : state === 'signedout'
            ? 'Signed out. Reports are saved on this device and sent once you sign in.'
            : 'Checking connection. Reports are saved on this device either way.';
  }

  function paintIdentity(): void {
    const signedIn = identity !== null;
    loginView.hidden = signedIn;
    who.hidden = !signedIn;
    if (identity !== null) {
      // Holding no seat means signed in with no authority to act (ADR-0004). Saying so is
      // the difference between understanding why a report will not send and assuming the
      // system is broken.
      whoName.textContent =
        identity.seatId === null
          ? `${identity.fullName} — no current duty assignment`
          : identity.fullName;
    }
    // The board and the inbox both need a seat to scope them, so they are offered only once
    // signed in. Intake never is — an emergency can be captured signed out (INV-01).
    nav.hidden = !signedIn;
    // Offered only to the two offices that are the authority for the whole district
    // (ADR-0010). The server does the actual refusing.
    navAdmin.hidden = !signedIn || identity?.isAdministration !== true;
    // Offered to a seat that belongs to a department. A district-wide seat with no
    // department of its own — the control room, the DC — has no "my department" to show, and
    // the two offices reach every roster through the console instead.
    navMine.hidden = !signedIn || identity?.departmentId === null;
    // The shift screen is for somebody who holds a post. A seat with no department has no
    // fleet and no departmental queue, so the board is already their whole view.
    navShift.hidden = !signedIn || identity?.departmentId === null;
    // Everybody signed in gets a dashboard. What it *contains* is scoped by the server.
    navDashboard.hidden = !signedIn;
    // Everybody signed in may state something. What, exactly, is decided server-side.
    navStatus.hidden = !signedIn;

    if (!signedIn) {
      if (
        boardView.hidden === false ||
        inboxView.hidden === false ||
        adminView.hidden === false ||
        mineView.hidden === false ||
        shiftView.hidden === false ||
        dashboardView.hidden === false ||
        statusView.hidden === false
      ) {
        showView('report');
      }
      paintInboxCount(0);
    } else {
      void refreshInboxCount();
    }

    const unreachable = reachability === 'unreachable' || navigator.onLine === false;
    offlineLoginNote.hidden = signedIn || !unreachable;
    el<HTMLButtonElement>('loginSubmit').disabled = unreachable;
  }

  async function paintQueue(): Promise<void> {
    const all = await store.all();
    count.textContent = `(${all.length})`;
    entries.innerHTML = '';

    for (const entry of all) {
      const payload = entry.event.payload as { category?: string; severity?: string };
      const row = document.createElement('div');
      row.className = 'entry';

      const label = document.createElement('span');
      label.textContent = `${payload.severity ?? 'unknown'} · ${payload.category ?? 'unknown'}`;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset['s'] = entry.state;
      // Never "sent", never a tick. Only what is actually true.
      badge.textContent = entry.state === 'blocked' ? 'needs attention' : 'saved on this device';

      row.append(label, badge);
      entries.append(row);
    }
  }

  async function trySync(): Promise<void> {
    const result = await outbox.sync();
    reachability = result.authRequired ? 'refused' : result.offline ? 'unreachable' : 'reachable';
    if (result.authRequired && identity !== null) identity = null;

    paintIdentity();
    paintStatus();
    await paintQueue();
  }

  async function loadIdentity(): Promise<void> {
    try {
      const res = await fetch('/auth/me');
      identity = res.ok ? ((await res.json()) as { identity: Identity }).identity : null;
      if (!res.ok && (res.status === 401 || res.status === 403)) reachability = 'refused';
    } catch {
      identity = null;
      reachability = 'unreachable';
    }
    paintIdentity();
    paintStatus();
  }

  // ---------------------------------------------------------------- location

  // Started immediately, and never waited on. Whatever has arrived by submit time is what
  // gets attached; a report with no coordinates is still a report.
  startLocationWatch((next, error) => {
    if (next !== null) fix = next;
    where.textContent = error ?? describeFix(fix);
  });

  // ---------------------------------------------------------------- intake

  function refreshSubmit(): void {
    // Category is the only thing that must be chosen. Severity is pre-set to High, so the
    // fastest valid report is one tap and the button.
    submit.disabled = checkedValue('category') === null;
  }

  reportForm.addEventListener('change', refreshSubmit);
  refreshSubmit();

  /**
   * Reporting is available whether or not anyone is signed in.
   *
   * The one place the app is deliberately more permissive than the server. A duty officer
   * whose session expired overnight, on a handset with no signal, *cannot* sign in — and
   * refusing them would lose the emergency outright (INV-01). Nothing is weakened: the
   * server still requires a session to accept anything, so the report waits in the outbox.
   * The trade is attribution to whoever delivered it rather than whoever typed it, which
   * is the honest available answer.
   */
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const category = checkedValue('category');
    if (category === null) return;

    const incidentId = crypto.randomUUID();
    const draft = {
      eventId: crypto.randomUUID(),
      incidentId,
      type: 'reported',
      occurredAt: new Date().toISOString(),
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'mobile',
      payload: {
        reportId: crypto.randomUUID(),
        category,
        severity: checkedValue('severity') ?? 'high',
        location: buildCapture(fix, ''),
      },
    } as unknown as Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>;

    // Durable first, always. Nothing here waits on the network.
    await outbox.enqueue(draft);
    lastIncidentId = incidentId;

    // The operator's job is done at this point. Everything below is optional.
    sent.hidden = false;
    sentDetail.textContent =
      fix === null
        ? 'Saved. Add the place below if you can — it will be sent with the report.'
        : 'Saved with your location. Add anything else below if you can.';
    submit.disabled = true;

    await paintQueue();
    void trySync();
  });

  /**
   * Enrichment: a second event against the same incident.
   *
   * Appended rather than edited, because the log is the record (ADR-0001). What the
   * reporter first said and what they added afterwards are both part of the history.
   */
  el('addDetail').addEventListener('click', async () => {
    if (lastIncidentId === null) return;

    const place = el<HTMLInputElement>('place').value;
    const detail = el<HTMLTextAreaElement>('detail').value;
    if (place.trim().length === 0 && detail.trim().length === 0) return;

    await outbox.enqueue({
      eventId: crypto.randomUUID(),
      incidentId: lastIncidentId,
      type: 'action_logged',
      occurredAt: new Date().toISOString(),
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'mobile',
      payload: {
        note: detail.trim().length > 0 ? detail.trim() : 'Location detail added',
        location: buildCapture(fix, place),
      },
    } as unknown as Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>);

    sentDetail.textContent = 'Details saved and will be sent with the report.';
    el<HTMLInputElement>('place').value = '';
    el<HTMLTextAreaElement>('detail').value = '';

    await paintQueue();
    void trySync();
  });

  el('newReport').addEventListener('click', () => {
    reportForm.reset();
    sent.hidden = true;
    lastIncidentId = null;
    el<HTMLInputElement>('place').value = '';
    el<HTMLTextAreaElement>('detail').value = '';
    refreshSubmit();
    where.textContent = describeFix(fix);
  });

  // ---------------------------------------------------------------- board (M0-33)

  const nav = el('nav');
  const navReport = el<HTMLButtonElement>('navReport');
  const navBoard = el<HTMLButtonElement>('navBoard');
  const navSearch = el<HTMLButtonElement>('navSearch');
  const reportView = el('reportView');
  const boardView = el('boardView');
  const boardAsOfText = el('boardAsOfText');
  const boardScope = el('boardScope');
  const boardSummary = el('boardSummary');
  const boardRows = el('boardRows');
  const boardEmpty = el('boardEmpty');
  const boardAsOf = el('boardAsOf');
  const boardUnassigned = el('boardUnassigned');

  // The administration console (M1a). Mounted for everyone and shown to nobody until the
  // identity says so — building it lazily would mean the tab appearing a beat after the
  // rest of the app, on the screen whose whole job is to be trusted.
  const navAdmin = el<HTMLButtonElement>('navAdmin');
  const adminView = el('adminView');
  /**
   * The office screens, fetched together on first use — see `web/src/office.ts`.
   *
   * The console, the roster and the Status screen are one bundle because `admin.ts` already
   * imports `roster.ts` (the console reaches every department's roster, and "My department" is
   * the same component through its other door). Splitting them would put a second copy of the
   * roster in one of the two files, and the point of this is fewer bytes.
   *
   * None of the three is any use at a scene, and none works without a connection.
   */
  interface Office {
    mountAdmin: () => AdminConsole;
    mountRoster: (host: RosterHost) => RosterPanel;
    mountStatus: (options: { onChanged?: () => void }) => StatusPanel;
  }

  let office: Office | null = null;

  async function loadOffice(): Promise<Office | null> {
    if (office !== null) return office;
    if (!(await loadScreen('office', false))) return null;

    office = (window as unknown as { DncOffice?: Office }).DncOffice ?? null;
    return office;
  }

  let admin: AdminConsole | null = null;

  // A department's own roster (M1a-10) — the other door onto the same component the console
  // uses. The server resolves "my department" from the caller's seat, so a department
  // officer never has to know their own uuid and cannot change the answer by sending one.
  // The shift screen (M1-01). Opening an incident from it goes through the same detail
  // view the board uses — one definition of what an incident looks like, two ways in.
  const navShift = el<HTMLButtonElement>('navShift');
  const navDashboard = el<HTMLButtonElement>('navDashboard');
  const navStatus = el<HTMLButtonElement>('navStatus');
  const statusView = el('statusView');
  const dashboardView = el('dashboardView');

  /**
   * The dashboard (M4). Refreshes only while it is the screen somebody is looking at.
   */
  /**
   * The dashboard, and where its panels lead.
   *
   * A summary that cannot be opened is a summary somebody has to act on by memory: they read
   * "Fire — 2 open", switch to the board, and hunt. Each panel therefore leads to the screen
   * that already answers the next question, rather than growing a second detail view beside
   * the one the board already has.
   */
  const dashboard = createDashboard({
    onOpenCategory: (category, label) => {
      showBoardFiltered('category', category, label);
    },
    onOpenDepartment: (name) => {
      showBoardFiltered('department', name, name);
    },
    /**
     * A district counter, opened on exactly what it counted.
     *
     * `open` is the board with no filter — everything live, which is what that counter counts.
     * The rest filter on an attribute the **server** set, so the number and the rows agree by
     * construction rather than by two implementations happening to match.
     *
     * The board is refetched rather than filtered in place, because "today" needs closed rows
     * the current fetch did not ask for.
     */
    onOpenFlag: (flag) => {
      boardFilter =
        flag === 'open' ? null : { kind: flag, value: flag, label: flag };
      showView('board');
      void refreshBoard();
    },
    // Utilities, services and presence are *changed* on the Status screen, so that is where
    // "tell me more" leads: the row, with its note and its buttons.
    onOpenStatus: () => {
      showView('status');
    },
    onOpenAdmin: () => {
      showView('admin');
    },
    canAdmin: () => identity?.isAdministration === true,
  });

  /**
   * The Status screen (M4).
   *
   * `onChanged` refreshes the dashboard's numbers the next time it is opened, so an officer
   * who reports a power cut and switches tabs does not see their own report missing.
   */
  let statusPanel: StatusPanel | null = null;

  // Runs from load, on every screen, signed in or out. See `startClock`.
  startClock();
  const shiftView = el('shiftView');
  const shift: Workspace = mountWorkspace((incidentId) => {
    void openDetail(incidentId);
  });

  const navMine = el<HTMLButtonElement>('navMine');
  const mineView = el('mineView');
  const searchView = el('searchView');
  const piReportView = el('piReportView');
  const mineError = el('mineError');
  let mine: RosterPanel | null = null;

  /**
   * Open one of the office screens, fetching the bundle if this is the first.
   *
   * A failure to arrive is said in words on the screen the operator asked for, rather than
   * left as a tab that does nothing — the same rule every other screen here follows when it
   * cannot reach the server.
   */
  async function openOfficeScreen(which: 'admin' | 'mine' | 'status'): Promise<void> {
    const loaded = await loadOffice();

    if (loaded === null) {
      const error = which === 'mine' ? mineError : which === 'admin' ? el('adminError') : el('statusNote');
      error.hidden = false;
      error.textContent =
        'Could not load this screen. It is fetched when first needed, so it needs a connection.';
      return;
    }

    if (which === 'admin') {
      admin ??= loaded.mountAdmin();
      admin.show();
      return;
    }

    if (which === 'status') {
      statusPanel ??= loaded.mountStatus({ onChanged: () => void dashboard.show() });
      await statusPanel.show();
      return;
    }

    mine ??= loaded.mountRoster({
      container: el('mineBody'),
      fail(message) {
        mineError.textContent = message;
        mineError.hidden = false;
      },
      clearError() {
        mineError.hidden = true;
        mineError.textContent = '';
      },
    });
    await mine.show(null);
  }

  interface BoardRow {
    incidentId: string;
    status: string;
    severity: string;
    assessed: boolean;
    overriddenFrom: string | null;
    category: string;
    occurredAt: string | null;
    lastRecordedAt: string | null;
    acknowledgedAt: string | null;
    escalationCount: number;
    overdue: boolean;
    overdueByMinutes: number;
    notificationsFailed: number;
    notificationsUndelivered: number;
    responsibleDepartments: string[];
    /** Routing ran and matched nothing. Nobody has this one (ADR-0010). */
    unassigned: boolean;
    /** Server-decided flags the district counters lead through — see incidentRow.ts. */
    held: boolean;
    acknowledged: boolean;
    occurredToday: boolean;
    notificationsUnmet: boolean;
    /** The deadline actually applied to this row, set by the administration (Q-06). */
    targetMinutes: number;
  }
  interface BoardData {
    asOf: string;
    summary: {
      open: number;
      unacknowledged: number;
      overdue: number;
      worst: string | null;
      unassessed: number;
      notificationsUnmet: number;
      unassigned: number;
    };
    incidents: BoardRow[];
  }

  let boardTimer: ReturnType<typeof setInterval> | null = null;
  /** When the board last actually reached the server. Not when we last tried. */
  let boardFetchedAt: number | null = null;

  /** Beyond this the board is openly called stale rather than shown as if it were live. */
  const BOARD_STALE_MS = 30_000;



  function tally(kind: string, label: string, value: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'tally';
    box.dataset['kind'] = kind;
    const strong = document.createElement('b');
    strong.textContent = value;
    box.append(strong, document.createTextNode(label));
    return box;
  }

  /**
   * A slice of the board, chosen on the dashboard.
   *
   * Applied in the browser rather than by asking the server for a narrower board. The board
   * is already loaded and capped at 500 rows; a second endpoint taking a filter would be a
   * second definition of what the board contains, and the two would drift.
   */
  /**
   * The flags the dashboard's district counters lead through.
   *
   * Each names a `data-` attribute the **server** set on the row, so a counter reading 5 lands
   * on 5 rows. None of these is a predicate this file works out for itself — that would be a
   * second implementation of a rule the counter already applied, and the first one to drift
   * would put a number on the district's home screen that its own board disagrees with.
   */
  const FLAG_FILTERS = {
    unassigned: { attr: 'held', want: 'false', label: 'emergencies with nobody' },
    unacknowledged: { attr: 'acknowledged', want: 'false', label: 'not yet acknowledged' },
    today: { attr: 'today', want: 'true', label: 'reported today' },
    unmet: { attr: 'unmet', want: 'true', label: 'where nobody was reached' },
  } as const;

  type FlagKind = keyof typeof FLAG_FILTERS;

  let boardFilter: {
    kind: 'category' | 'department' | FlagKind;
    /** What the rows are matched on — the stored code, e.g. `rta`. */
    value: string;
    /** What the operator is told, e.g. "Road accident". Never the code. */
    label: string;
  } | null = null;

  function applyBoardFilter(): void {
    const bar = el('boardFilter');
    const rows = Array.from(boardRows.querySelectorAll<HTMLElement>('.row'));

    if (boardFilter === null) {
      bar.hidden = true;
      for (const row of rows) row.hidden = false;
      return;
    }

    bar.hidden = false;

    const flag =
      boardFilter.kind in FLAG_FILTERS ? FLAG_FILTERS[boardFilter.kind as FlagKind] : null;

    el('boardFilterText').textContent =
      flag !== null
        ? `Showing only: ${flag.label}`
        : boardFilter.kind === 'category'
          ? `Showing only: ${boardFilter.label}`
          : `Showing only what is with: ${boardFilter.label}`;

    let shown = 0;
    for (const row of rows) {
      const match =
        flag !== null
          ? row.dataset[flag.attr] === flag.want
          : boardFilter.kind === 'category'
            ? row.dataset['category'] === boardFilter.value
            : (row.dataset['departments'] ?? '').split('').includes(boardFilter.value);

      row.hidden = !match;
      if (match) shown += 1;
    }

    /**
     * "Nothing matches" is only said once there is a board to match against.
     *
     * Arriving from the dashboard, this runs before the board's own fetch has returned, so
     * there are no rows yet — and saying "nothing matches Fire" at that moment is a false
     * statement shown at the exact instant somebody is looking for a fire. It resolves a
     * second later, which is worse than useless: it teaches people to distrust the message
     * when it is true.
     *
     * A filter that genuinely hides everything still has to say so, because that looks
     * identical to a quiet district (ADR-0005).
     */
    if (shown === 0 && rows.length > 0) {
      el('boardFilterText').textContent =
        `Nothing on the board matches ${boardFilter.label} — it may already be resolved.`;
    }
  }

  /** Open the board narrowed to one slice. Called from the dashboard. */
  function showBoardFiltered(
    kind: 'category' | 'department',
    value: string,
    label: string,
  ): void {
    boardFilter = { kind, value, label };
    showView('board');
    applyBoardFilter();
  }

  function renderBoard(data: BoardData): void {
    const at = Date.parse(data.asOf);

    boardSummary.replaceChildren(
      tally('open', 'open', String(data.summary.open)),
      tally('unack', 'unacknowledged', String(data.summary.unacknowledged)),
      tally('overdue', 'past deadline', String(data.summary.overdue)),
      // Two numbers, never one. An unassessed report is not a severity level, and folding
      // it into one would hide either it or the criticals beside it (ADR-0009, INV-04).
      tally(
        data.summary.worst === 'critical' ? 'worst-critical' : 'worst',
        'worst assessed',
        data.summary.worst ?? 'none',
      ),
      tally('unassessed', 'not yet assessed', String(data.summary.unassessed)),
      // INV-03, on the board, in words: "a message that did not reach the duty officer
      // surfaces as an unmet obligation, not as a log line."
      tally('unmet', 'nobody reached', String(data.summary.notificationsUnmet)),
      tally('unassigned', 'nobody has it', String(data.summary.unassigned)),
    );

    // Above everything, because an unassigned emergency is not low priority — it is one
    // that has not been given to anybody. It is also a routing signal somebody forgot to
    // write, which is why the wording points at both (ADR-0005, ADR-0010).
    boardUnassigned.hidden = data.summary.unassigned === 0;
    if (data.summary.unassigned > 0) {
      const n = data.summary.unassigned;
      boardUnassigned.textContent =
        `${String(n)} emergenc${n === 1 ? 'y has' : 'ies have'} no department. ` +
        'The routing signals matched nothing — assign them, and add a signal so the next one ' +
        'goes straight through.';
    }

    // Applied again at the end of this function: the board polls every ten seconds, and a
    // repaint that forgot the filter would silently widen the view under somebody's eye.
    boardRows.replaceChildren(...data.incidents.map((row) => incidentRow(row, at)));

    boardEmpty.hidden = data.incidents.length > 0;
    boardFetchedAt = Date.now();
    paintBoardAge(data);

    // The board polls every ten seconds. A repaint that forgot the filter would silently
    // widen the view under somebody's eye, mid-read.
    applyBoardFilter();
  }

  let lastBoard: BoardData | null = null;

  /**
   * Say how old this is, always, and say it loudly once it is old.
   *
   * INV-02 in the one place it is easiest to violate: a board that keeps showing its last
   * good data during an outage, with no indication, is worse than a blank screen — someone
   * decides not to send a crew because the screen says a crew is already going.
   */
  function paintBoardAge(data: BoardData | null): void {
    if (data === null || boardFetchedAt === null) {
      boardAsOfText.textContent = 'Loading…';
      return;
    }
    const age = Date.now() - boardFetchedAt;
    const stale = age > BOARD_STALE_MS;
    boardAsOf.dataset['stale'] = String(stale);
    boardAsOfText.textContent = stale
      ? `NOT LIVE — last reached the server ${Math.round(age / 1000)}s ago. Do not act on this without checking.`
      : `Live as of ${new Date(data.asOf).toLocaleTimeString()}`;
  }

  async function refreshBoard(): Promise<void> {
    try {
      /**
       * Closed rows are asked for only when the filter in force is about a day rather than a
       * queue.
       *
       * "Reported today" counts everything that happened today, including what was dealt with
       * by lunchtime — so arriving from that counter and being shown only what is still open
       * would land on fewer rows than the number that was clicked. Every other view is a
       * working queue, where yesterday's closed incidents are in the way.
       */
      const wantsClosed = boardFilter?.kind === 'today';
      const res = await fetch(wantsClosed ? '/incidents?closed=1' : '/incidents', {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // Signed out or holding no seat. Say so rather than showing an empty district.
        boardAsOf.dataset['stale'] = 'true';
        boardAsOfText.textContent =
          res.status === 401
            ? 'Signed out — sign in to see the district board.'
            : 'You hold no duty seat, so there is no board to show.';
        boardRows.replaceChildren();
        boardEmpty.hidden = true;
        return;
      }
      lastBoard = (await res.json()) as BoardData;
      renderBoard(lastBoard);
      // Say whose view this is, by name (M0-34). The same endpoint and the same projection
      // serve both — the scoping falls out of the seat, so a department board is not a
      // second query that could disagree with the district one. What differs is the label.
      boardScope.textContent =
        identity === null
          ? ''
          : identity.departmentId === null
            ? 'district-wide'
            : (identity.departmentName ?? 'your department');
    } catch {
      // Offline. Keep what is on screen — and make sure it is labelled for what it is.
      paintBoardAge(lastBoard);
    }
  }

  function showBoard(show: boolean): void {
    showView(show ? 'board' : 'report');
  }

  function showView(
    view:
      | 'report'
      | 'board'
      | 'detail'
      | 'inbox'
      | 'admin'
      | 'mine'
      | 'shift'
      | 'dashboard'
      | 'status'
      | 'search'
      | 'piReport',
  ): void {
    dashboardView.hidden = view !== 'dashboard';
    statusView.hidden = view !== 'status';
    reportView.hidden = view !== 'report';
    boardView.hidden = view !== 'board';
    detailView.hidden = view !== 'detail';
    inboxView.hidden = view !== 'inbox';
    adminView.hidden = view !== 'admin';
    mineView.hidden = view !== 'mine';
    shiftView.hidden = view !== 'shift';
    searchView.hidden = view !== 'search';
    piReportView.hidden = view !== 'piReport';

    // Detail is reached from the board or the inbox, so whichever tab you came from stays
    // current while reading one.
    navReport.setAttribute('aria-current', view === 'report' ? 'page' : 'false');
    navInbox.setAttribute('aria-current', view === 'inbox' ? 'page' : 'false');
    navBoard.setAttribute('aria-current', view === 'board' || view === 'detail' ? 'page' : 'false');
    navAdmin.setAttribute('aria-current', view === 'admin' ? 'page' : 'false');
    navMine.setAttribute('aria-current', view === 'mine' ? 'page' : 'false');
    navShift.setAttribute('aria-current', view === 'shift' ? 'page' : 'false');
    navDashboard.setAttribute('aria-current', view === 'dashboard' ? 'page' : 'false');
    navStatus.setAttribute('aria-current', view === 'status' ? 'page' : 'false');
    navSearch.setAttribute('aria-current', view === 'search' ? 'page' : 'false');

    // Polling stops the moment the operator leaves. A background refresh against a screen
    // nobody is looking at is a request the district's one server did not need to serve.
    if (view !== 'shift') shift.stop();
    if (view !== 'dashboard') {
      dashboard.stop();
      el('ticker').hidden = true;
    }
    if (view === 'dashboard') void dashboard.show();
    if (view === 'status') void openOfficeScreen('status');
    if (view === 'search') void openSearchScreen();
    if (view !== 'search') searchPanel?.reset();
    if (view === 'shift' && identity !== null) {
      void shift.show({
        departmentId: identity.departmentId,
        departmentName: identity.departmentName,
        seatTitle: identity.seatTitle,
      });
    }

    if (view === 'admin') void openOfficeScreen('admin');
    if (view === 'mine') void openOfficeScreen('mine');

    if (view === 'inbox') void refreshInbox();

    if (boardTimer !== null) clearInterval(boardTimer);
    boardTimer = null;

    if (view === 'board') {
      void refreshBoard();
      // Poll rather than push: M0 has no realtime transport, and a board that silently
      // stops updating is exactly what the staleness clock above is there to expose.
      boardTimer = setInterval(() => {
        void refreshBoard();
        paintBoardAge(lastBoard);
      }, 10_000);
    }
  }

  // ------------------------------------------------------------- the inbox (M0-34)

  const navInbox = el<HTMLButtonElement>('navInbox');
  const inboxView = el('inboxView');
  const inboxWho = el('inboxWho');
  const inboxRows = el('inboxRows');
  const inboxEmpty = el('inboxEmpty');
  const inboxCount = el('inboxCount');

  interface InboxItem {
    attemptId: string;
    incidentId: string;
    reason: string;
    attemptedAt: string;
    severity: string;
    category: string;
  }

  /** Why this seat is being told. Plain words — an operator should not decode an enum. */
  const REASON_TEXT: Readonly<Record<string, string>> = {
    routed: 'routed to your department',
    reassigned: 'reassigned to your department',
    lost_responsibility: 'no longer your department — handed to someone else',
    escalated: 'escalated to your seat',
  };

  /**
   * Record that a human has actually seen this.
   *
   * The one action that turns a pending attempt into a delivered one. Deliberately an
   * explicit tap rather than something the list does on render: "the tab was open" is not
   * "somebody knows", and the board carries the obligation as unmet until this happens
   * (INV-03).
   */
  async function markSeen(attemptId: string): Promise<void> {
    try {
      await fetch(`/notifications/${attemptId}/seen`, { method: 'POST' });
    } catch {
      // Offline. It stays pending, which is the truthful state — nothing was confirmed.
    }
  }

  function renderInbox(items: InboxItem[]): void {
    inboxWho.textContent =
      identity?.seatTitle === null || identity === null
        ? 'You hold no duty seat, so nothing is addressed to you.'
        : `Addressed to ${identity.seatTitle}${
            identity.departmentName === null ? '' : ` · ${identity.departmentName}`
          }`;

    inboxRows.replaceChildren(
      ...items.map((item) => {
        const row = document.createElement('div');
        row.className = 'inbox-row';
        row.dataset['attempt'] = item.attemptId;

        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = `${item.severity === 'unknown' ? 'unassessed' : item.severity} · ${item.category}`;

        const why = document.createElement('span');
        why.className = 'why';
        why.textContent = `${REASON_TEXT[item.reason] ?? item.reason} · ${ago(
          item.attemptedAt,
          Date.now(),
        )}`;
        what.append(why);

        const acts = document.createElement('div');
        acts.className = 'acts';

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'open';
        open.textContent = 'Open';
        open.addEventListener('click', () => {
          // Opening it is seeing it. No second confirmation for something already read.
          void markSeen(item.attemptId).then(() => refreshInboxCount());
          void openDetail(item.incidentId);
        });

        const seen = document.createElement('button');
        seen.type = 'button';
        seen.className = 'seen';
        seen.textContent = 'Seen';
        seen.addEventListener('click', () => {
          void markSeen(item.attemptId).then(() => refreshInbox());
        });

        acts.append(open, seen);
        row.append(what, acts);
        return row;
      }),
    );

    inboxEmpty.hidden = items.length > 0;
  }

  async function fetchInbox(): Promise<InboxItem[] | null> {
    try {
      const res = await fetch('/notifications', { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      return ((await res.json()) as { notifications: InboxItem[] }).notifications;
    } catch {
      return null;
    }
  }

  async function refreshInbox(): Promise<void> {
    const items = await fetchInbox();
    if (items === null) {
      inboxWho.textContent = 'Cannot reach the server, so this may not be everything.';
      return;
    }
    renderInbox(items);
    paintInboxCount(items.length);
  }

  /**
   * The badge on the tab.
   *
   * Shown only when there is something, because a permanent "0" is furniture an operator
   * stops seeing — and the whole point is that a number appearing means something arrived.
   */
  function paintInboxCount(n: number): void {
    inboxCount.hidden = n === 0;
    inboxCount.textContent = String(n);
  }

  async function refreshInboxCount(): Promise<void> {
    const items = await fetchInbox();
    if (items !== null) paintInboxCount(items.length);
  }

  // Registered here rather than beside `showView`, because these consts are declared above
  // and referencing them earlier would be a temporal-dead-zone error at boot.
  navBoard.addEventListener('click', () => {
    // Clicking "Board" means the board. A filter left over from a dashboard panel would make
    // the tab show a slice with no explanation of why.
    boardFilter = null;
    showView('board');
    applyBoardFilter();
  });
  navReport.addEventListener('click', () => showView('report'));
  navInbox.addEventListener('click', () => showView('inbox'));
  navAdmin.addEventListener('click', () => showView('admin'));
  navMine.addEventListener('click', () => showView('mine'));
  navShift.addEventListener('click', () => showView('shift'));
  navDashboard.addEventListener('click', () => showView('dashboard'));

  el('boardFilterClear').addEventListener('click', () => {
    boardFilter = null;
    applyBoardFilter();
  });
  /**
   * Search, fetched on first use — the same reasoning as the report screen below.
   *
   * An officer standing at a scene is reporting an emergency, not looking one up. Search needs
   * a connection to be of any use at all, so nothing is lost by fetching it when somebody
   * actually opens it, and the shell stays small enough to arrive on a weak one.
   */
  let searchPanel: { show(): void; reset(): void } | null = null;

  async function openSearchScreen(): Promise<void> {
    if (searchPanel === null) {
      const ok = await loadScreen('search', true);
      const factory = (
        window as unknown as {
          DncSearch?: {
            mountSearch: (o: { onOpen: (id: string) => void }) => {
              show(): void;
              reset(): void;
            };
          };
        }
      ).DncSearch;

      if (!ok || factory === undefined) {
        const error = el('searchError');
        error.hidden = false;
        error.textContent =
          'Could not load the search screen. It is fetched when first needed, so it needs a ' +
          'connection — as does searching the record.';
        return;
      }
      searchPanel = factory.mountSearch({ onOpen: (id) => void openDetail(id) });
    }
    searchPanel.show();
  }

  /**
   * Which incident the detail screen is showing.
   *
   * The screen had never needed this: it renders what it fetched and nothing asked it
   * afterwards. The post-incident report does — it is reached *from* an incident, and it
   * has to know which one to fold and which one Back returns to.
   */
  let openIncidentId: string | null = null;

  /**
   * The report screen, fetched the first time somebody asks for one.
   *
   * **Not imported.** It is built as its own file (see `build.mjs`) and kept out of the shell,
   * because the shell is what a field officer downloads at a scene and an officer at a scene
   * has no use for a post-incident report. The shell stood at **159 KB against a 160 KB
   * budget** when this screen was written — the budget existed to make that visible and did,
   * and the answer to it is not a bigger number.
   *
   * A failure to load is said plainly rather than left as a dead button. This screen needs a
   * connection, and so does the report it folds.
   */
  let piReport: { show(incidentId: string): Promise<void> } | null = null;

  /**
   * Fetch a screen that is not part of the shell.
   *
   * Each of these is office work that always has a connection, so nothing is lost by fetching
   * it on first use — and the shell stays the thing a field officer can download at a scene.
   *
   * Returns false rather than throwing. A screen that failed to arrive is a message, not a
   * dead button: the caller says so in words, which is the same rule every other screen here
   * follows when it cannot reach the server.
   */
  async function loadScreen(name: string, withCss: boolean): Promise<boolean> {
    if (withCss && document.getElementById(`${name}Css`) === null) {
      const css = document.createElement('link');
      css.id = `${name}Css`;
      css.rel = 'stylesheet';
      css.href = `/${name}.css`;
      document.head.append(css);
    }

    return new Promise<boolean>((resolve) => {
      const tag = document.createElement('script');
      tag.src = `/${name}.js`;
      tag.onload = () => resolve(true);
      tag.onerror = () => resolve(false);
      document.head.append(tag);
    });
  }

  async function loadReportScreen(): Promise<boolean> {
    if (piReport !== null) return true;
    if (!(await loadScreen('report', true))) return false;

    const factory = (
      window as unknown as {
        DncReport?: { mountReport: () => { show(incidentId: string): Promise<void> } };
      }
    ).DncReport;

    piReport = factory?.mountReport() ?? null;
    return piReport !== null;
  }

  /** The incident whose report is on screen, so Back knows where to return. */
  let piReportFor: string | null = null;

  el('detailReport').addEventListener('click', () => {
    if (openIncidentId === null) return;
    const forIncident = openIncidentId;
    piReportFor = forIncident;
    showView('piReport');

    void (async () => {
      const ready = await loadReportScreen();
      const error = el('piReportError');
      if (!ready || piReport === null) {
        error.hidden = false;
        error.textContent =
          'Could not load the report screen. It is fetched when first needed, so it needs a ' +
          'connection — as does the report it folds.';
        return;
      }
      await piReport.show(forIncident);
    })();
  });
  el('piReportPrint').addEventListener('click', () => window.print());
  el('piReportBack').addEventListener('click', () => {
    if (piReportFor !== null) void openDetail(piReportFor);
    else showView('board');
  });

  navSearch.addEventListener('click', () => showView('search'));
  navStatus.addEventListener('click', () => showView('status'));
  el('back').addEventListener('click', () => showView('board'));

  // ------------------------------------------------------- incident detail (M0-35)

  const detailView = el('detailView');
  const detailHead = el('detailHead');
  const detailValues = el('detailValues');
  const timelineRows = el('timelineRows');

  interface Actor {
    personId: string | null;
    seatId: string | null;
  }
  interface Provenanced<T> {
    value: T;
    setBy: Actor;
    setAt: string;
    overriddenFrom?: {
      value: T;
      setBy: Actor;
      setAt: string;
      reason: string;
      overriddenBy: Actor;
      overriddenAt: string;
    };
  }
  interface DetailEvent {
    eventId: string;
    type: string;
    occurredAt: string;
    recordedAt: string;
    actorPersonId: string | null;
    actorSeatId: string | null;
    sourceChannel: string;
    payload: Record<string, unknown>;
  }
  interface Detail {
    state: {
      incidentId: string;
      status: string;
      severity: Provenanced<string> | null;
      category: Provenanced<string> | null;
      responsibleDepartmentIds: string[];
      acknowledgedAt: string | null;
      acknowledgedBySeatId: string | null;
      escalationCount: number;
      resolution: string | null;
      closureNotes: string | null;
      occurredAt: string | null;
      lastRecordedAt: string | null;
    };
    events: DetailEvent[];
    actors: {
      people: Record<string, string>;
      seats: Record<string, { title: string; tier: string }>;
    };
    responsibleDepartments: string[];
    responsibleDepartmentIds: string[];
  }

  /**
   * Name an actor, leading with the seat.
   *
   * Authority attaches to the post, not the person (ADR-0004) — "the District Control Room
   * overrode this" is the operationally meaningful sentence, and the individual is the
   * supporting detail rather than the headline.
   */
  function nameOf(actor: Actor, actors: Detail['actors']): string {
    const seat = actor.seatId === null ? null : (actors.seats[actor.seatId] ?? null);
    const person = actor.personId === null ? null : (actors.people[actor.personId] ?? null);

    if (seat === null && person === null) {
      // Server-issued events (escalation) carry no actor. Saying so is better than a blank:
      // "nobody did this, the deadline did" is a real and important distinction.
      return 'the system';
    }
    if (seat === null) return person ?? 'unknown';
    return person === null ? seat.title : `${seat.title} — ${person}`;
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** A value with the answer to "who set this, when, and what did it replace". */
  function valueBlock(
    label: string,
    prov: Provenanced<string> | null,
    actors: Detail['actors'],
    fallback: string,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'value';
    box.dataset['field'] = label.toLowerCase();

    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;

    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = prov === null ? fallback : prov.value;

    box.append(k, v);

    if (prov !== null) {
      const by = document.createElement('span');
      by.className = 'prov';
      by.textContent = `set by ${nameOf(prov.setBy, actors)} · ${when(prov.setAt)}`;
      box.append(by);

      // ADR-0003, the heart of it: an override never erases what the department entered.
      // Nobody can be blamed for a figure they did not enter, and nobody can quietly
      // rewrite a department's assessment.
      const from = prov.overriddenFrom;
      if (from !== undefined) {
        const was = document.createElement('span');
        was.className = 'was';
        const strong = document.createElement('b');
        strong.textContent = from.value;
        was.append(
          document.createTextNode('was '),
          strong,
          document.createTextNode(
            `, set by ${nameOf(from.setBy, actors)} · overridden by ${nameOf(
              from.overriddenBy,
              actors,
            )} on ${when(from.overriddenAt)} — "${from.reason}"`,
          ),
        );
        box.append(was);
      }
    }

    return box;
  }

  /** The human-readable heart of an event, when it has one. */
  function detailOf(event: DetailEvent): string | null {
    const p = event.payload;
    const str = (k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);

    switch (event.type) {
      case 'reported':
        return `${str('category') ?? 'unknown'} · ${str('severity') ?? 'unknown'}`;
      case 'triaged':
        return `${str('category') ?? ''} · ${str('severity') ?? ''}${
          str('reason') === null ? '' : ` — "${str('reason')!}"`
        }`;
      case 'overridden':
        return `${str('field') ?? ''} → ${str('value') ?? ''} — "${str('reason') ?? ''}"`;
      case 'reassigned':
      case 'reopened':
        return str('reason') === null ? null : `"${str('reason')!}"`;
      case 'routed':
        return str('reason') === null ? null : `"${str('reason')!}"`;
      case 'action_logged':
        return str('note');
      case 'resolved':
        return str('outcome');
      case 'closed':
        return str('notes');
      case 'escalated':
        return `trigger: ${str('trigger') ?? 'unknown'}`;
      default:
        return null;
    }
  }

  function renderDetail(data: Detail): void {
    const s = data.state;

    const h2 = document.createElement('h2');
    h2.textContent = `${s.category?.value ?? 'unknown'} — ${s.status}`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `Incident ${s.incidentId} · ${
      s.occurredAt === null ? 'time unknown' : `happened ${when(s.occurredAt)}`
    }${s.escalationCount > 0 ? ` · escalated ${s.escalationCount}×` : ''}`;
    /**
     * The post-incident report (M1-06), from the incident it describes.
     *
     * Opened in a new tab as plain text rather than rendered here. Two reasons: an operator
     * needs to copy it into whatever their department submits upward (Q-02 made export the
     * point rather than integration), and re-rendering the same fold in a second place is
     * how the screen and the document start disagreeing about the same night.
     */
    const takeReport = document.createElement('button');
    takeReport.type = 'button';
    takeReport.id = 'takeReport';
    takeReport.className = 'act';
    takeReport.textContent = 'Post-incident report';
    takeReport.addEventListener('click', () => {
      window.open(`/incidents/${s.incidentId}/report?format=text`, '_blank', 'noopener');
    });

    detailHead.replaceChildren(h2, meta, takeReport);

    const ack = document.createElement('div');
    ack.className = 'value';
    ack.dataset['field'] = 'acknowledged';
    const ackK = document.createElement('span');
    ackK.className = 'k';
    ackK.textContent = 'Acknowledged';
    const ackV = document.createElement('span');
    ackV.className = 'v';
    ackV.textContent = s.acknowledgedAt === null ? 'not yet' : when(s.acknowledgedAt);
    ack.append(ackK, ackV);
    if (s.acknowledgedBySeatId !== null) {
      const by = document.createElement('span');
      by.className = 'prov';
      by.textContent = `by ${nameOf({ personId: null, seatId: s.acknowledgedBySeatId }, data.actors)}`;
      ack.append(by);
    }

    const dept = document.createElement('div');
    dept.className = 'value';
    dept.dataset['field'] = 'responsible';
    const deptK = document.createElement('span');
    deptK.className = 'k';
    deptK.textContent = 'Responsible';
    const deptV = document.createElement('span');
    deptV.className = 'v';
    deptV.textContent =
      data.responsibleDepartments.length > 0
        ? data.responsibleDepartments.join(', ')
        : 'not yet routed';
    dept.append(deptK, deptV);

    /**
     * The numbers, here, on the incident.
     *
     * This is where somebody decides to escalate — and the decision they make next is to pick
     * up a phone. Making them leave for the roster, find the department, find the post, find
     * the holder and read a number back is the friction that ends with them ringing somebody
     * they already know instead of whoever is actually on duty.
     */
    for (const [i, id] of data.responsibleDepartmentIds.entries()) {
      dept.append(
        reachButton(
          id,
          data.responsibleDepartmentIds.length === 1
            ? 'Reach them'
            : `Reach ${data.responsibleDepartments[i] ?? 'them'}`,
        ),
      );
    }

    detailValues.replaceChildren(
      valueBlock('Severity', s.severity, data.actors, 'not yet assessed'),
      valueBlock('Category', s.category, data.actors, 'unknown'),
      dept,
      ack,
    );

    timelineRows.replaceChildren(
      ...data.events.map((event) => {
        const row = document.createElement('div');
        row.className = 'tl';
        row.dataset['type'] = event.type;

        const whenEl = document.createElement('span');
        whenEl.className = 'when';
        whenEl.textContent = when(event.occurredAt);

        const what = document.createElement('span');
        what.className = 'what';
        const type = document.createElement('b');
        type.textContent = event.type.replace(/_/g, ' ');
        what.append(type);

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = nameOf(
          { personId: event.actorPersonId, seatId: event.actorSeatId },
          data.actors,
        );
        what.append(who);

        const why = detailOf(event);
        if (why !== null && why.trim().length > 0) {
          const whyEl = document.createElement('span');
          whyEl.className = 'why';
          whyEl.textContent = why;
          what.append(whyEl);
        }

        // The occurred/recorded gap is the district's connectivity picture, not noise
        // (ADR-0002). A report that took two hours to surface is an operational fact.
        const gapMinutes = Math.round(
          (Date.parse(event.recordedAt) - Date.parse(event.occurredAt)) / 60_000,
        );
        if (gapMinutes >= 15) {
          const late = document.createElement('span');
          late.className = 'late';
          late.textContent = `reached the server ${gapMinutes}m later — ${when(event.recordedAt)}`;
          what.append(late);
        }

        row.append(whenEl, what);
        return row;
      }),
    );
  }

  async function openDetail(incidentId: string): Promise<void> {
    openIncidentId = incidentId;
    showView('detail');
    detailHead.textContent = 'Loading…';
    try {
      const res = await fetch(`/incidents/${incidentId}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        detailHead.textContent =
          res.status === 404
            ? 'That incident is not available to your seat.'
            : 'Could not load this incident.';
        detailValues.replaceChildren();
        timelineRows.replaceChildren();
        return;
      }
      renderDetail((await res.json()) as Detail);
    } catch {
      // Offline. Say so rather than showing an empty incident, which reads as "nothing
      // happened" when the truth is "we cannot see" (INV-02).
      detailHead.textContent = 'No connection — cannot load this incident right now.';
      detailValues.replaceChildren();
      timelineRows.replaceChildren();
    }
  }

  boardRows.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.row');
    const id = row?.dataset['incident'];
    if (id !== undefined) void openDetail(id);
  });

  // ---------------------------------------------------------------- auth

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const data = new FormData(loginForm);

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone: String(data.get('phone') ?? ''),
          password: String(data.get('password') ?? ''),
        }),
      });

      if (!res.ok) {
        loginError.textContent = 'Phone number or password is not correct.';
        loginError.hidden = false;
        return;
      }

      identity = ((await res.json()) as { identity: Identity }).identity;
      loginForm.reset();
      paintIdentity();

      /**
       * Where somebody lands depends on what they are holding.
       *
       * On a phone, the report form — that is the officer standing at a scene, and putting a
       * summary in front of them first would cost seconds at the only moment seconds matter.
       *
       * On a laptop or an office screen, the dashboard — nobody carries one of those to an
       * incident, and the question they opened it to answer is "what is happening".
       *
       * This is the *only* place in the client that reads the viewport, and it chooses a
       * starting screen rather than a layout. Every layout decision stays in CSS, where it
       * responds to a resized window and a turned phone without any code being involved.
       */
      if (window.matchMedia('(min-width: 56rem)').matches) showView('dashboard');

      await trySync();
    } catch {
      loginError.textContent = 'Cannot reach the server. Check your connection and try again.';
      loginError.hidden = false;
    }
  });

  el('logout').addEventListener('click', async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {
      // Offline. The cookie stays until it expires; the server refuses it either way.
    }
    identity = null;
    paintIdentity();
    await trySync();
  });

  // Hints that something changed, worth a sync attempt — but they never set the displayed
  // state on their own. Only a sync outcome does that.
  addEventListener('online', () => {
    paintIdentity();
    void trySync();
  });
  addEventListener('offline', () => {
    reachability = 'unreachable';
    paintIdentity();
    paintStatus();
  });

  paintStatus();
  await paintQueue();
  await loadIdentity();
  void trySync();

  (globalThis as unknown as { __dnc: unknown }).__dnc = {
    outbox,
    store,
    trySync,
    paintQueue,
    identity: () => identity,
    refreshBoard,
    showBoard,
    openDetail,
    /**
     * Move the board's "last reached the server" mark backwards, and repaint.
     *
     * A test seam, and a deliberate one. The alternative is a suite that sits for thirty
     * real seconds to watch a clock tick over, and a staleness warning nobody verifies is
     * exactly the kind of thing that rots — INV-02 is worth a hook.
     */
    backdateBoard: (ms: number) => {
      if (boardFetchedAt !== null) boardFetchedAt -= ms;
      paintBoardAge(lastBoard);
    },
    // So tests can assert against the incident itself rather than against the shape of a
    // payload, which would couple every suite to the intake form's field names.
    lastIncidentId: () => lastIncidentId,
  };
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

void boot();
