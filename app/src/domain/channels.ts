/**
 * How the system tries to reach somebody, and in what order — M3-01, ADR-0012.
 *
 * The owner's answer to Q-07 was an **order**, not a channel: WhatsApp first, a voice call
 * when WhatsApp does not reach them, and the ability to send a particular notification some
 * other way. This module holds that order and the rules for walking it.
 *
 * Four things here are load-bearing.
 *
 * **The in-app inbox is not a rung.** It always happens, in parallel, and it costs nothing.
 * A ladder that could contain it would let a district configure a seat whose only
 * notification is one nobody looks at.
 *
 * **An unconfigured provider is a failure, never a success.** Until R-05 there are no
 * accounts, so every rung below reports that it could not send. The alternative — treating
 * "no provider" as "nothing to do" — would mark the obligation met and put a green tick on
 * the one screen that must never lie about this (INV-03).
 *
 * **A placeholder number is not a number.** The same rule the in-app channel already
 * follows: a stand-in fills a post so the roster is complete, and nothing is ever sent to it.
 *
 * **Two internets.** WhatsApp, `voice` and `sms` all need the *server* to reach a provider.
 * The `gsm_*` rungs go out over the mobile network from a modem in the DC office and are the
 * only ones that survive the district's line dropping — which is the whole reason ADR-0011
 * puts the server in the DC office in the first place.
 */

export type LadderChannel = 'whatsapp' | 'voice' | 'sms' | 'gsm_sms' | 'gsm_voice';

/** Everything an attempt can be made through, including the one that is not a rung. */
export type NotifyChannel = LadderChannel | 'web';

export const LADDER_CHANNELS: readonly LadderChannel[] = [
  'whatsapp',
  'voice',
  'sms',
  'gsm_sms',
  'gsm_voice',
];

export function isLadderChannel(v: unknown): v is LadderChannel {
  return typeof v === 'string' && (LADDER_CHANNELS as readonly string[]).includes(v);
}

/** How a rung is described to an operator. Never the enum value. */
export const CHANNEL_NAMES: Readonly<Record<NotifyChannel, string>> = {
  web: 'in the app',
  whatsapp: 'WhatsApp',
  voice: 'a voice call',
  sms: 'SMS',
  gsm_sms: 'SMS from the district modem',
  gsm_voice: 'a call from the district modem',
};

/**
 * Which rungs keep working when the district's own line is down.
 *
 * Not a detail. ADR-0011 puts the server in the DC office precisely so a district internet
 * failure does not stop work — and a notification ladder that went entirely dark in that
 * same failure would be incoherent.
 */
export function survivesInternetOutage(channel: NotifyChannel): boolean {
  return channel === 'gsm_sms' || channel === 'gsm_voice';
}

export interface Rung {
  readonly channel: LadderChannel;
  readonly position: number;
}

export interface LadderConfig {
  /** Applied to any seat that has not set its own. */
  readonly district: readonly Rung[];
  /** seatId → that seat's own ladder. Replaces the district's entirely, never merges. */
  readonly bySeat: Readonly<Record<string, readonly Rung[]>>;
}

/**
 * The ladder for one seat.
 *
 * A seat's own ladder **replaces** the district default rather than merging with it. Merging
 * would mean a seat could never remove a rung — and "stop trying to phone this post at
 * night" is a real thing a department will want to say. The same reasoning as an SLA
 * override, and the same mistake avoided (`targetsFor` shipped wrong the first time by
 * merging when it should have replaced).
 */
export function ladderFor(config: LadderConfig, seatId: string | null): readonly LadderChannel[] {
  const own = seatId === null ? undefined : config.bySeat[seatId];
  const rungs = own ?? config.district;
  return [...rungs].sort((a, b) => a.position - b.position).map((r) => r.channel);
}

/**
 * The ladder for one notification, honouring a per-notification override.
 *
 * The owner asked for this explicitly — *the user should be able to choose to route a
 * notification to another channel when they need to*. An override names exactly what to try
 * and in what order; it does not append to the configured ladder, because "send this one by
 * SMS" means SMS and not "SMS after failing at WhatsApp for two minutes".
 */
export function ladderForNotification(
  config: LadderConfig,
  seatId: string | null,
  override?: readonly LadderChannel[],
): readonly LadderChannel[] {
  if (override !== undefined && override.length > 0) return override;
  return ladderFor(config, seatId);
}

export interface Recipient {
  readonly seatId: string;
  readonly personId: string | null;
  readonly fullName: string | null;
  readonly phone: string | null;
  /** The number is a stand-in, not theirs. Nothing is ever sent to it (migration 0008). */
  readonly placeholder: boolean;
}

export type SendVerdict =
  { readonly canSend: true } | { readonly canSend: false; readonly failure: string };

/**
 * Whether this rung can even be attempted for this person.
 *
 * Checked before the provider is called, so the recorded failure names something an
 * administrator can act on — "this post holds a stand-in number" rather than whatever a
 * gateway returns when it is handed nonsense.
 */
export function canAttempt(channel: LadderChannel, recipient: Recipient): SendVerdict {
  if (recipient.personId === null) {
    return {
      canSend: false,
      failure: 'no_duty_holder: nobody currently holds this seat, so nothing was sent',
    };
  }
  if (recipient.placeholder) {
    return {
      canSend: false,
      failure: 'placeholder_contact: this post holds a stand-in number, not a real one',
    };
  }
  if (recipient.phone === null || recipient.phone.trim() === '') {
    return {
      canSend: false,
      failure: `no_number: ${recipient.fullName ?? 'this person'} has no number to reach on ${CHANNEL_NAMES[channel]}`,
    };
  }
  return { canSend: true };
}

/**
 * What the district can actually reach anybody on, right now.
 *
 * For the administration console. A ladder every rung of which is unconfigured is a
 * department that will be told about nothing, and the console must say so rather than
 * showing five neatly ordered rows that all fail.
 */
export interface LadderHealth {
  readonly channel: LadderChannel;
  readonly position: number;
  readonly configured: boolean;
  readonly why: string | null;
  readonly survivesOutage: boolean;
}

export function describeLadder(
  rungs: readonly LadderChannel[],
  configured: (channel: LadderChannel) => { readonly ready: boolean; readonly why: string | null },
): readonly LadderHealth[] {
  return rungs.map((channel, index) => {
    const state = configured(channel);
    return {
      channel,
      position: index + 1,
      configured: state.ready,
      why: state.why,
      survivesOutage: survivesInternetOutage(channel),
    };
  });
}

/** True when no rung on this ladder can send anything. Nobody will ever be told. */
export function ladderIsDead(health: readonly LadderHealth[]): boolean {
  return health.length === 0 || health.every((h) => !h.configured);
}
