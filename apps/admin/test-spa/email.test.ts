// The Email issuer and Account links pages (build plan batch 9, D446, D448), as the browser runs public/app.js over the
// preview's data: the alerts, tokens, mail and refusal tables, the signer policy against the pins, a jump called out,
// the window links, and the empty and unavailable states said in plain words. No page offers a control; nothing here
// writes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';
import { emailIssuer, emailLinks } from './preview-data.ts';

afterEach(closeWindow);

const api = (route: string, body: unknown) => (c: Call): Answer => (c.path.startsWith(route) ? { body } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
const open = async (route: string, body: unknown, path = route) => {
  const s = boot(path, api(route, body));
  await vi.waitFor(() => expect(s.main().querySelector('h1')).not.toBeNull());
  return s;
};

const noStats = (over: Record<string, unknown>) => ({ ...emailIssuer(14), ...over });

describe('Email issuer', () => {
  it('shows alerts, tokens, mail with rates and refusals, per day and app, with names and no address', async () => {
    const s = await open('/api/email/issuer', emailIssuer(14), '/email/issuer');
    expect(s.main().querySelector('h1')!.textContent).toBe('Email issuer');
    const text = s.text();
    expect(text).toContain('Send budget 50% or 80% (global_50)');
    expect(text).toContain('Lumen Pay');
    expect(text).toContain('session');
    expect(text).toMatch(/\d+\.\d%/u);
    expect(text).toContain('ip:start:10m');
    expect(text).not.toContain('@');
    expect(s.doc.querySelector('#nav .nav-group:nth-child(5) h2')!.textContent).toBe('Email login');
    expect(s.api().every((c) => c.method === 'GET')).toBe(true);
  });

  it('asks the server for the chosen window and marks it', async () => {
    const s = await open('/api/email/issuer', emailIssuer(7), '/email/issuer?days=7');
    expect(s.api().some((c) => c.path === '/api/email/issuer?days=7')).toBe(true);
    expect(s.main().querySelector('.jp-seg [aria-pressed=true]')!.textContent).toBe('Last 7 days');
  });

  it('the signer policy: required signatures, the keys on chain against the pins, and the KMS note', async () => {
    const s = await open('/api/email/issuer', emailIssuer(14), '/email/issuer');
    const text = s.text();
    expect(text).toContain('Signatures required1');
    expect(text).toContain('Matches');
    expect(text).toContain('g7cQ0QKkU1rVwwX2W1Jd7uL9HjM4bQmH5GmQj1RzY2w');
    expect(text).toMatch(/signs with a Worker secret.*AWS KMS/su);
    expect(text).not.toMatch(/reconciliation ran|last run/iu);
  });

  it('pins that differ are shown as bad; a key off the chain and an unpinned key are marked', async () => {
    const d = emailIssuer(14);
    const s = await open('/api/email/issuer', { ...d, policy: { ...d.policy, matchesPins: false, keys: [{ kid: 'kid1', signer: 'hana', onChain: true, pinned: false }, { kid: 'kid2', signer: 'hana', onChain: false, pinned: true }] } }, '/email/issuer');
    const text = s.text();
    expect(text).toContain('Differs: check the watchdog');
    expect(text).toContain('Not pinned');
    expect(text).toContain('Not on chain');
  });

  it('counters and policy unavailable are said in place; empty tables say what is empty', async () => {
    const s = await open('/api/email/issuer', noStats({ stats: { unavailable: 'The issuer didn’t answer: its counters can’t be shown right now.' }, policy: { unavailable: 'NEAR didn’t answer: the signer policy can’t be shown right now.' } }), '/email/issuer');
    expect(s.text()).toContain('The issuer didn’t answer');
    expect(s.text()).toContain('NEAR didn’t answer');
    const empty = await open('/api/email/issuer', noStats({ stats: { days: 14, truncated: false, issuance: [], metrics: [] } }), '/email/issuer');
    expect(empty.text()).toContain('No tokens issued in this window.');
    expect(empty.text()).toContain('No alerts in this window.');
    expect(empty.text()).toContain('No refusals in this window.');
    expect(empty.text()).toContain('No mail in this window.');
  });

  it('a cut list says so; an error is plain words, and the page never pops a browser dialog', async () => {
    const d = emailIssuer(14);
    const cut = await open('/api/email/issuer', { ...d, stats: { ...d.stats, truncated: true } }, '/email/issuer');
    expect(cut.text()).toContain('The list was cut');
    expect(cut.dialogs).toEqual([]);
    const err = boot('/email/issuer', () => ({ status: 503, body: { error: { code: 'upstream_unavailable', message: 'A Journear service did not answer; try again shortly' } } }));
    await vi.waitFor(() => expect(err.text()).toContain('did not answer'));
  });
});

describe('Account links', () => {
  it('calls out a jump, lists today against the median and the days with automatic and explicit counts', async () => {
    const s = await open('/api/email/links', emailLinks(14), '/email/links');
    expect(s.main().querySelector('h1')!.textContent).toBe('Account links');
    const text = s.text();
    expect(text).toContain('Link rate jump');
    expect(text).toContain('Lumen Pay: 76 links today, 4 on a usual day');
    expect(text).toContain('Jumped');
    expect(text).toContain('Normal');
    expect(text).toContain('Automatic');
    expect(text).toContain('Explicit');
    expect(s.api().map((c) => c.path)).toEqual(['/api/email/links?days=14']);
  });

  it('nothing yet is an honest empty page, with no jump note', async () => {
    const s = await open('/api/email/links', { days: 14, today: '2026-11-09', rows: [], jumps: [] }, '/email/links');
    expect(s.text()).not.toContain('Link rate jump');
    expect(s.text()).toContain('No links today.');
    expect(s.text()).toContain('No links in this window.');
  });

  it('the page’s controls stay reachable: staff can’t act on a link', async () => {
    const s = await open('/api/email/links', emailLinks(14), '/email/links');
    expect(s.text()).toContain('Staff can’t create or cancel a link');
    expect(s.main().querySelectorAll('button:not([type=button])').length).toBe(0);
  });
});
