// D915: the shared-scope rule and its words, read by the API, the console, the admin portal and the admin CLI.
import { describe, expect, it } from 'vitest';
import { APP_CREATOR_KINDS, SHARED_WALLET_NO_AUTO_APPROVE, appDetail, autoApproveRefused, setScopeAppUserIdsInput } from '../src/index.ts';

describe('autoApproveRefused', () => {
  it('refuses on a shared scope or for a platform-created app, and only then', () => {
    expect(autoApproveRefused({ sharedScope: false, createdByKind: 'hana' })).toBe(false);
    expect(autoApproveRefused({ sharedScope: true, createdByKind: 'hana' })).toBe(true);
    expect(autoApproveRefused({ sharedScope: false, createdByKind: 'platform' })).toBe(true);
    expect(autoApproveRefused({ sharedScope: true, createdByKind: 'platform' })).toBe(true);
  });

  it('the words are plain and the kinds are the migration’s', () => {
    expect(SHARED_WALLET_NO_AUTO_APPROVE).toBe('Auto-approve is off for apps that share a wallet');
    expect(APP_CREATOR_KINDS).toEqual(['hana', 'platform']);
  });
});

describe('the RPC shapes', () => {
  const ctx = { actor: { kind: 'hana', id: 'staff-1', email: 'staff@hana.example' }, requestId: 'req_12345678', clientIp: '198.51.100.2' };
  it('setScopeAppUserIds takes an org and a scope, and nothing that could turn it off', () => {
    expect(setScopeAppUserIdsInput.safeParse({ ...ctx, orgId: 'org_a', scopeId: 's1' }).success).toBe(true);
    expect(setScopeAppUserIdsInput.safeParse({ ...ctx, orgId: 'org_a', scopeId: 's1', on: false }).success).toBe(false);
    expect(setScopeAppUserIdsInput.safeParse({ ...ctx, scopeId: 's1' }).success).toBe(false);
  });

  it('an app detail may carry the three fields (an API before migration 0026 leaves them out)', () => {
    const fields = appDetail.shape;
    expect(fields.sharedScope.safeParse(undefined).success).toBe(true);
    expect(fields.createdByKind.safeParse('platform').success).toBe(true);
    expect(fields.createdByKind.safeParse('member').success).toBe(false);
    expect(fields.sharedWallet.safeParse(true).success).toBe(true);
  });
});
