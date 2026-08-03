/**
 * The notification ladder and the people at the end of it — M3-01.
 *
 * Two reads and two writes. The reads are both bulk: a notification pass asks about every
 * obligation on every open incident, and a round trip per seat would make the slowest moment
 * of the night the slowest job.
 */

import type { Pool } from './pool.js';
import type { Uuid } from '../domain/events.js';
import type { LadderChannel, LadderConfig, Recipient, Rung } from '../domain/channels.js';
import { inTransaction, recordChange, type ConfigActor } from './configStore.js';

export async function loadLadder(pool: Pool): Promise<LadderConfig> {
  const { rows } = await pool.query<{
    seat_id: string | null;
    channel: LadderChannel;
    position: number;
  }>('SELECT seat_id, channel, position FROM channel_ladder ORDER BY position');

  const district: Rung[] = [];
  const bySeat: Record<string, Rung[]> = {};

  for (const r of rows) {
    const rung = { channel: r.channel, position: r.position };
    if (r.seat_id === null) district.push(rung);
    else (bySeat[r.seat_id] ??= []).push(rung);
  }

  return { district, bySeat };
}

/**
 * Who currently holds a seat, and how to reach them.
 *
 * Returns a `Recipient` even when nobody holds the post — with `personId: null` — rather than
 * null. The caller has to record *something* against that obligation either way (INV-03), and
 * a "no such recipient" branch is how a vacant post ends up silently skipped.
 */
export async function recipientFor(pool: Pool, seatId: Uuid): Promise<Recipient> {
  const { rows } = await pool.query<{
    person_id: string | null;
    full_name: string | null;
    phone: string | null;
    placeholder: boolean | null;
  }>(
    `SELECT p.person_id, p.full_name, p.phone, p.placeholder
       FROM duty_assignment d
       JOIN person p ON p.person_id = d.person_id
      WHERE d.seat_id = $1 AND d.to_at IS NULL AND p.removed_at IS NULL
      LIMIT 1`,
    [seatId],
  );

  const row = rows[0];
  return {
    seatId,
    personId: row?.person_id ?? null,
    fullName: row?.full_name ?? null,
    phone: row?.phone ?? null,
    placeholder: row?.placeholder === true,
  };
}

/** Enough to write a notification that says something useful without saying too much. */
export async function incidentSummary(
  pool: Pool,
  incidentId: Uuid,
): Promise<{ readonly departmentName: string | null }> {
  const { rows } = await pool.query<{ name: string | null }>(
    `SELECT d.name
       FROM incident_event e
       CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'departmentIds') AS a(department_id)
       JOIN department d ON d.department_id = a.department_id::uuid
      WHERE e.incident_id = $1 AND e.type = 'routed'
      ORDER BY e.seq DESC
      LIMIT 1`,
    [incidentId],
  );
  return { departmentName: rows[0]?.name ?? null };
}

//------------------------------------------------------------------------------
// Editing it
//------------------------------------------------------------------------------

export type LadderResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Replace a ladder wholesale.
 *
 * Not "add a rung" and "remove a rung", because the thing being configured is an **order**,
 * and two operations that each change one row leave the district momentarily configured with
 * a ladder nobody chose — including, between two clicks, an empty one. Whole-list replacement
 * inside a transaction means there is no moment at which the district cannot reach anybody.
 *
 * An empty list is refused. A seat wanting no external notifications should be given a
 * ladder of one rung it can actually be reached on, or the district should say so out loud
 * rather than expressing it as an absence (ADR-0005).
 */
export async function setLadder(
  pool: Pool,
  seatId: Uuid | null,
  channels: readonly LadderChannel[],
  actor: ConfigActor,
): Promise<LadderResult> {
  if (channels.length === 0) {
    return {
      ok: false,
      why: 'a ladder with no rungs means nobody is ever told — say which channel to use instead',
    };
  }
  if (new Set(channels).size !== channels.length) {
    // The same channel twice would notify somebody twice on one obligation.
    return { ok: false, why: 'that ladder tries the same channel more than once' };
  }

  return inTransaction(pool, async (tx) => {
    const before = await tx.query<{ channel: string; position: number }>(
      seatId === null
        ? 'SELECT channel, position FROM channel_ladder WHERE seat_id IS NULL ORDER BY position'
        : 'SELECT channel, position FROM channel_ladder WHERE seat_id = $1 ORDER BY position',
      seatId === null ? [] : [seatId],
    );

    await tx.query(
      seatId === null
        ? 'DELETE FROM channel_ladder WHERE seat_id IS NULL'
        : 'DELETE FROM channel_ladder WHERE seat_id = $1',
      seatId === null ? [] : [seatId],
    );

    for (const [index, channel] of channels.entries()) {
      await tx.query(
        'INSERT INTO channel_ladder (seat_id, channel, position) VALUES ($1, $2, $3)',
        [seatId, channel, index + 1],
      );
    }

    // Recorded like every other configuration change. "Why did nobody get a call that
    // night?" is answerable only if somebody reordering the ladder left a trace.
    await recordChange(tx, {
      subject: 'channel_ladder',
      // The district ladder has no seat, and `subject_id` is not nullable. A fixed nil uuid
      // reads unambiguously as "the district's own" wherever the history is rendered.
      subjectId: seatId ?? '00000000-0000-0000-0000-000000000000',
      action: before.rowCount === 0 ? 'created' : 'updated',
      before: { ladder: before.rows.map((r) => r.channel) },
      after: { ladder: channels },
      actor,
    });

    return { ok: true as const };
  });
}
