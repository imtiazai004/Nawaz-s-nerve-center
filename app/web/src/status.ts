/**
 * The Status screen — M4.
 *
 * Where the district says how it is doing. Everything the dashboard *shows* is entered here,
 * and it is one screen rather than four because the four things are the same shape: somebody
 * with authority states a fact, and the fact is stamped with who and when.
 *
 * **Scoped, not hidden.** A department sees the services it answers for and the posts it
 * holds; the two administrative offices see everything, plus the district's advisories and
 * standing facts. Everything on this screen that a caller may not do is simply not drawn —
 * and every one of those is refused server-side as well, because a hidden control is a
 * courtesy and never a control (INV-05).
 *
 * **Nothing here is entered on the dashboard.** The prototype this came from puts an Edit
 * button on every panel, which follows from having no backend: the display has to be its own
 * admin because there is nowhere else for the data to live. Here there is somewhere else, and
 * it is this screen — which knows who is typing.
 */

interface Utility {
  utilityId: string;
  name: string;
  panel: 'utility' | 'services';
  departmentId: string | null;
  departmentName: string | null;
  status: 'normal' | 'degraded' | 'down' | null;
  note: string | null;
  reportedAt: string | null;
  reportedBy: string | null;
}

interface Presence {
  seatId: string;
  seatTitle: string;
  departmentName: string | null;
  isAdministration: boolean;
  status: 'office' | 'field' | 'leave' | null;
  note: string | null;
  reportedAt: string | null;
  untilAt: string | null;
}

interface Alert {
  alertId: string;
  tag: string;
  message: string;
  issuedAt: string;
  untilAt: string;
}

interface Fact {
  key: string;
  label: string;
  value: string | null;
}

interface StatusFeed {
  utilities: Utility[];
  presence: Presence[];
  facts: Fact[];
  alerts: Alert[];
  departments: { departmentId: string; name: string }[];
  canConfigure: boolean;
  departmentId: string | null;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ago(iso: string | null): string {
  if (iso === null) return 'never reported';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never reported';

  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)} min ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/**
 * A local time as an input[type=datetime-local] wants it.
 *
 * `toISOString()` is UTC, and a district officer typing "back at two" means two o'clock in
 * Bannu. Getting this wrong by five hours in a field that decides when an advisory expires
 * is worse than having no default at all.
 */
function localStamp(hoursFromNow: number): string {
  const when = new Date(Date.now() + hoursFromNow * 3600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');

  return (
    `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

export interface StatusPanel {
  show(): Promise<void>;
}

export function mountStatus(options: { onChanged?: () => void } = {}): StatusPanel {
  const root = el('statusBody');
  const note = el('statusNote');

  let feed: StatusFeed | null = null;
  let busy = false;

  async function send(path: string, body: unknown): Promise<boolean> {
    // One in flight at a time. Two clicks on "Down" while the first is still going would
    // write the same report twice, and the second is indistinguishable from a real one.
    if (busy) return false;
    busy = true;
    note.textContent = 'Saving…';
    note.className = 'note';

    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { error?: string };
        // The server's own words. It knows why it refused; a generic "could not save" would
        // send somebody to find a developer for a message that was already written.
        note.textContent = problem.error ?? `Refused (${String(res.status)}).`;
        note.className = 'note state-critical';
        return false;
      }

      note.textContent = 'Saved.';
      note.className = 'note state-ok';
      options.onChanged?.();
      return true;
    } catch {
      note.textContent = 'Could not reach the server. Nothing was saved.';
      note.className = 'note state-critical';
      return false;
    } finally {
      busy = false;
    }
  }

  async function reload(): Promise<void> {
    const res = await fetch('/status', { headers: { accept: 'application/json' } });
    if (!res.ok) {
      clear(root);
      root.appendChild(make('p', 'note state-critical', 'Could not load the status screen.'));
      return;
    }

    feed = (await res.json()) as StatusFeed;
    paint();
  }

  function section(title: string, hint?: string): HTMLElement {
    const panel = make('section', 'panel');
    panel.appendChild(make('h2', '', title));
    if (hint !== undefined) panel.appendChild(make('p', 'note', hint));
    root.appendChild(panel);
    return panel;
  }

  //----------------------------------------------------------------------------
  // Conditions — what a department reports about the service it answers for
  //----------------------------------------------------------------------------

  function conditionRows(panel: HTMLElement, rows: Utility[]): void {
    if (rows.length === 0) {
      panel.appendChild(
        make('p', 'empty', 'Nothing here is yours to report. The two offices assign these.'),
      );
      return;
    }

    for (const row of rows) {
      const item = make('div', 'srow');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', row.name));
      head.appendChild(
        make(
          'span',
          'age',
          row.departmentName === null
            ? // A visible, fixable gap rather than a silent one (ADR-0005).
              'nobody assigned'
            : `${row.departmentName} · ${ago(row.reportedAt)}`,
        ),
      );
      item.appendChild(head);

      const noteField = make('input', 'snote');
      noteField.type = 'text';
      noteField.placeholder = 'What is happening? e.g. load shedding, 4 hrs on 2 off';
      noteField.maxLength = 120;
      noteField.value = row.note ?? '';

      const buttons = make('div', 'sbuttons');
      for (const [value, label] of [
        ['normal', 'Normal'],
        ['degraded', 'Degraded'],
        ['down', 'Down'],
      ] as const) {
        const button = make('button', `sbtn ${value}`, label);
        button.type = 'button';
        if (row.status === value) button.setAttribute('aria-pressed', 'true');

        button.addEventListener('click', () => {
          void (async () => {
            const ok = await send('/status/utility', {
              utilityId: row.utilityId,
              status: value,
              note: noteField.value,
            });
            if (ok) await reload();
          })();
        });

        buttons.appendChild(button);
      }

      item.appendChild(noteField);
      item.appendChild(buttons);

      // Only the two offices decide who answers for a service.
      if (feed?.canConfigure === true) {
        const assign = make('select', 'sassign');
        const none = make('option', '', 'nobody assigned');
        none.value = '';
        assign.appendChild(none);

        for (const dept of feed.departments) {
          const option = make('option', '', dept.name);
          option.value = dept.departmentId;
          if (dept.departmentId === row.departmentId) option.selected = true;
          assign.appendChild(option);
        }

        /**
         * Read the chosen value off the event, not off the captured element.
         *
         * `paint()` replaces this whole subtree on every reload, so a handler that reaches
         * back for `assign.value` can find an element that is no longer in the document — and
         * a detached select reports the empty string, which this endpoint accepts as "nobody
         * assigned". The failure was a save that reported success and cleared the field.
         */
        assign.addEventListener('change', (event) => {
          const chosen = (event.currentTarget as HTMLSelectElement).value;

          void (async () => {
            const ok = await send('/status/utilities/assign', {
              utilityId: row.utilityId,
              departmentId: chosen,
            });
            if (ok) await reload();
          })();
        });

        item.appendChild(assign);
      }

      panel.appendChild(item);
    }
  }

  //----------------------------------------------------------------------------
  // Presence
  //----------------------------------------------------------------------------

  /**
   * Which posts to draw, and why not all of them.
   *
   * The two offices may set presence for any seat in the district — 83 of them. Drawing all 83
   * with three buttons and two fields each produced a column two thousand pixels long, which
   * is not a screen anybody uses: the six posts somebody actually wants are lost in it.
   *
   * So the default is the posts an office would look for — its own, plus anything already
   * reported — and a search box reaches the rest. Nothing is withheld; it is one word away.
   */
  function visiblePresence(rows: Presence[], search: string): Presence[] {
    const needle = search.trim().toLowerCase();

    if (needle !== '') {
      return rows.filter((r) => r.seatTitle.toLowerCase().includes(needle)).slice(0, 40);
    }

    const shortlist = rows.filter((r) => r.isAdministration || r.status !== null);

    // A department seeing only its own posts is already a short list; do not shorten it again.
    return (feed?.canConfigure === true ? shortlist : rows).slice(0, 40);
  }

  let presenceSearch = '';

  function presenceRows(panel: HTMLElement, all: Presence[]): void {
    if (all.length === 0) {
      panel.appendChild(make('p', 'empty', 'No posts to report on.'));
      return;
    }

    if (feed?.canConfigure === true) {
      const find = make('input', 'snote');
      find.type = 'search';
      find.id = 'presenceSearch';
      find.placeholder = `Find a post — showing the administration's own of ${String(all.length)}`;
      find.value = presenceSearch;
      find.addEventListener('input', () => {
        presenceSearch = find.value;
        paint();
        // Re-painting replaces the field, so put the cursor back where it was.
        const again = document.getElementById('presenceSearch');
        if (again !== null) (again as HTMLInputElement).focus();
      });
      panel.appendChild(find);
    }

    const rows = visiblePresence(all, presenceSearch);

    if (rows.length === 0) {
      panel.appendChild(make('p', 'empty', 'No post matches that.'));
      return;
    }

    for (const row of rows) {
      const item = make('div', 'srow');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', row.seatTitle));
      head.appendChild(make('span', 'age', ago(row.reportedAt)));
      item.appendChild(head);

      const noteField = make('input', 'snote');
      noteField.type = 'text';
      noteField.placeholder = 'Where, roughly? e.g. Domel side';
      noteField.maxLength = 120;
      noteField.value = row.note ?? '';

      /**
       * `field` and `leave` must state an end; `office` need not.
       *
       * "In office" degrades safely — the worst case is a walk to an empty desk. The other two
       * are claims the district plans around, and one left open forever becomes a grey box
       * nobody trusts and nobody fixes. The server enforces this; the field is here so the
       * officer is not refused after the fact.
       */
      const until = make('input', 'suntil');
      until.type = 'datetime-local';
      until.value = localStamp(4);
      until.title = 'When does this end?';

      const buttons = make('div', 'sbuttons');
      for (const [value, label] of [
        ['office', 'In office'],
        ['field', 'In field'],
        ['leave', 'On leave'],
      ] as const) {
        const button = make('button', `sbtn ${value}`, label);
        button.type = 'button';
        if (row.status === value) button.setAttribute('aria-pressed', 'true');

        button.addEventListener('click', () => {
          void (async () => {
            const ok = await send('/status/presence', {
              seatId: row.seatId,
              status: value,
              note: noteField.value,
              ...(value === 'office' ? {} : { untilAt: new Date(until.value).toISOString() }),
            });
            if (ok) await reload();
          })();
        });

        buttons.appendChild(button);
      }

      item.appendChild(noteField);
      item.appendChild(until);
      item.appendChild(buttons);
      panel.appendChild(item);
    }
  }

  //----------------------------------------------------------------------------
  // Advisories — the two offices issue them
  //----------------------------------------------------------------------------

  function advisories(panel: HTMLElement): void {
    if (feed === null) return;

    if (feed.canConfigure) {
      const form = make('div', 'sform');

      const tag = make('select', '');
      for (const [value, label] of [
        ['vip', 'VIP movement'],
        ['security', 'Security'],
        ['road', 'Road'],
        ['weather', 'Weather'],
        ['other', 'Other'],
      ] as const) {
        const option = make('option', '', label);
        option.value = value;
        tag.appendChild(option);
      }

      const message = make('input', '');
      message.type = 'text';
      message.id = 'alertMessage';
      message.placeholder = 'What is being advised?';
      message.maxLength = 200;

      const until = make('input', '');
      until.type = 'datetime-local';
      until.id = 'alertUntil';
      until.value = localStamp(12);
      until.title = 'When does it stop mattering?';

      // `.plain` is the critical-red submit used for reporting an emergency. An advisory is
      // an announcement, not an alarm, so it gets the accent instead.
      const issue = make('button', 'plain go', 'Issue advisory');
      issue.type = 'button';
      issue.id = 'issueAlert';
      issue.addEventListener('click', () => {
        void (async () => {
          const ok = await send('/status/alerts', {
            tag: tag.value,
            message: message.value,
            untilAt: new Date(until.value).toISOString(),
          });
          if (ok) {
            message.value = '';
            await reload();
          }
        })();
      });

      form.appendChild(tag);
      form.appendChild(message);
      form.appendChild(until);
      form.appendChild(issue);
      panel.appendChild(form);
    }

    if (feed.alerts.length === 0) {
      panel.appendChild(make('p', 'empty', 'Nothing in force.'));
      return;
    }

    for (const alert of feed.alerts) {
      const item = make('div', 'srow');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', alert.message));
      head.appendChild(make('span', 'age', `${alert.tag} · ${ago(alert.issuedAt)}`));
      item.appendChild(head);

      if (feed.canConfigure) {
        const withdraw = make('button', 'plain small', 'Withdraw');
        withdraw.type = 'button';
        withdraw.addEventListener('click', () => {
          // Withdrawn, never deleted — "we told the district the road was shut" is a thing
          // somebody may have to answer for (ADR-0001). So it asks why.
          const reason = window.prompt('Why is this being withdrawn?');
          if (reason === null || reason.trim() === '') return;

          void (async () => {
            const ok = await send('/status/alerts/withdraw', {
              alertId: alert.alertId,
              reason: reason.trim(),
            });
            if (ok) await reload();
          })();
        });
        item.appendChild(withdraw);
      }

      panel.appendChild(item);
    }
  }

  //----------------------------------------------------------------------------
  // The standing facts
  //----------------------------------------------------------------------------

  function facts(panel: HTMLElement): void {
    if (feed === null) return;

    for (const fact of feed.facts) {
      const item = make('div', 'srow');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', fact.label));
      item.appendChild(head);

      const input = make('input', 'snote');
      input.type = 'text';
      input.maxLength = 60;
      input.value = fact.value ?? '';
      input.placeholder = 'not supplied yet';

      // Saved on blur rather than on every keystroke: four fields, changed once a year, and a
      // request per character would be four hundred writes to record a population.
      input.addEventListener('blur', () => {
        if ((fact.value ?? '') === input.value.trim()) return;
        void send('/status/facts', { key: fact.key, value: input.value.trim() });
      });

      item.appendChild(input);
      panel.appendChild(item);
    }
  }

  function paint(): void {
    if (feed === null) return;
    clear(root);

    const mine = feed.canConfigure
      ? feed.utilities
      : feed.utilities.filter((u) => u.departmentId === feed?.departmentId);

    conditionRows(
      section(
        'Public utilities',
        feed.canConfigure
          ? 'You may report any of these, and decide which department answers for each.'
          : 'The services your department answers for.',
      ),
      mine.filter((u) => u.panel === 'utility'),
    );

    conditionRows(
      section('District services', 'Markets, schools, the hospital, the roads.'),
      mine.filter((u) => u.panel === 'services'),
    );

    presenceRows(
      section(
        'Where the officers are',
        'Set against the post, not the person — so it keeps reading correctly across a transfer.',
      ),
      feed.presence,
    );

    advisories(
      section(
        'Alerts & advisories',
        feed.canConfigure
          ? 'Issued to the whole district. Every one must say when it ends.'
          : 'Issued by the DC and AC Headquarter offices.',
      ),
    );

    if (feed.canConfigure) {
      facts(section('District status', 'The facts that do not change on a Tuesday.'));
    }
  }

  return {
    async show(): Promise<void> {
      note.textContent = '';
      note.className = 'note';
      await reload();
    },
  };
}
