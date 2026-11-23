// D894: `partnerLabels.enabled`, the manifest switch for partner labels: optional, off when absent, refused on any
// network but testnet; no checked-in manifest turns it on (only the local e2e stack, which isn't a manifest).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifestPath, manifestSchema, partnerLabelsProblem } from './index.ts';

const sandbox = (): Record<string, unknown> => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
const messages = (m: unknown): string[] => {
  const r = manifestSchema.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('partnerLabels.enabled (D894)', () => {
  it('is optional and off when absent; a strict object with a boolean', () => {
    expect(manifestSchema.parse(sandbox()).partnerLabels).toBeUndefined();
    for (const enabled of [true, false]) expect(messages({ ...sandbox(), partnerLabels: { enabled } })).toEqual([]);
    for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, {}, { enabled: true, extra: 1 }, true]) expect(messages({ ...sandbox(), partnerLabels: bad }).length, JSON.stringify(bad)).toBeGreaterThan(0);
  });

  it('is refused on any network but testnet, naming the decision it needs', () => {
    expect(partnerLabelsProblem({ network: 'testnet', partnerLabels: { enabled: true } })).toBeNull();
    expect(partnerLabelsProblem({ network: 'mainnet', partnerLabels: { enabled: false } })).toBeNull();
    expect(partnerLabelsProblem({ network: 'mainnet', partnerLabels: { enabled: true } })).toMatch(/testnet only \(D894\).*its own decision/u);
  });

  it('no checked-in manifest turns it on', () => {
    const dir = new URL('../../../envs/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) expect((JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { partnerLabels?: { enabled?: boolean } }).partnerLabels?.enabled, f).not.toBe(true);
  });
});
