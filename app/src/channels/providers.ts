/**
 * The things that actually send a message — M3-02, M3-03.
 *
 * Five rungs, one interface, and a fake behind each until the district has accounts (R-05).
 *
 * **An unconfigured provider fails. It never quietly succeeds.** This is the single most
 * important line in the file. The tempting shape — "no credentials, so skip it" — marks the
 * obligation met, and INV-03 exists because a notification that was never sent must be
 * visible as one. A ladder of five unconfigured rungs must produce five recorded failures
 * and an unmet obligation on the board, not silence.
 *
 * **Swapping a fake for the real thing is configuration, not a code change.** Each adapter
 * reads its credentials from the environment and reports itself unconfigured when they are
 * absent. Nothing in `jobs/notify.ts` knows which is which.
 *
 * Deliberately not here: retries and backoff. The notification pass already re-derives
 * obligations from state on every run, so a transient failure is retried by the next pass —
 * and a provider client with its own retry loop would fight that, turning one obligation
 * into a burst of messages during exactly the outage INV-08 is about.
 */

import type { LadderChannel, Recipient } from '../domain/channels.js';

export interface OutgoingMessage {
  readonly recipient: Recipient;
  readonly incidentId: string;
  /** Short, because it may become an SMS or be read aloud. Built by `renderMessage`. */
  readonly body: string;
  /**
   * Which pre-approved WhatsApp template this corresponds to.
   *
   * Meta requires business-initiated messages to use a template it has approved in advance
   * (R-05, `docs/09-notification-templates.md`). Named here rather than in the WhatsApp
   * adapter so the same identifier appears in the ledger for every channel — an operator
   * comparing what was sent by SMS and by WhatsApp is comparing the same thing.
   */
  readonly template: string;
}

export type SendResult =
  | { readonly ok: true; readonly providerRef: string | null }
  | { readonly ok: false; readonly failure: string };

export interface Provider {
  readonly channel: LadderChannel;
  /** False until the district has an account. Reported, never worked around. */
  readonly configured: boolean;
  /** Why it is not configured, in words an administrator can act on. */
  readonly why: string | null;
  send(message: OutgoingMessage): Promise<SendResult>;
}

//------------------------------------------------------------------------------
// What a notification says
//------------------------------------------------------------------------------

export interface MessageInput {
  readonly incidentId: string;
  readonly category: string;
  readonly severity: string;
  readonly departmentName: string | null;
  readonly reason: 'routed' | 'reassigned' | 'lost_responsibility' | 'escalated';
  readonly occurredAt: string | null;
}

/**
 * The words that go out.
 *
 * Constraints that shaped it, in order of how much they cost to get wrong:
 *
 * - **It may be read aloud.** A voice rung reads this to somebody who is asleep. No ids, no
 *   punctuation salad, no "incident 8f3c1a2e".
 * - **It may be one SMS.** 160 characters, and a Pakistani gateway charges per segment.
 * - **It must not contain anything private.** A notification travels through Meta, a gateway
 *   and a telephone network, and lands on a lock screen anybody standing nearby can read. It
 *   names the *kind* of emergency and never the reporter, the caller's number, or a location
 *   precise enough to identify a household.
 *
 * The one thing it does say is what to do: open the app. Everything sensitive lives behind
 * the sign-in, which is where the authority model can still see it (INV-05).
 */
export function renderMessage(input: MessageInput): string {
  const what =
    input.severity === 'unknown' ? input.category : `${input.severity} ${input.category}`;

  const opening =
    input.reason === 'escalated'
      ? 'ESCALATED, not yet acknowledged'
      : input.reason === 'lost_responsibility'
        ? 'No longer yours'
        : input.reason === 'reassigned'
          ? 'Reassigned to you'
          : 'New emergency';

  const who = input.departmentName === null ? '' : ` for ${input.departmentName}`;
  return `${opening}${who}: ${what}. Open the District Nerve Center to acknowledge.`;
}

/** Which pre-approved template a notification corresponds to. See `docs/09-...`. */
export function templateFor(reason: MessageInput['reason']): string {
  return `dnc_${reason}_v1`;
}

//------------------------------------------------------------------------------
// The adapters
//------------------------------------------------------------------------------

/**
 * A provider with no account behind it.
 *
 * Returns the reason it cannot send, every time, so the ledger fills with something an
 * administrator can act on rather than with silence. This is what every rung is until R-05.
 */
function unconfigured(channel: LadderChannel, why: string): Provider {
  return {
    channel,
    configured: false,
    why,
    send: (): Promise<SendResult> =>
      Promise.resolve({ ok: false, failure: `not_configured: ${why}` }),
  };
}

export interface ProviderEnv {
  readonly WHATSAPP_TOKEN?: string | undefined;
  readonly WHATSAPP_PHONE_ID?: string | undefined;
  readonly SMS_GATEWAY_URL?: string | undefined;
  readonly SMS_GATEWAY_KEY?: string | undefined;
  readonly VOICE_PROVIDER_URL?: string | undefined;
  readonly VOICE_PROVIDER_KEY?: string | undefined;
  readonly GSM_MODEM_PORT?: string | undefined;
}

/**
 * WhatsApp, through the Meta Business API.
 *
 * The longest lead time in the project, and not because of the code. Meta requires a
 * business account, a verified sending number, and **templates approved in advance** —
 * business-initiated messages cannot be free text. `docs/09-notification-templates.md` holds
 * the drafts the district submits.
 *
 * Note what this cannot do even once configured: reach anybody when the DC office's own line
 * is down. That is what the `gsm_*` rungs are for.
 */
export function whatsappProvider(env: ProviderEnv, http = fetch): Provider {
  const token = env.WHATSAPP_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_ID;

  if (token === undefined || phoneId === undefined) {
    return unconfigured(
      'whatsapp',
      'no Meta business account yet — needs a verified number and approved templates (R-05)',
    );
  }

  return {
    channel: 'whatsapp',
    configured: true,
    why: null,
    async send(message): Promise<SendResult> {
      try {
        const res = await http(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: message.recipient.phone,
            type: 'template',
            template: {
              name: message.template,
              language: { code: 'en' },
              components: [{ type: 'body', parameters: [{ type: 'text', text: message.body }] }],
            },
          }),
        });

        if (!res.ok) {
          // The status, not the body: a provider error body can contain the recipient's
          // number, and this string is written to the event log.
          return { ok: false, failure: `whatsapp_rejected: HTTP ${String(res.status)}` };
        }
        const body = (await res.json()) as { messages?: { id?: string }[] };
        return { ok: true, providerRef: body.messages?.[0]?.id ?? null };
      } catch (err) {
        return {
          ok: false,
          failure: `whatsapp_unreachable: ${err instanceof Error ? err.message : 'network error'}`,
        };
      }
    },
  };
}

/** SMS through a Pakistani gateway. Needs the server to have internet. */
export function smsProvider(env: ProviderEnv, http = fetch): Provider {
  const url = env.SMS_GATEWAY_URL;
  const key = env.SMS_GATEWAY_KEY;

  if (url === undefined || key === undefined) {
    return unconfigured('sms', 'no SMS gateway account yet (R-05)');
  }

  return {
    channel: 'sms',
    configured: true,
    why: null,
    async send(message): Promise<SendResult> {
      try {
        const res = await http(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to: message.recipient.phone, text: message.body }),
        });
        return res.ok
          ? { ok: true, providerRef: null }
          : { ok: false, failure: `sms_rejected: HTTP ${String(res.status)}` };
      } catch (err) {
        return {
          ok: false,
          failure: `sms_unreachable: ${err instanceof Error ? err.message : 'network error'}`,
        };
      }
    },
  };
}

/**
 * A voice call through a telephony provider.
 *
 * "Delivered" here means **the provider accepted the call**, not that anybody answered. The
 * distinction is the whole of INV-03: a ringing phone in an empty room is not somebody being
 * told, and the ledger must not claim otherwise. Acknowledgement is what settles an
 * obligation, and that only ever comes from the app.
 */
export function voiceProvider(env: ProviderEnv, http = fetch): Provider {
  const url = env.VOICE_PROVIDER_URL;
  const key = env.VOICE_PROVIDER_KEY;

  if (url === undefined || key === undefined) {
    return unconfigured('voice', 'no telephony provider yet (R-05)');
  }

  return {
    channel: 'voice',
    configured: true,
    why: null,
    async send(message): Promise<SendResult> {
      try {
        const res = await http(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to: message.recipient.phone, say: message.body }),
        });
        return res.ok
          ? { ok: true, providerRef: null }
          : { ok: false, failure: `voice_rejected: HTTP ${String(res.status)}` };
      } catch (err) {
        return {
          ok: false,
          failure: `voice_unreachable: ${err instanceof Error ? err.message : 'network error'}`,
        };
      }
    },
  };
}

//------------------------------------------------------------------------------
// The rung that survives an outage
//------------------------------------------------------------------------------

/**
 * A serial device with a SIM in it. The narrowest possible interface, on purpose.
 *
 * Real modems speak AT commands over a serial port. That is a driver's problem and not this
 * module's, so the seam is one method — and it means the whole GSM path is testable against a
 * fake without a `serialport` dependency in a system whose stack rule is "boring, single
 * node, operable by one person at 02:00" (ADR-0007).
 */
export interface GsmModem {
  /** Resolves when the modem reports the message queued to the network. */
  sendSms(to: string, text: string): Promise<void>;
  /** Places a call and plays a spoken message. Not every modem can; those reject. */
  placeCall(to: string, say: string): Promise<void>;
}

/**
 * SMS and voice from a modem in the DC office.
 *
 * **The only rungs that work when the district's line is down.** ADR-0011 puts the server in
 * the DC office so a district internet failure does not stop work; a notification ladder that
 * went dark in that same failure would make that pointless. The hardware is cheap and it is
 * on the district's list as part of R-05.
 */
export function gsmProvider(
  channel: 'gsm_sms' | 'gsm_voice',
  modem: GsmModem | null,
  env: ProviderEnv,
): Provider {
  if (modem === null) {
    return unconfigured(
      channel,
      env.GSM_MODEM_PORT === undefined
        ? 'no GSM modem attached to the district server (R-05) — this is the only rung that survives an internet outage'
        : `GSM modem configured on ${env.GSM_MODEM_PORT} but not responding`,
    );
  }

  return {
    channel,
    configured: true,
    why: null,
    async send(message): Promise<SendResult> {
      const to = message.recipient.phone ?? '';
      try {
        if (channel === 'gsm_sms') await modem.sendSms(to, message.body);
        else await modem.placeCall(to, message.body);
        return { ok: true, providerRef: null };
      } catch (err) {
        return {
          ok: false,
          failure: `${channel}_failed: ${err instanceof Error ? err.message : 'modem error'}`,
        };
      }
    },
  };
}

//------------------------------------------------------------------------------
// Assembling the set
//------------------------------------------------------------------------------

export interface ProviderSet {
  readonly byChannel: Readonly<Record<LadderChannel, Provider>>;
  /** True when nothing at all can leave the building. Worth saying out loud on a screen. */
  readonly anyConfigured: boolean;
}

export function buildProviders(
  env: ProviderEnv,
  options: { readonly modem?: GsmModem | null; readonly http?: typeof fetch } = {},
): ProviderSet {
  const http = options.http ?? fetch;
  const modem = options.modem ?? null;

  const byChannel: Record<LadderChannel, Provider> = {
    whatsapp: whatsappProvider(env, http),
    voice: voiceProvider(env, http),
    sms: smsProvider(env, http),
    gsm_sms: gsmProvider('gsm_sms', modem, env),
    gsm_voice: gsmProvider('gsm_voice', modem, env),
  };

  return {
    byChannel,
    anyConfigured: Object.values(byChannel).some((p) => p.configured),
  };
}
