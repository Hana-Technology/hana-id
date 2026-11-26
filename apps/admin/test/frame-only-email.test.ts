// D934: a frame-only web address in Journear's partner emails: one plain row, "Where it works", under that address, in
// the change notice, the platform's and the four-eyes request emails and the confirmation's notice; an email for any
// other change is byte for byte the one it was (the field absent, or false, renders the same).
import { describe, expect, it } from 'vitest';
import type { ChangeNotice } from '../src/env.ts';
import { FRAME_ONLY_ROW, changePending } from '../src/email/messages.ts';
import { originsConfirmed, platformOriginsProposed, secondPersonOriginsProposed } from '../src/email/platform-messages.ts';

const ctx = { env: 'sandbox-test', consoleOrigin: 'https://console.test' };
const app = { id: 'app_1', name: 'Coffee Club', orgId: 'org_1', scopeId: 's1', environment: 'test' as const };
const WHERE = 'Only inside the app’s other web addresses (for example a widget in an iframe). Opened on its own, the wallet won’t load there.';
const change = (over: Record<string, unknown> = {}) =>
  ({ id: 'gc_1', appId: 'app_1', kind: 'origin_add', origin: 'https://widget.lumenpay.example', display: 'https://widget.lumenpay.example', idn: false, status: 'pending', proposedByKind: 'hana', proposedBy: 'sub', proposedAt: 0, ...over }) as ChangeNotice['change'];
const line = (over: Record<string, unknown> = {}) => ({ changeId: 'gc_1', origin: 'https://widget.lumenpay.example', display: 'https://widget.lumenpay.example', idn: false, cancelUrl: 'https://console.test/cancel/gc_1#t=abc', ...over });

describe('the row', () => {
  it('plain words', () => {
    expect(FRAME_ONLY_ROW).toEqual(['Where it works', WHERE]);
  });
});

describe('changePending', () => {
  const mail = (over: Record<string, unknown>) => changePending(ctx, { change: change(over), contacts: [], app }, { cancelUrl: 'https://console.test/cancel/gc_1#t=abc', delayMs: 86_400_000 });
  it('a frame-only add says where it works, after its web address', () => {
    const m = mail({ frameOnly: true });
    expect(m.text).toContain(WHERE);
    expect(m.text.indexOf(WHERE)).toBeGreaterThan(m.text.indexOf('https://widget.lumenpay.example'));
    expect(m.html).toContain('Where it works');
  });
  it('any other add, and every other kind: byte for byte as before', () => {
    expect(mail({ frameOnly: undefined })).toEqual(mail({}));
    expect(mail({ frameOnly: false })).toEqual(mail({}));
    expect(mail({}).text).not.toContain('Where it works');
    // A frame-only mark on another kind (never sent) changes nothing either.
    const policy = (over: Record<string, unknown>) => changePending(ctx, { change: change({ kind: 'policy_set', origin: undefined, display: undefined, policyId: 'a'.repeat(64), ...over }), contacts: [], app, policy: { label: 'x' } }, { cancelUrl: 'https://console.test/cancel/gc_1#t=abc', delayMs: 60_000 });
    expect(policy({ frameOnly: true })).toEqual(policy({}));
  });
});

describe('the request emails and the confirmation’s notice', () => {
  const platform = (lines: ReturnType<typeof line>[]) =>
    platformOriginsProposed(ctx, { app, keyId: 'pkc_1', keyLabel: 'Partner backend', proposedAt: 0, waitMs: 86_400_000 }, lines, { now: 0, confirmUrl: 'https://console.test/confirm/gc_1' });
  const staff = (lines: ReturnType<typeof line>[]) => secondPersonOriginsProposed(ctx, { app, proposedBy: 'sub', proposedAt: 0, waitMs: 86_400_000 }, lines, { now: 0, confirmUrl: 'https://console.test/confirm/gc_1' });
  const confirmed = (lines: ReturnType<typeof line>[]) =>
    originsConfirmed(
      ctx,
      { app, confirmedByKind: 'member', confirmedBy: 'usr_1', confirmedAt: 0, proposedByKind: 'platform', keyId: 'pkc_1', keyLabel: 'Partner backend', proposedBy: 'pkc_1' } as never,
      lines.map(({ cancelUrl, ...l }) => ({ ...l, removeUrl: cancelUrl.replace('/cancel/', '/remove/') })),
      { confirmedBy: 'owner@partner.example' },
    );
  for (const [name, build] of [
    ['platformOriginsProposed', platform],
    ['secondPersonOriginsProposed', staff],
    ['originsConfirmed', confirmed],
  ] as const) {
    it(`${name}: the row under the frame-only address only; without it, as before`, () => {
      const page = line({ changeId: 'gc_2', origin: 'https://coffeeclub.example', display: 'https://coffeeclub.example', cancelUrl: 'https://console.test/cancel/gc_2#t=def' });
      const m = build([page, line({ frameOnly: true })]);
      expect(m.text.split(WHERE)).toHaveLength(2);
      expect(m.text.indexOf(WHERE)).toBeGreaterThan(m.text.indexOf('https://widget.lumenpay.example'));
      expect(build([page, line({ frameOnly: false })])).toEqual(build([page, line()]));
      expect(build([page, line()]).text).not.toContain('Where it works');
    });
  }
});
