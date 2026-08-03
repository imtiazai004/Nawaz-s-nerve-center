/**
 * The wall feed, against a real database — M4-05, ADR-0013.
 *
 * The tests that matter here are about **what the response does not contain**. A wall screen
 * cannot ask who is looking at it, so the only defence is that private data never reaches the
 * wire. That boundary is one careless join away from breaking, in a file somebody will edit
 * for an unrelated reason, so it is asserted against a live response rather than trusted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { buildWallFeed, handleWall } from '../wall.js';
import { wallSafetyViolations } from '../../domain/wall.js';
import { issueWallScreen, revokeWallScreen, resolveWallToken } from '../../db/wallStore.js';
import type { Identity } from '../../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];

/** Enough of an `IncomingMessage` for the handler. Nothing here touches the socket. */
function request(headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

const anonymous: Identity | null = null;

describe.skipIf(dbUrl === undefined)('the wall feed', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, join(process.cwd(), 'db', 'migrations'));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  describe('what it says', () => {
    it('answers with counts, never with rows', async () => {
      const feed = await buildWallFeed(pool, 'test screen');

      expect(typeof feed.district.openIncidents).toBe('number');
      expect(typeof feed.district.unassigned).toBe('number');

      // No incident ids anywhere. An id is a thing somebody can look up, and looking things
      // up is what a wall screen must not enable.
      expect(JSON.stringify(feed)).not.toMatch(/incidentId|reportId/);
    });

    it('carries an age for every reported panel', async () => {
      const feed = await buildWallFeed(pool, 'test screen');

      for (const row of [...feed.utilities, ...feed.presence]) {
        // Either it has been reported and says when, or it has not and says that.
        if (row.freshness === 'never') {
          expect(row.asOf).toBeNull();
        } else {
          expect(row.asOf).not.toBeNull();
          expect(typeof row.ageMinutes).toBe('number');
        }
      }
    });

    it('names its own condition, including what is missing', async () => {
      const feed = await buildWallFeed(pool, 'test screen');

      expect(feed.condition.map((c) => c.what)).toEqual([
        'Record backed up',
        'Second machine',
        'Alerts leave the building',
      ]);

      // Every one carries a sentence, not just a colour. A red dot with no words is a thing
      // people learn to stop seeing.
      for (const item of feed.condition) expect(item.detail.length).toBeGreaterThan(3);
    });

    it('gives the category the words the report form uses', async () => {
      const feed = await buildWallFeed(pool, 'test screen');

      // Never the raw code. "rta" beside "Fire" is a screen that looks unfinished, and on a
      // wall there is nobody to explain it to.
      for (const row of feed.categories) expect(row.label).not.toBe('rta');
    });
  });

  describe('what it must never say (ADR-0013 §1)', () => {
    it('passes its own safety check on a live response', async () => {
      const feed = await buildWallFeed(pool, 'test screen');

      expect(wallSafetyViolations(feed)).toEqual([]);
    });

    it('refuses the whole response rather than stripping a leak', async () => {
      // Stripping would let a change that started leaking private data ship, minus one field,
      // with nobody finding out. A blank screen in the DC office gets a phone call.
      const violations = wallSafetyViolations({
        district: { openIncidents: 2 },
        leak: 'call the DEO on 0333-1234567',
      });

      expect(violations).toHaveLength(1);
    });

    it('carries no personal name, number or coordinate for any officer on the wall', async () => {
      const feed = await buildWallFeed(pool, 'test screen');
      const text = JSON.stringify(feed);

      // Presence is by **seat**, so the panel reads "AAC Domel", not who currently holds it.
      // A seat title is a public post; a person's name on a wall is not the district's to put
      // there (ADR-0004 gives the reason this shape was available in the first place).
      expect(text).not.toMatch(/"fullName"/);
      expect(text).not.toMatch(/"personId"/);
      expect(text).not.toMatch(/"phone"/);
    });
  });

  describe('who may read it', () => {
    it('refuses a caller with no token and no session', async () => {
      const reply = await handleWall(pool, request(), new URL('http://x/wall'), anonymous);

      expect(reply.status).toBe(401);
    });

    it('accepts a screen presenting its token in the query string', async () => {
      const issued = await issueWallScreen(pool, {
        label: `test screen ${randomUUID().slice(0, 8)}`,
        issuedBy: null,
      });

      const reply = await handleWall(
        pool,
        request(),
        new URL(`http://x/wall?token=${encodeURIComponent(issued.token)}`),
        anonymous,
      );

      expect(reply.status).toBe(200);
    });

    it('accepts the same token as a bearer header', async () => {
      const issued = await issueWallScreen(pool, {
        label: `bearer ${randomUUID().slice(0, 8)}`,
        issuedBy: null,
      });

      const reply = await handleWall(
        pool,
        request({ authorization: `Bearer ${issued.token}` }),
        new URL('http://x/wall'),
        anonymous,
      );

      expect(reply.status).toBe(200);
    });

    it('stops accepting a revoked screen immediately', async () => {
      const issued = await issueWallScreen(pool, {
        label: `revoked ${randomUUID().slice(0, 8)}`,
        issuedBy: null,
      });

      await revokeWallScreen(pool, issued.screenId);

      const reply = await handleWall(
        pool,
        request({ authorization: `Bearer ${issued.token}` }),
        new URL('http://x/wall'),
        anonymous,
      );

      // A screen taken off the wall — or one whose token was photographed — stops working the
      // moment somebody says so, without a restart and without a deployment.
      expect(reply.status).toBe(401);
    });

    it('refuses a token that was never issued', async () => {
      expect(await resolveWallToken(pool, 'not-a-real-token')).toBeNull();
      expect(await resolveWallToken(pool, '')).toBeNull();
    });

    it('lets a signed-in person preview what a screen shows', async () => {
      const identity = {
        personId: randomUUID(),
        fullName: 'An Officer',
        seatId: null,
        seatTitle: null,
        departmentId: null,
        departmentName: null,
        tier: 'district',
        canBreakGlass: false,
        isAdministration: true,
      } as unknown as Identity;

      const reply = await handleWall(pool, request(), new URL('http://x/wall'), identity);

      expect(reply.status).toBe(200);
      expect((reply.body as { screen: string }).screen).toBe('preview');
    });

    it('refuses anything but a read', async () => {
      const reply = await handleWall(
        pool,
        request({}, 'POST'),
        new URL('http://x/wall'),
        anonymous,
      );

      // The wall has no write path at all — not a hidden one, not a privileged one
      // (ADR-0013 §4). This is the assertion that keeps it that way.
      expect(reply.status).toBe(405);
    });
  });

  describe('the token itself', () => {
    it('is shown once and is not recoverable from the record', async () => {
      const label = `once ${randomUUID().slice(0, 8)}`;
      const issued = await issueWallScreen(pool, { label, issuedBy: null });

      const stored = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM wall_screen WHERE screen_id = $1',
        [issued.screenId],
      );

      // A console that could redisplay it would be putting it in every nightly dump in
      // readable form, and the dump leaves the district (ADR-0011).
      expect(stored.rows[0]!.token_hash).not.toContain(issued.token);
    });

    it('records that a screen called home, so a dark one is visible', async () => {
      const issued = await issueWallScreen(pool, {
        label: `seen ${randomUUID().slice(0, 8)}`,
        issuedBy: null,
      });

      const before = await pool.query<{ last_seen_at: string | null }>(
        'SELECT last_seen_at FROM wall_screen WHERE screen_id = $1',
        [issued.screenId],
      );
      expect(before.rows[0]!.last_seen_at).toBeNull();

      await resolveWallToken(pool, issued.token);

      const after = await pool.query<{ last_seen_at: string | null }>(
        'SELECT last_seen_at FROM wall_screen WHERE screen_id = $1',
        [issued.screenId],
      );

      // A dark television in the corner of an office is exactly the failure nobody reports.
      expect(after.rows[0]!.last_seen_at).not.toBeNull();
    });
  });
});
