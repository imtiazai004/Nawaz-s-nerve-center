/**
 * "Reach them" — M5.
 *
 * One control, used wherever somebody is about to assign, escalate, or ask a department to do
 * something. It shows the numbers and opens the officer's own WhatsApp, dialler or messages
 * app. **Nothing is sent by the software**, and nothing here needs an account with anybody.
 *
 * The owner's instruction, after I had built an entire ladder of providers nobody asked for:
 *
 *   > es ka ye matlab nhe hai k software call karega … ju banda alert jare karega ya escalate
 *   > karega … un ko mutalqa number mil jaye and us pr click kare tou contact karne ka channel
 *   > selection mai ho … ye buht simple process hai
 *
 * Three things this file is careful about.
 *
 * **A stand-in number is never offered as a number.** A placeholder fills a post so the roster
 * is complete; dialling it reaches nobody, and discovering that at 02:00 is the exact failure
 * the whole system exists to prevent. It is shown, greyed, labelled, and its channels are
 * disabled.
 *
 * **Nothing is recorded.** By the owner's decision. A click here is not an event, and the
 * screen does not pretend it is one — no tick appears, nothing says "notified". What happened
 * is that an app opened.
 *
 * **The dialog closes on Escape and returns focus.** It is opened mid-task by somebody who
 * may decide not to ring after all, and a control that traps them is a control they will
 * stop opening.
 */

interface ContactLine {
  seatTitle: string;
  holder: string | null;
  phone: string | null;
  placeholder: boolean;
}

interface DepartmentContacts {
  departmentId: string;
  name: string;
  officePhone: string | null;
  posts: ContactLine[];
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

/**
 * A number as a link wants it: digits, and a leading `+` only if it was already there.
 *
 * `wa.me` refuses anything but digits, and a Pakistani number written `0928-610001` has to
 * lose the dash before it will open. What is *shown* stays exactly as the district typed it —
 * an officer checking a number against a piece of paper needs it to look the same.
 */
export function dialable(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');

  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/**
 * WhatsApp wants a full international number and will not guess a country.
 *
 * `03001112222` opens nothing; `923001112222` opens the chat. So a leading zero becomes
 * Pakistan's code — and a number that is already international is left alone.
 *
 * This is the one place in the client that assumes a country, and it is stated rather than
 * hidden: the district is Bannu, and a number typed by somebody in Bannu with a leading zero
 * is a Pakistani number. If that ever stops being true, it stops being true here.
 */
export function whatsappNumber(phone: string): string {
  const digits = dialable(phone).replace(/^\+/, '');

  if (digits.startsWith('92')) return digits;
  if (digits.startsWith('0')) return `92${digits.slice(1)}`;

  return digits;
}

/** Short published numbers — 1122, 15, 16 — are dialled, never WhatsApp'd. */
function isShortCode(phone: string): boolean {
  return /^[0-9]{2,5}$/.test(phone.trim());
}

function channelRow(phone: string, note: string): HTMLElement {
  const row = make('div', 'channels');

  const open = (href: string): void => {
    // `_blank` with `noopener`: on a handset these are handled by an app, and on a desk this
    // must not navigate the operator away from the incident they were working on.
    window.open(href, '_blank', 'noopener');
  };

  if (!isShortCode(phone)) {
    const whatsapp = make('button', 'chan wa', 'WhatsApp');
    whatsapp.type = 'button';
    whatsapp.addEventListener('click', () => {
      open(`https://wa.me/${whatsappNumber(phone)}`);
    });
    row.appendChild(whatsapp);
  }

  const call = make('button', 'chan call', 'Call');
  call.type = 'button';
  call.addEventListener('click', () => {
    open(`tel:${dialable(phone)}`);
  });
  row.appendChild(call);

  const sms = make('button', 'chan sms', 'SMS');
  sms.type = 'button';
  sms.addEventListener('click', () => {
    open(`sms:${dialable(phone)}`);
  });
  row.appendChild(sms);

  const copy = make('button', 'chan copy', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(phone);
        copy.textContent = 'Copied';
        window.setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch {
        // Clipboard permission refused, or an insecure origin. The number is on screen and
        // can be read; saying "copied" when nothing was copied would be worse than this.
        copy.textContent = 'Select it above';
        window.setTimeout(() => (copy.textContent = 'Copy'), 2500);
      }
    })();
  });
  row.appendChild(copy);

  if (note !== '') row.appendChild(make('span', 'age', note));

  return row;
}

function line(label: string, phone: string | null, sub: string, placeholder: boolean): HTMLElement {
  const box = make('div', 'creach');

  const head = make('div', 'chead');
  head.appendChild(make('span', 'cwho', label));
  if (sub !== '') head.appendChild(make('span', 'age', sub));
  box.appendChild(head);

  if (phone === null || phone.trim() === '') {
    // Said out loud rather than shown as an empty row. An unreachable post is not untidy data
    // — it is an alert that will go nowhere on the night somebody needs it (ADR-0005).
    box.appendChild(make('div', 'cnone', 'No number on the roster — nothing can reach this post.'));
    return box;
  }

  box.appendChild(make('div', 'cnum', phone));

  if (placeholder) {
    box.classList.add('placeholder');
    box.appendChild(
      make(
        'div',
        'cnone',
        'This is a stand-in number, not a real one. Dialling it reaches nobody.',
      ),
    );
    return box;
  }

  box.appendChild(channelRow(phone, ''));

  return box;
}

let open: HTMLElement | null = null;
let returnFocusTo: HTMLElement | null = null;

export function closeContacts(): void {
  open?.remove();
  open = null;
  returnFocusTo?.focus();
  returnFocusTo = null;
}

function shell(title: string): { panel: HTMLElement; body: HTMLElement } {
  closeContacts();

  const overlay = make('div', 'coverlay');
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeContacts();
  });

  const panel = make('div', 'cpanel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', `How to reach ${title}`);

  const head = make('div', 'cpanelhead');
  head.appendChild(make('h3', '', `Reach ${title}`));

  const close = make('button', 'chan', 'Close');
  close.type = 'button';
  close.addEventListener('click', closeContacts);
  head.appendChild(close);
  panel.appendChild(head);

  const body = make('div', 'cbody');
  panel.appendChild(body);

  panel.appendChild(
    make(
      'p',
      'note',
      'This opens WhatsApp, your dialler or your messages app. Nothing is sent by the system, ' +
        'and nothing here is recorded — the conversation is yours.',
    ),
  );

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  open = overlay;

  close.focus();

  return { panel, body };
}

document.addEventListener('keydown', (event) => {
  // Opened mid-task by somebody who may decide not to ring after all. A dialog that traps
  // them is a dialog they stop opening.
  if (event.key === 'Escape' && open !== null) closeContacts();
});

/**
 * Show how to reach one department.
 *
 * `trigger` is the control that opened this, so focus can go back to it — an officer who
 * presses Escape should be where they were, not at the top of the page.
 */
export async function showContacts(departmentId: string, trigger?: HTMLElement): Promise<void> {
  returnFocusTo = trigger ?? null;

  const { body } = shell('department');

  let contacts: DepartmentContacts;
  try {
    const res = await fetch(`/contacts/department/${departmentId}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      body.appendChild(make('p', 'cnone', 'Could not load the numbers for this department.'));
      return;
    }
    contacts = (await res.json()) as DepartmentContacts;
  } catch {
    body.appendChild(
      make('p', 'cnone', 'You are offline, so the numbers cannot be loaded right now.'),
    );
    return;
  }

  const panel = body.parentElement;
  panel?.setAttribute('aria-label', `How to reach ${contacts.name}`);
  const heading = panel?.querySelector('h3');
  if (heading !== null && heading !== undefined) heading.textContent = `Reach ${contacts.name}`;

  const held = contacts.posts.filter((p) => p.phone !== null && p.phone.trim() !== '');
  const empty = contacts.posts.filter((p) => p.phone === null || p.phone.trim() === '');

  for (const post of held) {
    body.appendChild(line(post.seatTitle, post.phone, post.holder ?? '', post.placeholder));
  }

  if (contacts.officePhone !== null && contacts.officePhone.trim() !== '') {
    // Below the posts, on purpose. The post is who is on duty now; the office is what to try
    // when nobody is.
    body.appendChild(line('Office number', contacts.officePhone, contacts.name, false));
  }

  for (const post of empty) {
    body.appendChild(line(post.seatTitle, null, '', false));
  }

  if (body.childElementCount === 0) {
    body.appendChild(
      make(
        'p',
        'cnone',
        'This department has no numbers at all — no posts and no office line. Nothing can reach it.',
      ),
    );
  }
}

/**
 * A "Reach them" button for a department.
 *
 * Returned rather than appended, so each screen decides where it belongs — and every screen
 * gets the same control rather than four that drift.
 */
export function reachButton(departmentId: string, label = 'Reach them'): HTMLButtonElement {
  const button = make('button', 'reach', label);
  button.type = 'button';
  button.addEventListener('click', (event) => {
    // The card underneath opens an incident. This button does not.
    event.stopPropagation();
    void showContacts(departmentId, button);
  });

  return button;
}
