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

  describe('E: token_first (D270)', () => {
    const CLIENT = '123-abc.apps.googleusercontent.com';
    const TOKENINFO = { aud: CLIENT, azp: CLIENT, sub: '42', scope: 'openid https://www.googleapis.com/auth/userinfo.email', email: 'ada@gmail.com', email_verified: 'true', expires_in: '3599' };
    const summary = () => JSON.parse(document.getElementById('summary')!.textContent!) as Record<string, unknown>[];
    let calls: { url: string; init?: RequestInit }[] = [];
    const stubGoogle = (tokeninfo: Record<string, unknown> | 'throws' = TOKENINFO) => {
      calls = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (u: string, init?: RequestInit) => {
          calls.push({ url: String(u), ...(init ? { init } : {}) });
          if (String(u).includes('tokeninfo')) {
            if (tokeninfo === 'throws') throw new TypeError('Failed to fetch');
            return { status: 200, json: async () => tokeninfo };
          }
          return { status: 200, json: async () => ({ sub: '42', email: 'ada@gmail.com', email_verified: true }) };
        }),
      );
    };
    /** E's first request answered with an access token; resolves once the silent request is open. */
    const accessStep = async () => {
      (document.getElementById('five') as HTMLButtonElement).click();
      deliver(`access_token=ya29.secret&token_type=Bearer&expires_in=3599&state=${opened[0]!.searchParams.get('state')}`);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      return opened[1]!;
    };
    const done = (n: number) => vi.waitFor(() => expect(summary()).toHaveLength(n));

    it('asks for an access token only (openid email, the account chooser), then tokeninfo by POST with the token in the body', async () => {
      stubGoogle();
      (document.getElementById('five') as HTMLButtonElement).click();
      expect(Object.fromEntries(opened[0]!.searchParams)).toMatchObject({ client_id: CLIENT, response_type: 'token', scope: 'openid email', prompt: 'select_account', response_mode: 'fragment' });
      expect(opened[0]!.searchParams.get('redirect_uri')).toBe('http://localhost:5173/spike-callback.html');
      expect(opened[0]!.searchParams.has('nonce')).toBe(false);
      deliver(`access_token=ya29.secret&state=${opened[0]!.searchParams.get('state')}`);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      const ti = calls.find((c) => c.url.includes('tokeninfo'))!;
      expect(ti.url).toBe('https://oauth2.googleapis.com/tokeninfo');
      expect(ti.init?.method).toBe('POST');
      expect(new Headers(ti.init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(String(ti.init?.body)).toBe('access_token=ya29.secret');
      vi.unstubAllGlobals();
    });

    it('then a silent id_token request, openid only, for tokeninfo’s sub with a fresh nonce; a clean token is usable', async () => {
      stubGoogle();
      const silent = await accessStep();
      expect(Object.fromEntries(silent.searchParams)).toMatchObject({ client_id: CLIENT, response_type: 'id_token', scope: 'openid', prompt: 'none', login_hint: '42' });
      const nonce = silent.searchParams.get('nonce')!;
      expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
      expect(silent.searchParams.get('state')).not.toBe(opened[0]!.searchParams.get('state'));
      deliver(`id_token=${jwt({ iss: 'https://accounts.google.com', aud: CLIENT, azp: CLIENT, sub: '42', nonce, iat: 1, exp: 2 })}&state=${silent.searchParams.get('state')}`);
      await done(1);
      expect(summary()[0]).toMatchObject({
        mode: 'five',
        accessToken: true,
        idTokenInAccessAnswer: false,
        tokeninfoReachable: true,
        tokeninfoStatus: 200,
        tokeninfoHasSub: true,
        tokeninfoAudIsClient: true,
        tokeninfoHasEmail: true,
        silentIdToken: true,
        idTokenClaimNames: ['aud', 'azp', 'exp', 'iat', 'iss', 'nonce', 'sub'],
        idTokenPersonalClaims: [],
        emailInIdToken: false,
        nonceMatches: true,
        sameAccount: true,
        userinfoHasEmail: true,
        userinfoSubMatches: true,
        tokenFirstUsable: true,
      });
      // Nothing personal: no address, no sub, no token; the access token never in a URL, never revoked.
      const text = document.getElementById('summary')!.textContent!;
      for (const v of ['ada@gmail.com', '"42"', 'ya29', nonce]) expect(text).not.toContain(v);
      for (const c of calls) expect(c.url).not.toContain('ya29');
      for (const u of opened) expect(u.href).not.toContain('ya29');
      expect(calls.some((c) => c.url.includes('revoke'))).toBe(false);
      vi.unstubAllGlobals();
    });

    it('is not usable when the silent ID token carries email, is another account’s, or has another nonce', async () => {
      stubGoogle();
      let silent = await accessStep();
      deliver(`id_token=${jwt({ sub: '42', email: 'ada@gmail.com', email_verified: true, nonce: silent.searchParams.get('nonce') })}&state=${silent.searchParams.get('state')}`);
      await done(1);
      expect(summary()[0]).toMatchObject({ emailInIdToken: true, idTokenPersonalClaims: ['email', 'email_verified'], sameAccount: true, nonceMatches: true, tokenFirstUsable: false });
      expect(document.getElementById('summary')!.textContent).not.toContain('ada@gmail.com');

      opened = [];
      silent = await accessStep();
      deliver(`id_token=${jwt({ sub: '43', nonce: silent.searchParams.get('nonce') })}&state=${silent.searchParams.get('state')}`);
      await done(2);
      expect(summary()[1]).toMatchObject({ sameAccount: false, nonceMatches: true, tokenFirstUsable: false });

      opened = [];
      silent = await accessStep();
      deliver(`id_token=${jwt({ sub: '42', nonce: 'other' })}&state=${silent.searchParams.get('state')}`);
      await done(3);
      expect(summary()[2]).toMatchObject({ sameAccount: true, nonceMatches: false, tokenFirstUsable: false });
      vi.unstubAllGlobals();
    });

    it('records the silent request’s Google error, with no interactive retry', async () => {
      stubGoogle();
      const silent = await accessStep();
      deliver(`error=interaction_required&state=${silent.searchParams.get('state')}`);
      await done(1);
      expect(summary()[0]).toMatchObject({ mode: 'five', silentIdToken: false, silentError: 'interaction_required', tokenFirstUsable: false });
      expect(opened).toHaveLength(2);
      vi.unstubAllGlobals();
    });

    it('records a tokeninfo the browser can’t reach (CORS) or that gives no sub, and sends no silent request', async () => {
      stubGoogle('throws');
      (document.getElementById('five') as HTMLButtonElement).click();
      deliver(`access_token=ya29.x&state=${opened[0]!.searchParams.get('state')}`);
      await done(1);
      expect(summary()[0]).toMatchObject({ tokeninfoReachable: false, tokeninfoHasSub: false, silentRequest: 'not sent: no sub', tokenFirstUsable: false });
      expect(opened).toHaveLength(1);
      expect((document.getElementById('fiveAgain') as HTMLButtonElement).disabled).toBe(true);

      stubGoogle({ aud: CLIENT, scope: 'https://www.googleapis.com/auth/userinfo.email', expires_in: '3599' });
      (document.getElementById('five') as HTMLButtonElement).click();
      deliver(`access_token=ya29.x&state=${opened[1]!.searchParams.get('state')}`);
      await done(2);
      expect(summary()[1]).toMatchObject({ tokeninfoReachable: true, tokeninfoHasSub: false, tokenFirstUsable: false });
      expect(opened).toHaveLength(2);
      vi.unstubAllGlobals();
    });

    it('E2 (after E) repeats only the silent openid request for E’s account, with a fresh nonce', async () => {
      stubGoogle();
      const again = document.getElementById('fiveAgain') as HTMLButtonElement;
      expect(again.disabled).toBe(true);
      const silent = await accessStep();
      deliver(`id_token=${jwt({ sub: '42', nonce: silent.searchParams.get('nonce') })}&state=${silent.searchParams.get('state')}`);
      await done(1);
      expect(again.disabled).toBe(false);
      const before = calls.length;
      // A changed client field doesn't matter: E2 uses E's client.
      (document.getElementById('client') as HTMLInputElement).value = 'other.apps.googleusercontent.com';
      again.click();
      expect(opened).toHaveLength(3);
      expect(Object.fromEntries(opened[2]!.searchParams)).toMatchObject({ client_id: CLIENT, response_type: 'id_token', scope: 'openid', prompt: 'none', login_hint: '42' });
      const nonce = opened[2]!.searchParams.get('nonce');
      expect(nonce).not.toBe(silent.searchParams.get('nonce'));
      deliver(`id_token=${jwt({ sub: '42', aud: CLIENT, nonce })}&state=${opened[2]!.searchParams.get('state')}`);
      await done(2);
      expect(summary()[1]).toMatchObject({ mode: 'fiveAgain', silentIdToken: true, idTokenPersonalClaims: [], emailInIdToken: false, nonceMatches: true, sameAccount: true, returningTokenClean: true });
      expect(summary()[1]).not.toHaveProperty('tokenFirstUsable');
      // No access token in E2: no Google API call.
      expect(calls).toHaveLength(before);
      expect(document.getElementById('summary')!.textContent).not.toContain('"42"');
      vi.unstubAllGlobals();
    });

    it('E2 needs E first', () => {
      (document.getElementById('fiveAgain') as HTMLButtonElement).disabled = false;
      (document.getElementById('fiveAgain') as HTMLButtonElement).click();
      expect(opened).toHaveLength(0);
      expect(document.getElementById('out')!.textContent).toBe('Run E first.');
    });
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
