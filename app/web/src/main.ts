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
import { mountAdmin, type AdminConsole } from './admin.js';
import { mountRoster, type RosterPanel } from './roster.js';
import { mountWorkspace, type Workspace } from './workspace.js';
import { createDashboard, startClock } from './dashboard.js';

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

    if (!signedIn) {
      if (
        boardView.hidden === false ||
        inboxView.hidden === false ||
        adminView.hidden === false ||
        mineView.hidden === false ||
        shiftView.hidden === false ||
        dashboardView.hidden === false
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
  const admin: AdminConsole = mountAdmin();

  // A department's own roster (M1a-10) — the other door onto the same component the console
  // uses. The server resolves "my department" from the caller's seat, so a department
  // officer never has to know their own uuid and cannot change the answer by sending one.
  // The shift screen (M1-01). Opening an incident from it goes through the same detail
  // view the board uses — one definition of what an incident looks like, two ways in.
  const navShift = el<HTMLButtonElement>('navShift');
  const navDashboard = el<HTMLButtonElement>('navDashboard');
  const dashboardView = el('dashboardView');

  /**
   * The dashboard (M4). Refreshes only while it is the screen somebody is looking at.
   */
  const dashboard = createDashboard();

  // Runs from load, on every screen, signed in or out. See `startClock`.
  startClock();
  const shiftView = el('shiftView');
  const shift: Workspace = mountWorkspace((incidentId) => {
    void openDetail(incidentId);
  });

  const navMine = el<HTMLButtonElement>('navMine');
  const mineView = el('mineView');
  const mineError = el('mineError');
  const mine: RosterPanel = mountRoster({
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

  function ago(iso: string | null, from: number): string {
    if (iso === null) return '—';
    const mins = Math.floor((from - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
  }

  function tally(kind: string, label: string, value: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'tally';
    box.dataset['kind'] = kind;
    const strong = document.createElement('b');
    strong.textContent = value;
    box.append(strong, document.createTextNode(label));
    return box;
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

    boardRows.replaceChildren(
      ...data.incidents.map((row) => {
        const div = document.createElement('div');
        div.className = 'row';
        div.dataset['overdue'] = String(row.overdue);
        div.dataset['unassigned'] = String(row.unassigned);
        div.dataset['incident'] = row.incidentId;

        const sev = document.createElement('span');
        sev.className = 'sev';
        sev.dataset['level'] = row.severity;
        // The word carries the meaning; the colour only repeats it (INV-04). "Unassessed"
        // is spelled out rather than shown as a level nobody chose.
        sev.textContent = row.assessed ? row.severity : 'unassessed';

        const cat = document.createElement('span');
        cat.className = 'cat';
        cat.textContent = row.category;
        if (row.overriddenFrom !== null) {
          const note = document.createElement('span');
          note.className = 'meta';
          note.textContent = ` (overridden from ${row.overriddenFrom})`;
          cat.append(note);
        }

        const state = document.createElement('span');
        state.className = 'state';
        state.textContent =
          row.acknowledgedAt !== null
            ? row.status
            : row.overdue
              ? `unacknowledged · ${row.overdueByMinutes}m past deadline`
              : 'unacknowledged';
        if (row.overdue) state.classList.add('flag');

        const meta = document.createElement('span');
        meta.className = 'meta';
        // Whose incident it is, by name (M0-51). "Not yet routed" is said out loud rather
        // than left blank — an unrouted emergency is a state somebody has to act on.
        const who =
          row.responsibleDepartments.length > 0
            ? row.responsibleDepartments.join(', ')
            : 'not yet routed';
        meta.textContent = `${who} · ${ago(row.occurredAt, at)}${
          row.escalationCount > 0 ? ` · escalated ${row.escalationCount}×` : ''
        }`;

        div.append(sev, cat, state, meta);

        // Spelled out, on the row, next to the incident it concerns. A count in a corner
        // tells you the district has a problem; this tells you which incident nobody is
        // coming to (INV-03).
        if (row.notificationsFailed > 0 || row.notificationsUndelivered > 0) {
          const unmet = document.createElement('span');
          unmet.className = 'flag unmet';
          unmet.textContent =
            row.notificationsFailed > 0
              ? `could not notify the duty seat (${row.notificationsFailed})`
              : `notified, nobody has picked it up (${row.notificationsUndelivered})`;
          div.append(unmet);
        }
        return div;
      }),
    );

    boardEmpty.hidden = data.incidents.length > 0;
    boardFetchedAt = Date.now();
    paintBoardAge(data);
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
      const res = await fetch('/incidents', { headers: { accept: 'application/json' } });
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
    view: 'report' | 'board' | 'detail' | 'inbox' | 'admin' | 'mine' | 'shift' | 'dashboard',
  ): void {
    dashboardView.hidden = view !== 'dashboard';
    reportView.hidden = view !== 'report';
    boardView.hidden = view !== 'board';
    detailView.hidden = view !== 'detail';
    inboxView.hidden = view !== 'inbox';
    adminView.hidden = view !== 'admin';
    mineView.hidden = view !== 'mine';
    shiftView.hidden = view !== 'shift';

    // Detail is reached from the board or the inbox, so whichever tab you came from stays
    // current while reading one.
    navReport.setAttribute('aria-current', view === 'report' ? 'page' : 'false');
    navInbox.setAttribute('aria-current', view === 'inbox' ? 'page' : 'false');
    navBoard.setAttribute('aria-current', view === 'board' || view === 'detail' ? 'page' : 'false');
    navAdmin.setAttribute('aria-current', view === 'admin' ? 'page' : 'false');
    navMine.setAttribute('aria-current', view === 'mine' ? 'page' : 'false');
    navShift.setAttribute('aria-current', view === 'shift' ? 'page' : 'false');
    navDashboard.setAttribute('aria-current', view === 'dashboard' ? 'page' : 'false');

    // Polling stops the moment the operator leaves. A background refresh against a screen
    // nobody is looking at is a request the district's one server did not need to serve.
    if (view !== 'shift') shift.stop();
    if (view !== 'dashboard') {
      dashboard.stop();
      el('ticker').hidden = true;
    }
    if (view === 'dashboard') void dashboard.show();
    if (view === 'shift' && identity !== null) {
      void shift.show({
        departmentId: identity.departmentId,
        departmentName: identity.departmentName,
        seatTitle: identity.seatTitle,
      });
    }

    if (view === 'admin') admin.show();
    if (view === 'mine') void mine.show(null);

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
  navBoard.addEventListener('click', () => showView('board'));
  navReport.addEventListener('click', () => showView('report'));
  navInbox.addEventListener('click', () => showView('inbox'));
  navAdmin.addEventListener('click', () => showView('admin'));
  navMine.addEventListener('click', () => showView('mine'));
  navShift.addEventListener('click', () => showView('shift'));
  navDashboard.addEventListener('click', () => showView('dashboard'));
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
