/**
 * Slowing down guessing — M5's security review.
 *
 * The property under test is not "does it slow an attacker down". It is **that it never stops
 * anybody signing in**, because the obvious implementation of this feature — an account
 * lockout — is a denial of service an attacker can aim at a named duty officer, and the
 * district's numbers are semi-public. Ten wrong passwords against Rescue's duty officer at
 * 01:50 must not be able to lock out the person the system exists to reach.
 *
 * Every test below that asserts a *bound* is guarding that, not performance.
 */

import { describe, expect, it } from 'vitest';
import { LoginThrottle, withScryptSlot, sleep } from '../throttle.js';

const PHONE = '+923001234567';
const SOURCE = '10.0.0.9';

/** A clock the test moves, so nothing here waits on real time. */
function at(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('the login throttle', () => {
  describe('what it must never do', () => {
    /**
     * The whole reason this is a delay and not a lockout.
     *
     * An officer who has been targeted — or who simply cannot remember a password at 02:00 —
     * still gets an answer, every time, for ever. There is no attempt count that turns into a
     * refusal, because there is no number of wrong guesses that should stop a duty officer
     * reaching the system during an emergency. INV-01 outranks a failed-login counter.
     */
    it('never refuses, however many failures pile up', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 500; i += 1) throttle.fail(PHONE, SOURCE);

      const decision = throttle.decide(PHONE, SOURCE);

      // A delay, not a door closing. There is no "refused" to assert because the type has
      // no such state — which is the design, not an omission.
      expect(decision.delayMs).toBeGreaterThan(0);
      expect(Number.isFinite(decision.delayMs)).toBe(true);
    });

    /**
     * An unbounded backoff *is* a lockout wearing a different name.
     *
     * An officer facing a four-minute delay has been locked out in every sense that matters at
     * 02:00. The cap is what keeps this a nuisance to an attacker and not a barrier to a
     * person.
     */
    it('caps the delay, so a targeted officer is never waiting minutes', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 10_000; i += 1) throttle.fail(PHONE, SOURCE);

      expect(throttle.decide(PHONE, SOURCE).delayMs).toBeLessThanOrEqual(5_000);
    });

    it('lets an honest fumble through with no delay at all', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      // Caps lock on, then the wrong one of two passwords, then a typo. Nobody notices this.
      throttle.fail(PHONE, SOURCE);
      throttle.fail(PHONE, SOURCE);
      throttle.fail(PHONE, SOURCE);

      expect(throttle.decide(PHONE, SOURCE).delayMs).toBe(0);
    });
  });

  describe('what it does do', () => {
    it('makes each further guess cost more than the last', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 8; i += 1) throttle.fail(PHONE, SOURCE);
      const early = throttle.decide(PHONE, SOURCE).delayMs;

      for (let i = 0; i < 5; i += 1) throttle.fail(PHONE, SOURCE);
      const later = throttle.decide(PHONE, SOURCE).delayMs;

      expect(early).toBeGreaterThan(0);
      expect(later).toBeGreaterThan(early);
    });

    /**
     * The second attack, which a per-number counter alone would miss entirely.
     *
     * One password tried against all 79 offices leaves no single number with enough failures
     * to notice. The source is what sees it.
     */
    it('notices one password sprayed across many different numbers', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(`+9230000000${i}`, SOURCE);

      // A number never seen before, from that source, is already slowed.
      expect(throttle.decide('+923009999999', SOURCE).delayMs).toBeGreaterThan(0);
      // ...and the same fresh number from somewhere else is not.
      expect(throttle.decide('+923009999999', '10.0.0.250').delayMs).toBe(0);
    });

    it('forgets failures once the window has passed', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(PHONE, SOURCE);
      expect(throttle.decide(PHONE, SOURCE).delayMs).toBeGreaterThan(0);

      clock.advance(16 * 60 * 1000);

      // A mistyped password twenty minutes ago is not evidence of anything.
      expect(throttle.decide(PHONE, SOURCE).delayMs).toBe(0);
    });

    it('clears the number on a successful sign-in', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(PHONE, SOURCE);
      throttle.succeed(PHONE);

      expect(throttle.decide(PHONE, '10.0.0.77').delayMs).toBe(0);
    });

    /**
     * Success must not launder the source.
     *
     * Somebody spraying the district's list will eventually guess one weak password. If that
     * success also cleared their source, the single thing that had noticed the spray would be
     * erased by the attack working.
     */
    it('does not clear the source when one guess finally lands', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      for (let i = 0; i < 20; i += 1) throttle.fail(`+9230000000${i}`, SOURCE);
      throttle.succeed('+92300000005');

      expect(throttle.decide('+923007777777', SOURCE).delayMs).toBeGreaterThan(0);
    });
  });

  describe('what it reveals', () => {
    /**
     * The delay is decided before the password is checked and without asking whether the
     * account exists, so it cannot become the timing oracle `login` already avoids by hashing
     * even for numbers that do not exist.
     */
    it('treats a number with no account exactly like one with an account', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);

      // The throttle is never told which is which — it has no way to be.
      expect(throttle.decide('+920000000000', SOURCE)).toEqual(
        throttle.decide('+923001111111', SOURCE),
      );
    });

    it('counts without naming anybody', () => {
      const clock = at();
      const throttle = new LoginThrottle(clock.now);
      throttle.fail(PHONE, SOURCE);

      const snapshot = throttle.snapshot();

      expect(snapshot.numbersWithFailures).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain(PHONE);
      expect(JSON.stringify(snapshot)).not.toContain(SOURCE);
    });
  });

  describe('the scrypt slot', () => {
    /**
     * `login` returns null for a wrong password, and the slot returns "did not run" when the
     * box is saturated. Collapsing those into one value would make "your password is wrong"
     * and "the server is busy" indistinguishable to the caller.
     */
    it('distinguishes not running from running and returning null', async () => {
      const ran = await withScryptSlot(async () => null);

      expect(ran.ran).toBe(true);
      if (ran.ran) expect(ran.value).toBeNull();
    });

    it('runs work and hands back its value', async () => {
      const result = await withScryptSlot(async () => {
        await sleep(1);
        return 'derived';
      });

      expect(result).toEqual({ ran: true, value: 'derived' });
    });

    it('releases its slot even when the work throws', async () => {
      await expect(
        withScryptSlot(() => Promise.reject(new Error('scrypt exploded'))),
      ).rejects.toThrow('scrypt exploded');

      // If the slot leaked, this would eventually block rather than answer.
      expect(await withScryptSlot(async () => 'fine')).toEqual({ ran: true, value: 'fine' });
    });
  });
});
