/**
 * App shell boot. Scaffold for M0-12 — proves the app opens and captures a report with no
 * network. The real intake screen, and its 15-second budget, is M0-36.
 *
 * Two behaviours here are not scaffold and must survive into the real UI:
 *
 *   1. The connectivity rung is always stated, never implied.
 *   2. A queued entry never renders as delivered. "Saved" and "sent" are different words
 *      and the difference can matter to someone's life.
 */

import { Outbox } from '../../src/outbox/outbox.js';
import { IndexedDbOutboxStore, requestPersistence } from '../../src/outbox/adapters/indexeddb.js';
import { HttpTransport } from '../../src/outbox/adapters/httpTransport.js';
import type { IncidentEvent } from '../../src/domain/events.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

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
  const form = el<HTMLFormElement>('report');

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
  type Reachability = 'unknown' | 'reachable' | 'unreachable';
  let reachability: Reachability = 'unknown';

  function paintStatus(): void {
    const state =
      navigator.onLine === false || reachability === 'unreachable'
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
          : 'Checking connection. Reports are saved on this device either way.';
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
    // Ground truth: did we actually reach the server just now?
    reachability = result.offline ? 'unreachable' : 'reachable';
    paintStatus();
    await paintQueue();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);

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
    void trySync();
  });
  addEventListener('offline', () => {
    reachability = 'unreachable';
    paintStatus();
  });

  paintStatus();
  await paintQueue();
  void trySync();

  // Expose for the browser tests. Harmless, and it keeps the tests driving the real app
  // rather than a parallel harness that could drift from it.
  (globalThis as unknown as { __dnc: unknown }).__dnc = { outbox, store, trySync, paintQueue };
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

void boot();
