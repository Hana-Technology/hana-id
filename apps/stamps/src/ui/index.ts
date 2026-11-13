// The passport's UI (the shared spec's "UI module contract"): `mountPassport(root, handlers)` draws the cover or the
// open booklet, the six stamp slots, the recent stamps and the notice, and `update(view)` patches what changed. Pure
// rendering: no chain, SDK or network, nothing stored.
//
// Safety: every string from the view is set with textContent after safeText() (text.ts), never as markup; the only
// attributes that carry view data are link hrefs, kept only when safeHref() resolves them to http(s), and the
// `data-stamp` of a recent item, kept only when it is one of the six ids. Everything else (the artwork, the hooks,
// the labels) is a constant of this module.
//
// Patching: every element is built once and kept; an update rewrites a text only when it differs, toggles attributes,
// and attaches or detaches the parts a state shows (the note field stays the same element, so its text and focus
// survive updates). A collected stamp's artwork is rebuilt only when its time changes, and its "inked" animation is
// played once per stamp, only when the view marks it `fresh` and the user hasn't asked for reduced motion.
import { chopArt, inkDefs, markArt, chipArt, miniArt, outlineArt, portraitArt, guillocheArt, stampArt } from './art.ts';
import { COVER_COPY, STAMP_LABELS, STAMP_PROOFS, UI_TEXT } from './labels.ts';
import { longDate, relativeTime, safeHref, safeText, scalarCount, shortAccount } from './text.ts';
import { type PassportHandlers, type PassportView, type StampId, type StampState, STAMP_IDS } from './types.ts';

export type { PassportHandlers, PassportView, StampId, StampState } from './types.ts';
export { STAMP_IDS } from './types.ts';
export { COVER_COPY, STAMP_LABELS, STAMP_PROOFS } from './labels.ts';

/** The postcard's limit, in Unicode scalar values (the contract's count). */
export const NOTE_MAX = 140;

const HTML_NS = 'http://www.w3.org/1999/xhtml';
type Kid = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

/** Set a text only when it differs (no needless mutation, no screen-reader chatter). */
function setText(e: Element, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

function setAttr(e: Element, name: string, value: string | null): void {
  if (value === null) {
    if (e.hasAttribute(name)) e.removeAttribute(name);
  } else if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

function setDisabled(e: HTMLButtonElement | HTMLInputElement, v: boolean): void {
  if (e.disabled !== v) e.disabled = v;
}

/** Make `parent`'s children exactly `want`, in order, moving only what is out of place. */
function place(parent: Element, want: (Element | false | null | undefined)[]): void {
  const list = want.filter((x): x is Element => !!x);
  for (const child of [...parent.children]) if (!list.includes(child)) child.remove();
  list.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null);
  });
}

/** A link from the view: kept only when its href is http(s); another site opens in a new tab. */
function setLink(a: HTMLAnchorElement, href: unknown, base: string, origin: string): boolean {
  const url = safeHref(href, base);
  if (!url) {
    setAttr(a, 'href', null);
    return false;
  }
  setAttr(a, 'href', url.href);
  setAttr(a, 'rel', 'noopener noreferrer');
  setAttr(a, 'target', url.origin === origin ? null : '_blank');
  return true;
}

const icon = (paths: string, cls = 'pp-ic') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths);
  s.append(p);
  return s;
};
const ICON_COPY = 'M7 7h9v9H7z M4 13V4h9';
const ICON_INFO = 'M10 2.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z M10 9v5 M10 6.4v.1';
const ICON_ERROR = 'M10 2.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15z M7.5 7.5l5 5 M12.5 7.5l-5 5';

let mounts = 0;

interface Slot {
  id: StampId;
  li: HTMLLIElement;
  art: HTMLDivElement;
  outline: SVGElement;
  stamp: SVGElement | null;
  stampKey: string;
  chop: SVGElement;
  cap: HTMLDivElement;
  title: HTMLHeadingElement;
  meta: HTMLParagraphElement;
  metaDate: HTMLTimeElement;
  badge: HTMLSpanElement;
  text: HTMLParagraphElement;
  note: HTMLParagraphElement;
  /** A locked stamp's line of what to do, its link and its Copy button (D807). */
  detail: HTMLParagraphElement;
  help: HTMLAnchorElement;
  copy: HTMLButtonElement;
  field: HTMLDivElement | null;
  input: HTMLInputElement | null;
  count: HTMLSpanElement | null;
  button: HTMLButtonElement;
  buttonLabel: HTMLSpanElement;
  tx: HTMLAnchorElement;
  status: StampState['status'] | null;
}

interface RecentRow {
  li: HTMLLIElement;
  link: HTMLAnchorElement;
  plain: HTMLSpanElement;
  time: HTMLTimeElement;
  atMs: number;
}

export function mountPassport(root: HTMLElement, handlers: PassportHandlers): { update(view: PassportView): void; destroy(): void } {
  const prefix = `pp${++mounts}`;
  const doc = root.ownerDocument;
  const base = () => doc.baseURI;
  const origin = () => {
    try {
      return new URL(doc.baseURI).origin;
    } catch {
      return '';
    }
  };
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The stamps whose inked animation has played (or been skipped): `${id}:${atMs}`. */
  const inked = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let view: PassportView | null = null;
  let fullShown = false;

  const wrap = h('div', { class: 'pp', 'data-mode': 'cover' });
  const live = h('div', { class: 'pp-sr', 'aria-live': 'polite', 'data-role': 'live' });

  // ---- notice ----
  const noticeText = h('span', { class: 'pp-notice-text' });
  const noticeLink = h('a', { class: 'pp-notice-link' });
  const noticeBody = h('div', { class: 'body' }, noticeText);
  const noticeIconInfo = icon(ICON_INFO, 'ic');
  const noticeIconError = icon(ICON_ERROR, 'ic');
  const notice = h('div', { class: 'jp-alert pp-notice', 'data-role': 'notice', 'aria-live': 'polite', hidden: '' }, noticeIconInfo, noticeBody);

  // ---- cover ----
  const coverSignIn = h('button', { type: 'button', class: 'jp-btn jp-btn-primary jp-btn-lg pp-btn', 'data-action': 'sign-in' }, COVER_COPY.signIn);
  const coverBook = h(
    'div',
    { class: 'pp-coverbook', 'aria-hidden': 'true' },
    h('div', { class: 'pp-cover-foil' }, markArt('pp-crest'), h('p', { class: 'pp-cover-name' }, 'JOURNEAR'), h('p', { class: 'pp-cover-kind' }, 'PASSPORT'), chipArt(), h('p', { class: 'pp-cover-net' }, 'NEAR TESTNET')),
  );
  const cover = h(
    'section',
    { class: 'pp-cover', 'aria-labelledby': `${prefix}-cover-h` },
    coverBook,
    h(
      'div',
      { class: 'pp-coverside' },
      h('p', { class: 'pp-eyebrow' }, COVER_COPY.eyebrow),
      h('h1', { class: 'pp-h1', id: `${prefix}-cover-h` }, COVER_COPY.title),
      h('p', { class: 'pp-lead' }, COVER_COPY.line),
      h('div', { class: 'pp-row' }, coverSignIn),
      h('p', { class: 'pp-fine' }, COVER_COPY.fine),
    ),
  );

  // ---- identity page ----
  const idHeading = h('h2', { class: 'pp-pagetitle', id: `${prefix}-id-h` });
  const account = h('code', { class: 'pp-account', 'data-role': 'account' });
  const fullAccount = h('code', { class: 'pp-account-full', id: `${prefix}-full` });
  const fullRow = h('dd', { class: 'pp-fullrow' }, fullAccount);
  const copyBtn = h('button', { type: 'button', class: 'jp-btn jp-btn-ghost jp-btn-sm pp-btn', 'data-action': 'copy-account' }, icon(ICON_COPY, 'ic'), UI_TEXT.copy);
  const fullBtn = h('button', { type: 'button', class: 'jp-btn jp-btn-ghost jp-btn-sm pp-btn', 'data-action': 'show-full', 'aria-expanded': 'false', 'aria-controls': `${prefix}-full` }, UI_TEXT.showFull);
  const balanceValue = h('span', {});
  const balanceLink = h('a', { class: 'pp-link pp-balance-link', 'data-role': 'balance-link' });
  const balance = h('dd', { class: 'pp-balance', 'data-role': 'balance' }, balanceValue);
  const balanceDt = h('dt', {}, UI_TEXT.balance);
  const stampCount = h('dd', { 'data-role': 'count' });
  const accountActs = h('span', { class: 'pp-acts' }, copyBtn, fullBtn);
  const fieldRows = {
    accountDt: h('dt', {}, UI_TEXT.account),
    accountDd: h('dd', { class: 'pp-accountrow' }, account, accountActs),
    networkDt: h('dt', {}, UI_TEXT.network),
    networkDd: h('dd', {}, UI_TEXT.networkValue),
    stampsDt: h('dt', {}, UI_TEXT.stamps),
  };
  const fields = h('dl', { class: 'pp-fields' });
  const explorer = h('a', { class: 'pp-link', 'data-role': 'explorer' }, UI_TEXT.explorer);
  const shareLink = h('a', { class: 'pp-link pp-share-url', 'data-role': 'share' });
  const share = h('p', { class: 'pp-share' }, h('span', { class: 'pp-share-label' }, UI_TEXT.share), shareLink);
  const links = h('div', { class: 'pp-links' });
  const publicNote = h('p', { class: 'pp-publicnote' }, UI_TEXT.publicNote);
  const signOut = h('button', { type: 'button', class: 'jp-btn jp-btn-secondary pp-btn', 'data-action': 'sign-out' }, UI_TEXT.signOut);
  const ownPassport = h('button', { type: 'button', class: 'jp-btn jp-btn-primary pp-btn', 'data-action': 'sign-in' }, UI_TEXT.ownPassport);
  const idActions = h('div', { class: 'pp-row pp-idactions' });
  const portraitBox = h('div', { class: 'pp-photo' });
  let portraitFor = '';
  const mrz1 = h('span', {});
  const mrz2 = h('span', {});
  const idTop = [
    guillocheArt(),
    h('header', { class: 'pp-pagehead' }, markArt('pp-headmark'), h('span', { class: 'pp-headname' }, 'JOURNEAR PASSPORT'), h('span', { class: 'pp-headcode' }, 'NEAR · TESTNET')),
    idHeading,
    h('div', { class: 'pp-idgrid' }, portraitBox, fields),
  ];
  const proofs = h(
    'div',
    { class: 'pp-proofs' },
    h('h3', { class: 'pp-proofs-h' }, UI_TEXT.proofs),
    h(
      'ul',
      { class: 'pp-prooflist' },
      ...STAMP_IDS.map((sid) =>
        h('li', {}, h('span', { class: 'pp-r-icon', 'data-ink': sid }, miniArt(sid)), h('span', {}, h('b', {}, STAMP_LABELS[sid].title), ' ', STAMP_PROOFS[sid])),
      ),
    ),
  );
  const idBottom = [proofs, h('p', { class: 'pp-mrz', 'aria-hidden': 'true' }, mrz1, mrz2), h('span', { class: 'pp-pageno', 'aria-hidden': 'true' }, '1')];
  const idPage = h('section', { class: 'pp-page pp-page-id', 'aria-labelledby': `${prefix}-id-h` }, ...idTop, links, idActions, ...idBottom);

  // ---- stamps page ----
  const stampsCount = h('span', { class: 'pp-pagecount' });
  const slotList = h('ol', { class: 'pp-slots' });
  const slots = new Map<StampId, Slot>();
  for (const id of STAMP_IDS) {
    const slot = makeSlot(id);
    slots.set(id, slot);
    slotList.append(slot.li);
  }
  const stampsPage = h(
    'section',
    { class: 'pp-page pp-page-stamps', 'aria-labelledby': `${prefix}-st-h` },
    guillocheArt(),
    h('header', { class: 'pp-pagehead' }, h('h2', { class: 'pp-headname', id: `${prefix}-st-h` }, 'STAMPS'), stampsCount),
    slotList,
    h('span', { class: 'pp-pageno', 'aria-hidden': 'true' }, '2'),
  );
  const book = h('div', { class: 'pp-book' }, idPage, stampsPage);

  // ---- recent ----
  const totals = h('p', { class: 'pp-totals', 'data-role': 'totals', hidden: '' });
  const refresh = h('button', { type: 'button', class: 'jp-btn jp-btn-ghost jp-btn-sm pp-btn', 'data-action': 'refresh' }, UI_TEXT.refresh);
  const recentList = h('ol', { class: 'pp-recentlist', 'data-role': 'recent' });
  const recentEmpty = h('p', { class: 'pp-empty' }, UI_TEXT.recentEmpty);
  const recentRows = new Map<string, RecentRow>();
  const recent = h(
    'section',
    { class: 'pp-recent', 'aria-labelledby': `${prefix}-rc-h` },
    h('div', { class: 'pp-recenthead' }, h('h2', { class: 'pp-h2', id: `${prefix}-rc-h` }, UI_TEXT.recent), totals, refresh),
    recentList,
  );

  wrap.append(inkDefs(prefix), live, notice);
  root.append(wrap);

  // ---- events: one delegated listener for every action ----
  const onClick = (ev: Event) => {
    const target = (ev.target as Element | null)?.closest?.('[data-action]');
    if (!target || !wrap.contains(target)) return;
    if (target instanceof HTMLButtonElement && target.disabled) return;
    switch (target.getAttribute('data-action')) {
      case 'sign-in':
        handlers.signIn();
        break;
      case 'sign-out':
        handlers.signOut();
        break;
      case 'copy-account':
        handlers.copyAccount();
        break;
      case 'refresh':
        handlers.refresh();
        break;
      case 'show-full':
        fullShown = !fullShown;
        renderIdentity();
        break;
      case 'collect': {
        const id = target.closest('[data-stamp]')?.getAttribute('data-stamp') as StampId | null;
        if (id) collect(id);
        break;
      }
    }
  };
  const onInput = (ev: Event) => {
    const input = ev.target;
    if (input instanceof HTMLInputElement && input.getAttribute('data-field') === 'note') {
      const slot = slots.get('postcard');
      if (slot) renderNoteState(slot);
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    const input = ev.target;
    if (ev.key === 'Enter' && input instanceof HTMLInputElement && input.getAttribute('data-field') === 'note') {
      ev.preventDefault();
      const slot = slots.get('postcard');
      if (slot && !slot.button.disabled && slot.button.isConnected) collect('postcard');
    }
  };
  wrap.addEventListener('click', onClick);
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('keydown', onKey);

  function collect(id: StampId): void {
    const slot = slots.get(id);
    if (!slot || !view) return;
    // A stamp's own next step (D807) is the busy slot's: it is offered while the page is busy.
    if (slot.status === 'continue') {
      if (view.mode === 'mine') handlers.collect(id);
      return;
    }
    if (view.busy) return;
    if (slot.status !== 'available' && slot.status !== 'failed') return;
    if (id === 'postcard') {
      const note = (slot.input?.value ?? '').trim();
      const n = scalarCount(note);
      if (n < 1 || n > NOTE_MAX) {
        slot.input?.focus();
        return;
      }
      handlers.collect(id, { note });
    } else handlers.collect(id);
  }

  // ---- a slot ----
  function makeSlot(id: StampId): Slot {
    const label = STAMP_LABELS[id];
    const outline = outlineArt(id);
    const chop = chopArt(prefix);
    const art = h('div', { class: 'pp-art' }, outline);
    const title = h('h3', { class: 'pp-slottitle' }, label.title);
    const metaDate = h('time', {});
    const badge = h('span', { class: 'pp-nogas', title: UI_TEXT.noGasLong }, UI_TEXT.noGas);
    const meta = h('p', { class: 'pp-meta' }, metaDate);
    const text = h('p', { class: 'pp-text' });
    const note = h('p', { class: 'pp-note', dir: 'auto' });
    const buttonLabel = h('span', {}, UI_TEXT.collect);
    const button = h('button', { type: 'button', class: 'jp-btn jp-btn-primary pp-btn pp-collect', 'data-action': 'collect' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), buttonLabel);
    const tx = h('a', { class: 'pp-link pp-tx' }, UI_TEXT.viewTx);
    const detail = h('p', { class: 'pp-detail' });
    const help = h('a', { class: 'pp-link pp-help', 'data-role': 'stamp-link' });
    const copy = h('button', { type: 'button', class: 'jp-btn jp-btn-ghost jp-btn-sm pp-btn pp-slotcopy', 'data-action': 'copy-account', 'aria-label': `${UI_TEXT.copy} your full account id` }, icon(ICON_COPY, 'ic'), UI_TEXT.copyAccount);
    let field: HTMLDivElement | null = null;
    let input: HTMLInputElement | null = null;
    let count: HTMLSpanElement | null = null;
    if (id === 'postcard') {
      const inputId = `${prefix}-note`;
      input = h('input', {
        id: inputId,
        class: 'jp-input pp-noteinput',
        type: 'text',
        'data-field': 'note',
        maxlength: String(NOTE_MAX),
        autocomplete: 'off',
        spellcheck: 'true',
        dir: 'auto',
        placeholder: UI_TEXT.notePlaceholder,
        'aria-describedby': `${prefix}-note-hint ${prefix}-note-count`,
      });
      count = h('span', { class: 'pp-count', id: `${prefix}-note-count`, 'aria-live': 'polite' }, `0 / ${NOTE_MAX}`);
      field = h(
        'div',
        { class: 'jp-field pp-notefield' },
        h('label', { class: 'jp-label', for: inputId }, UI_TEXT.noteLabel),
        input,
        h('div', { class: 'pp-fieldfoot' }, h('span', { class: 'jp-hint', id: `${prefix}-note-hint` }, UI_TEXT.noteHint), count),
      );
      button.setAttribute('aria-describedby', `${prefix}-note-hint`);
    }
    const cap = h('div', { class: 'pp-cap' }, title);
    const li = h('li', { class: 'pp-slot', 'data-stamp': id }, art, cap);
    return { id, li, art, outline, stamp: null, stampKey: '', chop, cap, title, meta, metaDate, badge, text, note, detail, help, copy, field, input, count, button, buttonLabel, tx, status: null };
  }

  function renderNoteState(slot: Slot): void {
    if (!slot.input || !slot.count) return;
    const n = scalarCount(slot.input.value.trim());
    setText(slot.count, `${n} / ${NOTE_MAX}`);
    const working = slot.status === 'working';
    const blocked = !view || !!view.busy || working || n < 1 || n > NOTE_MAX;
    setDisabled(slot.button, blocked);
    setDisabled(slot.input, working || !!view?.busy);
  }

  function renderSlot(slot: Slot, st: StampState | undefined, busy: boolean): void {
    const state: StampState = st && st.id === slot.id ? st : { id: slot.id, status: 'locked', reason: '' };
    const label = STAMP_LABELS[slot.id];
    const changed = slot.status !== state.status;
    slot.status = state.status;
    setAttr(slot.li, 'data-status', state.status);
    setAttr(slot.li, 'aria-busy', state.status === 'working' ? 'true' : null);

    let showMeta = false;
    let showText = false;
    let showNote = false;
    let showField = false;
    let showButton = false;
    let showTx = false;
    let showChop = false;
    let showDetail = false;
    let showHelp = false;
    let showCopy = false;

    if (state.status === 'collected') {
      const key = String(state.atMs);
      if (slot.stampKey !== key || !slot.stamp) {
        const art = stampArt(slot.id, state.atMs, prefix, `${label.title} stamp, ${longDate(state.atMs) || 'date unknown'}`);
        if (slot.stamp) slot.stamp.replaceWith(art);
        slot.stamp = art;
        slot.stampKey = key;
      }
      const inkKey = `${slot.id}:${key}`;
      if (state.fresh && !inked.has(inkKey)) {
        inked.add(inkKey);
        if (!reducedMotion()) startInking(slot);
      } else if (!state.fresh) inked.add(inkKey);
      const iso = Number.isFinite(state.atMs) && Math.abs(state.atMs) <= 8.64e15 ? new Date(state.atMs).toISOString() : null;
      setAttr(slot.metaDate, 'datetime', iso);
      setText(slot.metaDate, longDate(state.atMs));
      place(slot.meta, [slot.metaDate, state.sponsored && slot.badge]);
      showMeta = true;
      showChop = state.sponsored && slot.id !== 'sponsored';
      if (slot.id === 'postcard' && typeof state.note === 'string' && state.note.length > 0) {
        setText(slot.note, safeText(state.note, NOTE_MAX));
        showNote = true;
      }
      showTx = setLink(slot.tx, state.txUrl, base(), origin());
    } else {
      if (state.status === 'available') {
        setText(slot.text, label.blurb);
        showText = true;
        showButton = true;
      } else if (state.status === 'locked') {
        setText(slot.text, safeText(state.reason, 200));
        showText = slot.text.textContent !== '';
        if (typeof state.detail === 'string' && state.detail !== '') {
          setText(slot.detail, safeText(state.detail, 300));
          showDetail = true;
        }
        showHelp = setLink(slot.help, state.href, base(), origin());
        if (showHelp) setText(slot.help, safeText(state.hrefLabel || 'Open ↗', 60));
        showCopy = state.copyAccount === true && typeof view?.accountId === 'string' && view.accountId !== '';
      } else if (state.status === 'working' || state.status === 'continue') {
        setText(slot.text, safeText(state.stage, 200));
        showText = true;
        showButton = true;
      } else {
        setText(slot.text, safeText(state.message, 300));
        showText = true;
        showButton = true;
      }
      // The postcard's note is sent with its first step: a step to continue needs no field.
      showField = slot.id === 'postcard' && showButton && state.status !== 'continue';
      setAttr(slot.text, 'role', state.status === 'failed' ? 'alert' : null);
      const word =
        state.status === 'failed'
          ? UI_TEXT.retry
          : state.status === 'working'
            ? UI_TEXT.working
            : state.status === 'continue'
              ? safeText(state.action, 40) || UI_TEXT.continue
              : slot.id === 'postcard'
                ? UI_TEXT.collectPostcard
                : UI_TEXT.collect;
      setText(slot.buttonLabel, word);
      if (slot.id !== 'postcard' || state.status === 'continue') setDisabled(slot.button, state.status === 'continue' ? false : busy || state.status === 'working');
      // The accessible name starts with the visible words, then says which stamp.
      setAttr(slot.button, 'aria-label', word.toLowerCase().includes(label.title.toLowerCase()) ? null : `${word} ${label.title}`);
    }

    place(slot.art, [state.status === 'collected' ? slot.stamp : slot.outline, showChop && slot.chop]);
    place(slot.cap, [slot.title, showMeta && slot.meta, showText && slot.text, showDetail && slot.detail, showNote && slot.note, showField && slot.field, showButton && slot.button, showHelp && slot.help, showCopy && slot.copy, showTx && slot.tx]);
    if (showField) renderNoteState(slot);

    if (changed && view) {
      const word = UI_TEXT.status[state.status];
      setText(live, `${label.title}: ${word}${state.status === 'failed' || state.status === 'working' || state.status === 'continue' ? `. ${slot.text.textContent ?? ''}` : ''}`);
    }
  }

  function startInking(slot: Slot): void {
    const art = slot.art;
    art.classList.remove('is-inking');
    // Restart only this element's animation: a reflow between the class removal and its addition.
    void art.offsetWidth;
    art.classList.add('is-inking');
    const done = () => {
      art.classList.remove('is-inking');
      art.removeEventListener('animationend', onEnd);
    };
    const onEnd = (e: Event) => {
      if (e.target === slot.stamp) done();
    };
    art.addEventListener('animationend', onEnd);
    const t = setTimeout(() => {
      timers.delete(t);
      done();
    }, 1600);
    timers.add(t);
  }

  // ---- identity ----
  function renderIdentity(): void {
    if (!view) return;
    const mine = view.mode === 'mine';
    const id = safeText(view.accountId ?? '', 128);
    setText(idHeading, mine ? UI_TEXT.mine : UI_TEXT.public);
    setText(account, id ? shortAccount(id) : '…');
    setText(fullAccount, id);
    setAttr(fullBtn, 'aria-expanded', fullShown ? 'true' : 'false');
    setText(fullBtn, fullShown ? UI_TEXT.hideFull : UI_TEXT.showFull);
    const long = id !== shortAccount(id);
    place(accountActs, [id !== '' && copyBtn, long && fullBtn]);
    const hasBalance = mine && typeof view.balanceNear === 'string' && view.balanceNear !== '';
    if (hasBalance) setText(balanceValue, `${safeText(view.balanceNear, 40)} NEAR`);
    const hasBalanceLink = hasBalance && setLink(balanceLink, view.balanceLink?.href, base(), origin());
    if (hasBalanceLink) setText(balanceLink, safeText(view.balanceLink?.label || 'Open ↗', 60));
    place(balance, [balanceValue, hasBalanceLink && balanceLink]);
    const collected = view.stamps.filter((s) => s.status === 'collected').length;
    setText(stampCount, UI_TEXT.collectedOf(collected));
    setText(stampsCount, `${collected} / 6`);
    place(fields, [
      fieldRows.accountDt,
      fieldRows.accountDd,
      fullShown && long && fullRow,
      fieldRows.networkDt,
      fieldRows.networkDd,
      hasBalance && balanceDt,
      hasBalance && balance,
      fieldRows.stampsDt,
      stampCount,
    ]);
    const hasExplorer = setLink(explorer, view.explorerUrl, base(), origin());
    const hasShare = setLink(shareLink, view.shareUrl, base(), origin());
    if (hasShare) setText(shareLink, shortUrl(shareLink.getAttribute('href') ?? ''));
    place(links, [hasExplorer && explorer, hasShare && share]);
    place(idActions, [mine ? signOut : ownPassport]);
    setDisabled(ownPassport, !!view.busy);
    if (portraitFor !== id) {
      portraitFor = id;
      place(portraitBox, [portraitArt(id || '-')]);
    }
    const [l1, l2] = mrz(id, collected);
    setText(mrz1, l1);
    setText(mrz2, l2);
    place(idPage, [...idTop, !mine && publicNote, links, idActions, ...idBottom]);
  }

  // ---- recent ----
  function renderRecent(): void {
    if (!view) return;
    const now = Date.now();
    const want: HTMLLIElement[] = [];
    const seen = new Set<string>();
    for (const r of Array.isArray(view.recent) ? view.recent.slice(0, 50) : []) {
      if (!r || !STAMP_IDS.includes(r.stamp)) continue;
      const acct = safeText(r.accountId, 128);
      const key = `${acct}|${r.stamp}|${r.atMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let row = recentRows.get(key);
      if (!row) {
        const link = h('a', { class: 'pp-r-acct' });
        const plain = h('span', { class: 'pp-r-acct' });
        const time = h('time', { class: 'pp-r-time' });
        setText(link, shortAccount(acct));
        setText(plain, shortAccount(acct));
        const li = h(
          'li',
          { class: 'pp-recentitem', 'data-role': 'recent-item', 'data-kind': r.stamp },
          h('span', { class: 'pp-r-icon', 'data-ink': r.stamp }, miniArt(r.stamp)),
          h('span', { class: 'pp-r-title' }, STAMP_LABELS[r.stamp].title),
        );
        row = { li, link, plain, time, atMs: r.atMs };
        recentRows.set(key, row);
      }
      const hasLink = setLink(row.link, r.href, base(), origin());
      const iso = Number.isFinite(r.atMs) && Math.abs(r.atMs) <= 8.64e15 ? new Date(r.atMs).toISOString() : null;
      setAttr(row.time, 'datetime', iso);
      setAttr(row.time, 'title', longDate(r.atMs) || null);
      setText(row.time, relativeTime(r.atMs, now));
      place(row.li, [row.li.children[0] as Element, row.li.children[1] as Element, hasLink ? row.link : row.plain, row.time]);
      want.push(row.li);
    }
    for (const [key, row] of recentRows) if (!seen.has(key)) recentRows.delete(key) && row.li.remove();
    place(recentList, want);
    place(recent, [recent.children[0] as Element, want.length > 0 ? recentList : recentEmpty]);
    const t = view.totals;
    const okTotals = !!t && Number.isSafeInteger(t.passports) && Number.isSafeInteger(t.stamps) && t.passports >= 0 && t.stamps >= 0;
    if (okTotals) setText(totals, UI_TEXT.totals(t.passports, t.stamps));
    setAttr(totals, 'hidden', okTotals ? null : '');
    setDisabled(refresh, false);
  }

  function renderNotice(): void {
    const n = view?.notice;
    if (!n || typeof n.text !== 'string' || n.text === '') {
      setAttr(notice, 'hidden', '');
      setAttr(notice, 'data-kind', null);
      return;
    }
    const kind = n.kind === 'error' ? 'error' : 'info';
    setAttr(notice, 'data-kind', kind);
    setAttr(notice, 'class', `jp-alert pp-notice ${kind === 'error' ? 'jp-alert-danger' : 'jp-alert-info'}`);
    setAttr(notice, 'role', kind === 'error' ? 'alert' : 'status');
    place(notice, [kind === 'error' ? noticeIconError : noticeIconInfo, noticeBody]);
    setText(noticeText, safeText(n.text, 400));
    const hasLink = setLink(noticeLink, n.href, base(), origin());
    if (hasLink) setText(noticeLink, safeText(n.hrefLabel || 'Open ↗', 60));
    place(noticeBody, [noticeText, hasLink && noticeLink]);
    setAttr(notice, 'hidden', null);
  }

  function update(next: PassportView): void {
    view = next;
    const mode = next.mode === 'mine' || next.mode === 'public' ? next.mode : 'cover';
    setAttr(wrap, 'data-mode', mode);
    setAttr(wrap, 'aria-busy', next.busy ? 'true' : null);
    renderNotice();
    if (mode === 'cover') {
      setDisabled(coverSignIn, !!next.busy);
      place(wrap, [wrap.children[0] as Element, live, notice, cover, recent]);
    } else {
      renderIdentity();
      const busy = !!next.busy || mode === 'public';
      for (const id of STAMP_IDS) {
        const slot = slots.get(id)!;
        const st = Array.isArray(next.stamps) ? next.stamps.find((s) => s && s.id === id) : undefined;
        // Someone else's passport: nothing to collect there, so an empty slot is only an empty slot.
        const shown: StampState | undefined =
          mode === 'public' && (!st || st.status !== 'collected') ? { id, status: 'locked', reason: st?.status === 'locked' ? st.reason : UI_TEXT.notYet } : st;
        renderSlot(slot, shown, busy);
      }
      setAttr(stampsPage, 'data-public', mode === 'public' ? '' : null);
      place(wrap, [wrap.children[0] as Element, live, notice, book, recent]);
    }
    renderRecent();
  }

  function destroy(): void {
    wrap.removeEventListener('click', onClick);
    wrap.removeEventListener('input', onInput);
    wrap.removeEventListener('keydown', onKey);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    wrap.remove();
    view = null;
  }

  return { update, destroy };
}

/** A link as text, short: the host and the path, a long last segment (an account id) cut in the middle. */
function shortUrl(href: string): string {
  try {
    const u = new URL(href);
    const parts = u.pathname.split('/');
    const last = parts.pop() ?? '';
    return safeText(`${u.host}${parts.join('/')}/${shortAccount(decodeURIComponent(last))}`, 120);
  } catch {
    return safeText(href, 120);
  }
}

/** The identity page's machine-readable zone: decorative, two lines of 44 characters from [A-Z0-9<] only. */
function mrz(accountId: string, collected: number): [string, string] {
  const clean = accountId.toUpperCase().replace(/[^A-Z0-9]/gu, '<');
  const l1 = 'P<NRT<JOURNEAR<<PASSPORT'.padEnd(44, '<').slice(0, 44);
  const l2 = `${clean.slice(0, 30).padEnd(30, '<')}<NEAR<${String(collected)}<<`.padEnd(44, '<').slice(0, 44);
  return [l1, l2];
}
