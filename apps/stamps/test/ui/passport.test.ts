// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://stamps.example/"}
// The UI module (src/ui): each state renders with the hooks the site's tests use, the handlers get the right arguments,
// update() patches in place (a collected stamp's node, the note field's text and focus survive), the inked animation
// plays once and never under reduced motion, hostile strings stay text, and only http(s) links are kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PassportHandlers, type PassportView, STAMP_IDS, type StampId, type StampState, mountPassport } from '../../src/ui/index.ts';

const ME = '6e5e4e2b9f1c4d8a7b3e0f12c4a5d6e7f8091a2b3c4d5e6f708192a3b4f35000';
const AT = Date.UTC(2026, 10, 13, 15, 12, 0);
const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>‮evil‬​⁦x⁩';

const locked = (id: StampId): StampState => ({ id, status: 'locked', reason: 'Collect Arrival first' });

function view(over: Partial<PassportView> = {}, stamps?: Partial<Record<StampId, StampState>>): PassportView {
  const base: Record<StampId, StampState> = {
    arrival: { id: 'arrival', status: 'collected', atMs: AT, sponsored: true, txUrl: 'https://testnet.nearblocks.io/txns/abc' },
    sponsored: { id: 'sponsored', status: 'available' },
    own_fare: { id: 'own_fare', status: 'failed', message: 'No NEAR for the fee.' },
    signature: { id: 'signature', status: 'working', stage: 'Waiting for your approval…' },
    postcard: { id: 'postcard', status: 'available' },
    layover: { id: 'layover', status: 'locked', reason: 'In 1 min 40 s' },
  };
  const merged = { ...base, ...stamps };
  return {
    mode: 'mine',
    accountId: ME,
    explorerUrl: `https://testnet.nearblocks.io/address/${ME}`,
    balanceNear: '0',
    stamps: STAMP_IDS.map((id) => merged[id]),
    recent: [{ accountId: 'alice.testnet', stamp: 'postcard', atMs: AT - 120_000, href: '/p/alice.testnet' }],
    totals: { passports: 3, stamps: 9 },
    ...over,
  };
}

let root: HTMLElement;
let handlers: { [K in keyof PassportHandlers]: ReturnType<typeof vi.fn> };
let ui: ReturnType<typeof mountPassport>;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('main');
  document.body.append(root);
  handlers = { signIn: vi.fn(), signOut: vi.fn(), collect: vi.fn(), copyAccount: vi.fn(), refresh: vi.fn() };
  ui = mountPassport(root, handlers as unknown as PassportHandlers);
});
afterEach(() => {
  ui.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const $$ = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const slot = (id: StampId) => $(`[data-stamp="${id}"]`)!;
const click = (el: Element | null) => (el as HTMLElement).click();

describe('the cover', () => {
  it('shows the mark, one line and the sign-in button, and no stamps', () => {
    ui.update({ mode: 'cover', stamps: [], recent: [] });
    expect($('.pp')!.getAttribute('data-mode')).toBe('cover');
    expect($$('[data-action="sign-in"]')).toHaveLength(1);
    expect($('.pp-crest')).not.toBeNull();
    expect(root.textContent).toContain('Journear Passport');
    expect($$('[data-stamp]')).toHaveLength(0);
    expect($('[data-role="account"]')).toBeNull();
    click($('[data-action="sign-in"]'));
    expect(handlers.signIn).toHaveBeenCalledTimes(1);
    expect(handlers.signIn).toHaveBeenCalledWith();
  });

  it('disables sign-in while busy', () => {
    ui.update({ mode: 'cover', stamps: [], recent: [], busy: true });
    expect($<HTMLButtonElement>('[data-action="sign-in"]')!.disabled).toBe(true);
    click($('[data-action="sign-in"]'));
    expect(handlers.signIn).not.toHaveBeenCalled();
  });
});

describe('the open passport', () => {
  it('has six slots in catalog order, each with its status', () => {
    ui.update(view());
    expect($$('[data-stamp]').map((e) => [e.getAttribute('data-stamp'), e.getAttribute('data-status')])).toEqual([
      ['arrival', 'collected'],
      ['sponsored', 'available'],
      ['own_fare', 'failed'],
      ['signature', 'working'],
      ['postcard', 'available'],
      ['layover', 'locked'],
    ]);
  });

  it('collected: the inked stamp with its date, the no-gas marker, the transaction link; no collect control', () => {
    ui.update(view());
    const s = slot('arrival');
    expect(s.querySelector('[data-action="collect"]')).toBeNull();
    const art = s.querySelector('svg.pp-stamp')!;
    expect(art.getAttribute('role')).toBe('img');
    expect(art.textContent).toContain('13 NOV 2026');
    expect(art.textContent).toContain('ARRIVAL');
    expect(s.querySelector('.pp-nogas')!.textContent).toBe('No gas');
    expect(s.querySelector('time')!.getAttribute('datetime')).toBe(new Date(AT).toISOString());
    const tx = s.querySelector<HTMLAnchorElement>('a.pp-tx')!;
    expect(tx.getAttribute('href')).toBe('https://testnet.nearblocks.io/txns/abc');
    expect(tx.getAttribute('target')).toBe('_blank');
    expect(tx.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a stamp not sponsored has no marker; the sponsored stamp itself carries no extra chop', () => {
    ui.update(view({}, { arrival: { id: 'arrival', status: 'collected', atMs: AT, sponsored: false }, sponsored: { id: 'sponsored', status: 'collected', atMs: AT, sponsored: true } }));
    expect(slot('arrival').querySelector('.pp-nogas')).toBeNull();
    expect(slot('arrival').querySelector('.pp-chop')).toBeNull();
    expect(slot('arrival').querySelector('a.pp-tx')).toBeNull();
    expect(slot('sponsored').querySelector('.pp-nogas')).not.toBeNull();
    expect(slot('sponsored').querySelector('.pp-chop')).toBeNull();
  });

  it('available: title, blurb and an enabled Collect that calls collect(id) with the id alone', () => {
    ui.update(view());
    const s = slot('sponsored');
    expect(s.textContent).toContain('Fare paid');
    expect(s.textContent).toContain('Journear’s relay paid the fee. You hold no NEAR.');
    const b = s.querySelector<HTMLButtonElement>('[data-action="collect"]')!;
    expect(b.tagName).toBe('BUTTON');
    expect(b.disabled).toBe(false);
    click(b);
    expect(handlers.collect).toHaveBeenCalledTimes(1);
    expect(handlers.collect.mock.calls[0]).toEqual(['sponsored']);
  });

  it('locked: the reason, no control', () => {
    ui.update(view());
    expect(slot('layover').querySelector('[data-action="collect"]')).toBeNull();
    expect(slot('layover').textContent).toContain('In 1 min 40 s');
  });

  it('working: the stage, the button disabled; failed: the message and a retry', () => {
    ui.update(view());
    const w = slot('signature');
    expect(w.textContent).toContain('Waiting for your approval…');
    expect(w.getAttribute('aria-busy')).toBe('true');
    expect(w.querySelector<HTMLButtonElement>('[data-action="collect"]')!.disabled).toBe(true);
    click(w.querySelector('[data-action="collect"]'));
    expect(handlers.collect).not.toHaveBeenCalled();
    const f = slot('own_fare');
    expect(f.textContent).toContain('No NEAR for the fee.');
    const retry = f.querySelector<HTMLButtonElement>('[data-action="collect"]')!;
    expect(retry.textContent).toContain('Try again');
    click(retry);
    expect(handlers.collect.mock.calls).toEqual([['own_fare']]);
  });

  it('continue (D807): the step in plain words and an enabled primary button with its label, even while busy; the click calls collect(id)', () => {
    ui.update(view({ busy: true }));
    ui.update(view({ busy: true }, { signature: { id: 'signature', status: 'continue', stage: 'Step 2 of 2: send your signed message to the contract.', action: 'Continue' } }));
    const c = slot('signature');
    expect(c.getAttribute('data-status')).toBe('continue');
    expect(c.getAttribute('aria-busy')).toBeNull();
    expect(c.textContent).toContain('Step 2 of 2: send your signed message to the contract.');
    const b = c.querySelector<HTMLButtonElement>('[data-action="collect"]')!;
    expect(b.disabled).toBe(false);
    expect(b.className).toContain('jp-btn-primary');
    expect(b.textContent).toContain('Continue');
    expect(b.getAttribute('aria-label')).toBe('Continue Signature');
    // Every other collect stays disabled while busy.
    expect(slot('sponsored').querySelector<HTMLButtonElement>('[data-action="collect"]')!.disabled).toBe(true);
    click(b);
    expect(handlers.collect.mock.calls).toEqual([['signature']]);
    expect($('[data-role="live"]')!.textContent).toContain('Signature: needs your click to continue. Step 2 of 2');
  });

  it('continue on the postcard hides its note field (the note went with the first step); public mode never shows it', () => {
    ui.update(view({}, { postcard: { id: 'postcard', status: 'continue', stage: 'Your approval is ready.', action: 'Continue' } }));
    expect(slot('postcard').querySelector('[data-field="note"]')).toBeNull();
    expect(slot('postcard').querySelector<HTMLButtonElement>('[data-action="collect"]')!.disabled).toBe(false);
    ui.update(view({ mode: 'public' }, { postcard: { id: 'postcard', status: 'continue', stage: 'x', action: 'Continue' } }));
    expect(slot('postcard').querySelector('[data-action="collect"]')).toBeNull();
  });

  it('locked with help (D807): the reason, a line of what to do, the link in a new tab, and Copy (the copy-account action)', () => {
    const own: StampState = { id: 'own_fare', status: 'locked', reason: 'Needs testnet NEAR', detail: 'Send testnet NEAR to your account.', href: 'https://faucet.example/', hrefLabel: 'Get testnet NEAR ↗', copyAccount: true };
    ui.update(view({}, { own_fare: own }));
    const o = slot('own_fare');
    expect(o.textContent).toContain('Needs testnet NEAR');
    expect(o.querySelector('.pp-detail')!.textContent).toBe('Send testnet NEAR to your account.');
    const a = o.querySelector<HTMLAnchorElement>('[data-role="stamp-link"]')!;
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.textContent]).toEqual(['https://faucet.example/', '_blank', 'noopener noreferrer', 'Get testnet NEAR ↗']);
    expect(o.querySelector('[data-action="collect"]')).toBeNull();
    click(o.querySelector('[data-action="copy-account"]'));
    expect(handlers.copyAccount).toHaveBeenCalledTimes(1);
    // A link that isn't http(s) is dropped; without copyAccount, no Copy; a plain locked slot has neither.
    ui.update(view({}, { own_fare: { ...own, href: 'javascript:alert(1)', copyAccount: false } }));
    expect(slot('own_fare').querySelector('[data-role="stamp-link"]')).toBeNull();
    expect(slot('own_fare').querySelector('[data-action="copy-account"]')).toBeNull();
    expect(slot('layover').querySelector('.pp-detail, [data-role="stamp-link"]')).toBeNull();
  });

  it('the balance link (D807): beside the balance in mine mode, http(s) only', () => {
    ui.update(view({ balanceNear: '0', balanceLink: { href: 'https://faucet.example/', label: 'Get testnet NEAR ↗' } }));
    const a = $<HTMLAnchorElement>('[data-role="balance-link"]')!;
    expect(a.getAttribute('href')).toBe('https://faucet.example/');
    expect(a.getAttribute('target')).toBe('_blank');
    expect($('[data-role="balance"]')!.textContent).toBe('0 NEARGet testnet NEAR ↗');
    ui.update(view({ balanceNear: '0', balanceLink: { href: 'data:text/html,x', label: 'x' } }));
    expect($('[data-role="balance-link"]')).toBeNull();
    expect($('[data-role="balance"]')!.textContent).toBe('0 NEAR');
  });

  it('busy disables every collect control', () => {
    ui.update(view({ busy: true }));
    for (const b of $$('[data-action="collect"]')) expect((b as HTMLButtonElement).disabled).toBe(true);
    click(slot('sponsored').querySelector('[data-action="collect"]'));
    expect(handlers.collect).not.toHaveBeenCalled();
  });

  it('the identity page: short account, copy, show full, explorer, balance, sign out, the share link', () => {
    ui.update(view({ shareUrl: `https://stamps.example/p/${ME}` }));
    expect($('[data-role="account"]')!.textContent).toBe('6e5e4e…f35000');
    click($('[data-action="copy-account"]'));
    expect(handlers.copyAccount).toHaveBeenCalledWith();
    const full = $('[data-action="show-full"]')!;
    expect(full.getAttribute('aria-expanded')).toBe('false');
    expect(root.textContent).not.toContain(ME);
    click(full);
    expect(full.getAttribute('aria-expanded')).toBe('true');
    expect($('.pp-account-full')!.textContent).toBe(ME);
    expect($('[data-role="balance"]')!.textContent).toBe('0 NEAR');
    const ex = $<HTMLAnchorElement>('[data-role="explorer"]')!;
    expect(ex.getAttribute('target')).toBe('_blank');
    expect(ex.getAttribute('rel')).toBe('noopener noreferrer');
    const share = $<HTMLAnchorElement>('[data-role="share"]')!;
    expect(share.getAttribute('href')).toBe(`https://stamps.example/p/${ME}`);
    expect(share.getAttribute('target')).toBeNull();
    expect(share.textContent).toBe('stamps.example/p/6e5e4e…f35000');
    click($('[data-action="sign-out"]'));
    expect(handlers.signOut).toHaveBeenCalledWith();
    expect($('[data-action="sign-in"]')).toBeNull();
  });

  it('public mode: read-only, no balance, no sign-out, no collect controls; an empty slot is just empty', () => {
    ui.update(view({ mode: 'public', balanceNear: '5' }));
    expect($('[data-role="balance"]')).toBeNull();
    expect($('[data-action="sign-out"]')).toBeNull();
    expect($$('[data-action="collect"]')).toHaveLength(0);
    expect(slot('sponsored').getAttribute('data-status')).toBe('locked');
    expect(slot('sponsored').textContent).toContain('Not collected yet');
    expect(slot('arrival').getAttribute('data-status')).toBe('collected');
    expect($('[data-action="sign-in"]')!.textContent).toBe('Get your own passport');
  });

  it('recent stamps and totals; refresh calls refresh()', () => {
    ui.update(view());
    const items = $$('[data-role="recent"] [data-role="recent-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('Postcard');
    expect(items[0]!.textContent).toContain('alice.testnet');
    const a = items[0]!.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://stamps.example/p/alice.testnet');
    expect(a.getAttribute('target')).toBeNull();
    expect($('[data-role="totals"]')!.textContent).toBe('3 passports · 9 stamps');
    click($('[data-action="refresh"]'));
    expect(handlers.refresh).toHaveBeenCalledWith();
  });

  it('an empty recent list says so; no totals hides the line', () => {
    ui.update(view({ recent: [], totals: undefined }));
    expect($$('[data-role="recent-item"]')).toHaveLength(0);
    expect(root.textContent).toContain('No stamps yet');
    expect($('[data-role="totals"]')!.hidden).toBe(true);
  });

  it('the notice: info or error, with an optional link', () => {
    ui.update(view({ notice: { kind: 'error', text: 'The relay is busy.', href: 'https://testnet.nearblocks.io/txns/x', hrefLabel: 'View it ↗' } }));
    const n = $('[data-role="notice"]')!;
    expect(n.hidden).toBe(false);
    expect(n.getAttribute('data-kind')).toBe('error');
    expect(n.getAttribute('role')).toBe('alert');
    expect(n.textContent).toContain('The relay is busy.');
    expect(n.querySelector('a')!.textContent).toBe('View it ↗');
    ui.update(view({ notice: { kind: 'info', text: 'Copied.' } }));
    expect(n.getAttribute('data-kind')).toBe('info');
    expect(n.querySelector('a')).toBeNull();
    ui.update(view());
    expect(n.hidden).toBe(true);
  });

  it('announces a slot’s change of status in the live region', () => {
    ui.update(view());
    ui.update(view({}, { sponsored: { id: 'sponsored', status: 'working', stage: 'Sending…' } }));
    expect($('[data-role="live"]')!.textContent).toBe('Fare paid: in progress. Sending…');
  });
});

describe('the postcard', () => {
  it('has a 140-character field with a live counter; Collect sends the trimmed note', () => {
    ui.update(view());
    const input = slot('postcard').querySelector<HTMLInputElement>('[data-field="note"]')!;
    expect(input.getAttribute('maxlength')).toBe('140');
    expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    const button = slot('postcard').querySelector<HTMLButtonElement>('[data-action="collect"]')!;
    expect(button.disabled).toBe(true);
    input.value = '  gm 👋  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(slot('postcard').querySelector('.pp-count')!.textContent).toBe('4 / 140');
    expect(button.disabled).toBe(false);
    click(button);
    expect(handlers.collect.mock.calls).toEqual([['postcard', { note: 'gm 👋' }]]);
  });

  it('Enter in the field sends it; a blank note sends nothing', () => {
    ui.update(view());
    const input = slot('postcard').querySelector<HTMLInputElement>('[data-field="note"]')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handlers.collect).not.toHaveBeenCalled();
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handlers.collect.mock.calls).toEqual([['postcard', { note: 'hello' }]]);
  });

  it('the collected postcard shows its note beneath, as text', () => {
    ui.update(view({}, { postcard: { id: 'postcard', status: 'collected', atMs: AT, sponsored: true, note: 'gm from KL' } }));
    expect(slot('postcard').querySelector('.pp-note')!.textContent).toBe('gm from KL');
    expect(slot('postcard').querySelector('[data-field="note"]')).toBeNull();
  });
});

describe('patching', () => {
  it('keeps the slots, a collected stamp’s artwork and the links across repeated updates', () => {
    ui.update(view());
    const li = slot('arrival');
    const art = li.querySelector('svg.pp-stamp');
    const tx = li.querySelector('a.pp-tx');
    const recentItem = $('[data-role="recent-item"]');
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    for (let i = 0; i < 5; i++) ui.update(view());
    const recs = observer.takeRecords();
    expect(recs).toHaveLength(0);
    observer.disconnect();
    expect(slot('arrival')).toBe(li);
    expect(li.querySelector('svg.pp-stamp')).toBe(art);
    expect(li.querySelector('a.pp-tx')).toBe(tx);
    expect($('[data-role="recent-item"]')).toBe(recentItem);
  });

  it('a countdown tick rewrites only the reason’s text', () => {
    ui.update(view());
    const text = slot('layover').querySelector('.pp-text')!;
    ui.update(view({}, { layover: { id: 'layover', status: 'locked', reason: 'In 1 min 39 s' } }));
    expect(slot('layover').querySelector('.pp-text')).toBe(text);
    expect(text.textContent).toBe('In 1 min 39 s');
  });

  it('the note field keeps its text and focus while the site updates, and through working and failed', () => {
    ui.update(view());
    const input = slot('postcard').querySelector<HTMLInputElement>('[data-field="note"]')!;
    input.focus();
    input.value = 'half-typed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    ui.update(view());
    ui.update(view({}, { layover: { id: 'layover', status: 'locked', reason: 'In 1 min 30 s' } }));
    expect(slot('postcard').querySelector('[data-field="note"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('half-typed');
    ui.update(view({}, { postcard: { id: 'postcard', status: 'working', stage: 'Sending…' } }));
    expect(slot('postcard').querySelector('[data-field="note"]')).toBe(input);
    expect(input.disabled).toBe(true);
    ui.update(view({}, { postcard: { id: 'postcard', status: 'failed', message: 'Try a shorter note.' } }));
    expect(slot('postcard').querySelector('[data-field="note"]')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('half-typed');
  });

  it('a stamp collected later gets new artwork; a different time replaces it', () => {
    ui.update(view({}, { sponsored: { id: 'sponsored', status: 'available' } }));
    expect(slot('sponsored').querySelector('svg.pp-stamp')).toBeNull();
    ui.update(view({}, { sponsored: { id: 'sponsored', status: 'collected', atMs: AT, sponsored: true } }));
    const first = slot('sponsored').querySelector('svg.pp-stamp');
    expect(first).not.toBeNull();
    ui.update(view({}, { sponsored: { id: 'sponsored', status: 'collected', atMs: AT + 86_400_000, sponsored: true } }));
    const second = slot('sponsored').querySelector('svg.pp-stamp');
    expect(second).not.toBe(first);
    expect(second!.textContent).toContain('14 NOV 2026');
  });
});

describe('the inked animation', () => {
  const fresh = (f: boolean) => view({}, { sponsored: { id: 'sponsored', status: 'collected', atMs: AT, sponsored: true, fresh: f } });

  it('plays once for a fresh stamp, and not again on later updates', () => {
    ui.update(view());
    ui.update(fresh(true));
    const art = slot('sponsored').querySelector('.pp-art')!;
    expect(art.classList.contains('is-inking')).toBe(true);
    // As animationend would.
    art.classList.remove('is-inking');
    ui.update(fresh(true));
    ui.update(fresh(true));
    expect(art.classList.contains('is-inking')).toBe(false);
  });

  it('never plays for a stamp that is not fresh', () => {
    ui.update(fresh(false));
    expect($$('.is-inking')).toHaveLength(0);
  });

  it('ends itself (the class comes off after the animation, or a timeout)', () => {
    vi.useFakeTimers();
    ui.update(fresh(true));
    expect($$('.is-inking')).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect($$('.is-inking')).toHaveLength(0);
  });

  it('does not play under reduced motion: the stamp is simply there', () => {
    ui.destroy();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} }));
    ui = mountPassport(root, handlers as unknown as PassportHandlers);
    ui.update(fresh(true));
    expect($$('.is-inking')).toHaveLength(0);
    expect(slot('sponsored').querySelector('svg.pp-stamp')).not.toBeNull();
  });
});

describe('untrusted strings and links', () => {
  function hostileView(): PassportView {
    return view(
      {
        accountId: HOSTILE,
        balanceNear: HOSTILE,
        shareUrl: 'javascript:alert(1)',
        explorerUrl: 'data:text/html,<script>alert(1)</script>',
        notice: { kind: 'info', text: HOSTILE, href: 'vbscript:msgbox(1)', hrefLabel: HOSTILE },
        recent: [
          { accountId: HOSTILE, stamp: 'arrival', atMs: AT, href: 'javascript:alert(1)' },
          { accountId: 'bob.testnet', stamp: 'nope' as StampId, atMs: AT, href: '/p/bob' },
          { accountId: 'carol.testnet', stamp: 'layover', atMs: AT, href: ' javascript:alert(1)' },
          { accountId: 'dave.testnet', stamp: 'signature', atMs: AT, href: 'https://user:pw@evil.example/' },
        ],
      },
      {
        postcard: { id: 'postcard', status: 'collected', atMs: AT, sponsored: true, note: HOSTILE, txUrl: 'javascript:alert(1)' },
        layover: { id: 'layover', status: 'locked', reason: HOSTILE },
        signature: { id: 'signature', status: 'working', stage: HOSTILE },
        own_fare: { id: 'own_fare', status: 'failed', message: HOSTILE },
      },
    );
  }

  it('renders every hostile string as text: no element, no attribute from it', () => {
    ui.update(hostileView());
    expect(root.querySelectorAll('img, script, iframe, object, embed')).toHaveLength(0);
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.startsWith('on'), `${el.tagName} ${attr.name}`).toBe(false);
        expect(attr.value, `${el.tagName} ${attr.name}`).not.toMatch(/onerror|alert\(|<script/u);
      }
    }
    // The markup shows as its own characters, and the direction and invisible characters as U+FFFD.
    const note = slot('postcard').querySelector('.pp-note')!.textContent!;
    expect(note).toContain('<img src=x onerror="alert(1)">');
    expect(note).not.toMatch(/[‪-‮⁦-⁩​]/u);
    expect(note).toContain('�evil���x�');
    expect(root.textContent).not.toMatch(/[‪-‮⁦-⁩​]/u);
    expect(slot('layover').textContent).toContain('<script>alert(2)</script>');
  });

  it('drops links that are not http(s): javascript:, data:, vbscript:, with spaces or credentials', () => {
    ui.update(hostileView());
    for (const a of root.querySelectorAll('a[href]')) expect(a.getAttribute('href')).toMatch(/^https?:\/\/[^@\s]+$/u);
    expect(slot('postcard').querySelector('a.pp-tx')).toBeNull();
    expect($('[data-role="explorer"]')).toBeNull();
    expect($('[data-role="share"]')).toBeNull();
    expect($('[data-role="notice"] a')).toBeNull();
    // A recent stamp of an unknown kind is left out; one with a bad link shows its account without a link.
    const items = $$('[data-role="recent-item"]');
    expect(items).toHaveLength(3);
    for (const it of items) expect(it.querySelector('a')).toBeNull();
  });

  it('keeps an emoji sequence whole (a zero-width joiner between pictographs)', () => {
    ui.update(view({}, { postcard: { id: 'postcard', status: 'collected', atMs: AT, sponsored: true, note: 'hi \u{1F469}‍\u{1F4BB}' } }));
    expect(slot('postcard').querySelector('.pp-note')!.textContent).toBe('hi \u{1F469}‍\u{1F4BB}');
  });

  it('isolates the note’s direction (dir=auto) so it can’t reorder the page around it', () => {
    ui.update(view({}, { postcard: { id: 'postcard', status: 'collected', atMs: AT, sponsored: true, note: 'שלום' } }));
    expect(slot('postcard').querySelector('.pp-note')!.getAttribute('dir')).toBe('auto');
  });
});

describe('destroy', () => {
  it('removes the passport and stops calling the handlers', () => {
    ui.update(view());
    const button = slot('sponsored').querySelector('[data-action="collect"]')!;
    ui.destroy();
    expect(root.children).toHaveLength(0);
    click(button);
    expect(handlers.collect).not.toHaveBeenCalled();
  });

  it('two passports on one page keep their own ids', () => {
    const other = document.createElement('div');
    document.body.append(other);
    const ui2 = mountPassport(other, handlers as unknown as PassportHandlers);
    ui.update(view());
    ui2.update(view());
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    ui2.destroy();
  });
});
