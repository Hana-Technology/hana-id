// The email pins' parsing and the per-key and policy verdicts (src/pins.ts), without a run.
import { describe, expect, it } from 'vitest';
import type { EmailSnapshot } from '../src/chain.ts';
import { emailKeyVerdict, OVERLAP_SLACK_MS, parsePins, POLICY_OVERLAP_MS, policyFindings, policyId } from '../src/pins.ts';
import { emailJwk, pinsOf } from './helpers.ts';

describe('parsePins', () => {
  const tp = (c: string) => c.repeat(43);
  it('absent: nothing pinned; well-formed: as written', () => {
    expect(parsePins(undefined)).toEqual({ pins: null, problems: [] });
    expect(parsePins('')).toEqual({ pins: null, problems: [] });
    expect(parsePins(JSON.stringify({ required: 1, signers: { hana: [tp('a')] } }))).toEqual({ pins: { required: 1, signers: { hana: [tp('a')] } }, problems: [] });
  });

  it('malformed: nothing pinned (never looser), with the problem for the config check', () => {
    for (const raw of ['{', '[]', '{"required":2,"signers":{"hana":["' + tp('a') + '"]}}', '{"required":1,"signers":{"hana":[]}}', '{"required":1,"signers":{"Hana":["' + tp('a') + '"]}}', '{"required":1,"signers":{"hana":["short"]}}', '{"required":1,"signers":{"a":["' + tp('a') + '"],"b":["' + tp('a') + '"]}}']) {
      const r = parsePins(raw);
      expect(r.pins, raw).toBeNull();
      expect(r.problems, raw).toHaveLength(1);
    }
  });
});

describe('emailKeyVerdict and policyFindings', () => {
  it('judges a key by thumbprint, kid and signer; without material by kid', async () => {
    const hana = await emailJwk(201);
    const pins = pinsOf({ hana: [hana] });
    const k = { kid: hana.kid, n: hana.n, e: hana.e };
    expect((await emailKeyVerdict(pins, k, 'hana', true)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, k, null, false)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, k, null, true)).reason).toBe('no_signer');
    expect((await emailKeyVerdict(pins, k, 'cosign', true)).reason).toBe('other_signer');
    expect((await emailKeyVerdict(pins, { ...k, kid: 'x' }, 'hana', true)).reason).toBe('kid_not_thumbprint');
    expect((await emailKeyVerdict(null, k, 'hana', true)).reason).toBe('not_pinned');
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: null, e: null }, 'hana', false)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, { kid: 'other', n: null, e: null }, 'hana', false)).reason).toBe('not_pinned');
    // Material that can't be hashed fails closed: never judged by its (pinned) kid (L1).
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: 'a*b', e: 'AQAB' }, 'hana', false)).reason).toBe('bad_material');
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: hana.n, e: null }, 'hana', false)).reason).toBe('bad_material');
  });

  it('a pre-v3 contract and an env before set_issuer have no findings; ids name the chain state', async () => {
    const none: EmailSnapshot = { issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: false };
    const pins = pinsOf({ hana: [await emailJwk(201)] });
    const empty = { differences: [], weaker: [], critical: [], transition: [] };
    expect(policyFindings(null, none, 0)).toEqual(empty);
    expect(policyFindings(pins, none, 0)).toEqual(empty);
    expect(policyId(none)).toBe('none');
    const v2WithIssuer: EmailSnapshot = { ...none, issuer: { provider: 'email', iss_values: [], kids: [] } };
    expect(policyFindings(pins, v2WithIssuer, 0).critical).toEqual(['the contract has no get_self_issued (pre-v3): the email issuer has no signer policy']);
    expect(policyId(v2WithIssuer)).toBe('not-self-issued');
  });

  it('an overlap of the contract\'s length is a transition; a longer one is weaker (M3)', async () => {
    const pins = pinsOf({ hana: [await emailJwk(201)] });
    const now = 1_000_000_000;
    const at = (overlap_until_ms: number | null): EmailSnapshot => ({
      issuer: { provider: 'email', iss_values: [], kids: [] },
      issuerKeys: [],
      selfIssued: { provider: 'email', signers: [{ id: 'hana', kids: [] }], required: 1, overlap_until_ms },
      hasSelfIssuedView: true,
    });
    expect(policyFindings(pins, at(null), now)).toEqual({ differences: [], weaker: [], critical: [], transition: [] });
    expect(policyFindings(pins, at(now - 1), now).differences).toEqual([]); // over (the view hides it too)
    const normal = policyFindings(pins, at(now + POLICY_OVERLAP_MS), now);
    expect(normal.weaker).toEqual([]);
    expect(normal.transition).toHaveLength(1);
    expect(policyFindings(pins, at(now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS), now).weaker).toEqual([]);
    const long = policyFindings(pins, at(now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS + 1), now);
    expect(long.weaker).toEqual([expect.stringContaining("longer than the contract's 10-minute overlap")]);
    expect(policyId(at(now + 1))).toBe('hana/1+overlap');
  });
});
