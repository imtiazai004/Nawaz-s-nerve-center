import type { IncidentEvent, Uuid } from '../domain/events.js';
import type { Pool } from './pool.js';

/**
 * The only way events enter and leave the system.
 *
 * There is no update method and no delete method, and that is not an oversight — it is
 * the interface making ADR-0001 impossible to violate by accident. The database enforces
 * the same rule independently (see 0001_event_store.sql), because one of the two will
 * eventually be bypassed.
 */

export interface AppendResult {
  /** Events written for the first time. */
  readonly appended: number;
  /** Events already present, recognised by `eventId` and skipped. */
  readonly duplicates: number;
}

interface Row {
  event_id: string;
  incident_id: string;
  type: string;
  occurred_at: string;
  recorded_at: string;
  client_seq: number;
  seq: string;
  actor_person_id: string | null;
  actor_seat_id: string | null;
  source_channel: string;
  payload: Record<string, unknown>;
}

function toDomain(r: Row): IncidentEvent {
  return {
    eventId: r.event_id,
    incidentId: r.incident_id,
    type: r.type,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    clientSeq: r.client_seq,
    actorPersonId: r.actor_person_id,
    actorSeatId: r.actor_seat_id,
    sourceChannel: r.source_channel,
    payload: r.payload,
  } as IncidentEvent;
}

/**
 * Append events. Re-appending an event already stored is a no-op, not an error.
 *
 * This is what lets an offline client retry a sync it is not sure landed, and what stops
 * a reconnect from replaying a queue into duplicates (INV-08). The caller does not have
 * to know which of its events the server already has.
 */
export async function append(pool: Pool, events: readonly IncidentEvent[]): Promise<AppendResult> {
  if (events.length === 0) return { appended: 0, duplicates: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      const b = i * 9;
      values.push(
        e.eventId,
        e.incidentId,
        e.type,
        e.occurredAt,
        e.clientSeq,
        e.actorPersonId,
        e.actorSeatId,
        e.sourceChannel,
        JSON.stringify(e.payload),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::timestamptz,$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb)`;
    });

    // recorded_at is set by the server, never by the client. A device with a wrong clock
    // can misreport when something happened; it must not be able to misreport when we
    // learned of it, because that is what escalation timing depends on.
    const res = await client.query(
      `INSERT INTO incident_event
         (event_id, incident_id, type, occurred_at, client_seq, actor_person_id, actor_seat_id, source_channel, payload)
       VALUES ${tuples.join(',')}
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      values,
    );

    await client.query('COMMIT');
    return { appended: res.rowCount ?? 0, duplicates: events.length - (res.rowCount ?? 0) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Every event for one incident, in fold order. Must match `compareEvents`. */
export async function loadIncident(
  pool: Pool,
  incidentId: Uuid,
): Promise<readonly IncidentEvent[]> {
  const res = await pool.query<Row>(
    `SELECT * FROM incident_event
      WHERE incident_id = $1
      ORDER BY occurred_at, client_seq, recorded_at, event_id`,
    [incidentId],
  );
  return res.rows.map(toDomain);
}

/**
 * Every event, grouped by incident, for incidents seen in the last `days`.
 *
 * One query, not one per incident. The board is the first thing that needs many incidents
 * at once, and folding N incidents with N round trips would make the district's live view
 * get slower exactly as the district gets busier.
 *
 * The SQL narrows candidates by recency and nothing else. **It does not decide what is
 * open** — that is the fold's answer, and expressing it here in a second language is how
 * the escalation rule nearly ended up defined twice (see `jobs/escalation.ts`).
 */
export async function loadRecentIncidents(
  pool: Pool,
  days = 7,
  limit = 500,
): Promise<readonly (readonly IncidentEvent[])[]> {
  const res = await pool.query<Row>(
    `WITH recent AS (
       SELECT incident_id, MIN(recorded_at) AS first_seen
         FROM incident_event
        WHERE recorded_at > now() - make_interval(days => $1)
        GROUP BY incident_id
        ORDER BY first_seen DESC
        LIMIT $2
     )
     SELECT e.*
       FROM incident_event e
       JOIN recent r ON r.incident_id = e.incident_id
      ORDER BY e.incident_id, e.occurred_at, e.client_seq, e.recorded_at, e.event_id`,
    [days, limit],
  );

  const byIncident = new Map<string, IncidentEvent[]>();
  for (const row of res.rows) {
    const events = byIncident.get(row.incident_id);
    if (events === undefined) byIncident.set(row.incident_id, [toDomain(row)]);
    else events.push(toDomain(row));
  }
  return [...byIncident.values()];
}

/**
 * The server's current position in the log.
 *
 * Exists because the alternative kept being "read a big page and take its `nextCursor`",
 * which is only the end of the log while the log is smaller than the page. Two tests were
 * written that way, passed for months, and started failing the day the test database grew
 * past ten thousand events — a cursor that silently stops meaning "the end" is exactly the
 * failure `loadSince` warns about in its own comment.
 */
export async function currentCursor(pool: Pool): Promise<number> {
  const res = await pool.query<{ max: string | null }>(
    'SELECT MAX(seq)::text AS max FROM incident_event',
  );
  return Number(res.rows[0]?.max ?? 0);
}

export interface Page {
  readonly events: readonly IncidentEvent[];
  /** Pass back as `cursor` to continue. */
  readonly nextCursor: number;
}

/**
 * Everything recorded since a cursor. The basis for realtime fan-out and for a client
 * catching up after reconnection — replay from a position, not from the beginning.
 *
 * The cursor is `seq`, not a timestamp. A timestamp cursor silently skips events that
 * share a `recorded_at`, and every event written in one transaction shares one — so a
 * client resuming mid-batch would lose the rest of it, permanently and invisibly. That is
 * the same root cause as the ordering bug in migration 0002.
 */
export async function loadSince(pool: Pool, cursor = 0, limit = 500): Promise<Page> {
  const res = await pool.query<Row>(
    `SELECT * FROM incident_event
      WHERE seq > $1
      ORDER BY seq
      LIMIT $2`,
    [cursor, limit],
  );
  const last = res.rows.at(-1);
  return {
    events: res.rows.map(toDomain),
    nextCursor: last ? Number(last.seq) : cursor,
  };
}

/**
 * Incidents whose first event reached us well after it happened.
 *
 * Not a diagnostic curiosity. This is the district's measured connectivity picture, and
 * the gap is exactly what the DC needs to see — an emergency that took two hours to
 * surface is an operational risk regardless of how fast the response was afterwards.
 */
export async function lateArrivals(
  pool: Pool,
  thresholdMinutes = 15,
): Promise<readonly { incidentId: Uuid; gapMinutes: number }[]> {
  const res = await pool.query<{ incident_id: string; gap_minutes: string }>(
    `SELECT incident_id,
            EXTRACT(EPOCH FROM (recorded_at - occurred_at)) / 60 AS gap_minutes
       FROM incident_event
      WHERE recorded_at - occurred_at > make_interval(mins => $1)
      ORDER BY gap_minutes DESC`,
    [thresholdMinutes],
  );
  return res.rows.map((r) => ({
    incidentId: r.incident_id,
    gapMinutes: Number(r.gap_minutes),
  }));
}
