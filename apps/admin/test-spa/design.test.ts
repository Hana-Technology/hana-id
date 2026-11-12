// The Journear Passport design system's patterns on the staff SPA (D765; apps/admin/README.md "Design"), run as the
// browser runs public/app.js (boot.ts): the names staff read (packages/brand's BRAND, no "Hana"), one primary button per
// view, danger only inside a confirmation, toasts for what an action did (a stack of three, gone after 5 s unless the
// pointer is on one, a danger toast staying), fields checked when they are left (never while typing) with the optional
// ones marked, the save bar of a settings form, setting rows, the pager, right-aligned numbers and the brand's tables.
import { readFileSync } from 'node:fs';
import { BRAND } from '@hana-id/brand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, SRC, boot, closeWindow } from './boot.ts';

afterEach(async () => {
  vi.useRealTimers();
  await closeWindow();
});

const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const org = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: 'partner', status: 'active', createdAt: T - 9 * DAY, ...extra });
const ORGS = [org('org_legacy', 'Legacy apps', { kind: 'internal' }), org('org_lumen', 'Lumen Pay')];
const member = (userId: string, email: string, role: string) => ({ userId, sub: `sub-${userId}`, email, role, roleSince: T - DAY, disabled: false });
const APP = { id: 'app_pay', name: 'Lumen checkout', scopeId: 's_pay', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 12, pendingChanges: 3 };
const LUMEN = {
  org: ORGS[1],
  members: [member('usr_ann', 'ann@lumen.example', 'owner'), member('usr_bob', 'bob@lumen.example', 'viewer')],
  invites: [],
  grants: [],
  securityContacts: ['sec@lumen.example'],
  apps: [APP],
  flags: { noSecurityContacts: false, ownersNotContacts: [] },
};
const LEGACY = { ...LUMEN, org: ORGS[0], members: [], securityContacts: ['security@journear.example'], apps: [{ ...APP, id: 'app_wend', scopeId: 's_wend' }] };
const APP_DETAIL = { ...APP, orgId: 'org_lumen', originsVersion: 1, settingsVersion: 1, origins: [], changes: [], keys: [], settings: { rawSign: 'off', persistence: 'session', policy: null } };

/** The org screens' API; `write` answers every non-GET; `next` gives the list a next page. */
function orgsApi(write: (c: Call) => Answer = () => ({ body: { ok: true } }), opts: { next?: string } = {}) {
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path === '/api/orgs' || c.path.startsWith('/api/orgs?')) return { body: { orgs: ORGS, next: opts.next } };
    if (c.path === '/api/invites/new-orgs') return { body: { invites: [], truncated: false } };
    if (c.path.startsWith('/api/apps/app_pay')) return { body: { app: APP_DETAIL } };
    const m = /^\/api\/orgs\/([^/]+)(\/changes)?$/u.exec(c.path);
    if (m && m[2]) return { body: { changes: [] } };
    if (m && m[1] === 'org_lumen') return { body: LUMEN };
    if (m && m[1] === 'org_legacy') return { body: LEGACY };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}
type Session = ReturnType<typeof boot>;
const writes = (s: Session) => s.api().filter((c) => c.method !== 'GET');
/** The page's buttons a person can see now (not hidden, not in a closed box). */
const visible = (s: Session, sel: string) => [...s.main().querySelectorAll(sel)].filter((b) => !(b as unknown as HTMLElement).hidden && !b.closest('[hidden]'));
const typeInto = (s: Session, input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new s.w.Event('input', { bubbles: true }) as unknown as Event);
};
const leave = (s: Session, input: HTMLInputElement) => input.dispatchEvent(new s.w.Event('blur') as unknown as Event);

describe('the names staff read (D765)', () => {
  it('the SPA’s BRAND is packages/brand’s, and the page title and shell use it', async () => {
    const m = /const BRAND = Object\.freeze\((\{[^}]*\})\);/u.exec(SRC);
    expect(m).not.toBeNull();
    const mirrored = Function(`return (${m![1]});`)() as Record<string, string>;
    expect(mirrored).toEqual({ company: BRAND.company, product: BRAND.product, home: BRAND.home });
    const s = boot('/orgs', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('2 organisations'));
    expect(s.doc.title).toBe('Journear Passport admin (sandbox-dev)');
    expect(s.doc.querySelector('.lockup')!.getAttribute('aria-label')).toBe('Journear Passport');
  });

  it('no string staff read says "Hana": only code (the `hana` actor kind, `x-hana-admin`, `@hana-id/*`) and the Support ID format keep it', () => {
    const code = SRC.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/u.test(l))
      .map((l) => l.replace(/\s\/\/ .*$/u, ''))
      .join('\n');
    expect(code.match(/\bHana\b.{0,40}/gu) ?? []).toEqual([]);
    // Lower-case `hana` only as an identifier, a header, a package name or the Support ID pattern.
    const left = [...code.matchAll(/[\w@'`/^-]*hana[\w'`/:-]*/giu)].map((x) => x[0]);
    for (const w of left) expect(w, w).toMatch(/^(x-hana-admin|'x-hana-admin'|hana:|'hana'|@hana-id\/scripts|`HANA-XXXX-XXXX`|'?HANA-XXXX-XXXX|HANA-2750-G5HM|\/\^hana)/u);
  });
});

describe('one primary button per view; danger only in a confirmation', () => {
  const primaries = (s: Session) => visible(s, '.jp-btn-primary').map((b) => b.textContent);

  it.each([
    ['/orgs', '2 organisations', ['Invite a new partner']],
    ['/orgs/org_lumen', 'Members', ['Invite someone']],
    ['/orgs/org_legacy', 'Scopes waiting for an organisation', ['Invite a new partner']],
    ['/orgs/org_lumen/apps/app_pay', 'Signing settings', []],
  ])('%s: at most one primary (%s)', async (path, ready, want) => {
    const s = boot(path, orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain(ready));
    expect(primaries(s)).toEqual(want);
    // No destructive button is drawn until its confirmation asks.
    expect(visible(s, '.jp-btn-danger')).toEqual([]);
  });

  it('a disclosure that opens a form hands the primary to the form’s submit', async () => {
    const s = boot('/orgs', orgsApi());
    await vi.waitFor(() => expect(s.button('Invite a new partner')).toBeTruthy());
    s.button('Invite a new partner').click();
    expect(primaries(s)).toEqual(['Send invite']);
    expect(s.button('Invite a new partner').className).toContain('jp-btn-secondary');
  });

  it('a destructive trigger reads as one, and its danger button is the confirmation’s', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.buttons('Remove')).toHaveLength(2));
    expect(s.buttons('Remove')[0]!.className).toBe('jp-btn jp-btn-secondary jp-btn-sm danger-text');
    s.buttons('Remove')[0]!.click();
    const strip = s.main().querySelector('.confirm')!;
    expect(strip.className).toContain('jp-alert-danger');
    expect(visible(s, '.jp-btn-danger').map((b) => b.textContent)).toEqual(['Remove']);
    expect(strip.contains(visible(s, '.jp-btn-danger')[0]!)).toBe(true);
  });

  it('a destructive action without its confirmation isn’t drawn at all', async () => {
    const s = boot('/orgs', orgsApi(), { expose: ['actionButton'] });
    await vi.waitFor(() => expect(s.text()).toContain('2 organisations'));
    const actionButton = s.exposed.actionButton as (label: string, action: () => unknown, confirm: string | null, danger: boolean) => HTMLElement;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(actionButton('Delete everything', () => undefined, null, true).querySelector('button')).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
    expect(actionButton('Delete everything', () => undefined, 'Sure?', true).querySelector('button')!.textContent).toBe('Delete everything');
    errors.mockRestore();
  });
});

describe('toasts: what an action did, then gone', () => {
  it('a success is a toast (role=status) outside the page, not a line in it; Dismiss removes it', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.buttons('Remove')).toHaveLength(2));
    s.buttons('Remove')[1]!.click();
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.toasts()).toContain('bob@lumen.example was removed.'));
    const t = s.doc.querySelector('#toasts .jp-toast')!;
    expect(t.className).toBe('jp-toast jp-toast-success');
    expect(t.getAttribute('role')).toBe('status');
    expect(t.querySelector('.tx b')!.textContent).toBe('bob@lumen.example was removed.');
    expect(s.text()).not.toContain('was removed');
    (t.querySelector('button.x') as unknown as HTMLButtonElement).click();
    expect(s.doc.querySelectorAll('#toasts .jp-toast')).toHaveLength(0);
  });

  it('goes after 5 s, paused while the pointer is on it; at most three; a danger toast stays until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = boot('/orgs', orgsApi(), { expose: ['toast'] });
    await vi.waitFor(() => expect(s.text()).toContain('2 organisations'));
    const toast = s.exposed.toast as (tone: string, title: string, text?: string) => HTMLElement;
    const one = toast('success', 'Saved', 'The rate is set.');
    vi.advanceTimersByTime(4_000);
    expect(one.isConnected).toBe(true);
    one.dispatchEvent(new s.w.Event('mouseenter') as unknown as Event);
    vi.advanceTimersByTime(20_000);
    expect(one.isConnected).toBe(true);
    one.dispatchEvent(new s.w.Event('mouseleave') as unknown as Event);
    vi.advanceTimersByTime(1_100);
    expect(one.isConnected).toBe(false);
    // A stack of three: the fourth pushes the oldest out.
    const four = ['a', 'b', 'c', 'd'].map((x) => toast('info', x));
    expect([...s.doc.querySelectorAll('#toasts .jp-toast b')].map((b) => b.textContent)).toEqual(['b', 'c', 'd']);
    expect(four[0]!.isConnected).toBe(false);
    vi.advanceTimersByTime(5_100);
    expect(s.doc.querySelectorAll('#toasts .jp-toast')).toHaveLength(0);
    // Danger stays (role=alert, no countdown bar) until its Dismiss.
    const bad = toast('danger', 'Not sent', 'The watchdog refused it.');
    expect(bad.getAttribute('role')).toBe('alert');
    expect(bad.querySelector('.bar')).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(bad.isConnected).toBe(true);
    (bad.querySelector('button.x') as unknown as HTMLButtonElement).click();
    expect(bad.isConnected).toBe(false);
  });
});

describe('fields: labels above, hints below, checked when left', () => {
  const inviteEmail = (s: Session) => s.main().querySelector('#members input[name=email]') as unknown as HTMLInputElement;

  it('says nothing while typing; the problem shows when the field is left, and clears as soon as it is right', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(inviteEmail(s)).toBeTruthy());
    const input = inviteEmail(s);
    const wrap = input.closest('.jp-field')!;
    expect(wrap.querySelector('label.jp-label')!.getAttribute('for')).toBe(input.id);
    typeInto(s, input, 'nope');
    expect(wrap.classList.contains('is-invalid')).toBe(false);
    leave(s, input);
    expect(wrap.classList.contains('is-invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(wrap.querySelector('.jp-error')!.textContent).toBe('Enter a full email address, like name@partner.example.');
    expect(input.getAttribute('aria-describedby')).toContain(wrap.querySelector('.jp-error')!.id);
    typeInto(s, input, 'new@lumen.example');
    expect(wrap.classList.contains('is-invalid')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('a submit with a problem sends nothing, marks every field and focuses the first', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(inviteEmail(s)).toBeTruthy());
    const f = s.main().querySelector('#members form') as unknown as HTMLFormElement;
    expect(f.noValidate).toBe(true);
    s.submit(f);
    expect(writes(s)).toEqual([]);
    const wrap = inviteEmail(s).closest('.jp-field')!;
    expect(wrap.classList.contains('is-invalid')).toBe(true);
    expect(wrap.querySelector('.jp-error')!.textContent).toBe('Enter email.');
    expect(s.doc.activeElement).toBe(inviteEmail(s));
    typeInto(s, inviteEmail(s), 'new@lumen.example');
    s.submit(f);
    await vi.waitFor(() => expect(writes(s)).toHaveLength(1));
  });

  it('required is the default: only the optional fields say so', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.button('Create an app')).toBeTruthy());
    s.button('Create an app').click();
    const label = (name: string) => s.main().querySelector(`[name=${name}]`)!.closest('.jp-field')!.querySelector('.jp-label')!;
    expect(label('origins').querySelector('.opt')!.textContent).toBe('optional');
    for (const name of ['scopeId', 'name', 'environment']) expect(label(name).querySelector('.opt'), name).toBeNull();
  });
});

describe('a settings form: the save bar', () => {
  const contacts = (s: Session) => s.main().querySelector('#contacts [name=emails]') as unknown as HTMLInputElement;
  const bar = (s: Session) => s.main().querySelector('#contacts .jp-savebar') as unknown as HTMLElement;

  it('slides up at the first change, counts it, and Discard puts the values back', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(contacts(s)).toBeTruthy());
    expect(contacts(s).value).toBe('sec@lumen.example');
    expect(bar(s).hidden).toBe(true);
    // No submit button of its own: the bar holds Save.
    expect(visible(s, '#contacts button[type=submit]')).toEqual([]);
    typeInto(s, contacts(s), 'sec@lumen.example, ann@lumen.example');
    expect(bar(s).hidden).toBe(false);
    expect(bar(s).className).toContain('on');
    expect(bar(s).textContent).toContain('1 unsaved change');
    (bar(s).querySelector('.jp-btn-ghost') as unknown as HTMLButtonElement).click();
    expect(contacts(s).value).toBe('sec@lumen.example');
    expect(bar(s).hidden).toBe(true);
    expect(writes(s)).toEqual([]);
  });

  it('Save asks the confirmation (the bar steps away); Cancel brings it back; the confirm sends and says so in a toast', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(contacts(s)).toBeTruthy());
    typeInto(s, contacts(s), 'a@lumen.example b@lumen.example');
    const save = [...bar(s).querySelectorAll('button')].find((b) => b.textContent === 'Save contacts') as unknown as HTMLButtonElement;
    expect(save.className).toBe('jp-btn jp-btn-primary');
    save.click();
    expect(s.main().querySelector('#contacts .confirm')!.textContent).toContain('Replace the security contacts with a@lumen.example, b@lumen.example?');
    expect(bar(s).hidden).toBe(true);
    expect(writes(s)).toEqual([]);
    s.button('Cancel').click();
    expect(bar(s).hidden).toBe(false);
    save.click();
    (s.main().querySelector('#contacts .confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writes(s)).toHaveLength(1));
    expect(writes(s)[0]).toMatchObject({ method: 'PUT', path: '/api/orgs/org_lumen/security-contacts', body: { emails: ['a@lumen.example', 'b@lumen.example'] } });
    await vi.waitFor(() => expect(s.toasts()).toContain('Security contacts replaced.'));
  });

  it('an empty list isn’t saved: the field says why, and the bar stays for the fix', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(contacts(s)).toBeTruthy());
    typeInto(s, contacts(s), '');
    ([...bar(s).querySelectorAll('button')].find((b) => b.textContent === 'Save contacts') as unknown as HTMLButtonElement).click();
    expect(s.main().querySelector('#contacts .confirm')).toBeNull();
    expect(contacts(s).closest('.jp-field')!.querySelector('.jp-error')!.textContent).toBe('Enter contacts.');
    expect(bar(s).hidden).toBe(false);
  });
});

describe('settings rows, tables, the pager', () => {
  it('the app’s signing settings are rows: a title, one line of what it means, the control on the right', async () => {
    const s = boot('/orgs/org_lumen/apps/app_pay', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('Signing settings'));
    const rows = [...s.main().querySelectorAll('.settings .jp-setting')];
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Raw signing', 'Auto-approve policy', 'Other settings']);
    expect(rows[0]!.querySelector('small')!.textContent).toMatch(/^Off: /u);
    expect(rows[1]!.querySelector('button')!.textContent).toBe('Propose an auto-approve policy');
  });

  it('numbers are right-aligned under a right-aligned header; the brand’s table keeps its header in view', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('Lumen checkout'));
    const table = [...s.main().querySelectorAll('table.jp-table')].find((t) => t.textContent!.includes('Lumen checkout'))!;
    expect(table.closest('.jp-table-wrap')).not.toBeNull();
    const heads = [...table.querySelectorAll('thead th')];
    const at = heads.findIndex((th) => th.textContent === 'Origins');
    expect(heads[at]!.className).toBe('num');
    expect(table.querySelectorAll('tbody tr')[0]!.children[at]!.className).toBe('num');
    expect(table.querySelectorAll('tbody tr')[0]!.children[at]!.textContent).toBe('12');
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.jp-table th\{[^}]*position:sticky;top:0/u);
    expect(css).toMatch(/\.jp-table-wrap \{ max-height:/u);
  });

  it('a list with more pages has the pager: Next page, and First page once on a later one', async () => {
    const s = boot('/orgs', orgsApi(undefined, { next: 'c2' }));
    await vi.waitFor(() => expect(s.main().querySelector('.jp-pager')).not.toBeNull());
    expect([...s.main().querySelectorAll('.jp-pager .jp-page')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Next page', '/orgs?cursor=c2']]);
    const t = boot('/orgs?cursor=c2', orgsApi());
    await vi.waitFor(() => expect(t.main().querySelector('.jp-pager')).not.toBeNull());
    expect([...t.main().querySelectorAll('.jp-pager .jp-page')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['First page', '/orgs']]);
  });

  it('crumbs to the parents, the current page last', async () => {
    const s = boot('/orgs/org_lumen/apps/app_pay', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('Signing settings'));
    const crumbs = s.main().querySelector('nav.jp-crumbs')!;
    expect([...crumbs.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Organisations', '/orgs'], ['org_lumen', '/orgs/org_lumen']]);
    expect(crumbs.querySelector('b[aria-current=page]')!.textContent).toBe('Lumen checkout');
  });

  it('a part of the page that is still loading is a skeleton, said to screen readers', async () => {
    const s = boot('/orgs', orgsApi(), { expose: ['loading'] });
    await vi.waitFor(() => expect(s.text()).toContain('2 organisations'));
    const sk = (s.exposed.loading as (t?: string) => HTMLElement)('Reading organisations…');
    expect(sk.getAttribute('role')).toBe('status');
    expect(sk.querySelectorAll('.jp-skel')).toHaveLength(3);
    expect(sk.textContent).toBe('Reading organisations…');
  });
});

describe('the usage report: every cell under its own header', () => {
  it('extra and numeric cells line up with their headers, hidden together until "Show every column"', async () => {
    const data = await import('./preview-data.ts');
    const s = boot('/reports?org=org_01jc8lumenpay', (c) => (c.path === '/api/orgs' ? { body: { orgs: data.orgs } } : c.path.startsWith('/api/reports?') ? { body: data.reports } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }));
    await vi.waitFor(() => expect(s.main().querySelector('.compact table')).not.toBeNull());
    const table = s.main().querySelector('.compact table')!;
    const heads = [...table.querySelectorAll('thead th')];
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.children).toHaveLength(heads.length);
      heads.forEach((th, i) => {
        const td = r.children[i]!;
        expect(td.classList.contains('extra'), `${th.textContent} extra`).toBe(th.classList.contains('extra'));
        expect(td.classList.contains('num'), `${th.textContent} num`).toBe(th.classList.contains('num'));
      });
    }
    const toggle = s.main().querySelector('.jp-toggle input') as unknown as HTMLInputElement;
    toggle.click();
    expect(s.main().querySelector('.compact')).toBeNull();
  });
});
