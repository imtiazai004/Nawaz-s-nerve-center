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
