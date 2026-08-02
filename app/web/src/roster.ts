/**
 * The roster on screen — M1a-10.
 *
 * **One component, two doors.** A department officer reaches it as "My department" and sees
 * their own; the two administrative offices reach it from the console and can pick any of
 * the 79. Same markup, same operations — the server decides what is permitted, and this
 * module only decides what to draw (INV-05).
 *
 * The screen is organised around the question the roster answers — *who is in that post
 * right now?* — so posts lead and people follow, rather than the other way round. A post
 * with nobody in it is the thing an administrator needs to see first, because it is the one
 * that silently swallows an alert at 02:00.
 *
 * Three rules, all the same rule:
 *
 * 1. **Unreachable is stated, in words.** Empty post, placeholder number — both mean nothing
 *    can be told, and both say so (ADR-0005, INV-04).
 * 2. **Anything that stops somebody being reachable asks why, first.** The server requires a
 *    reason and so does the table beneath it; collecting it afterwards would mean meeting a
 *    refusal the operator did not expect.
 * 3. **Adding a contact and granting a login are separate buttons**, because they are
 *    separate decisions. A credential for somebody who has not been told the system exists
 *    is a password nobody chose on an account nobody watches.
 */

export interface RosterPerson {
  personId: string;
  fullName: string;
  phone: string;
  placeholder: boolean;
  hasAccount: boolean;
  disabledAt: string | null;
}

export interface RosterPost {
  seatId: string;
  title: string;
  tier: string;
  retiredAt: string | null;
  holder: RosterPerson | null;
  heldSince: string | null;
}

export interface RosterView {
  departmentId: string;
  departmentName: string;
  posts: RosterPost[];
  people: RosterPerson[];
  unreachablePosts: number;
  editable: boolean;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

export interface RosterHost {
  /** Where to draw. Cleared and replaced on every render. */
  readonly container: HTMLElement;
  /** Show a refusal. The console and the department view surface these differently. */
  fail(message: string): void;
  clearError(): void;
}

export interface RosterPanel {
  /** `null` means "whichever department my own seat sits in" — the server resolves it. */
  show(departmentId: string | null): Promise<void>;
}

export function mountRoster(host: RosterHost): RosterPanel {
  let current: string | null = null;

  /**
   * Same guard as the console's tabs: only the newest render may paint.
   *
   * An administrator switching between departments faster than the requests return would
   * otherwise see whichever answered last, attributed to whichever they clicked last. On a
   * screen full of phone numbers that is not a cosmetic problem.
   */
  let generation = 0;

  async function api<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      host.fail('Could not reach the server. Nothing was changed.');
      return null;
    }

    const raw = await res.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);

    if (!res.ok) {
      host.fail((parsed as { error?: string }).error ?? `The server refused that (${String(res.status)}).`);
      return null;
    }
    host.clearError();
    return parsed as T;
  }

  const reload = (): void => void show(current);

  function link(label: string, onClick: () => void, danger = false): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = danger ? 'link danger' : 'link';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** Ask before acting, because the server and the database both require a reason. */
  function withReason(question: string, run: (reason: string) => Promise<unknown>): () => void {
    return () => {
      const reason = prompt(question);
      if (reason === null || reason.trim() === '') return;
      void (async () => {
        const done = await run(reason);
        if (done !== null) reload();
      })();
    };
  }

  function personLine(person: RosterPerson): HTMLElement {
    const line = document.createElement('span');
    line.className = 'holder';
    line.dataset['placeholder'] = String(person.placeholder);
    line.append(text('span', 'pname', person.fullName));
    line.append(text('span', 'pphone', person.phone));

    if (person.placeholder) {
      // The number is a stand-in. Said in words, on the row, because the whole hazard of a
      // placeholder is that it looks exactly like a contact.
      line.append(text('strong', 'warn', 'placeholder number — nothing will be sent here'));
    }
    if (person.hasAccount) line.append(text('span', 'tag', 'can sign in'));
    return line;
  }

  function postCard(view: RosterView, post: RosterPost): HTMLElement {
    const card = document.createElement('article');
    card.className = 'post';
    card.dataset['post'] = post.seatId;
    card.dataset['retired'] = String(post.retiredAt !== null);

    const head = document.createElement('header');
    head.append(text('h4', 'title', post.title));
    if (post.tier !== 'station') head.append(text('span', 'tag', post.tier));
    if (post.retiredAt !== null) head.append(text('span', 'tag retired', 'retired'));
    card.append(head);

    if (post.holder === null) {
      if (post.retiredAt === null) {
        // The gap this whole screen exists to close. An alert addressed to this post reaches
        // nobody, and the escalation ladder is designed to surface that rather than swallow
        // it (ADR-0004).
        card.append(text('p', 'nobody', 'Nobody holds this post — an alert sent here reaches no one'));
      }
    } else {
      card.append(personLine(post.holder));
    }

    if (!view.editable || post.retiredAt !== null) {
      if (post.retiredAt !== null && view.editable) {
        card.append(
          link(
            'Bring back',
            withReason('Why is this post returning?', (reason) =>
              api('POST', `/roster/posts/${post.seatId}/restore`, { reason }),
            ),
          ),
        );
      }
      return card;
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    // Putting somebody in the post. Only people already on this department's roster, so a
    // department cannot reach across and staff itself from somebody else's list.
    const assignable = view.people.filter((p) => p.personId !== post.holder?.personId);
    if (assignable.length > 0) {
      const picker = document.createElement('select');
      picker.className = 'assign';
      picker.setAttribute('aria-label', `Put somebody in ${post.title}`);
      picker.append(new Option(post.holder === null ? 'Put somebody in…' : 'Hand over to…', ''));
      for (const p of assignable) picker.append(new Option(p.fullName, p.personId));
      picker.addEventListener('change', () => {
        if (picker.value === '') return;
        void (async () => {
          const done = await api('POST', `/roster/posts/${post.seatId}/assign`, {
            personId: picker.value,
          });
          if (done !== null) reload();
        })();
      });
      actions.append(picker);
    }

    actions.append(
      link('Rename', () => {
        const title = prompt('New title for this post', post.title);
        if (title === null || title.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/posts/${post.seatId}`, { title });
          if (done !== null) reload();
        })();
      }),
    );

    if (post.holder !== null) {
      actions.append(
        link(
          'Take off this post',
          withReason(`Why is ${post.holder.fullName} being taken off ${post.title}?`, (reason) =>
            api('POST', `/roster/posts/${post.seatId}/relieve`, { reason }),
          ),
          true,
        ),
      );
    }

    actions.append(
      link(
        'Retire post',
        withReason(`Why is ${post.title} being retired? Its holder comes off it.`, (reason) =>
          api('POST', `/roster/posts/${post.seatId}/retire`, { reason }),
        ),
        true,
      ),
    );

    card.append(actions);
    return card;
  }

  function personCard(view: RosterView, person: RosterPerson): HTMLElement {
    const card = document.createElement('article');
    card.className = 'rosterperson';
    card.dataset['person'] = person.personId;
    card.append(personLine(person));

    if (!view.editable) return card;

    const actions = document.createElement('div');
    actions.className = 'actions';

    actions.append(
      link('Change number', () => {
        const phone = prompt(`Number for ${person.fullName}`, person.phone);
        if (phone === null || phone.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/people/${person.personId}`, { phone });
          if (done !== null) reload();
        })();
      }),
      link('Rename', () => {
        const fullName = prompt('Name', person.fullName);
        if (fullName === null || fullName.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/people/${person.personId}`, { fullName });
          if (done !== null) reload();
        })();
      }),
    );

    if (!person.hasAccount) {
      // A second, deliberate act — never folded into "add a person". See rule 3 in the
      // header: an account for somebody who has not been told the system exists is a
      // password nobody chose, on an account nobody watches.
      actions.append(
        link('Give a login', () => {
          if (
            !confirm(
              `Give ${person.fullName} a login?\n\nOnly do this if you have spoken to them. ` +
                'They will be able to sign in and act on emergencies.',
            )
          ) {
            return;
          }
          const password = prompt('A starting password — at least 12 characters');
          if (password === null || password.length < 12) return;
          void (async () => {
            const done = await api('POST', `/roster/people/${person.personId}/account`, {
              password,
            });
            if (done !== null) reload();
          })();
        }),
      );
    }

    actions.append(
      link(
        'Remove',
        withReason(
          `Why is ${person.fullName} being removed? They stay in the record; they stop being ` +
            'someone to notify.',
          (reason) => api('POST', `/roster/people/${person.personId}/remove`, { reason }),
        ),
        true,
      ),
    );

    card.append(actions);
    return card;
  }

  function addPersonForm(view: RosterView): HTMLElement {
    const form = document.createElement('form');
    form.className = 'addperson';
    form.innerHTML = `
      <input type="text" class="pn" placeholder="Name" aria-label="Name" required />
      <input type="text" class="pp" placeholder="Phone number" aria-label="Phone number" required />
      <select class="ps" aria-label="Put them in a post">
        <option value="">No post yet</option>
      </select>
      <label class="ph"><input type="checkbox" class="pc" /> stand-in number</label>
      <button type="submit">Add person</button>`;

    const picker = form.querySelector<HTMLSelectElement>('.ps')!;
    for (const p of view.posts.filter((p) => p.retiredAt === null && p.holder === null)) {
      picker.append(new Option(p.title, p.seatId));
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const fullName = form.querySelector<HTMLInputElement>('.pn')!.value.trim();
      const phone = form.querySelector<HTMLInputElement>('.pp')!.value.trim();
      const seatId = picker.value;
      const placeholder = form.querySelector<HTMLInputElement>('.pc')!.checked;
      if (fullName === '' || phone === '') return;

      void (async () => {
        const done = await api('POST', `/roster/${view.departmentId}/people`, {
          fullName,
          phone,
          placeholder,
          ...(seatId === '' ? {} : { seatId }),
        });
        if (done !== null) reload();
      })();
    });
    return form;
  }

  function addPostForm(view: RosterView): HTMLElement {
    const form = document.createElement('form');
    form.className = 'addpost';
    form.innerHTML = `
      <input type="text" class="tt" placeholder="New post, e.g. Station Officer" aria-label="Post title" required />
      <button type="submit">Add post</button>`;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = form.querySelector<HTMLInputElement>('.tt')!.value.trim();
      if (title === '') return;
      void (async () => {
        const done = await api('POST', `/roster/${view.departmentId}/posts`, { title });
        if (done !== null) reload();
      })();
    });
    return form;
  }

  async function show(departmentId: string | null): Promise<void> {
    generation += 1;
    const mine = generation;
    current = departmentId;

    host.container.replaceChildren(text('p', 'meta', 'Loading…'));

    const view = await api<RosterView>(
      'GET',
      departmentId === null ? '/roster' : `/roster/${departmentId}`,
    );
    if (view === null || mine !== generation) return;

    const wrap = document.createElement('div');
    wrap.id = 'rosterBody';
    wrap.dataset['department'] = view.departmentId;

    wrap.append(text('h3', 'rostername', view.departmentName));

    if (view.unreachablePosts > 0) {
      // Above everything. A post nothing can reach is not a tidy-up job — it is an alert
      // that will be recorded as failed on the night somebody needed it.
      const n = view.unreachablePosts;
      wrap.append(
        text(
          'p',
          'unreachable',
          `${String(n)} post${n === 1 ? '' : 's'} cannot be reached — empty, or holding a ` +
            'stand-in number. An alert sent to one is recorded as failed.',
        ),
      );
    }

    wrap.append(text('h4', 'sectionhead', 'Posts'));
    if (view.editable) wrap.append(addPostForm(view));
    if (view.posts.length === 0) {
      wrap.append(
        text('p', 'nobody', 'This department has no posts, so nothing can ever be sent to it.'),
      );
    }
    for (const post of view.posts) wrap.append(postCard(view, post));

    wrap.append(text('h4', 'sectionhead', 'People'));
    if (view.editable) wrap.append(addPersonForm(view));
    if (view.people.length === 0) wrap.append(text('p', 'meta', 'Nobody on this roster yet.'));
    for (const person of view.people) wrap.append(personCard(view, person));

    if (mine === generation) host.container.replaceChildren(wrap);
  }

  return { show };
}
