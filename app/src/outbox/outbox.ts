/**
 * The outbox. The piece the whole project rests on.
 *
 * ADR-0002: offline is the substrate, not a feature. Every write goes here first, durably,
 * before any network attempt is made. Only once the server has confirmed it does an entry
 * leave. If the process dies between those two moments, the entry is still here on restart.
 *
 * Storage is behind a port so the logic can be tested exhaustively without a browser, and
 * so the same logic can run against IndexedDB in the field. The adapter is tested
 * separately, in a real browser — a fake IndexedDB would prove nothing about the thing
 * that matters (see `adapters/`).
 */

import type { IncidentEvent, Uuid } from '../domain/events.js';

export type EntryState =
  /** Waiting to be sent. */
  | 'pending'
  /** Handed to the network; outcome unknown. Stays durable until confirmed. */
  | 'inflight'
  /** The server rejected it as unusable. Needs a human, not another retry. */
  | 'blocked';

export interface OutboxEntry {
  readonly event: IncidentEvent;
  readonly state: EntryState;
  readonly attempts: number;
  /** Set when state is `blocked`. Shown to an operator. */
  readonly lastError?: string;
}

/**
 * Durable storage for the outbox.
 *
 * Every method must survive process death. An implementation that keeps entries in memory
 * satisfies the types and defeats the purpose.
 */
export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  delete(eventIds: readonly Uuid[]): Promise<void>;
  all(): Promise<readonly OutboxEntry[]>;
  /** Monotonic per incident, and durable across restarts. See ADR-0008. */
  nextClientSeq(incidentId: Uuid): Promise<number>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export interface SyncTransport {
  push(events: readonly IncidentEvent[]): Promise<{
    readonly accepted: readonly Uuid[];
    readonly rejected: readonly { readonly eventId: string | null; readonly reason: string }[];
    readonly cursor: number;
  }>;
  pull(cursor: number): Promise<{
    readonly events: readonly IncidentEvent[];
    readonly nextCursor: number;
    readonly hasMore: boolean;
  }>;
}

export interface SyncResult {
  readonly pushed: number;
  readonly blocked: number;
  readonly pulled: number;
  readonly stillPending: number;
  /** True when the network could not be reached. Not an error — the normal case here. */
  readonly offline: boolean;
}

export interface OutboxOptions {
  readonly store: OutboxStore;
  readonly transport: SyncTransport;
  /** Batch size per push. Kept modest: a weak link should not have to carry 500 events. */
  readonly batchSize?: number;
}

export class Outbox {
  private readonly store: OutboxStore;
  private readonly transport: SyncTransport;
  private readonly batchSize: number;
  private syncing = false;

  constructor(options: OutboxOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Record an event locally. Returns once it is durable — **not** once it is sent.
   *
   * The caller may show "saved", never "delivered". A user must never believe an emergency
   * has reached the control room when it is still on the handset
   * (docs/02-connectivity-ladder.md, rung L2).
   */
  async enqueue(event: Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>): Promise<IncidentEvent> {
    const clientSeq = await this.store.nextClientSeq(event.incidentId);
    const full = {
      ...event,
      clientSeq,
      // A placeholder only. The server assigns the authoritative value and it is never
      // read from here — a device clock must not be able to influence escalation timing.
      recordedAt: event.occurredAt,
    } as IncidentEvent;

    await this.store.put({ event: full, state: 'pending', attempts: 0 });
    return full;
  }

  async pendingCount(): Promise<number> {
    return (await this.store.all()).filter((e) => e.state !== 'blocked').length;
  }

  async blocked(): Promise<readonly OutboxEntry[]> {
    return (await this.store.all()).filter((e) => e.state === 'blocked');
  }

  /**
   * Push everything queued, then pull whatever we have missed.
   *
   * Safe to call at any time, including repeatedly and on every reconnect. Concurrent
   * calls collapse into one: two sync passes racing could push the same batch twice, which
   * the server would deduplicate, but which would also double-count attempts and confuse
   * the blocked-entry logic.
   */
  async sync(): Promise<SyncResult> {
    if (this.syncing) {
      return {
        pushed: 0,
        blocked: 0,
        pulled: 0,
        stillPending: await this.pendingCount(),
        offline: false,
      };
    }
    this.syncing = true;
    try {
      return await this.runSync();
    } finally {
      this.syncing = false;
    }
  }

  private async runSync(): Promise<SyncResult> {
    let pushed = 0;
    let blocked = 0;
    let pulled = 0;
    let offline = false;

    const queued = (await this.store.all())
      .filter((e) => e.state !== 'blocked')
      // Send in the order the operator created things, so the server sees causal order
      // even if it only ever receives one batch.
      .sort((a, b) => {
        if (a.event.occurredAt !== b.event.occurredAt) {
          return a.event.occurredAt < b.event.occurredAt ? -1 : 1;
        }
        return a.event.clientSeq - b.event.clientSeq;
      });

    for (let i = 0; i < queued.length; i += this.batchSize) {
      const batch = queued.slice(i, i + this.batchSize);

      // Mark in-flight *before* the request. If the process dies mid-flight the entry is
      // still here on restart, and re-sending is harmless because the server deduplicates
      // on eventId (INV-08).
      await Promise.all(
        batch.map((e) => this.store.put({ ...e, state: 'inflight', attempts: e.attempts + 1 })),
      );

      let result;
      try {
        result = await this.transport.push(batch.map((e) => e.event));
      } catch {
        // The normal case in Bannu, not an exception. Put everything back and stop trying;
        // nothing is lost and the next reconnect will pick it up.
        offline = true;
        await Promise.all(
          batch.map((e) => this.store.put({ ...e, state: 'pending', attempts: e.attempts + 1 })),
        );
        break;
      }

      const accepted = new Set(result.accepted);
      const rejected = new Map(result.rejected.map((r) => [r.eventId, r.reason]));

      // Delete only what the server confirmed it holds. Anything else stays queued —
      // releasing an event the server does not actually have would lose an emergency.
      const releasable = batch.filter((e) => accepted.has(e.event.eventId));
      if (releasable.length > 0) {
        await this.store.delete(releasable.map((e) => e.event.eventId));
        pushed += releasable.length;
      }

      for (const entry of batch) {
        if (accepted.has(entry.event.eventId)) continue;

        const reason = rejected.get(entry.event.eventId);
        if (reason !== undefined) {
          // Structurally unusable. Retrying forever would never succeed and would hide it.
          // Keep it, stop retrying, and surface it to an operator (INV-01: not lost).
          await this.store.put({
            ...entry,
            state: 'blocked',
            attempts: entry.attempts + 1,
            lastError: reason,
          });
          blocked += 1;
        } else {
          // Neither accepted nor rejected — the server said nothing about it. Assume the
          // worst and keep it.
          await this.store.put({ ...entry, state: 'pending', attempts: entry.attempts + 1 });
        }
      }

      await this.store.setCursor(result.cursor);
    }

    if (!offline) {
      try {
        let cursor = await this.store.getCursor();
        for (let guard = 0; guard < 100; guard++) {
          const page = await this.transport.pull(cursor);
          pulled += page.events.length;
          cursor = page.nextCursor;
          await this.store.setCursor(cursor);
          if (!page.hasMore) break;
        }
      } catch {
        offline = true;
      }
    }

    return { pushed, blocked, pulled, stillPending: await this.pendingCount(), offline };
  }
}
