/**
 * The administration console — M1a, on screen.
 *
 * The two offices that are the authority for the whole district (ADR-0010) do four things
 * here, and the screen is organised as those four things rather than as the tables beneath
 * them:
 *
 *   Departments  — who exists, how to reach them, and what each one answers for
 *   Deadlines    — how long a department has to acknowledge (Q-06, as configuration)
 *   Performance  — the district whole, ranked by what needs attention
 *   History      — who changed what, and why
 *
 * Three rules the markup follows, all of them the same rule in different places:
 *
 * 1. **A destructive action always asks for a reason before it happens**, because the
 *    server requires one and the database requires one (migration 0007). Asking afterwards
 *    would mean discovering the refusal after the operator believed it was done.
 * 2. **Nothing missing is drawn as zero.** A department with no acknowledgements shows a
 *    dash, not `0`. Zero minutes is the best possible performance and no data is no
 *    performance at all (ADR-0005).
 * 3. **Text carries the meaning, colour only repeats it** (INV-04).
 *
 * This module owns no authority. Every request it makes is checked server-side, and hiding
 * the tab is a courtesy to the operator rather than a control (INV-05).
 */

import { mountRoster, type RosterPanel } from './roster.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

interface RoutingSignal {
  signalId: string;
  departmentId: string;
  kind: 'category' | 'keyword';
  pattern: string;
}

interface DepartmentView {
  departmentId: string;
  code: string;
  name: string;
  description: string | null;
  contactPhone: string | null;
  isAdministration: boolean;
  retiredAt: string | null;
  signals: RoutingSignal[];
  slaOverrides: Partial<Record<Severity, number>>;
  seats: number;
  vacantSeats: number;
}

interface SlaConfiguration {
  district: Record<Severity, number>;
  byDepartment: Record<string, Partial<Record<Severity, number>>>;
}

interface DepartmentPerformance {
  departmentId: string;
  name: string;
  retired: boolean;
  total: number;
  open: number;
  unacknowledged: number;
  overdue: number;
  escalated: number;
  closed: number;
  medianAckMinutes: number | null;
  meanAckMinutes: number | null;
  slowestAckMinutes: number | null;
  withinTarget: number | null;
  notificationsUnmet: number;
}

interface DistrictPerformance {
  asOf: string;
  windowDays: number;
  departments: DepartmentPerformance[];
  district: {
    total: number;
    open: number;
    overdue: number;
    unassigned: number;
    medianAckMinutes: number | null;
    notificationsUnmet: number;
  };
}

interface ConfigChange {
  subject: string;
  subjectId: string;
  action: string;
  actorSeatTitle: string | null;
  actorName: string | null;
  reason: string | null;
  recordedAt: string;
  after: unknown;
  before: unknown;
}

interface IntegrityFinding {
  code: string;
  severity: 'blocking' | 'serious' | 'note';
  what: string;
  consequence: string;
  count: number;
  examples: string[];
}

interface IntegrityReport {
  asOf: string;
  findings: IntegrityFinding[];
  summary: { blocking: number; serious: number; notes: number };
}

type Tab =
  | 'departments'
  | 'deadlines'
  | 'roster'
  | 'alerts'
  | 'backups'
  | 'performance'
  | 'history';

/** A number, or a dash. Never a zero standing in for "we do not know". */
function num(v: number | null, suffix = ''): string {
  return v === null ? '—' : `${String(v)}${suffix}`;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

export interface AdminConsole {
  /** Re-read everything the visible tab needs. */
  refresh(): Promise<void>;
  show(tab?: Tab): void;
}

export function mountAdmin(): AdminConsole {
  const view = el('adminView');
  const tabs = el('adminTabs');
  const body = el('adminBody');
  const error = el('adminError');

  let tab: Tab = 'departments';

  /**
   * Which render is allowed to paint.
   *
   * Every render takes a number and checks it is still the current one before touching the
   * DOM. Without it, a slow response from a tab the operator has **left** lands on top of
   * the tab they are now looking at — the browser test caught exactly that, painting the
   * deadlines list over a performance table that had just loaded.
   *
   * Worth more than the tidiness: the two screens that can lose this race are the district
   * performance table, which is the slowest request in the console, and the deadlines list,
   * which re-renders itself after every keystroke that saves. An operator would see numbers
   * that belong to a screen they are not on, with nothing to indicate it.
   */
  let generation = 0;

  function paint(mine: number, node: HTMLElement): void {
    if (mine !== generation) return;
    body.replaceChildren(node);
  }

  function fail(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError(): void {
    error.hidden = true;
    error.textContent = '';
  }

  /**
   * One request helper for the whole console.
   *
   * A failed configuration change is shown, always, and the screen is never repainted as
   * though it succeeded. This is the opposite of intake, which cannot refuse (INV-01) — and
   * the asymmetry is deliberate: nobody's emergency is lost because a form was rejected, and
   * a routing rule that silently failed to save is far worse than one that visibly did.
   */
  async function api<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      fail('Could not reach the server. Nothing was changed.');
      return null;
    }

    const raw = await res.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);

    if (!res.ok) {
      const message = (parsed as { error?: string }).error;
      fail(message ?? `The server refused that (${String(res.status)}).`);
      return null;
    }

    clearError();
    return parsed as T;
  }

  //--------------------------------------------------------------------------
  // Departments
  //--------------------------------------------------------------------------

  function signalRow(signal: RoutingSignal, onChanged: () => void): HTMLElement {
    const row = document.createElement('span');
    row.className = 'signal';
    row.dataset['kind'] = signal.kind;
    row.append(text('span', 'kind', signal.kind === 'category' ? 'is' : 'mentions'));
    row.append(text('span', 'pattern', signal.pattern));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link';
    remove.dataset['retireSignal'] = signal.signalId;
    remove.textContent = 'remove';
    remove.addEventListener('click', () => {
      // Asked before, not after. The server requires a reason and so does the table under
      // it, so collecting it afterwards would mean a refusal the operator did not expect.
      const reason = prompt(`Why is "${signal.pattern}" being removed?`);
      if (reason === null || reason.trim() === '') return;
      void (async () => {
        const done = await api('POST', `/admin/signals/${signal.signalId}/retire`, { reason });
        if (done !== null) onChanged();
      })();
    });
    row.append(remove);
    return row;
  }

  function departmentCard(dept: DepartmentView, onChanged: () => void): HTMLElement {
    const card = document.createElement('article');
    card.className = 'dept';
    card.dataset['department'] = dept.departmentId;
    card.dataset['retired'] = String(dept.retiredAt !== null);
    // Drives the card's left edge, so the two offices that are the district's authority are
    // distinguishable at a glance from the eighty departments they are the authority for
    // (ADR-0010). The card already says "administration" in words beside the name.
    card.dataset['administration'] = String(dept.isAdministration);

    const head = document.createElement('header');
    head.append(text('h4', 'name', dept.name));
    if (dept.isAdministration) head.append(text('span', 'tag admin', 'administration'));
    if (dept.retiredAt !== null) head.append(text('span', 'tag retired', 'retired'));
    card.append(head);

    if (dept.description !== null) card.append(text('p', 'desc', dept.description));

    const meta: string[] = [];
    meta.push(dept.contactPhone === null ? 'no office number' : dept.contactPhone);
    meta.push(`${String(dept.seats)} post${dept.seats === 1 ? '' : 's'}`);
    // A department with routing signals and nobody holding a post will be sent emergencies
    // it cannot be told about. Stated on the card rather than left to be discovered.
    if (dept.vacantSeats > 0) meta.push(`${String(dept.vacantSeats)} vacant`);
    const metaLine = text('p', 'meta', meta.join(' · '));
    if (dept.vacantSeats > 0 && dept.signals.length > 0) {
      metaLine.append(
        text('strong', 'warn', ' — has routing signals but a vacant post to notify'),
      );
    }
    card.append(metaLine);

    const signals = document.createElement('div');
    signals.className = 'signals';
    if (dept.signals.length === 0 && dept.retiredAt === null) {
      // Not an empty space. A department with no signals receives nothing, ever, and that
      // is a configuration gap rather than a neutral default (ADR-0005).
      signals.append(
        text('span', 'nosignals', 'No routing signals — nothing will ever reach this department'),
      );
    }
    for (const s of dept.signals) signals.append(signalRow(s, onChanged));
    card.append(signals);

    if (dept.retiredAt === null) {
      const form = document.createElement('form');
      form.className = 'addsignal';
      form.innerHTML = `
        <select aria-label="Signal kind">
          <option value="keyword">mentions</option>
          <option value="category">is exactly</option>
        </select>
        <input type="text" placeholder="fire, canal breach, heatstroke…" aria-label="Pattern" />
        <button type="submit">Add signal</button>`;
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const kind = form.querySelector('select')!.value;
        const input = form.querySelector('input')!;
        const pattern = input.value.trim();
        if (pattern === '') return;
        void (async () => {
          const added = await api('POST', `/admin/departments/${dept.departmentId}/signals`, {
            kind,
            pattern,
          });
          if (added !== null) {
            input.value = '';
            onChanged();
          }
        })();
      });
      card.append(form);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'link';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => {
      const name = prompt('New name for this department', dept.name);
      if (name === null || name.trim() === '') return;
      void (async () => {
        const done = await api('PATCH', `/admin/departments/${dept.departmentId}`, { name });
        if (done !== null) onChanged();
      })();
    });
    actions.append(rename);

    const phone = document.createElement('button');
    phone.type = 'button';
    phone.className = 'link';
    phone.textContent = dept.contactPhone === null ? 'Add office number' : 'Change number';
    phone.addEventListener('click', () => {
      const value = prompt('Office contact number', dept.contactPhone ?? '');
      if (value === null) return;
      void (async () => {
        const done = await api('PATCH', `/admin/departments/${dept.departmentId}`, {
          contactPhone: value,
        });
        if (done !== null) onChanged();
      })();
    });
    actions.append(phone);

    // The two administrative offices cannot be retired: the district would be left with no
    // authority and no way to restore one (ADR-0010). The server refuses it; not offering
    // the button keeps the operator from meeting that refusal by surprise.
    if (!dept.isAdministration) {
      const retire = document.createElement('button');
      retire.type = 'button';
      retire.className = 'link danger';
      retire.dataset['retire'] = dept.departmentId;
      const retiring = dept.retiredAt === null;
      retire.textContent = retiring ? 'Retire' : 'Bring back';
      retire.addEventListener('click', () => {
        const reason = prompt(
          retiring
            ? `Why is ${dept.name} being retired? Its routing signals stop immediately.`
            : `Why is ${dept.name} coming back?`,
        );
        if (reason === null || reason.trim() === '') return;
        void (async () => {
          const done = await api(
            'POST',
            `/admin/departments/${dept.departmentId}/${retiring ? 'retire' : 'restore'}`,
            { reason },
          );
          if (done !== null) onChanged();
        })();
      });
      actions.append(retire);
    }

    card.append(actions);
    return card;
  }

  /**
   * The configuration sweep, at the top of the departments screen (W-01).
   *
   * Here rather than on a tab of its own, because a report nobody opens is a report that
   * does not exist. This is the screen the two offices are on when they can act on a
   * finding, and every finding names its consequence rather than only its count — "37 vacant
   * posts" is a number somebody scrolls past.
   */
  function integrityPanel(report: IntegrityReport): HTMLElement {
    const panel = document.createElement('section');
    panel.id = 'integrity';
    panel.dataset['worst'] =
      report.summary.blocking > 0 ? 'blocking' : report.summary.serious > 0 ? 'serious' : 'clear';

    if (report.findings.length === 0) {
      panel.append(
        text(
          'p',
          'clear',
          'Every department has a post, a routing signal and somebody to call.',
        ),
      );
      return panel;
    }

    panel.append(
      text(
        'h4',
        'sectionhead',
        `Needs attention — ${String(report.summary.blocking)} blocking, ` +
          `${String(report.summary.serious)} serious`,
      ),
    );

    for (const f of report.findings) {
      const row = document.createElement('details');
      row.className = 'finding';
      row.dataset['severity'] = f.severity;
      // Blocking findings are open by default; a collapsed one is a finding nobody read.
      row.open = f.severity === 'blocking';

      const head = document.createElement('summary');
      head.append(text('span', 'sev', f.severity));
      head.append(text('span', 'what', f.what));
      head.append(text('span', 'count', String(f.count)));
      row.append(head);

      row.append(text('p', 'consequence', f.consequence));
      const list = document.createElement('ul');
      for (const e of f.examples) list.append(text('li', '', e));
      if (f.count > f.examples.length) {
        list.append(text('li', 'more', `… and ${String(f.count - f.examples.length)} more`));
      }
      row.append(list);
      panel.append(row);
    }

    return panel;
  }

  async function renderDepartments(mine: number): Promise<void> {
    const [departments, report] = await Promise.all([
      api<DepartmentView[]>('GET', '/admin/departments'),
      api<IntegrityReport>('GET', '/admin/integrity'),
    ]);
    if (departments === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminDepartments';

    if (report !== null) wrap.append(integrityPanel(report));

    const add = document.createElement('form');
    add.id = 'addDepartment';
    add.innerHTML = `
      <input type="text" id="newDeptName" placeholder="New department name" aria-label="New department name" required />
      <input type="text" id="newDeptPhone" placeholder="Office number (optional)" aria-label="Office number" />
      <button type="submit" id="addDepartmentSubmit">Add department</button>`;
    add.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = el<HTMLInputElement>('newDeptName').value.trim();
      const contactPhone = el<HTMLInputElement>('newDeptPhone').value.trim();
      if (name === '') return;
      void (async () => {
        const created = await api('POST', '/admin/departments', { name, contactPhone });
        if (created !== null) await renderDepartments(mine);
      })();
    });
    wrap.append(add);

    const live = departments.filter((d) => d.retiredAt === null);
    const retired = departments.filter((d) => d.retiredAt !== null);

    // Departments with no routing signals lead, because they are the ones that will never
    // receive anything — the configuration gap, at the top, where it gets fixed.
    const ordered = [...live].sort((a, b) => {
      const aGap = a.signals.length === 0 && !a.isAdministration ? 0 : 1;
      const bGap = b.signals.length === 0 && !b.isAdministration ? 0 : 1;
      if (aGap !== bGap) return aGap - bGap;
      return a.name.localeCompare(b.name);
    });

    const rerender = (): void => void renderDepartments(mine);
    wrap.append(
      text('p', 'meta', `${String(live.length)} live, ${String(retired.length)} retired`),
    );
    for (const d of ordered) wrap.append(departmentCard(d, rerender));
    if (retired.length > 0) {
      wrap.append(text('h4', 'sectionhead', 'Retired'));
      for (const d of retired) wrap.append(departmentCard(d, rerender));
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Deadlines (Q-06)
  //--------------------------------------------------------------------------

  function deadlineInput(
    departmentId: string | null,
    severity: Severity,
    value: number | null,
    placeholder: number,
    onChanged: () => void,
  ): HTMLElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '10080';
    input.className = 'ack';
    input.dataset['severity'] = severity;
    if (departmentId !== null) input.dataset['department'] = departmentId;
    input.value = value === null ? '' : String(value);
    input.placeholder = String(placeholder);

    // Whether this department has set its own, or is showing the district's.
    //
    // Without it the two are the same rectangle with the same number in it, and an
    // administrator cannot tell "this department chose 15" from "nobody has decided, so it
    // inherits 15". They behave differently the moment the district value changes, and this
    // whole screen exists so somebody can see what has actually been decided.
    input.dataset['set'] = String(value !== null);
    input.setAttribute(
      'aria-label',
      value === null
        ? `${severity} deadline, inheriting the district's ${String(placeholder)} minutes`
        : `${severity} deadline, set to ${String(value)} minutes`,
    );

    input.addEventListener('change', () => {
      const minutes = Number(input.value);
      if (!Number.isInteger(minutes) || minutes < 1) return;
      void (async () => {
        const done = await api('PUT', '/admin/sla', {
          ...(departmentId === null ? {} : { departmentId }),
          severity,
          ackMinutes: minutes,
        });
        if (done !== null) onChanged();
      })();
    });
    return input;
  }

  async function renderDeadlines(mine: number): Promise<void> {
    const [sla, departments] = await Promise.all([
      api<SlaConfiguration>('GET', '/admin/sla'),
      api<DepartmentView[]>('GET', '/admin/departments'),
    ]);
    if (sla === null || departments === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminDeadlines';
    wrap.append(
      text(
        'p',
        'note',
        'Minutes to acknowledge. The district value applies unless a department sets its own. ' +
          '“Not yet assessed” is not a severity level — it is how long the district will wait ' +
          'for a human to look at a report nobody has judged.',
      ),
    );

    // The heading sits outside the grid. Inside it, it took the first cell and pushed the
    // five severities onto four columns plus an orphan — which read as though "not yet
    // assessed" belonged to a different group.
    wrap.append(text('h4', 'sectionhead', 'District default'));

    const district = document.createElement('div');
    district.className = 'deadlines district';
    for (const severity of SEVERITIES) {
      const cell = document.createElement('label');
      cell.className = 'cell';
      cell.append(
        text('span', 'label', severity === 'unknown' ? 'not yet assessed' : severity),
        deadlineInput(null, severity, sla.district[severity], sla.district[severity], () =>
          void renderDeadlines(mine),
        ),
      );
      district.append(cell);
    }
    wrap.append(district);

    wrap.append(text('h4', 'sectionhead', 'Per department'));
    wrap.append(
      text(
        'p',
        'meta',
        'A greyed number is the district value being inherited, not a choice this department ' +
          'has made — type over it to set one, and clear it to go back. A department may be ' +
          'given more time, not only less.',
      ),
    );

    // Column headings. Five unlabelled boxes of numbers in a row is not a table anybody can
    // read, and getting the wrong column here sets the wrong deadline on the wrong severity.
    const heads = document.createElement('div');
    heads.className = 'deadlines headings';
    heads.append(text('span', 'deptname', ''));
    for (const severity of SEVERITIES) {
      heads.append(text('span', 'label', severity === 'unknown' ? 'not assessed' : severity));
    }
    wrap.append(heads);

    for (const dept of departments.filter((d) => d.retiredAt === null)) {
      const row = document.createElement('div');
      row.className = 'deadlines';
      row.dataset['department'] = dept.departmentId;
      row.append(text('span', 'deptname', dept.name));
      for (const severity of SEVERITIES) {
        row.append(
          deadlineInput(
            dept.departmentId,
            severity,
            sla.byDepartment[dept.departmentId]?.[severity] ?? null,
            sla.district[severity],
            () => void renderDeadlines(mine),
          ),
        );
      }
      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Rosters — the same component a department sees, with a department picker
  //--------------------------------------------------------------------------

  /**
   * The administration's door onto `web/src/roster.ts`.
   *
   * Departments that cannot be reached lead the list, because a post with nobody in it is
   * the thing that silently swallows an alert. Everything below is the same markup a
   * department officer sees on their own screen — one component, two doors, so the two views
   * cannot drift into disagreeing about what a roster is.
   */
  async function renderRosters(mine: number): Promise<void> {
    const departments = await api<DepartmentView[]>('GET', '/admin/departments');
    if (departments === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminRosters';

    const picker = document.createElement('select');
    picker.id = 'rosterPicker';
    picker.setAttribute('aria-label', 'Department');
    for (const d of departments.filter((d) => d.retiredAt === null)) {
      const label = d.vacantSeats > 0 ? `${d.name} — ${String(d.vacantSeats)} vacant` : d.name;
      picker.append(new Option(label, d.departmentId));
    }
    wrap.append(picker);

    const panelHost = document.createElement('div');
    panelHost.id = 'rosterPanel';
    wrap.append(panelHost);

    paint(mine, wrap);
    if (mine !== generation) return;

    const panel: RosterPanel = mountRoster({
      container: panelHost,
      fail,
      clearError,
    });
    picker.addEventListener('change', () => void panel.show(picker.value));
    if (picker.value !== '') await panel.show(picker.value);
  }

  //--------------------------------------------------------------------------
  // Alerts — the notification ladder (M3-01, ADR-0012)
  //--------------------------------------------------------------------------

  interface LadderRung {
    channel: string;
    position: number;
    configured: boolean;
    why: string | null;
    survivesOutage: boolean;
  }
  interface LadderView {
    district: LadderRung[];
    nothingCanBeSent: boolean;
    channels: string[];
  }

  const CHANNEL_LABEL: Readonly<Record<string, string>> = {
    whatsapp: 'WhatsApp',
    voice: 'a voice call',
    sms: 'SMS',
    gsm_sms: 'SMS from the district modem',
    gsm_voice: 'a call from the district modem',
  };

  /**
   * What the district tries, in what order, and what actually works.
   *
   * The important thing on this screen is not the ordering control — it is the second column.
   * A ladder of five neatly ordered rungs that all say "no account yet" is a district that
   * reaches nobody outside the app, and that has to be readable at a glance rather than
   * inferred from five greyed rows.
   */
  async function renderAlerts(mine: number): Promise<void> {
    const view = await api<LadderView>('GET', '/admin/ladder');
    if (view === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'alertLadder';

    if (view.nothingCanBeSent) {
      wrap.append(
        text(
          'p',
          'dead',
          'Nothing can be sent outside the app. Alerts reach the in-app inbox and nowhere ' +
            'else — an officer who is not looking at the app is not told.',
        ),
      );
    }

    wrap.append(
      text(
        'p',
        'note',
        'Tried in order, top first, until one works. A rung with no provider behind it is ' +
          'skipped rather than tried, so the ladder is shorter than it looks. The in-app ' +
          'inbox is not on this list: it always happens, in parallel, and costs nothing.',
      ),
    );

    const order = view.district.map((r) => r.channel);

    const save = (next: string[]): void => {
      void (async () => {
        const done = await api('PUT', '/admin/ladder', { channels: next });
        if (done !== null) await renderAlerts(mine);
      })();
    };

    for (const [index, rung] of view.district.entries()) {
      const row = document.createElement('div');
      row.className = 'rung';
      row.dataset['channel'] = rung.channel;
      row.dataset['ready'] = String(rung.configured);

      row.append(text('span', 'pos', String(rung.position)));
      row.append(text('span', 'cname', CHANNEL_LABEL[rung.channel] ?? rung.channel));
      row.append(
        text('span', 'state', rung.configured ? 'ready' : (rung.why ?? 'no provider')),
      );

      // The rung that still works when the district's own line is down (ADR-0011). Worth a
      // badge, because it is the reason the modem is on the shopping list at all.
      if (rung.survivesOutage) row.append(text('span', 'outage', 'works offline'));

      if (index > 0) {
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'move';
        up.dataset['up'] = rung.channel;
        up.textContent = '↑ earlier';
        up.addEventListener('click', () => {
          const next = [...order];
          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
          save(next);
        });
        row.append(up);
      }

      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Backups (M0-55, ADR-0011)
  //--------------------------------------------------------------------------

  interface BackupRunRow {
    backupRunId: string;
    status: string;
    startedAt: string;
    bytes: number | null;
    eventCount: number | null;
    error: string | null;
    offsiteAt: string | null;
    offsiteError: string | null;
  }
  interface BackupView {
    health: {
      ok: boolean;
      lastSuccessAt: string | null;
      ageHours: number | null;
      stuckRuns: number;
    };
    replication: { role: string; lagSeconds: number | null; ok: boolean; why: string | null };
    offsiteConfigured: boolean;
    offsiteWhy: string | null;
    lastOffsiteAt: string | null;
    recent: BackupRunRow[];
    files: { name: string; bytes: number }[];
    restoreNote: string;
  }

  /**
   * Is the district's record safe, and where is it?
   *
   * Two separate questions, shown separately: a dump on the DC office disk covers a bad
   * restore, and only the off-site copy covers the building. A screen that collapsed them
   * into one green tick would let somebody believe a fire is survivable when it is not.
   */
  async function renderBackups(mine: number): Promise<void> {
    const view = await api<BackupView>('GET', '/admin/backups');
    if (view === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'backups';

    const stuck =
      view.health.stuckRuns > 0
        ? ` ${String(view.health.stuckRuns)} run(s) started and never finished.`
        : '';
    const local = text(
      'p',
      'state',
      view.health.lastSuccessAt === null
        ? 'No backup has ever been taken on this server.'
        : `Last backup ${String(view.health.ageHours ?? 0)}h ago.${stuck}`,
    );
    local.dataset['ok'] = String(view.health.ok);
    wrap.append(local);

    // The building question, asked separately.
    const offsite = text(
      'p',
      'state',
      view.lastOffsiteAt !== null
        ? `A copy left the district at ${view.lastOffsiteAt.replace('T', ' ').slice(0, 16)}.`
        : view.offsiteConfigured
          ? 'No backup has ever left the district, although off-site storage is configured.'
          : `Backups never leave the DC office — ${view.offsiteWhy ?? 'off-site storage is not set up'}.`,
    );
    offsite.dataset['ok'] = String(view.lastOffsiteAt !== null);
    wrap.append(offsite);

    const rep = text(
      'p',
      'state',
      view.replication.ok
        ? `Standby is keeping up (${String(view.replication.lagSeconds ?? 0)}s behind).`
        : (view.replication.why ?? 'Replication state unknown.'),
    );
    rep.dataset['ok'] = String(view.replication.ok);
    wrap.append(rep);

    const now = document.createElement('button');
    now.type = 'button';
    now.id = 'backupNow';
    now.className = 'act primary';
    now.textContent = 'Take a backup now';
    now.addEventListener('click', () => {
      now.disabled = true;
      now.textContent = 'Taking a backup…';
      void (async () => {
        const done = await api<{ ran: boolean; reason: string }>('POST', '/admin/backups/now');
        if (done !== null && !done.ran) fail(`Not taken: ${done.reason}`);
        await renderBackups(mine);
      })();
    });
    wrap.append(now);

    // Said on the screen rather than left as a missing button. Somebody will look for it.
    wrap.append(text('p', 'note', view.restoreNote));

    wrap.append(text('h4', 'sectionhead', 'Recent runs'));
    if (view.recent.length === 0) wrap.append(text('p', 'meta', 'None yet.'));

    for (const run of view.recent) {
      const row = document.createElement('div');
      row.className = 'run';
      row.dataset['status'] = run.status;
      row.dataset['offsite'] = String(run.offsiteAt !== null);

      row.append(text('span', 'when', run.startedAt.replace('T', ' ').slice(0, 16)));
      row.append(text('span', 'status', run.status));

      const detail =
        run.error !== null
          ? run.error
          : run.offsiteAt !== null
            ? `${String(run.eventCount ?? 0)} events · copy sent off-site`
            : `${String(run.eventCount ?? 0)} events · ${run.offsiteError ?? 'stayed in the DC office'}`;
      row.append(text('span', 'offsite', detail));

      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Performance
  //--------------------------------------------------------------------------

  async function renderPerformance(mine: number): Promise<void> {
    const data = await api<DistrictPerformance>('GET', '/admin/performance');
    if (data === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminPerformance';
    wrap.append(
      text('p', 'meta', `Last ${String(data.windowDays)} days · as of ${data.asOf.slice(11, 16)} UTC`),
    );

    const summary = document.createElement('div');
    summary.className = 'tallies';
    const tally = (kind: string, label: string, value: string): HTMLElement => {
      const node = document.createElement('span');
      node.className = 'tally';
      node.dataset['kind'] = kind;
      node.append(text('b', '', value), document.createTextNode(label));
      return node;
    };
    summary.append(
      tally('total', 'incidents', String(data.district.total)),
      tally('open', 'still open', String(data.district.open)),
      tally('overdue', 'past deadline', String(data.district.overdue)),
      tally('unassigned', 'unassigned', String(data.district.unassigned)),
      tally('median', 'median minutes to acknowledge', num(data.district.medianAckMinutes)),
      tally('unmet', 'nobody reached', String(data.district.notificationsUnmet)),
    );
    wrap.append(summary);

    const table = document.createElement('table');
    table.id = 'performanceTable';
    table.innerHTML = `
      <thead><tr>
        <th>Department</th><th>Total</th><th>Open</th><th>Unack.</th><th>Past deadline</th>
        <th>Median ack</th><th>Slowest</th><th>Within target</th><th>Nobody reached</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');

    for (const d of data.departments) {
      const tr = document.createElement('tr');
      tr.dataset['department'] = d.departmentId;
      if (d.overdue > 0) tr.dataset['overdue'] = 'true';
      const cells = [
        d.name + (d.retired ? ' (retired)' : ''),
        String(d.total),
        String(d.open),
        String(d.unacknowledged),
        String(d.overdue),
        // A dash, never a zero. Zero minutes is the best possible answer; no data is not an
        // answer at all, and a table that confuses them ranks the idle above the excellent.
        num(d.medianAckMinutes, 'm'),
        num(d.slowestAckMinutes, 'm'),
        d.withinTarget === null ? '—' : `${String(Math.round(d.withinTarget * 100))}%`,
        String(d.notificationsUnmet),
      ];
      for (const c of cells) tr.append(text('td', '', c));
      tbody.append(tr);
    }

    table.append(tbody);
    wrap.append(table);
    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // History
  //--------------------------------------------------------------------------

  function describe(change: ConfigChange): string {
    const after = change.after as { name?: string; pattern?: string; severity?: string } | null;
    const before = change.before as { name?: string; pattern?: string } | null;
    const what = after?.name ?? after?.pattern ?? before?.name ?? before?.pattern ?? after?.severity ?? '';
    return `${change.subject.replace('_', ' ')} ${change.action}${what === '' ? '' : `: ${what}`}`;
  }

  async function renderHistory(mine: number): Promise<void> {
    const changes = await api<ConfigChange[]>('GET', '/admin/history');
    if (changes === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminHistory';
    wrap.append(
      text(
        'p',
        'note',
        'Every configuration change, in order, and it cannot be edited or deleted — the same ' +
          'guarantee the incident log has. This is what makes a past judgement of the system ' +
          'explainable months later.',
      ),
    );

    if (changes.length === 0) wrap.append(text('p', 'meta', 'Nothing has been changed yet.'));

    for (const c of changes) {
      const row = document.createElement('div');
      row.className = 'change';
      row.dataset['action'] = c.action;
      row.append(text('span', 'when', c.recordedAt.replace('T', ' ').slice(0, 16)));
      row.append(text('span', 'what', describe(c)));
      // The seat, not only the person: authority attaches to the post (ADR-0004).
      row.append(
        text(
          'span',
          'who',
          c.actorSeatTitle === null
            ? (c.actorName ?? 'the system')
            : `${c.actorSeatTitle}${c.actorName === null ? '' : ` (${c.actorName})`}`,
        ),
      );
      if (c.reason !== null) row.append(text('span', 'why', c.reason));
      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------

  async function render(): Promise<void> {
    generation += 1;
    const mine = generation;

    for (const button of Array.from(tabs.querySelectorAll('button'))) {
      button.setAttribute('aria-current', button.dataset['tab'] === tab ? 'page' : 'false');
    }
    body.replaceChildren(text('p', 'meta', 'Loading…'));

    if (tab === 'departments') await renderDepartments(mine);
    else if (tab === 'roster') await renderRosters(mine);
    else if (tab === 'alerts') await renderAlerts(mine);
    else if (tab === 'backups') await renderBackups(mine);
    else if (tab === 'deadlines') await renderDeadlines(mine);
    else if (tab === 'performance') await renderPerformance(mine);
    else await renderHistory(mine);
  }

  for (const button of Array.from(tabs.querySelectorAll('button'))) {
    button.addEventListener('click', () => {
      tab = (button.dataset['tab'] ?? 'departments') as Tab;
      void render();
    });
  }

  return {
    refresh: render,
    show(next?: Tab): void {
      if (next !== undefined) tab = next;
      view.hidden = false;
      void render();
    },
  };
}
