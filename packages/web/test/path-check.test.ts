// D263: a path through another identity is confirmed on two providers, each read alone (src/path-check.ts).
import { identityKeyHex, type IdentityView } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { PathCheckError, type ViewRead, confirmPath } from '../src/path-check.ts';

const S = 's1';
const G = { provider: 'google', sub: '110248495921238986420' };
const E = { provider: 'email', sub: `e1.${'Q'.repeat(43)}` };
const A = { provider: 'email', sub: `e1.${'A'.repeat(43)}` };
const view = (who: { provider: string; sub: string }, o: Partial<{ status: string; root: { provider: string; sub: string } | null; key: string }> = {}) => ({
  key: o.key ?? identityKeyHex(S, who.provider, who.sub),
  status: o.status ?? 'own',
  opened: true,
  ...(o.root ? { root: o.root, effective_at_ms: 1 } : {}),
  account_epoch: o.root ? 1 : 0,
});
const member: IdentityView = { key: identityKeyHex(S, G.provider, G.sub), status: 'member', opened: false, root: E, effectiveAtMs: 1, accountEpoch: 1 };
/** A provider whose get_identity answers from `views` (by `provider#sub`), or throws when `down`. */
const provider = (views: Record<string, unknown>, down = false): ViewRead => async (method, args) => {
  if (down) throw new TypeError('Failed to fetch');
  if (method !== 'get_identity') throw new Error(method);
  const a = args as { provider: string; sub: string };
  return views[`${a.provider}#${a.sub}`] ?? view(a);
};
const honest = { [`google#${G.sub}`]: view(G, { status: 'member', root: E }) };
const reason = async (p: Promise<void>) => p.then(() => null, (e: unknown) => (e instanceof PathCheckError ? e.reason : e));

describe('confirmPath', () => {
  it('passes when both providers agree on the member and show the root as an own identity', async () => {
    expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: E, views: { primary: provider(honest), second: provider(honest) } }))).toBeNull();
  });

  it('no second provider, or one that can’t be reached: path_unconfirmed', async () => {
    expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: E, views: null }))).toBe('path_unconfirmed');
    expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: E, views: { primary: provider(honest), second: provider(honest, true) } }))).toBe('path_unconfirmed');
    expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: E, views: { primary: provider(honest, true), second: provider(honest) } }))).toBe('path_unconfirmed');
  });

  it('disagreement on status, root or key, a malformed answer, or a root that isn’t own: path_disputed', async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { [`google#${G.sub}`]: view(G, { status: 'member', root: A }) },
      { [`google#${G.sub}`]: view(G, { status: 'pending', root: E }) },
      { [`google#${G.sub}`]: view(G, { status: 'member', root: E, key: '00'.repeat(32) }) },
      { [`google#${G.sub}`]: { nonsense: true } },
      { ...honest, [`email#${E.sub}`]: view(E, { status: 'member', root: A }) },
      { ...honest, [`email#${E.sub}`]: view(E, { key: 'ff'.repeat(32) }) },
    ];
    for (const second of cases) {
      expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: E, views: { primary: provider(honest), second: provider(second) } })), JSON.stringify(second)).toBe('path_disputed');
    }
  });

  it('a path that isn’t the view’s root is disputed even when both providers agree on the view', async () => {
    expect(await reason(confirmPath({ scopeId: S, via: G, viaView: member, path: A, views: { primary: provider(honest), second: provider(honest) } }))).toBe('path_disputed');
  });

  it('via’s own path (a link judgement whose target is the email identity itself): both must say own', async () => {
    const own: IdentityView = { key: identityKeyHex(S, E.provider, E.sub), status: 'own', opened: true, root: null, effectiveAtMs: null, accountEpoch: 0 };
    expect(await reason(confirmPath({ scopeId: S, via: E, viaView: own, path: E, views: { primary: provider({}), second: provider({}) } }))).toBeNull();
    const second = { [`email#${E.sub}`]: view(E, { status: 'member', root: A }) };
    expect(await reason(confirmPath({ scopeId: S, via: E, viaView: own, path: E, views: { primary: provider({}), second: provider(second) } }))).toBe('path_disputed');
  });
});
