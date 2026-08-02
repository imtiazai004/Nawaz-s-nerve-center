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

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Identity {
  personId: string;
  fullName: string;
  seatId: string | null;
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
  let lastClientSeq = 0;

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
    // The board needs a seat to scope it, so it is offered only once signed in. Intake is
    // never behind this — an emergency can be captured signed out (INV-01).
    nav.hidden = !signedIn;
    if (!signedIn && boardView.hidden === false) showBoard(false);

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
    const stored = await outbox.enqueue(draft);
    lastIncidentId = incidentId;
    lastClientSeq = stored.clientSeq;

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

    lastClientSeq += 1;
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
  }
  interface BoardData {
    asOf: string;
    summary: {
      open: number;
      unacknowledged: number;
      overdue: number;
      worst: string | null;
      unassessed: number;
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
    );

    boardRows.replaceChildren(
      ...data.incidents.map((row) => {
        const div = document.createElement('div');
        div.className = 'row';
        div.dataset['overdue'] = String(row.overdue);
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
        meta.textContent = `${ago(row.occurredAt, at)}${
          row.escalationCount > 0 ? ` · escalated ${row.escalationCount}×` : ''
        }`;

        div.append(sev, cat, state, meta);
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
      boardScope.textContent =
        identity?.departmentId === null ? 'district-wide' : 'your department';
    } catch {
      // Offline. Keep what is on screen — and make sure it is labelled for what it is.
      paintBoardAge(lastBoard);
    }
  }

  function showBoard(show: boolean): void {
    showView(show ? 'board' : 'report');
  }

  function showView(view: 'report' | 'board' | 'detail'): void {
    reportView.hidden = view !== 'report';
    boardView.hidden = view !== 'board';
    detailView.hidden = view !== 'detail';

    // Detail is reached from the board, so the board tab stays current while reading one.
    navBoard.setAttribute('aria-current', view === 'report' ? 'false' : 'page');
    navReport.setAttribute('aria-current', view === 'report' ? 'page' : 'false');

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

  navBoard.addEventListener('click', () => showView('board'));
  navReport.addEventListener('click', () => showView('report'));
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
    detailHead.replaceChildren(h2, meta);

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

    detailValues.replaceChildren(
      valueBlock('Severity', s.severity, data.actors, 'not yet assessed'),
      valueBlock('Category', s.category, data.actors, 'unknown'),
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
