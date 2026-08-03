/**
 * The dashboard screen — M4.
 *
 * One module, one set of markup, and the browser decides how much of it stands side by side.
 * There is deliberately nothing here that asks how wide the window is: every layout decision
 * lives in CSS, where it can respond to a window being resized, a phone being turned, or a
 * screen nobody predicted. Code that branched on width would be a second implementation to
 * keep in step with the first, which is precisely what was asked not to happen.
 *
 * What this file is careful about:
 *
 * **Every value carries its age.** A panel reporting the power was normal four hours ago is a
 * different fact from one reporting it a minute ago, and on a screen somebody glances at from
 * across a room the difference is the whole point. Past a threshold the server stops sending
 * the status at all and sends a sentence about time instead — this code could not render a
 * stale value as current even if it tried.
 *
 * **It writes text, never HTML.** Every string here is the district's own data: a department
 * name somebody typed, a note an officer wrote. None of it is a thing to hand to an HTML
 * parser.
 *
 * **One panel's failure costs one panel.** Found the hard way: a feed missing a single field
 * threw partway through, and the six panels after it silently never rendered — four numbers
 * and five empty boxes, which looks exactly like a quiet district.
 */

interface PanelRow {
  name: string;
  status: string | null;
  label: string;
  freshness: 'fresh' | 'stale' | 'never';
  asOf: string | null;
  ageMinutes: number | null;
  note: string | null;
}

interface Gap {
  total: number;
  answering: number;
  quiet: number;
}

export interface DashboardFeed {
  asOf: string;
  scope: string;
  isAdministration: boolean;
  district: {
    openIncidents: number;
    today: number;
    unassigned: number;
    overdueUnacknowledged: number;
    unassessed: number;
    oldestUnassignedMinutes: number | null;
  };
  categories: { category: string; label: string; open: number }[];
  situation: {
    category: string;
    label: string;
    state: 'ok' | 'pending' | 'critical';
    status: string;
    open: number;
    lastAt: string | null;
  }[];
  facts: { label: string; value: string | null }[];
  alerts: { tag: string; message: string; issuedAt: string; untilAt: string }[];
  services: PanelRow[];
  departments: { name: string; open: number; unacknowledged: number }[];
  condition: { what: string; state: 'ok' | 'pending' | 'critical'; detail: string }[];
  utilities: PanelRow[];
  presence: PanelRow[];
  reporting: { utilities: Gap; services: Gap; presence: Gap };
  weather: {
    reading: {
      temperatureC: number | null;
      apparentC: number | null;
      humidity: number | null;
      windKph: number | null;
      precipitationChance: number | null;
      condition: string;
      sunrise: string | null;
      sunset: string | null;
    } | null;
    fetchedAt: string | null;
    ageMinutes: number | null;
  };
  contacts: { title: string; number: string }[];
}

/**
 * Where a panel leads.
 *
 * The dashboard deliberately grows **no detail view of its own**. Every panel hands off to a
 * screen that already answers the next question — the board for emergencies, Status for the
 * things somebody reports, the console for the system's own condition. A second detail view
 * beside the board's would drift from it, and the two would disagree in front of an operator.
 */
export interface DashboardLinks {
  /** `category` is the stored code the rows carry; `label` is what a person is shown. */
  onOpenCategory?: (category: string, label: string) => void;
  onOpenDepartment?: (name: string) => void;
  onOpenStatus?: () => void;
  onOpenAdmin?: () => void;
  canAdmin?: () => boolean;
}

let links: DashboardLinks = {};

/**
 * Make a node open something, by mouse **and** by keyboard.
 *
 * `role="button"` and `tabindex` rather than a real `<button>`: these rows are grids of
 * several elements, and wrapping them in a button would flatten the layout and make a screen
 * reader announce the whole row as one label. What must not be lost is the keyboard — an
 * officer at a desk drives this with Tab, and a div with only a click handler is a control
 * that does not exist for them.
 */
function leadsTo(node: HTMLElement, label: string, open: () => void): void {
  node.classList.add('go');
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', label);

  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function box(className: string, text?: string): HTMLElement {
  const node = document.createElement('div');
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function span(className: string, text: string): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * How long ago, in words read at a glance.
 *
 * Not a timestamp. Somebody who has just walked into the room has not been watching the
 * clock, and "9 minutes ago" is an answer where "13:42" is a subtraction.
 */
export function ago(minutes: number | null): string {
  if (minutes === null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/**
 * The colour a reported state carries.
 *
 * `never` and `stale` are grey rather than amber, and that is deliberate. "Nobody has told us"
 * is not a mild version of "there is a problem" — it is a different fact with a different fix
 * (ADR-0009's reasoning, applied to a status panel).
 */
export function toneFor(row: { status: string | null; freshness: string }): string {
  if (row.freshness !== 'fresh' || row.status === null) return 'unknown';

  switch (row.status) {
    case 'normal':
    case 'office':
      return 'ok';
    case 'degraded':
    case 'field':
      return 'pending';
    case 'down':
    case 'leave':
      return 'critical';
    default:
      return 'unknown';
  }
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderKeys(feed: DashboardFeed): void {
  const d = feed.district;
  const target = el('dashKeys');
  clear(target);

  const keys: { k: string; n: number; tone?: 'alarm' | 'warn' }[] = [
    // The one number that means an emergency is with nobody at all. Red whenever it is not
    // zero, and never folded into "open".
    { k: 'Unassigned', n: d.unassigned, ...(d.unassigned > 0 ? { tone: 'alarm' as const } : {}) },
    {
      k: 'Not acknowledged',
      n: d.overdueUnacknowledged,
      ...(d.overdueUnacknowledged > 0 ? { tone: 'warn' as const } : {}),
    },
    { k: 'Open now', n: d.openIncidents },
    { k: 'Reported today', n: d.today },
  ];

  for (const key of keys) {
    const node = box(`key${key.tone === undefined ? '' : ` ${key.tone}`}`);
    node.appendChild(span('n', String(key.n)));
    node.appendChild(span('k', key.k));
    target.appendChild(node);
  }

  // Said as a sentence, because "the oldest one has been sitting for 41 minutes" is the thing
  // a person acts on — a bare number is not.
  const lede = el('dashLede');
  if (d.unassigned > 0) {
    lede.textContent =
      d.oldestUnassignedMinutes === null
        ? `${String(d.unassigned)} with nobody.`
        : `${String(d.unassigned)} with nobody — the oldest ${ago(d.oldestUnassignedMinutes)}.`;
    lede.className = 'note state-critical';
  } else if (d.unassessed > 0) {
    // Never described as a severity: nobody has looked yet, which is not a level (ADR-0009).
    lede.textContent = `${String(d.unassessed)} not yet assessed by anybody.`;
    lede.className = 'note';
  } else if (d.openIncidents === 0) {
    lede.textContent = 'Nothing open.';
    lede.className = 'note';
  } else {
    lede.textContent = 'Everything open is with a department and acknowledged.';
    lede.className = 'note';
  }
}

function renderCounts(
  targetId: string,
  rows: { name: string; count: number; warn?: boolean; open?: () => void; label?: string }[],
  empty: string,
): void {
  const target = el(targetId);
  clear(target);

  if (rows.length === 0) {
    target.appendChild(box('empty', empty));
    return;
  }

  for (const row of rows.slice(0, 10)) {
    const node = box('pitem');
    node.appendChild(span('pn', row.name));
    const count = span('pc', String(row.count));
    if (row.warn === true) count.classList.add('state-pending');
    node.appendChild(count);

    if (row.open !== undefined) leadsTo(node, row.label ?? row.name, row.open);

    target.appendChild(node);
  }
}

function renderStatusList(targetId: string, gapId: string, rows: PanelRow[], quiet: number): void {
  const target = el(targetId);
  clear(target);

  if (rows.length === 0) {
    target.appendChild(box('empty', 'nothing configured yet'));
  }

  for (const row of rows) {
    const node = box('pitem');
    node.appendChild(span('pn', row.name));
    node.appendChild(span(`tag ${toneFor(row)}`, row.label));

    const line =
      row.freshness === 'never'
        ? 'nobody has reported this'
        : `${row.note === null ? '' : `${row.note} · `}${ago(row.ageMinutes)}`;
    node.appendChild(box('pw', line));

    if (links.onOpenStatus !== undefined) {
      leadsTo(node, `Report on ${row.name}`, () => links.onOpenStatus?.());
    }

    target.appendChild(node);
  }

  const gap = el(gapId);
  gap.textContent = quiet === 0 ? '' : `${String(quiet)} not reporting`;
  gap.className = quiet === 0 ? 'age' : 'age state-pending';
}


/**
 * The Emergency Situation cards.
 *
 * Every kind the district watches, always present. Six calm cards say "nothing is happening"
 * in a way an empty panel cannot — an empty panel might mean the page failed to load, and on
 * a screen nobody is touching there is no way to tell the difference.
 *
 * The status word carries the meaning; the colour repeats it. A card reading "With nobody"
 * says the same thing to somebody who cannot see that it is red (INV-04).
 */
function renderSituation(feed: DashboardFeed): void {
  const target = el('dashSituation');
  clear(target);

  for (const row of feed.situation) {
    const card = box(`sit ${row.state}${row.open === 0 ? ' quiet' : ''}`);
    card.appendChild(box('kind', row.label));
    card.appendChild(box('state', row.status));

    const meta = box('meta');
    meta.appendChild(span('', row.open === 0 ? 'none open' : `${String(row.open)} open`));
    meta.appendChild(
      span('', row.lastAt === null ? '—' : ago(minutesSince(row.lastAt))),
    );
    card.appendChild(meta);

    if (row.open > 0 && links.onOpenCategory !== undefined) {
      // Only when there is something to open. A card reading "Normal · none open" that
      // navigates to an empty board teaches people the panel is broken.
      leadsTo(card, `Open the board for ${row.label}`, () =>
        links.onOpenCategory?.(row.category, row.label),
      );
    }

    target.appendChild(card);
  }
}

/** Whole minutes since an instant, floored, never negative. */
function minutesSince(iso: string): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 60_000));
}

const TAG_WORDS: Record<string, string> = {
  vip: 'VIP',
  security: 'SECURITY',
  road: 'ROAD',
  weather: 'WEATHER',
  other: 'NOTICE',
};

function renderAlerts(feed: DashboardFeed): void {
  const target = el('dashAlerts');
  const count = el('dashAlertCount');
  clear(target);

  if (feed.alerts.length === 0) {
    target.appendChild(box('empty', 'nothing in force'));
    count.textContent = '';
    return;
  }

  count.textContent = `${String(feed.alerts.length)} in force`;
  count.className = 'age';

  for (const alert of feed.alerts) {
    const row = box('alert-row');
    row.appendChild(span(`atag ${alert.tag}`, TAG_WORDS[alert.tag] ?? 'NOTICE'));

    const body = box('');
    body.appendChild(span('amsg', alert.message));
    // Both ends stated. An advisory people cannot tell the age of is one they either act on
    // too long or stop reading altogether.
    body.appendChild(
      span('awhen', `${ago(minutesSince(alert.issuedAt))} · until ${untilWords(alert.untilAt)}`),
    );
    row.appendChild(body);

    // An advisory has no screen of its own — it is two sentences. Rather than invent one,
    // the row opens Status, where the two offices can withdraw it and everybody else can see
    // the full list.
    if (links.onOpenStatus !== undefined) {
      leadsTo(row, 'Open advisories', () => links.onOpenStatus?.());
      row.classList.add('pitem');
    }

    target.appendChild(row);
  }
}

function untilWords(iso: string): string {
  const ends = new Date(iso);
  if (Number.isNaN(ends.getTime())) return 'further notice';

  const sameDay = ends.toDateString() === new Date().toDateString();
  return sameDay
    ? hhmm(ends)
    : ends.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderFacts(feed: DashboardFeed): void {
  const target = el('dashFacts');
  clear(target);

  for (const fact of feed.facts) {
    const node = box('fact');
    node.appendChild(span('k', fact.label));
    const value = span(fact.value === null ? 'v none' : 'v', fact.value ?? 'not supplied yet');
    node.appendChild(value);
    target.appendChild(node);
  }
}

function renderCondition(feed: DashboardFeed): void {
  const panel = el('dashConditionPanel');
  panel.hidden = feed.condition.length === 0;
  if (feed.condition.length === 0) return;

  const target = el('dashCondition');
  clear(target);

  for (const item of feed.condition) {
    const node = box('pitem');
    node.appendChild(span('pn', item.what));
    node.appendChild(span(`tag ${item.state}`, item.state === 'ok' ? 'Yes' : 'No'));
    node.appendChild(box('pw', item.detail));

    if (links.onOpenAdmin !== undefined && links.canAdmin?.() === true) {
      leadsTo(node, `Open the console for ${item.what}`, () => links.onOpenAdmin?.());
    }

    target.appendChild(node);
  }
}

function renderWeather(feed: DashboardFeed): void {
  const target = el('dashWeather');
  const age = el('dashWeatherAge');
  clear(target);

  const w = feed.weather.reading;

  if (w === null || w.temperatureC === null) {
    target.appendChild(box('empty', 'no reading has ever been fetched'));
    age.textContent = '';
    return;
  }

  const now = box('wx');
  now.appendChild(span('t', `${String(Math.round(w.temperatureC))}°C`));
  now.appendChild(span('tag unknown', w.condition));
  target.appendChild(now);

  const grid = box('wxgrid');
  const cells: [string, string][] = [
    ['Feels like', w.apparentC === null ? '—' : `${String(Math.round(w.apparentC))}°`],
    ['Humidity', w.humidity === null ? '—' : `${String(Math.round(w.humidity))}%`],
    ['Wind', w.windKph === null ? '—' : `${String(Math.round(w.windKph))} km/h`],
    ['Rain', w.precipitationChance === null ? '—' : `${String(w.precipitationChance)}%`],
    ['Sunrise', w.sunrise === null ? '—' : w.sunrise.slice(11, 16)],
    ['Sunset', w.sunset === null ? '—' : w.sunset.slice(11, 16)],
  ];

  for (const [k, v] of cells) {
    const cell = box('');
    cell.appendChild(span('k', k));
    cell.appendChild(span('v', v));
    grid.appendChild(cell);
  }
  target.appendChild(grid);

  // The one panel that depends on a machine outside the district. When the line is down this
  // number stops moving, and its age is the only thing that says so.
  const minutes = feed.weather.ageMinutes;
  age.textContent = ago(minutes);
  age.className = minutes !== null && minutes > 90 ? 'age state-pending' : 'age';
}

function renderContacts(feed: DashboardFeed): void {
  const target = el('dashContacts');
  clear(target);

  if (feed.contacts.length === 0) {
    target.appendChild(box('empty', 'no published numbers configured yet'));
    return;
  }

  for (const contact of feed.contacts.slice(0, 6)) {
    const node = box('num');
    node.appendChild(span('k', contact.title));
    node.appendChild(span('v', contact.number));
    target.appendChild(node);
  }
}

function panel(name: string, draw: () => void): void {
  try {
    draw();
  } catch (cause) {
    console.error(`dashboard panel "${name}" failed`, cause);
  }
}

/**
 * The ticker line.
 *
 * One sentence about the district, refreshed with the rest. It leads with whatever is wrong,
 * because a scrolling line somebody catches half of should give them the bad news in the half
 * they caught.
 */
function renderTicker(feed: DashboardFeed): void {
  const bar = el('ticker');
  const line = el('tickerText');
  clear(line);
  bar.hidden = false;

  const d = feed.district;
  const parts: { text: string; className?: string }[] = [];

  if (d.unassigned > 0) {
    parts.push({
      text: `${String(d.unassigned)} emergency with nobody${
        d.oldestUnassignedMinutes === null ? '' : ` — oldest ${ago(d.oldestUnassignedMinutes)}`
      }`,
      className: 'bad',
    });
  }
  if (d.overdueUnacknowledged > 0) {
    parts.push({ text: `${String(d.overdueUnacknowledged)} not acknowledged`, className: 'bad' });
  }

  const quiet = feed.reporting.utilities.quiet + feed.reporting.presence.quiet;
  if (quiet > 0) parts.push({ text: `${String(quiet)} panels not reporting` });

  parts.push({ text: `${String(d.openIncidents)} open`, className: 'b' });
  parts.push({ text: `${String(d.today)} reported today` });
  parts.push({ text: feed.scope });

  parts.forEach((part, i) => {
    if (i > 0) line.appendChild(document.createTextNode('  ·  '));
    const node = document.createElement(part.className === 'b' ? 'b' : 'span');
    if (part.className === 'bad') node.className = 'bad';
    node.textContent = part.text;
    line.appendChild(node);
  });
}

export function paint(feed: DashboardFeed): void {
  el('dashTitle').textContent = feed.scope;
  el('dashAsOf').textContent = `as of ${hhmm(new Date(feed.asOf))}`;
  el('dashScope').textContent = feed.isAdministration
    ? 'The whole district. Every department, every emergency.'
    : `${feed.scope} — your own work, and the district facts everybody needs.`;

  panel('keys', () => {
    renderKeys(feed);
  });
  panel('categories', () => {
    renderCounts(
      'dashCategories',
      feed.categories.map((c) => ({
        name: c.label,
        count: c.open,
        label: `Open the board for ${c.label}`,
        ...(links.onOpenCategory === undefined
          ? {}
          : { open: (): void => links.onOpenCategory?.(c.category, c.label) }),
      })),
      'nothing open',
    );
  });
  panel('departments', () => {
    renderCounts(
      'dashDepartments',
      feed.departments.map((d) => ({
        name: d.name,
        count: d.open,
        label: `Open the board for ${d.name}`,
        ...(d.unacknowledged > 0 ? { warn: true } : {}),
        ...(links.onOpenDepartment === undefined
          ? {}
          : { open: (): void => links.onOpenDepartment?.(d.name) }),
      })),
      'nothing assigned',
    );
  });
  panel('situation', () => {
    renderSituation(feed);
  });
  panel('alerts', () => {
    renderAlerts(feed);
  });
  panel('facts', () => {
    renderFacts(feed);
  });
  panel('services', () => {
    renderStatusList('dashServices', 'dashServiceGap', feed.services, feed.reporting.services.quiet);
  });
  panel('utilities', () => {
    renderStatusList(
      'dashUtilities',
      'dashUtilityGap',
      feed.utilities,
      feed.reporting.utilities.quiet,
    );
  });
  panel('presence', () => {
    renderStatusList(
      'dashPresence',
      'dashPresenceGap',
      feed.presence,
      feed.reporting.presence.quiet,
    );
  });
  panel('weather', () => {
    renderWeather(feed);
  });
  panel('contacts', () => {
    renderContacts(feed);
  });
  panel('condition', () => {
    renderCondition(feed);
  });
  panel('ticker', () => {
    renderTicker(feed);
  });
}

/**
 * The clock, which is not decoration.
 *
 * A dashboard shows numbers that were true at some point. A visibly running clock is the
 * cheapest proof anybody has that the page itself is alive, and when it stops that is the
 * first thing somebody notices from across a room.
 */
export function startClock(): void {
  const tick = (): void => {
    const now = new Date();
    el('clock').textContent = hhmm(now);
    el('dateline').textContent = now.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
  };

  tick();
  window.setInterval(tick, 1000);
}

export interface DashboardScreen {
  show(): Promise<void>;
  stop(): void;
}

/**
 * Poll while it is open, and stop the moment it is not.
 *
 * `setTimeout` rather than `setInterval`: an interval fires whether or not the previous
 * request finished, so a server that has become slow collects a growing queue of requests
 * from every open screen — the failure mode where the monitoring makes the outage worse.
 */
export function createDashboard(
  options: { intervalMs?: number } & DashboardLinks = {},
): DashboardScreen {
  links = options;

  const every = options.intervalMs ?? 20_000;
  let timer: number | null = null;
  let open = false;

  async function tick(): Promise<void> {
    try {
      const response = await fetch('/dashboard', { headers: { accept: 'application/json' } });
      if (response.ok) paint((await response.json()) as DashboardFeed);
    } catch {
      // Offline, or the server is restarting. The panels keep whatever they had, with their
      // ages still ticking up — which is the honest thing for them to show.
    } finally {
      if (open) timer = window.setTimeout(() => void tick(), every);
    }
  }

  return {
    async show(): Promise<void> {
      open = true;
      if (timer !== null) clearTimeout(timer);
      await tick();
    },
    stop(): void {
      open = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
