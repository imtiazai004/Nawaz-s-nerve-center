/**
 * The things that send a message — M3-02, M3-03.
 *
 * Every provider is tested against a fake, because none of them has an account behind it
 * until R-05 and none of them should need one to be proven correct.
 *
 * Two claims matter more than the rest.
 *
 * **An unconfigured provider fails.** It never quietly reports success. The tempting shape —
 * "no credentials, so nothing to do" — marks an obligation met, and INV-03 exists because a
 * notification that was never sent must be visible as one.
 *
 * **What goes out is safe to appear on a lock screen.** A notification travels through Meta,
 * a gateway and a telephone network, and lands somewhere anybody standing nearby can read it.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildProviders,
  gsmProvider,
  renderMessage,
  smsProvider,
  templateFor,
  voiceProvider,
  whatsappProvider,
  type GsmModem,
  type OutgoingMessage,
} from '../providers.js';
import { CHANNEL_NAMES, survivesInternetOutage } from '../../domain/channels.js';

const recipient = {
  seatId: 'seat-1',
  personId: 'person-1',
  fullName: 'Bakht Ullah Wazir',
  phone: '03001234567',
  placeholder: false,
};

function message(over: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    recipient,
    incidentId: 'inc-1',
    body: 'New emergency for Rescue 1122: critical fire. Open the District Nerve Center to acknowledge.',
    template: 'dnc_routed_v1',
    ...over,
  };
}

describe('an unconfigured provider fails rather than pretending', () => {
  it('reports every channel as unconfigured on a bare environment', async () => {
    const providers = buildProviders({});
    expect(providers.anyConfigured).toBe(false);

    for (const provider of Object.values(providers.byChannel)) {
      expect(provider.configured).toBe(false);

      const result = await provider.send(message());
      // Not `{ ok: true }`. Marking the obligation met is how a notification nobody sent
      // becomes a green tick on the one screen that must never lie about this.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toMatch(/^not_configured:/);
    }
  });

  it('says what is missing, in words somebody can act on', () => {
    const providers = buildProviders({});
    expect(providers.byChannel.whatsapp.why).toContain('Meta business account');
    expect(providers.byChannel.sms.why).toContain('SMS gateway');
    expect(providers.byChannel.voice.why).toContain('telephony provider');
    // The one that matters most on the night the district's line drops.
    expect(providers.byChannel.gsm_sms.why).toContain('survives an internet outage');
  });

  it('notices when a modem is configured but not answering', () => {
    const providers = buildProviders({ GSM_MODEM_PORT: 'COM3' });
    // Different from "no modem": one is a purchase, the other is a cable.
    expect(providers.byChannel.gsm_sms.why).toContain('not responding');
  });
});

describe('WhatsApp', () => {
  const env = { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_ID: '123' };

  it('sends through a pre-approved template, because Meta requires one', async () => {
    const http = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
    );
    const provider = whatsappProvider(env, http as unknown as typeof fetch);

    const result = await provider.send(message());
    expect(result.ok).toBe(true);

    const body = JSON.parse(http.mock.calls[0]![1]!.body as string) as {
      type: string;
      template: { name: string };
    };
    // Business-initiated messages cannot be free text (R-05). If this ever becomes `text`,
    // every alert stops sending the day Meta enforces it.
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('dnc_routed_v1');
  });

  it('reports a rejection without repeating the provider’s body back', async () => {
    const http = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { detail: '03001234567 is invalid' } }), {
          status: 400,
        }),
    );
    const result = await whatsappProvider(env, http as unknown as typeof fetch).send(message());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toContain('400');
      // The failure string is written into the event log. A provider error body can carry
      // the recipient's number, and the log is dumped into backups that leave the district.
      expect(result.failure).not.toContain('03001234567');
    }
  });

  it('reports being unable to reach Meta as unreachable, not as rejected', async () => {
    const http = vi.fn(async () => {
      throw new Error('ENOTFOUND graph.facebook.com');
    });
    const result = await whatsappProvider(env, http as unknown as typeof fetch).send(message());

    expect(result.ok).toBe(false);
    // Two different problems: Meta said no, and Meta could not be asked. The second one is
    // usually the district's own line, and the fix is the GSM rung.
    if (!result.ok) expect(result.failure).toMatch(/^whatsapp_unreachable:/);
  });
});

describe('SMS and voice', () => {
  it('sends an SMS through the gateway', async () => {
    const http = vi.fn(async () => new Response('', { status: 200 }));
    const provider = smsProvider(
      { SMS_GATEWAY_URL: 'https://gw.example/send', SMS_GATEWAY_KEY: 'k' },
      http as unknown as typeof fetch,
    );
    expect((await provider.send(message())).ok).toBe(true);
  });

  /**
   * "Delivered" means the provider accepted the call. Not that anybody answered.
   *
   * A ringing phone in an empty room is not somebody being told, and the ledger must not
   * claim otherwise. Only acknowledgement in the app settles the obligation.
   */
  it('treats an accepted call as sent, and nothing more than that', async () => {
    const http = vi.fn(async () => new Response('', { status: 202 }));
    const provider = voiceProvider(
      { VOICE_PROVIDER_URL: 'https://voice.example/call', VOICE_PROVIDER_KEY: 'k' },
      http as unknown as typeof fetch,
    );
    const result = await provider.send(message());
    expect(result.ok).toBe(true);
  });
});

describe('the modem in the DC office', () => {
  function fakeModem(): GsmModem & { sms: string[]; calls: string[] } {
    const sms: string[] = [];
    const calls: string[] = [];
    return {
      sms,
      calls,
      sendSms: async (to, text) => {
        sms.push(`${to}|${text}`);
      },
      placeCall: async (to, say) => {
        calls.push(`${to}|${say}`);
      },
    };
  }

  it('is the only rung that survives the district losing its internet', () => {
    // ADR-0011 puts the server in the DC office so an internet failure does not stop work. A
    // notification ladder that went dark in the same failure would make that pointless.
    expect(survivesInternetOutage('gsm_sms')).toBe(true);
    expect(survivesInternetOutage('gsm_voice')).toBe(true);
    expect(survivesInternetOutage('whatsapp')).toBe(false);
    expect(survivesInternetOutage('sms')).toBe(false);
    expect(survivesInternetOutage('voice')).toBe(false);
  });

  it('sends an SMS over the mobile network', async () => {
    const modem = fakeModem();
    const result = await gsmProvider('gsm_sms', modem, {}).send(message());

    expect(result.ok).toBe(true);
    expect(modem.sms[0]).toContain('03001234567');
    expect(modem.calls).toHaveLength(0);
  });

  it('places a call over the mobile network', async () => {
    const modem = fakeModem();
    expect((await gsmProvider('gsm_voice', modem, {}).send(message())).ok).toBe(true);
    expect(modem.calls).toHaveLength(1);
  });

  it('reports a modem that fails, rather than throwing at the caller', async () => {
    const broken: GsmModem = {
      sendSms: () => Promise.reject(new Error('no SIM')),
      placeCall: () => Promise.reject(new Error('no SIM')),
    };
    const result = await gsmProvider('gsm_sms', broken, {}).send(message());

    expect(result.ok).toBe(false);
    // A throw would abort the whole notification pass, and the rest of the district's
    // obligations with it.
    if (!result.ok) expect(result.failure).toContain('no SIM');
  });
});

describe('what the message says', () => {
  const base = {
    incidentId: 'inc-1',
    category: 'fire',
    severity: 'critical',
    departmentName: 'Rescue 1122',
    occurredAt: '2026-08-03T10:00:00.000Z',
  } as const;

  it('leads with what happened and who it is for', () => {
    const text = renderMessage({ ...base, reason: 'routed' });
    expect(text).toContain('critical fire');
    expect(text).toContain('Rescue 1122');
    expect(text).toContain('New emergency');
  });

  it('says an escalation is an escalation', () => {
    // An officer woken at 03:00 needs to know in the first three words whether this is new
    // or whether it is the one nobody answered.
    expect(renderMessage({ ...base, reason: 'escalated' })).toContain('ESCALATED');
  });

  it('tells the department that lost an incident that it lost it', () => {
    // A handover nobody announced is how two departments each assume the other went.
    expect(renderMessage({ ...base, reason: 'lost_responsibility' })).toContain('No longer yours');
  });

  /**
   * It lands on a lock screen anybody standing nearby can read.
   *
   * So it names the *kind* of emergency and nothing that identifies a person or a household.
   * Everything sensitive stays behind the sign-in, where the authority model can still see it
   * (INV-05).
   */
  it('carries nothing private', () => {
    const text = renderMessage({ ...base, reason: 'routed' });
    expect(text).not.toContain('inc-1');
    expect(text).not.toContain('03001234567');
    expect(text).not.toMatch(/\d{7,}/);
  });

  it('fits in one SMS segment', () => {
    // A Pakistani gateway charges per segment, and a message split in two arrives in two
    // pieces in an unpredictable order.
    for (const reason of ['routed', 'reassigned', 'lost_responsibility', 'escalated'] as const) {
      const text = renderMessage({ ...base, reason, category: 'road traffic accident' });
      expect(text.length).toBeLessThanOrEqual(160);
    }
  });

  it('says what to do, not only what happened', () => {
    expect(renderMessage({ ...base, reason: 'routed' })).toContain('acknowledge');
  });

  it('does not say a severity nobody assessed', () => {
    // ADR-0009: `unknown` is not a level, and an alert reading "unknown fire" would be the
    // system inventing an assessment on a lock screen.
    const text = renderMessage({ ...base, severity: 'unknown', reason: 'routed' });
    expect(text).not.toContain('unknown');
    expect(text).toContain('fire');
  });

  it('names one template per reason, so Meta can approve them all', () => {
    const names = (['routed', 'reassigned', 'lost_responsibility', 'escalated'] as const).map(
      templateFor,
    );
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^dnc_[a-z_]+_v1$/);
  });
});

describe('how a channel is described to an operator', () => {
  it('never shows the enum value', () => {
    // "gsm_sms" on a screen is a developer's word. "SMS from the district modem" is a fact
    // an administrator can reason about when the internet is down.
    expect(CHANNEL_NAMES.gsm_sms).toBe('SMS from the district modem');
    expect(CHANNEL_NAMES.web).toBe('in the app');
    for (const name of Object.values(CHANNEL_NAMES)) expect(name).not.toContain('_');
  });
});
