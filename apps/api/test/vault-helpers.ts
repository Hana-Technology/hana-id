// Helpers for the vault endpoint, page and cron tests.
import { env } from 'cloudflare:workers';
import { sha256 } from '../src/bytes.ts';
import { type ShareAction, NO_SHARE_ID, actionPayload, createSharePayload, vaultMessage } from '../src/vault/message.ts';
import { type Chain, ORIGIN, type SeededApp, call, chain, newSessionKey, seedApp, sessionKeyPair } from './helpers.ts';

export const VAULT = 'https://vault.test';
export const HOUR = 60 * 60 * 1000;

/** A valid AutoApprovePolicyV1 in normalized form: ERC-20 approve on one Base contract, under the address rule. */
export function autoApprovePolicy(label: string, perDayCount = 5) {
  return {
    v: 1,
    label,
    maxConsentMs: 12 * HOUR,
    limits: { perDayCount },
    evm: {
      chains: [
        {
          chainId: 8453,
          maxValueWei: '0',
          maxValueWeiPerDay: '0',
          maxFeeWei: '100000',
          contracts: [
            {
              address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              name: 'USDC',
              selectors: [{ selector: '0x095ea7b3', signature: 'approve(address,uint256)', addressArgs: 'self-or-listed' }],
            },
          ],
        },
      ],
    },
  };
}

/** Headers of a vault call for `app` serving `parent`. */
export const vaultHeaders = (app: { key: string }, parent: string | null = ORIGIN, origin: string | null = VAULT): Record<string, string> => ({
  'x-hana-key': app.key,
  ...(origin ? { origin } : {}),
  ...(parent ? { 'x-hana-parent-origin': parent } : {}),
});

/** Ed25519 signature by the test session key over the vault message. */
export async function signVault(spk: number[], appId: string, shareId: Uint8Array, counter: number, payload: Uint8Array): Promise<number[]> {
  const message = await vaultMessage({ signer: env.SIGNER_ACCOUNT, appId, shareId, counter, payload });
  return [...sessionKeyPair(spk).sign(message).signature];
}

export const pathFor = (scope: string, sub = '1234567890'): string => `${scope}#google#${sub}#0`;

/** A used-up session (as a 'session'-mode login leaves it) for a new session key, on the mock chain. */
export function spentSession(near: Chain, scope: string, opts: { sub?: string; expiresAtMs?: number; used?: number; maxUses?: number } = {}): number[] {
  const spk = newSessionKey();
  near.sessions.set(JSON.stringify(spk), {
    path: pathFor(scope, opts.sub),
    scope_id: scope,
    expires_at_ms: opts.expiresAtMs ?? Date.now() + 12 * HOUR,
    max_uses: opts.maxUses ?? 1,
    used: opts.used ?? 1,
  });
  return spk;
}

export async function createShareBody(spk: number[], appId: string, parent: string = ORIGIN): Promise<Record<string, unknown>> {
  return { sessionPublicKey: spk, signature: await signVault(spk, appId, NO_SHARE_ID, 0, createSharePayload(parent)) };
}

export interface Share {
  spk: number[];
  shareId: number[];
  ks: number[];
  absExpiresAtMs: number;
  idleUntilMs: number;
}

/** Creates a share through the API (asserts 201). */
export async function createShare(app: SeededApp, near: Chain, opts: { parent?: string; sub?: string; env?: Partial<typeof env>; expiresAtMs?: number } = {}): Promise<Share> {
  const spk = spentSession(near, app.scope, { sub: opts.sub, expiresAtMs: opts.expiresAtMs });
  const res = await call('/v1/vault/shares', { headers: vaultHeaders(app, opts.parent ?? ORIGIN), body: await createShareBody(spk, app.id, opts.parent), env: opts.env });
  if (res.status !== 201) throw new Error(`createShare: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as Omit<Share, 'spk'>;
  return { spk, ...body };
}

export async function actionBody(share: Pick<Share, 'spk' | 'shareId'>, appId: string, action: ShareAction, counter: number): Promise<Record<string, unknown>> {
  return { shareId: share.shareId, counter, signature: await signVault(share.spk, appId, Uint8Array.from(share.shareId), counter, actionPayload(action)) };
}

const PATHS: Record<ShareAction, string> = { unlock: '/v1/vault/unlock', touch: '/v1/vault/touch', revoke: '/v1/vault/revoke', 'revoke-all': '/v1/vault/revoke-all' };

export async function act(
  app: SeededApp,
  share: Pick<Share, 'spk' | 'shareId'>,
  action: ShareAction,
  counter: number,
  opts: { parent?: string; env?: Partial<typeof env>; headers?: Record<string, string>; signAs?: string } = {},
): Promise<Response> {
  return call(PATHS[action], {
    headers: { ...vaultHeaders(app, opts.parent ?? ORIGIN), ...opts.headers },
    body: await actionBody(share, opts.signAs ?? app.id, action, counter),
    env: opts.env,
  });
}

export interface StoredShare {
  share_enc: number[];
  kek_id: number;
  counter: number;
  created_at: number;
  idle_until: number;
  abs_expires_at: number;
  revoked_at: number | null;
  path_hash: number[];
  partner_origin: string;
}

/** The share's D1 row, BLOBs as number arrays. */
export async function storedShare(shareId: number[]): Promise<StoredShare | null> {
  const row = await env.DB.prepare('SELECT * FROM vault_shares WHERE share_id = ?1').bind(Uint8Array.from(shareId)).first<Record<string, unknown>>();
  if (!row) return null;
  const arr = (v: unknown): number[] => (v instanceof ArrayBuffer ? [...new Uint8Array(v)] : [...(v as number[])]);
  return { ...(row as unknown as StoredShare), share_enc: arr(row.share_enc), path_hash: arr(row.path_hash) };
}

export async function setShare(shareId: number[], fields: Partial<Record<'counter' | 'created_at' | 'idle_until' | 'abs_expires_at' | 'revoked_at', number | null>>): Promise<void> {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE vault_shares SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE share_id = ?1`)
    .bind(Uint8Array.from(shareId), ...keys.map((k) => fields[k as keyof typeof fields]))
    .run();
}

export async function setSettings(appId: string, fields: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE apps SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`)
    .bind(appId, ...keys.map((k) => fields[k]))
    .run();
}

export const pathHash = async (path: string): Promise<number[]> => [...(await sha256(new TextEncoder().encode(path)))];

/** A fresh app on a fresh mock chain. */
export async function vaultSetup(opts: Parameters<typeof seedApp>[0] = {}): Promise<{ app: SeededApp; near: Chain }> {
  const near = chain();
  const app = await seedApp(opts);
  return { app, near };
}

/** A random 32-byte KEK secret value with `id`. */
export function newKek(id: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return `${id}:${btoa(String.fromCharCode(...raw))}`;
}
