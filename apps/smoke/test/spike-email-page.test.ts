// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/spike-email.html"}
// spike-email.html (email login build plan batch 0): the requests it makes (one request with the email scope, or the
// openid request then the silent token request), the state check before anything is shown, no HTML sinks, and a
// summary without personal values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(join(import.meta.dirname, '..', 'spike-email.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');
const script = /<script type="module">([\s\S]*?)<\/script>/u.exec(html)![1]!;

let opened: URL[] = [];
beforeEach(() => {
  document.body.innerHTML = body;
  localStorage.clear();
  opened = [];
  window.open = ((u: string) => {
    opened.push(new URL(u));
    return null;
  }) as never;
  new Function(script)();
  (document.getElementById('client') as HTMLInputElement).value = '123-abc.apps.googleusercontent.com';
});

const deliver = (hash: string) => window.dispatchEvent(new StorageEvent('storage', { key: 'spike-callback', newValue: hash }));
const jwt = (claims: Record<string, unknown>) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('spike-email.html', () => {
  it('uses no HTML sinks', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  });

  it('A asks for id_token token with openid email; the verdict says whether the ID token stayed openid-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => ({ status: 200, json: async () => (String(u).includes('tokeninfo') ? { aud: '123-abc.apps.googleusercontent.com', sub: '42', scope: 'openid email' } : { sub: '42', email: 'ada@gmail.com', email_verified: true }) })),
    );
    (document.getElementById('one') as HTMLButtonElement).click();
    expect(opened[0]!.searchParams.get('response_type')).toBe('id_token token');
    expect(opened[0]!.searchParams.get('scope')).toBe('openid email');
    const state = opened[0]!.searchParams.get('state');
    const nonce = opened[0]!.searchParams.get('nonce');
    deliver(`id_token=${jwt({ sub: '42', aud: 'x', nonce })}&access_token=ya29.x&state=${state}`);
    await vi.waitFor(() => expect(document.getElementById('summary')!.textContent).toContain('oneRequestUsable'));
    const summary = document.getElementById('summary')!.textContent!;
    expect(JSON.parse(summary)[0]).toMatchObject({ mode: 'one', emailInIdToken: false, oneRequestUsable: true, userinfoHasEmail: true, emailIsGmail: true, tokeninfoSubMatches: true });
    // Nothing personal: no address, no sub, no token.
    expect(summary).not.toContain('ada@gmail.com');
    expect(summary).not.toContain('"42"');
    expect(summary).not.toContain('ya29');
    vi.unstubAllGlobals();
  });

  it('B: the openid request, then the silent email request for that account, then once more interactively', async () => {
    (document.getElementById('two') as HTMLButtonElement).click();
    expect(opened[0]!.searchParams.get('scope')).toBe('openid');
    deliver(`id_token=${jwt({ sub: '42', nonce: opened[0]!.searchParams.get('nonce') })}&state=${opened[0]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(Object.fromEntries(opened[1]!.searchParams)).toMatchObject({ response_type: 'token', scope: 'email', prompt: 'none', login_hint: '42' });
    deliver(`error=consent_required&state=${opened[1]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    expect(opened[2]!.searchParams.get('prompt')).toBeNull();
    deliver(`error=access_denied&state=${opened[2]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(document.getElementById('summary')!.textContent).toContain('silentError'));
    expect(JSON.parse(document.getElementById('summary')!.textContent!)[0]).toMatchObject({ mode: 'two', silentError: 'consent_required', interactiveError: 'access_denied', emailInIdToken: false });
  });

  it('calls tokeninfo by POST (never the token in a URL) and never revokes it (D265)', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        calls.push({ url: String(u), ...(init ? { init } : {}) });
        return { status: 200, json: async () => (String(u).includes('tokeninfo') ? { aud: '123-abc.apps.googleusercontent.com', sub: '42', scope: 'email' } : { sub: '42', email: 'ada@gmail.com', email_verified: true }) };
      }),
    );
    (document.getElementById('one') as HTMLButtonElement).click();
    deliver(`id_token=${jwt({ sub: '42', nonce: opened[0]!.searchParams.get('nonce') })}&access_token=ya29.secret&state=${opened[0]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(document.getElementById('summary')!.textContent).toContain('oneRequestUsable'));
    const tokeninfo = calls.find((c) => c.url.includes('tokeninfo'))!;
    expect(tokeninfo.init?.method).toBe('POST');
    for (const c of calls) expect(c.url).not.toContain('ya29');
    expect(calls.some((c) => c.url.includes('revoke'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('C and D run after B: a plain openid login (flags email claims: a token_has_pii lockout), then B’s silent request again', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => ({ status: 200, json: async () => (String(u).includes('tokeninfo') ? { aud: '123-abc.apps.googleusercontent.com', sub: '42', scope: 'email' } : { sub: '42', email: 'ada@gmail.com', email_verified: true }) })));
    expect((document.getElementById('three') as HTMLButtonElement).disabled).toBe(true);
    (document.getElementById('two') as HTMLButtonElement).click();
    deliver(`id_token=${jwt({ sub: '42', nonce: opened[0]!.searchParams.get('nonce') })}&state=${opened[0]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    deliver(`access_token=ya29.x&state=${opened[1]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect((document.getElementById('three') as HTMLButtonElement).disabled).toBe(false));
    // C: openid only; here Google added email claims, which the summary flags as a lockout.
    (document.getElementById('three') as HTMLButtonElement).click();
    expect(Object.fromEntries(opened[2]!.searchParams)).toMatchObject({ response_type: 'id_token', scope: 'openid', prompt: 'select_account' });
    deliver(`id_token=${jwt({ sub: '42', email: 'ada@gmail.com', email_verified: true, nonce: opened[2]!.searchParams.get('nonce') })}&state=${opened[2]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(JSON.parse(document.getElementById('summary')!.textContent!)).toHaveLength(2));
    const c = JSON.parse(document.getElementById('summary')!.textContent!)[1];
    expect(c).toMatchObject({ mode: 'three', tokenHasPiiLockout: true, lockoutClaims: ['email', 'email_verified'], sameAccountAsB: true });
    expect(c.idTokenClaimNames).toContain('email');
    // D: the silent request again, for B's account; no interactive retry: its error (or token) is the answer.
    (document.getElementById('four') as HTMLButtonElement).click();
    expect(Object.fromEntries(opened[3]!.searchParams)).toMatchObject({ response_type: 'token', scope: 'email', prompt: 'none', login_hint: '42' });
    deliver(`error=consent_required&state=${opened[3]!.searchParams.get('state')}`);
    await vi.waitFor(() => expect(JSON.parse(document.getElementById('summary')!.textContent!)).toHaveLength(3));
    expect(JSON.parse(document.getElementById('summary')!.textContent!)[2]).toMatchObject({ mode: 'four', silentError: 'consent_required' });
    expect(opened).toHaveLength(4);
    expect(document.getElementById('summary')!.textContent).not.toContain('ada@gmail.com');
    expect(document.getElementById('summary')!.textContent).not.toContain('"42"');
    vi.unstubAllGlobals();
  });

  it('takes exactly one state, the leg’s own, once (as production’s callback)', () => {
    (document.getElementById('one') as HTMLButtonElement).click();
    const state = opened[0]!.searchParams.get('state');
    deliver(`error=access_denied&state=${state}&state=${state}`);
    expect(document.getElementById('out')!.textContent).toBe('state mismatch: ignored');
    deliver(`error=access_denied&state=${state}`);
    expect(JSON.parse(document.getElementById('summary')!.textContent!)[0]).toMatchObject({ error: 'access_denied' });
  });

  it('ignores a fragment without the run’s state and shows nothing of it', () => {
    (document.getElementById('one') as HTMLButtonElement).click();
    deliver('error=%3Cimg%20src%3Dx%3E&state=wrong');
    const out = document.getElementById('out')!;
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).toBe('state mismatch: ignored');
  });
});
