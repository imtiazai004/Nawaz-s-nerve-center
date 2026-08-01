/**
 * App shell boot. Scaffold for M0-12 and M0-19 — proves the app opens offline, signs in,
 * and captures a report either way. The real intake screen is M0-36.
 *
 * Three behaviours here are not scaffold and must survive into the real UI:
 *
 *   1. The connectivity rung is always stated, never implied — and "signed out" is a
 *      distinct state from "no signal", because they need different actions from the user.
 *   2. A queued entry never renders as delivered. "Saved" and "sent" are different words
 *      and the difference can matter to someone's life.
 *   3. An emergency can be recorded whether or not anyone is signed in (see below).
 */

import { Outbox } from '../../src/outbox/outbox.js';
import { IndexedDbOutboxStore, requestPersistence } from '../../src/outbox/adapters/indexeddb.js';
import { HttpTransport } from '../../src/outbox/adapters/httpTransport.js';
import type { IncidentEvent } from '../../src/domain/events.js';

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
  const loginForm = el<HTMLFormElement>('login');
  const loginView = el('loginView');
  const loginError = el('loginError');
  const offlineLoginNote = el('offlineLoginNote');
  const who = el('who');
  const whoName = el('whoName');

  /**
   * Connectivity is derived from whether we actually reached the server — never from
   * `navigator.onLine`.
   *
   * `navigator.onLine` reports whether the browser has *a* network interface, not whether
   * anything gets through. A handset attached to a cell tower with dead backhaul reports
   * `true` while nothing reaches the control room. Trusting it would put "Connected.
   * Reports are delivered immediately." on screen during exactly the outage the operator
   * most needs to know about — INV-02 applied to connectivity itself.
   *
   * The negative is still trustworthy: if the browser says there is no interface, there is
   * certainly no connection. So `false` is believed, `true` is not.
   */
  type Reachability = 'unknown' | 'reachable' | 'unreachable' | 'refused';
  let reachability: Reachability = 'unknown';
  let identity: Identity | null = null;

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
      // the difference between an operator understanding why a report will not send and
      // assuming the system is broken.
      whoName.textContent =
        identity.seatId === null
          ? `${identity.fullName} — no current duty assignment`
          : identity.fullName;
    }
    // Signing in needs the server, so say so rather than letting someone type into a form
    // that cannot possibly work.
    //
    // Keyed on *measured* reachability, not `navigator.onLine` — same reason as the status
    // line. Chromium reports `onLine: true` with the network cut, and so does a handset on
    // a tower with dead backhaul, so trusting it would leave the form enabled and the
    // operator wondering why nothing happens.
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
    // Ground truth, and three distinct outcomes rather than two: reached the server,
    // could not reach it, or was refused by it.
    reachability = result.authRequired ? 'refused' : result.offline ? 'unreachable' : 'reachable';

    if (result.authRequired && identity !== null) {
      // The session went away underneath us — expired, or revoked by an administrator.
      identity = null;
    }

    // Always repaint: the sign-in form's availability depends on measured reachability,
    // which this call is what establishes.
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
      // Offline. We cannot know whether the session is still good, and guessing either way
      // would be a claim we cannot support.
      identity = null;
      reachability = 'unreachable';
    }
    paintIdentity();
    paintStatus();
  }

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
      // Anything captured while signed out goes now.
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

  /**
   * Reporting is available whether or not anyone is signed in.
   *
   * This is deliberate, and it is the one place the app is more permissive than the server.
   * A duty officer whose session expired overnight, on a handset with no signal, must not
   * be told to sign in before they can record a road accident — they cannot sign in, and
   * refusing them would lose the emergency outright (INV-01).
   *
   * Nothing is weakened by it: the server still requires a session to accept anything, so
   * the report simply waits in the outbox until someone signs in. The trade is that it is
   * then attributed to whoever delivered it rather than whoever typed it, which is the
   * honest available answer — that person is identifiable and accountable, and the
   * alternative is no record at all.
   */
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(reportForm);

    const draft = {
      eventId: crypto.randomUUID(),
      incidentId: crypto.randomUUID(),
      type: 'reported',
      occurredAt: new Date().toISOString(),
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'mobile',
      payload: {
        reportId: crypto.randomUUID(),
        category: String(data.get('category') ?? 'other'),
        severity: String(data.get('severity') ?? 'moderate'),
        place: String(data.get('place') ?? ''),
      },
    } as unknown as Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>;

    // Durable first, always. The screen updates from storage, not from optimism.
    await outbox.enqueue(draft);
    await paintQueue();
    void trySync();
  });

  // These events are a useful *hint* that something changed — worth a sync attempt — but
  // they never set the displayed state on their own. Only a sync outcome does that.
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

  // Exposed for the browser tests. Harmless, and it keeps the tests driving the real app
  // rather than a parallel harness that could drift from it.
  (globalThis as unknown as { __dnc: unknown }).__dnc = {
    outbox,
    store,
    trySync,
    paintQueue,
    identity: () => identity,
  };
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

void boot();
