/**
 * Walking the ladder — M3-01, ADR-0012.
 *
 * The owner's answer to Q-07 was an order: WhatsApp, then a call, then SMS. These tests are
 * about what "then" means when the first one fails, and — more importantly — about the three
 * ways a ladder can quietly stop being an escalation:
 *
 *   - stopping at the first rung forever, because something was "already attempted"
 *   - restarting on every pass after a success, so somebody already driving gets phoned
 *   - filling the board with failures for rungs the district has not bought yet
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { runNotifyPass } from '../notify.js';
import { loadLadder, setLadder } from '../../db/channelStore.js';
import { ladderFor, ladderForNotification, type LadderConfig } from '../../domain/channels.js';
import type { IncidentEvent } from '../../domain/events.js';
import type { Provider, ProviderSet, SendResult } from '../../channels/providers.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/** A provider that records what it was asked to send and answers however the test says. */
function fakeProvider(
  channel: Provider['channel'],
  behaviour: 'ok' | 'fail' | 'unconfigured',
  log: string[],
): Provider {
  return {
    channel,
    configured: behaviour !== 'unconfigured',
    why: behaviour === 'unconfigured' ? 'no account in this test' : null,
    send: (): Promise<SendResult> => {
      log.push(channel);
      return Promise.resolve(
        behaviour === 'ok'
          ? { ok: true, providerRef: null }
          : { ok: false, failure: `${channel}_rejected: the test said so` },
      );
    },
  };
}

function providerSet(
  behaviours: Partial<Record<Provider['channel'], 'ok' | 'fail' | 'unconfigured'>>,
  log: string[],
): ProviderSet {
  const byChannel = {
    whatsapp: fakeProvider('whatsapp', behaviours.whatsapp ?? 'unconfigured', log),
    voice: fakeProvider('voice', behaviours.voice ?? 'unconfigured', log),
    sms: fakeProvider('sms', behaviours.sms ?? 'unconfigured', log),
    gsm_sms: fakeProvider('gsm_sms', behaviours.gsm_sms ?? 'unconfigured', log),
    gsm_voice: fakeProvider('gsm_voice', behaviours.gsm_voice ?? 'unconfigured', log),
  };
  return { byChannel, anyConfigured: Object.values(byChannel).some((p) => p.configured) };
}

describe.skipIf(dbUrl === undefined)('the notification ladder (integration)', () => {
  let pool: Pool;
  let department: string;
  let seatId: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    department = await seedDepartment(pool, `Ladder Dept ${RUN}`);
    const actor = await seedActor(pool, {
      title: `Ladder Duty Officer ${RUN}`,
      departmentId: department,
    });
    seatId = actor.seatId;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  /** An incident routed to the department, so there is exactly one obligation. */
  async function incident(): Promise<string> {
    const incidentId = randomUUID();
    const at = new Date().toISOString();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: at,
        recordedAt: at,
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        payload: { reportId: randomUUID(), category: `ladder-${RUN}`, severity: 'critical' },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt: at,
        recordedAt: at,
        clientSeq: 2,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { departmentIds: [department], ruleId: 'manual' },
      } as unknown as IncidentEvent,
    ]);
    return incidentId;
  }

  async function attemptsOn(
    incidentId: string,
  ): Promise<{ channel: string; state: string; failure?: string }[]> {
    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    return state.notifications.map((n) => ({
      channel: n.channel,
      state: n.state,
      ...(n.failure === undefined ? {} : { failure: n.failure }),
    }));
  }

  //----------------------------------------------------------------------------

  describe('walking it', () => {
    it('tries WhatsApp first, and stops there when it works', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet({ whatsapp: 'ok', voice: 'ok', sms: 'ok' }, log),
      });

      // The order the owner asked for, and nothing beyond the first success. Trying the rest
      // would tell somebody the same thing three ways, which is how a district learns to
      // ignore the second and third.
      expect(log).toEqual(['whatsapp']);

      const attempts = await attemptsOn(id);
      expect(attempts.find((a) => a.channel === 'whatsapp')?.state).toBe('delivered');
    });

    it('falls through to the call when WhatsApp does not reach them', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet({ whatsapp: 'fail', voice: 'ok', sms: 'ok' }, log),
      });

      expect(log).toEqual(['whatsapp', 'voice']);

      // Both are recorded, separately. "WhatsApp failed, the call got through" and "we
      // notified them" are different facts, and only the first is useful at 03:00.
      const attempts = await attemptsOn(id);
      expect(attempts.find((a) => a.channel === 'whatsapp')?.state).toBe('failed');
      expect(attempts.find((a) => a.channel === 'voice')?.state).toBe('delivered');
    });

    it('records every rung that failed, in order, when none of them work', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet(
          { whatsapp: 'fail', voice: 'fail', sms: 'fail', gsm_sms: 'fail', gsm_voice: 'fail' },
          log,
        ),
      });

      expect(log).toEqual(['whatsapp', 'voice', 'sms', 'gsm_sms', 'gsm_voice']);

      const failures = (await attemptsOn(id)).filter((a) => a.state === 'failed');
      // Five rungs plus the in-app attempt, which fails only if the post is vacant — it is
      // not, so five.
      expect(failures).toHaveLength(5);
      for (const f of failures) expect(f.failure).toContain('the test said so');
    });

    /**
     * The rung with no account behind it is **skipped**, not failed.
     *
     * Until R-05 there are no providers. Recording each rung would put five
     * `not_configured` failures on every obligation of every incident — a board permanently
     * reading "nobody reached" for a reason that is a purchase order. The obligation is still
     * visibly unmet, because the in-app attempt stays pending until a human collects it.
     */
    it('skips a rung the district has not bought yet, without recording a failure', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet({ sms: 'ok' }, log),
      });

      // WhatsApp and voice are unconfigured, so they are never called at all.
      expect(log).toEqual(['sms']);

      const attempts = await attemptsOn(id);
      expect(attempts.map((a) => a.channel).sort()).toEqual(['sms', 'web']);
    });

    it('leaves nothing but the inbox when the district has no provider at all', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, { incidentIds: [id], providers: providerSet({}, log) });

      expect(log).toEqual([]);
      const attempts = await attemptsOn(id);
      // The obligation is still on the board: the in-app attempt is pending until somebody
      // collects it, which is what INV-03 needs.
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.channel).toBe('web');
      expect(attempts[0]?.state).toBe('pending');
    });
  });

  //----------------------------------------------------------------------------

  describe('it does not storm', () => {
    /**
     * The failure this is really about.
     *
     * A message delivered by WhatsApp at 02:00 must not be followed by a phone call at 02:00
     * and thirty seconds because the voice rung had never been attempted. That is a
     * notification storm aimed at somebody who is already awake and driving (INV-08).
     */
    it('does not restart the ladder on the next pass after a success', async () => {
      const log: string[] = [];
      const id = await incident();
      const providers = providerSet({ whatsapp: 'ok', voice: 'ok', sms: 'ok' }, log);

      await runNotifyPass(pool, { incidentIds: [id], providers });
      await runNotifyPass(pool, { incidentIds: [id], providers });
      await runNotifyPass(pool, { incidentIds: [id], providers });

      expect(log).toEqual(['whatsapp']);
    });

    it('does not retry a rung that already failed, on the same obligation', async () => {
      const log: string[] = [];
      const id = await incident();
      const providers = providerSet({ whatsapp: 'fail', voice: 'fail' }, log);

      await runNotifyPass(pool, { incidentIds: [id], providers });
      await runNotifyPass(pool, { incidentIds: [id], providers });

      // Two rungs, tried once each. A pass that retried everything it had already tried
      // would turn a scan loop into a message every fifteen seconds.
      expect(log).toEqual(['whatsapp', 'voice']);
    });

    it('gives each event its own sequence, so five rungs stay in causal order', async () => {
      const log: string[] = [];
      const id = await incident();
      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet({ whatsapp: 'fail', voice: 'fail', sms: 'ok' }, log),
      });

      // Every append used to take `state.eventCount + 1`, so a ladder of five rungs produced
      // ten events sharing two sequence numbers — and ordering fell to a random event id,
      // which is the exact mistake ADR-0008 exists to prevent.
      const events = await loadIncident(pool, id);
      const seqs = events.map((e) => e.clientSeq);
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });

  //----------------------------------------------------------------------------

  describe('sending one a different way', () => {
    /**
     * The owner asked for this directly: *the user should be able to choose to route a
     * notification to another channel when they need to.*
     */
    it('honours an override, instead of walking the configured ladder', async () => {
      const log: string[] = [];
      const id = await incident();

      await runNotifyPass(pool, {
        incidentIds: [id],
        providers: providerSet({ whatsapp: 'ok', gsm_sms: 'ok' }, log),
        only: ['gsm_sms'],
      });

      // "Send this by the modem" means the modem — not the modem after two minutes of
      // WhatsApp.
      expect(log).toEqual(['gsm_sms']);
    });
  });

  //----------------------------------------------------------------------------

  describe('the ladder itself', () => {
    it('starts from the district default the owner described', async () => {
      const config = await loadLadder(pool);
      expect(ladderFor(config, null)).toEqual(['whatsapp', 'voice', 'sms', 'gsm_sms', 'gsm_voice']);
    });

    it('lets a seat replace the district ladder entirely', async () => {
      const set = await setLadder(pool, seatId, ['voice', 'whatsapp'], {
        seatId: null,
        personId: null,
      });
      expect(set.ok).toBe(true);

      const config = await loadLadder(pool);
      // Replaced, not merged. "Stop trying to phone this post at night" is a real thing a
      // department will want to say, and a merge would make it unsayable — the same mistake
      // `targetsFor` shipped with for SLA overrides.
      expect(ladderFor(config, seatId)).toEqual(['voice', 'whatsapp']);
    });

    it('refuses a ladder with no rungs', async () => {
      const set = await setLadder(pool, seatId, [], { seatId: null, personId: null });
      expect(set.ok).toBe(false);
      // Silence expressed as an absence is exactly what ADR-0005 forbids. Say which channel
      // to use instead.
      if (!set.ok) expect(set.why).toContain('nobody is ever told');
    });

    it('refuses the same channel twice', async () => {
      const set = await setLadder(pool, seatId, ['sms', 'sms'], { seatId: null, personId: null });
      expect(set.ok).toBe(false);
    });

    it('records who reordered it, and what it was before', async () => {
      await setLadder(pool, seatId, ['sms', 'voice'], { seatId: null, personId: null });

      const { rows } = await pool.query<{ before: unknown; after: unknown }>(
        `SELECT before, after FROM config_event
          WHERE subject = 'channel_ladder' AND subject_id = $1
          ORDER BY seq DESC LIMIT 1`,
        [seatId],
      );
      // "Why did nobody get a call that night?" is answerable only if reordering left a
      // trace.
      expect((rows[0]?.after as { ladder: string[] }).ladder).toEqual(['sms', 'voice']);
      expect((rows[0]?.before as { ladder: string[] }).ladder).toEqual(['voice', 'whatsapp']);
    });
  });

  describe('choosing a ladder, as pure logic', () => {
    const config: LadderConfig = {
      district: [
        { channel: 'whatsapp', position: 1 },
        { channel: 'voice', position: 2 },
      ],
      bySeat: { 'seat-night': [{ channel: 'voice', position: 1 }] },
    };

    it('falls back to the district for a seat that has said nothing', () => {
      expect(ladderFor(config, 'seat-other')).toEqual(['whatsapp', 'voice']);
    });

    it('sorts by position rather than by insertion order', () => {
      const jumbled: LadderConfig = {
        district: [
          { channel: 'sms', position: 3 },
          { channel: 'whatsapp', position: 1 },
          { channel: 'voice', position: 2 },
        ],
        bySeat: {},
      };
      expect(ladderFor(jumbled, null)).toEqual(['whatsapp', 'voice', 'sms']);
    });

    it('treats an empty override as no override', () => {
      // A caller passing `[]` means "no preference", not "send this nowhere".
      expect(ladderForNotification(config, null, [])).toEqual(['whatsapp', 'voice']);
    });
  });
});
