/**
 * The wall screen — M4-05, ADR-0013.
 *
 * This runs for months without anybody touching it, in a browser that will be opened once
 * and never again. Everything about it follows from that.
 *
 * **It never stops trying.** A failed poll is expected — the server is rebooted, the office
 * switch is replaced, somebody unplugs the wrong thing. The screen backs off, keeps trying
 * forever, and says on its face how long it has been out of contact.
 *
 * **It never shows a stale number as current.** The moment a poll fails, the age of what is
 * on screen becomes the most important thing on it. A dashboard that keeps displaying the
 * last good figures in the same style is worse than a blank one: a room full of officers
 * would act on it (ADR-0005).
 *
 * **It writes text, never HTML.** Every value comes from the district's own data, and the
 * only reason this file has no `innerHTML` with interpolation in it is that a department name
 * somebody typed is not a thing to hand to an HTML parser. The prototype this replaces built
 * every panel that way.
 */

const POLL_MS = 15_000;
/** After this long with no answer, the screen stops presenting itself as current. */
const STALE_AFTER_MS = 90_000;

interface PanelRow {
  id: string;
  name: string;
  status: string | null;
  label: string;
  freshness: 'fresh' | 'stale' | 'never';
  asOf: string | null;
  ageMinutes: number | null;
  note: string | null;
}

interface Feed {
  asOf: string;
  screen: string;
  district: {
    openIncidents: number;
    today: number;
    unassigned: number;
    overdueUnacknowledged: number;
    unassessed: number;
    oldestUnassignedMinutes: number | null;
  };
  categories: { category: string; label: string; open: number }[];
  condition: { what: string; state: 'ok' | 'pending' | 'critical'; detail: string }[];
  departments: { name: string; open: number; unacknowledged: number }[];
  utilities: PanelRow[];
  presence: PanelRow[];
  reporting: {
    utilities: { total: number; answering: number; quiet: number };
    presence: { total: number; answering: number; quiet: number };
  };
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

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/** A div with text, and optionally a class. The only way anything reaches the page. */
function box(className: string, text?: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * How long ago, in words somebody reads at a glance.
 *
 * Minutes up to an hour, then hours, then days. Not "13:42" — a wall screen is read by
 * someone who has just walked in and has not been watching the clock, and "9 minutes ago" is
 * an answer where a timestamp is a subtraction.
 */
function ago(minutes: number | null): string {
  if (minutes === null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/** The colour a reported status carries. `never` and `stale` are grey, and that is the point. */
function toneFor(row: PanelRow): string {
  if (row.freshness !== 'fresh' || row.status === null) return 'state-unknown';

  switch (row.status) {
    case 'normal':
    case 'office':
      return 'state-ok';
    case 'degraded':
    case 'field':
      return 'state-pending';
    case 'down':
    case 'leave':
      return 'state-critical';
    default:
      return 'state-unknown';
  }
}

function renderKeys(feed: Feed): void {
  const d = feed.district;
  const target = el('keys');
  clear(target);

  const keys: { legend: string; value: string; tone?: 'alarm' | 'warn' }[] = [
    {
      legend: 'Unassigned',
      value: String(d.unassigned),
      // The one number on this screen that means an emergency is with nobody at all. It is
      // red whenever it is not zero, and it is never folded into "open".
      ...(d.unassigned > 0 ? { tone: 'alarm' as const } : {}),
    },
    {
      legend: 'Not acknowledged',
      value: String(d.overdueUnacknowledged),
      ...(d.overdueUnacknowledged > 0 ? { tone: 'warn' as const } : {}),
    },
    { legend: 'Open now', value: String(d.openIncidents) },
    { legend: 'Reported today', value: String(d.today) },
  ];

  for (const key of keys) {
    const node = box(`key${key.tone === undefined ? '' : ` ${key.tone}`}`);
    node.appendChild(box('figure', key.value));
    node.appendChild(box('legend', key.legend));
    target.appendChild(node);
  }

  // Said as a sentence rather than left as a number, because "the oldest one has been sitting
  // for 41 minutes" is what a person acts on.
  const foot = el('foot');
  if (d.unassigned > 0 && d.oldestUnassignedMinutes !== null) {
    foot.textContent = `${String(d.unassigned)} emergency${d.unassigned === 1 ? '' : ' reports'} with nobody — oldest ${ago(d.oldestUnassignedMinutes)}`;
    foot.className = 'state-critical';
  } else if (d.unassessed > 0) {
    // Never described as a severity. Nobody has looked yet, which is not a level (ADR-0009).
    foot.textContent = `${String(d.unassessed)} not yet assessed by anybody`;
    foot.className = 'state-pending';
  } else {
    foot.textContent = 'District Administration Bannu · live';
    foot.className = '';
  }
}

function renderCounts(
  targetId: string,
  rows: { name: string; count: number; sub?: string }[],
  empty: string,
): void {
  const target = el(targetId);
  clear(target);

  if (rows.length === 0) {
    target.appendChild(box('age', empty));
    return;
  }

  for (const row of rows.slice(0, 8)) {
    const node = box('row');
    node.appendChild(box('name', row.name));

    const right = box('figure');
    right.textContent = String(row.count);
    if (row.sub !== undefined) right.classList.add(row.sub);
    node.appendChild(right);

    target.appendChild(node);
  }
}

function renderPanel(targetId: string, gapId: string, rows: PanelRow[], quiet: number): void {
  const target = el(targetId);
  clear(target);

  if (rows.length === 0) {
    target.appendChild(box('age', 'nothing configured yet'));
  }

  for (const row of rows) {
    const node = box('row');
    node.appendChild(box('name', row.name));

    const chip = box(`chip ${toneFor(row)}`, row.label);
    node.appendChild(chip);

    // The age sits under the name, always, on every row — including the fresh ones. A screen
    // that shows an age only when something is wrong teaches people that no age means fine,
    // which is the exact habit that makes a frozen panel invisible.
    const line =
      row.freshness === 'never'
        ? 'nobody has reported this'
        : `${row.note === null ? '' : `${row.note} · `}${ago(row.ageMinutes)}`;
    node.appendChild(box('age note', line));

    target.appendChild(node);
  }

  const gap = el(gapId);
  gap.textContent = quiet === 0 ? '' : `${String(quiet)} not reporting`;
  gap.className = quiet === 0 ? 'age' : 'age state-pending';
}

/**
 * The district's own machinery.
 *
 * Rendered exactly like the utilities panel, on purpose: whether the power is on and whether
 * the record is being backed up are the same kind of fact — something that is either working
 * or is not, that nobody finds out about by using the system.
 */
function renderCondition(feed: Feed): void {
  const target = el('condition');
  clear(target);

  for (const item of feed.condition) {
    const node = box('row');
    node.appendChild(box('name', item.what));
    node.appendChild(box(`chip state-${item.state}`, item.state === 'ok' ? 'Yes' : 'No'));
    node.appendChild(box('age note', item.detail));
    target.appendChild(node);
  }
}

function renderWeather(feed: Feed): void {
  const target = el('weather');
  const age = el('weatherAge');
  clear(target);

  const w = feed.weather.reading;

  if (w === null || w.temperatureC === null) {
    target.appendChild(box('age', 'no reading has ever been fetched'));
    age.textContent = '';
    return;
  }

  const now = box('weather-now');
  now.appendChild(box('figure', `${String(Math.round(w.temperatureC))}°C`));
  now.appendChild(box('chip state-unknown', w.condition));
  target.appendChild(now);

  const grid = box('weather-grid');
  const cells: [string, string][] = [
    ['Feels like', w.apparentC === null ? '—' : `${String(Math.round(w.apparentC))}°`],
    ['Humidity', w.humidity === null ? '—' : `${String(Math.round(w.humidity))}%`],
    ['Wind', w.windKph === null ? '—' : `${String(Math.round(w.windKph))} km/h`],
    ['Rain', w.precipitationChance === null ? '—' : `${String(w.precipitationChance)}%`],
    ['Sunrise', w.sunrise === null ? '—' : w.sunrise.slice(11, 16)],
    ['Sunset', w.sunset === null ? '—' : w.sunset.slice(11, 16)],
  ];

  for (const [legend, value] of cells) {
    const cell = box('');
    cell.appendChild(box('legend', legend));
    cell.appendChild(box('figure', value));
    grid.appendChild(cell);
  }
  target.appendChild(grid);

  // Weather is the one panel that depends on a machine outside the district. When the line is
  // down this number stops moving, and the age is the only thing that says so.
  const minutes = feed.weather.ageMinutes;
  age.textContent = ago(minutes);
  age.className = minutes !== null && minutes > 90 ? 'age state-pending' : 'age';
}

function renderContacts(feed: Feed): void {
  const target = el('contacts');
  clear(target);

  if (feed.contacts.length === 0) {
    target.appendChild(box('age', 'no published numbers configured'));
    return;
  }

  for (const contact of feed.contacts.slice(0, 6)) {
    const node = box('contact');
    node.appendChild(box('legend', contact.title));
    node.appendChild(box('figure', contact.number));
    target.appendChild(node);
  }
}

/**
 * One panel's failure must cost one panel.
 *
 * Found by shipping it: a server sending a feed without the `condition` field made
 * `renderCondition` throw, and because every panel was rendered in one straight line, the six
 * panels after it never ran. The screen showed four numbers and five empty boxes — no error,
 * no clue, and a room full of people believing there were no open emergencies.
 *
 * An unattended display is exactly where this matters. Nobody has a console open, nobody is
 * going to refresh, and the failure looks identical to a quiet district.
 */
function panel(name: string, draw: () => void): void {
  try {
    draw();
  } catch (cause) {
    console.error(`wall panel "${name}" failed`, cause);
  }
}

function render(feed: Feed): void {
  el('screen').hidden = false;
  el('boot').hidden = true;
  el('screenName').textContent = feed.screen === 'preview' ? 'preview' : feed.screen;

  panel('keys', () => {
    renderKeys(feed);
  });
  panel('categories', () => {
    renderCounts(
      'categories',
      feed.categories.map((c) => ({ name: c.label, count: c.open })),
      'nothing open',
    );
  });
  panel('condition', () => {
    renderCondition(feed);
  });
  panel('departments', () => {
    renderCounts(
      'departments',
      feed.departments.map((d) => ({
        name: d.name,
        count: d.open,
        ...(d.unacknowledged > 0 ? { sub: 'state-pending' } : {}),
      })),
      'nothing assigned',
    );
  });
  panel('utilities', () => {
    renderPanel('utilities', 'utilityGap', feed.utilities, feed.reporting.utilities.quiet);
  });
  panel('presence', () => {
    renderPanel('presence', 'presenceGap', feed.presence, feed.reporting.presence.quiet);
  });
  panel('weather', () => {
    renderWeather(feed);
  });
  panel('contacts', () => {
    renderContacts(feed);
  });

  el('asOf').textContent = `updated ${hhmm(new Date(feed.asOf))}`;
}

function tickClock(): void {
  const now = new Date();
  el('clock').textContent = hhmm(now);
  el('dateline').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

let lastGood = 0;

function markConnection(): void {
  const silentFor = Date.now() - lastGood;

  if (lastGood === 0 || silentFor < STALE_AFTER_MS) {
    document.body.classList.remove('disconnected');
    return;
  }

  document.body.classList.add('disconnected');
  el('stale').textContent =
    `NOT UPDATING — last contact with the server ${ago(Math.floor(silentFor / 60_000))}. ` +
    'Everything below is out of date.';
}

/**
 * Poll, forever, and never let one failure end the loop.
 *
 * `setTimeout` rather than `setInterval`: an interval fires whether or not the previous
 * request finished, so a server that has become slow gets a growing queue of requests from
 * every television in the district — the failure mode where the monitoring makes the outage
 * worse.
 */
async function poll(token: string | null): Promise<void> {
  try {
    const url = token === null ? '/wall' : `/wall?token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });

    if (response.status === 401) {
      el('boot').hidden = false;
      el('screen').hidden = true;
      el('bootMessage').textContent =
        'This screen is not registered. Ask the DC or AC Headquarter office to issue it a ' +
        'token, then open this page with ?token=… at the end of the address.';
      return;
    }

    if (response.ok) {
      render((await response.json()) as Feed);
      lastGood = Date.now();
    }
  } catch {
    // Expected. The server is restarted, a switch is replaced, somebody trips over a cable.
    // The screen's job in that moment is to keep trying and to stop claiming to be current.
  } finally {
    markConnection();
    setTimeout(() => void poll(token), POLL_MS);
  }
}

/**
 * The token is remembered so the URL only has to be typed once.
 *
 * A television gets its address entered by somebody standing on a chair. If the browser is
 * restarted — a power cut, a Windows update — it reopens its home page, and requiring the
 * query string again would mean a screen that silently stays blank until somebody notices
 * and fetches the chair.
 */
function token(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token');

  if (fromUrl !== null && fromUrl !== '') {
    try {
      window.localStorage.setItem('dnc_wall_token', fromUrl);
    } catch {
      // A kiosk with storage disabled still works for this session.
    }
    // Taken out of the address bar so the credential is not sitting in plain view on a wall.
    window.history.replaceState(null, '', window.location.pathname);
    return fromUrl;
  }

  try {
    return window.localStorage.getItem('dnc_wall_token');
  } catch {
    return null;
  }
}

tickClock();
setInterval(tickClock, 1000);
setInterval(markConnection, 5000);
void poll(token());
