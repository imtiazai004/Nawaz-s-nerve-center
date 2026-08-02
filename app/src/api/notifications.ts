/**
 * The operator's inbox — the receiving half of M0-32.
 *
 * There is no inbox table. This is a query over the event log: attempts addressed to my
 * seat that nothing has settled yet. One source of truth (root idea #4) — an inbox table
 * would be a second copy of a fact the log already holds, free to disagree with it.
 *
 * Collecting a message is what makes it **delivered**. Until an operator's client actually
 * fetches and confirms one, the attempt stays pending and the board carries it as an unmet
 * obligation, because "we queued it" is not "somebody knows" (INV-03).
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent, Uuid } from '../domain/events.js';
import type { Identity } from '../auth/sessions.js';

export interface InboxItem {
  readonly attemptId: Uuid;
  readonly incidentId: Uuid;
  readonly reason: string;
  readonly attemptedAt: string;
  /** Enough to act on without opening the incident first. */
  readonly severity: string;
  readonly category: string;
}

interface InboxRow {
  attempt_id: string;
  incident_id: string;
  reason: string;
  attempted_at: string;
  severity: string | null;
  category: string | null;
}

/**
 * Everything waiting for this seat.
 *
 * Scoped to the seat, never to the person: an officer who has handed over stops seeing the
 * post's messages immediately, and the officer who took it over starts (ADR-0004). That
 * falls out of the session re-resolving the seat on every request.
 */
export async function inbox(pool: Pool, seatId: Uuid): Promise<readonly InboxItem[]> {
  const res = await pool.query<InboxRow>(
    `SELECT n.payload->>'attemptId'  AS attempt_id,
            n.incident_id,
            n.payload->>'reason'     AS reason,
            n.occurred_at            AS attempted_at,
            (SELECT r.payload->>'severity' FROM incident_event r
              WHERE r.incident_id = n.incident_id AND r.type = 'reported'
              ORDER BY r.seq LIMIT 1) AS severity,
            (SELECT r.payload->>'category' FROM incident_event r
              WHERE r.incident_id = n.incident_id AND r.type = 'reported'
              ORDER BY r.seq LIMIT 1) AS category
       FROM incident_event n
      WHERE n.type = 'notified'
        AND n.payload->>'seatId' = $1
        AND NOT EXISTS (
              SELECT 1 FROM incident_event s
               WHERE s.type IN ('notification_delivered', 'notification_failed')
                 AND s.payload->>'attemptId' = n.payload->>'attemptId'
            )
      ORDER BY n.occurred_at ASC`,
    [seatId],
  );

  return res.rows.map((r) => ({
    attemptId: r.attempt_id,
    incidentId: r.incident_id,
    reason: r.reason,
    attemptedAt: r.attempted_at,
    severity: r.severity ?? 'unknown',
    category: r.category ?? 'unknown',
  }));
}

/**
 * Mark one attempt as having actually reached a human.
 *
 * Refuses to settle an attempt addressed to a different seat. Without that check any
 * authenticated caller could clear somebody else's unmet obligation off the board, which is
 * the one thing that must not be possible — a board that can be quietened by the wrong
 * person is worse than no board.
 */
export async function markSeen(
  pool: Pool,
  attemptId: Uuid,
  identity: Identity,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly status: number; readonly error: string }
> {
  if (identity.seatId === null) {
    return { ok: false, status: 403, error: 'no current duty assignment; you hold no seat' };
  }

  const res = await pool.query<{ incident_id: string; seat_id: string; channel: string }>(
    `SELECT incident_id,
            payload->>'seatId'  AS seat_id,
            payload->>'channel' AS channel
       FROM incident_event
      WHERE type = 'notified' AND payload->>'attemptId' = $1
      LIMIT 1`,
    [attemptId],
  );

  const row = res.rows[0];
  if (row === undefined) return { ok: false, status: 404, error: 'no such notification' };
  if (row.seat_id !== identity.seatId) {
    return { ok: false, status: 404, error: 'no such notification' };
  }

  const now = new Date().toISOString();
  const existing = await loadIncident(pool, row.incident_id);

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: row.incident_id,
      type: 'notification_delivered',
      occurredAt: now,
      recordedAt: now,
      clientSeq: existing.length + 1,
      // Who collected it, on the record. "Delivered" with nobody attached is the kind of
      // claim that cannot be checked afterwards.
      actorPersonId: identity.personId,
      actorSeatId: identity.seatId,
      sourceChannel: 'web',
      payload: { attemptId, seatId: row.seat_id, channel: row.channel },
    } as unknown as IncidentEvent,
  ]);

  return { ok: true };
}
