// D894: the vault's check of the partner labels `GET /v1/app` delivers (a pure helper nothing calls yet, piece 3 will).
import { sha256, toHex } from '@hana-id/core';
import { describe, expect, it } from 'vitest';
import { MAX_DELIVERED_LABELS, verifyDeliveredLabels } from '../../src/vault/partner-labels.ts';

const doc = (network = 'testnet', object = 'the stamp') =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { near: { network, account: network === 'testnet' ? 'club.testnet' : 'club.near', codeHash: 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn' } },
    display: { formats: { join: { call: { args: {} }, intent: { verb: 'join', object }, sentence: ['verb', 'object'], fields: [] } } },
  });
const hash = (t: string) => toHex(sha256(new TextEncoder().encode(t)));
const delivered = (text: string, o: Record<string, unknown> = {}) => ({ id: 'pl_A1', changeId: 'lc_B2', version: 'journear-labels/1', sha256: hash(text), text, effectiveSince: 1_800_000_000_000, previousEffectiveSince: null, ...o });
const TESTNET = { network: 'testnet' } as const;

describe('verifyDeliveredLabels', () => {
  it('keeps a document whose hash, version, parse and network check out', () => {
    const [v] = verifyDeliveredLabels([delivered(doc())], TESTNET);
    expect(v).toMatchObject({ id: 'pl_A1', changeId: 'lc_B2', effectiveSince: 1_800_000_000_000, previousEffectiveSince: null });
    expect(Object.keys(v!.document.formats)).toEqual(['join']);
  });

  it('drops a wrong hash, an unknown schema version, a document its parser refuses, another network, a malformed entry', () => {
    const t = doc();
    expect(verifyDeliveredLabels([delivered(t, { sha256: hash(`${t} `) })], TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels([delivered(t, { version: 'journear-labels/2' })], TESTNET)).toEqual([]);
    const claim = doc('testnet', 'the verified club');
    expect(verifyDeliveredLabels([delivered(claim)], TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels([delivered(doc('mainnet'))], TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels([delivered(t)], { network: 'mainnet' })).toEqual([]);
    for (const bad of [null, 'x', [], { ...delivered(t), id: 'x' }, { ...delivered(t), effectiveSince: -1 }, { ...delivered(t), previousEffectiveSince: '1' }, { ...delivered(t), text: 7 }]) expect(verifyDeliveredLabels([bad], TESTNET)).toEqual([]);
  });

  it('no list is no labels; a list over the cap is no labels; an entry named twice is used neither time', () => {
    for (const v of [undefined, null, {}, 'x', 3]) expect(verifyDeliveredLabels(v, TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels(Array.from({ length: MAX_DELIVERED_LABELS + 1 }, (_, i) => delivered(doc(), { id: `pl_${i}x` })), TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels([delivered(doc()), delivered(doc())], TESTNET)).toEqual([]);
    expect(verifyDeliveredLabels([delivered(doc()), delivered(doc(), { id: 'pl_C3' })], TESTNET).map((v) => v.id)).toEqual(['pl_A1', 'pl_C3']);
  });

  it('nothing in the vault or the window calls it yet (piece 3)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../src/', import.meta.url).pathname;
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/u.test(n) && !p.endsWith('vault/partner-labels.ts') && /partner-labels/u.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
