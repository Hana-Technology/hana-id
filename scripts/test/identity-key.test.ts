// identity-key init / put / next / switch / retire / show against a temp .secrets root, an in-memory manifest and a
// fake wrangler: the --yes gate, file modes, never overwriting a key or published keys, the offline standby (never
// uploaded until a switch), a rotation from start to end with the Worker always holding the active kid, and that no
// private value is ever printed.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_SECRET_FILES, type Manifest, identitySealKeyId, loadEnv, manifestPath, manifestSchema, p256Thumbprint } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  type IdentityKeyDeps,
  type IdentitySecret,
  type SigningSlot,
  identityKey,
  insertManifestBlock,
  newP256,
  replaceManifestBlock,
  withIdentityPins,
  wranglerIssuerSecretArgv,
  wranglerSecretArgv,
  wranglerSecretDeleteArgv,
} from '../lib/identity-key.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

const base: Manifest = { ...loadEnv('sandbox-dev'), name: 'sandbox-idk-test', cloudflare: { workerName: 'hana-id-api-idk-test', d1Name: 'hana-id-idk-test' } };
const baseText = (): string => {
  const raw = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown> & { watchdog: Record<string, unknown> };
  delete raw.identityToken;
  delete raw.watchdog.pinnedIdentityKeys;
  return `${JSON.stringify({ ...raw, name: base.name, cloudflare: base.cloudflare }, null, 2)}\n`;
};
/** The same manifest without a watchdog block (no watchdog: nothing to pin). */
const unwatchedText = (): string => {
  const raw = JSON.parse(baseText()) as Record<string, unknown>;
  delete raw.watchdog;
  return `${JSON.stringify(raw, null, 2)}\n`;
};
const pinsNow = (): string[] => manifest().watchdog?.pinnedIdentityKeys ?? [];
const publishedNow = (): string[] => manifest().identityToken?.publicKeys.map((k) => k.kid) ?? [];
const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
let dir: string;
let out: string[];
let puts: { name: IdentitySecret; value: string }[];
let deletes: SigningSlot[];
/** The Worker's secrets as the fake wrangler leaves them. */
let worker: Map<IdentitySecret, string>;
let text: string;

const manifest = (): Manifest => manifestSchema.parse(JSON.parse(text));
const activeKid = (): string => (manifest().identityToken!.signer as { activeKid: string }).activeKid;
const deps = (): IdentityKeyDeps => ({
  putSecret: (m, name, value) => {
    expect(m.name).toBe(base.name);
    puts.push({ name, value });
    worker.set(name, value);
  },
  deleteSecret: (m, name) => {
    expect(m.name).toBe(base.name);
    deletes.push(name);
    worker.delete(name);
  },
  newP256,
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: (name) => {
    expect(name).toBe(base.name);
    return manifest();
  },
  readManifestText: () => text,
  writeManifestText: (_name, t) => {
    text = t;
  },
});
const run = (...argv: string[]) => identityKey([base.name, ...argv], deps());
const file = (k: keyof typeof IDENTITY_SECRET_FILES) => join(dir, IDENTITY_SECRET_FILES[k]);
const kidOf = (k: 'signingKey' | 'standbyKey' | 'nextKey' | 'previousKey') => p256Thumbprint(JSON.parse(readFileSync(file(k), 'utf8')) as { kty: string; crv: string; x: string; y: string });
/** The kids of the signing keys on the fake Worker. */
const workerKids = (): string[] => (['IDENTITY_SIGNING_KEY', 'IDENTITY_SIGNING_KEY_STANDBY'] as const).flatMap((s) => (worker.has(s) ? [p256Thumbprint(JSON.parse(worker.get(s)!))] : []));
/** No private value (a `d`, the sub key) in anything printed. */
const expectNoSecretsPrinted = () => {
  const printed = out.join('\n');
  for (const { value } of puts) {
    expect(printed).not.toContain(value);
    if (value.startsWith('{')) expect(printed).not.toContain((JSON.parse(value) as { d: string }).d);
  }
  for (const f of readdirSync(dir).filter((n) => n.startsWith('identity-signing-key'))) expect(printed).not.toContain((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { d: string }).d);
  if (existsSync(file('subKey'))) expect(printed).not.toContain(readFileSync(file('subKey'), 'utf8').trim());
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-id-idk-'));
  dir = join(root, '.secrets', base.name);
  out = [];
  puts = [];
  deletes = [];
  worker = new Map();
  text = baseText();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('identity-key init', () => {
  it('without --yes: a plan, nothing written or set', () => {
    run('init');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(existsSync(dir)).toBe(false);
    expect(puts).toEqual([]);
    expect(manifest().identityToken).toBeUndefined();
  });

  it('--yes: 0600 files, both public keys published, the active key and the sub key uploaded, never the standby', () => {
    run('init', '--yes');
    for (const k of ['signingKey', 'standbyKey', 'subKey', 'slots'] as const) expect(mode(file(k))).toBe(0o600);
    const t = manifest().identityToken!;
    expect(t.iss).toBe(`${base.apiUrl}/v1/identity`);
    expect(t.signer).toEqual({ kind: 'worker-secret', activeKid: kidOf('signingKey') });
    expect(t.publicKeys.map((k) => k.kid)).toEqual([kidOf('signingKey'), kidOf('standbyKey')]);
    expect(text).not.toContain('"d"');
    expect(text.indexOf('"identityToken"')).toBeGreaterThan(text.indexOf('"apiUrl"'));
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SUB_KEY']);
    // The standby is published, but no Worker secret holds it: a leak of the Worker's secrets doesn't reach it (D177).
    expect(workerKids()).toEqual([kidOf('signingKey')]);
    expect(JSON.parse(readFileSync(file('slots'), 'utf8'))).toEqual({ IDENTITY_SIGNING_KEY: kidOf('signingKey'), IDENTITY_SIGNING_KEY_STANDBY: null });
    expect(Buffer.from(worker.get('IDENTITY_SUB_KEY')!, 'base64')).toHaveLength(32);
    expectNoSecretsPrinted();
  });

  it('--local: files and manifest, no Worker secret', () => {
    run('init', '--local', '--yes');
    expect(puts).toEqual([]);
    expect(manifest().identityToken).toBeDefined();
    expectNoSecretsPrinted();
  });

  it('never overwrites a key file or published keys', () => {
    run('init', '--local', '--yes');
    const before = readFileSync(file('signingKey'), 'utf8');
    expect(() => run('init', '--yes')).toThrow(/already exists/u);
    expect(readFileSync(file('signingKey'), 'utf8')).toBe(before);
    rmSync(dir, { recursive: true });
    expect(() => run('init', '--yes')).toThrow(/already has identityToken/u);
  });

  it('refuses arguments it doesn’t know', () => {
    expect(() => run('rotate')).toThrow(CliError);
    expect(() => run('put', '--local')).toThrow(CliError);
    expect(() => run('put', '--to', 'next')).toThrow(CliError);
    expect(() => identityKey([base.name], deps())).toThrow(CliError);
  });
});

describe('identity-key put and show', () => {
  it('put sets the active key and the sub key again (never the standby)', () => {
    run('init', '--local', '--yes');
    run('put');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    run('put', '--yes');
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SIGNING_KEY', 'IDENTITY_SUB_KEY']);
    expect(workerKids()).toEqual([kidOf('signingKey')]);
    expectNoSecretsPrinted();
  });

  it('put refuses an active key file that isn’t the manifest’s active kid', () => {
    run('init', '--local', '--yes');
    const m = JSON.parse(text) as { identityToken: { signer: { activeKid: string } } };
    m.identityToken.signer.activeKid = kidOf('standbyKey');
    text = JSON.stringify(m);
    expect(() => run('put', '--yes')).toThrow(/active kid/u);
    expect(puts).toEqual([]);
  });

  it('put refuses a secret file others can read', () => {
    run('init', '--local', '--yes');
    chmodSync(file('subKey'), 0o644);
    expect(() => run('put', '--yes')).toThrow(/mode 644/u);
  });

  it('show prints the kids, the active one, roles and slots, nothing private', () => {
    run('show');
    expect(out.at(-1)).toMatch(/no identityToken/u);
    run('init', '--yes');
    out = [];
    run('show');
    const t = manifest().identityToken!;
    expect(out).toEqual([`iss ${t.iss}`, `kid ${t.publicKeys[0]!.kid} (active: signs) role signing in IDENTITY_SIGNING_KEY`, `kid ${t.publicKeys[1]!.kid} role standby not on the Worker`]);
    expectNoSecretsPrinted();
  });

  it('testnet only, and wrangler gets values on stdin, never argv', () => {
    expect(wranglerSecretArgv(base, 'IDENTITY_SUB_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'IDENTITY_SUB_KEY', '--name', base.cloudflare.workerName]);
    expect(wranglerSecretDeleteArgv(base, 'IDENTITY_SIGNING_KEY')).toEqual(['exec', 'wrangler', 'secret', 'delete', 'IDENTITY_SIGNING_KEY', '--name', base.cloudflare.workerName]);
    const mainnet = { ...deps(), loadManifest: () => ({ ...manifest(), network: 'mainnet' }) as unknown as Manifest };
    expect(() => identityKey([base.name, 'show'], mainnet)).toThrow(/not a testnet env/u);
  });
});

describe('identity-key rotation: next, switch, retire', () => {
  it('a scheduled rotation: the Worker always holds the active kid, the old key keeps verifying until retired', () => {
    run('init', '--yes');
    const first = kidOf('signingKey');
    run('next', '--yes');
    const next = kidOf('nextKey');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toContain(next);
    expect(activeKid()).toBe(first);
    expect(workerKids()).toEqual([first]);
    expect(() => run('next', '--yes')).toThrow(/exists/u);

    run('switch', '--to', 'next', '--yes');
    expect(activeKid()).toBe(next);
    // Both keys on the Worker now: whichever manifest is deployed, a key with its active kid is there.
    expect(workerKids().sort()).toEqual([first, next].sort());
    expect(kidOf('signingKey')).toBe(next);
    expect(kidOf('previousKey')).toBe(first);
    expect(existsSync(file('nextKey'))).toBe(false);
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toContain(first);
    expect(() => run('switch', '--to', 'standby', '--yes')).toThrow(/retire it first/u);

    run('retire', '--key', 'previous', '--yes');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).not.toContain(first);
    expect(deletes).toEqual(['IDENTITY_SIGNING_KEY']);
    expect(workerKids()).toEqual([next]);
    expect(existsSync(file('previousKey'))).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('identity-signing-key-retired-'))).toBe(true);
    expectNoSecretsPrinted();
  });

  it('a compromise of the Worker’s secrets: switch to the offline standby, then retire the leaked key at once', () => {
    run('init', '--yes');
    const leaked = kidOf('signingKey');
    const standby = kidOf('standbyKey');
    run('switch', '--to', 'standby', '--yes');
    expect(activeKid()).toBe(standby);
    expect(puts.at(-1)!.name).toBe('IDENTITY_SIGNING_KEY_STANDBY');
    run('retire', '--key', 'previous', '--yes');
    expect(manifest().identityToken!.publicKeys.map((k) => k.kid)).toEqual([standby]);
    expect(workerKids()).toEqual([standby]);
    expect(leaked).not.toBe(standby);
    // A new standby comes from `next` (published, not uploaded).
    run('next', '--yes');
    expect(workerKids()).toEqual([standby]);
  });

  it('both keys exposed: retire the standby too, rotate to a fresh key', () => {
    run('init', '--yes');
    const [first, standby] = [kidOf('signingKey'), kidOf('standbyKey')];
    run('retire', '--key', 'standby', '--yes');
    run('next', '--yes');
    run('switch', '--to', 'next', '--yes');
    run('retire', '--key', 'previous', '--yes');
    const kids = manifest().identityToken!.publicKeys.map((k) => k.kid);
    expect(kids).toHaveLength(1);
    expect(kids).not.toContain(first);
    expect(kids).not.toContain(standby);
    expect(workerKids()).toEqual(kids);
  });

  it('refuses to retire the active key, a switch to an unpublished key, and a fifth key', () => {
    run('init', '--yes');
    expect(() => run('retire', '--key', 'active')).toThrow(CliError);
    expect(() => run('switch', '--to', 'next', '--yes')).toThrow(/doesn't exist/u);
    run('next', '--yes');
    // Unpublish the next key by hand: a switch must refuse it.
    const m = JSON.parse(text) as { identityToken: { publicKeys: { kid: string }[] } };
    m.identityToken.publicKeys = m.identityToken.publicKeys.filter((k) => k.kid !== kidOf('nextKey'));
    text = JSON.stringify(m);
    expect(() => run('switch', '--to', 'next', '--yes')).toThrow(/isn't in identityToken.publicKeys/u);
    expect(puts.filter((p) => p.name === 'IDENTITY_SIGNING_KEY_STANDBY')).toEqual([]);
  });

  it('without --yes, next, switch and retire change nothing', () => {
    run('init', '--yes');
    const before = text;
    run('next');
    run('retire', '--key', 'standby');
    expect(text).toBe(before);
    expect(existsSync(file('nextKey'))).toBe(false);
    expect(deletes).toEqual([]);
  });
});

describe('watchdog pins (D211): every published key pinned, pin before publish, unpin after unpublish', () => {
  it('init pins both keys; the plan says so; the log says to deploy the watchdog first', () => {
    run('init');
    expect(out.join('\n')).toContain('pin both in watchdog.pinnedIdentityKeys');
    expect(pinsNow()).toEqual([]);
    run('init', '--yes');
    expect(pinsNow()).toEqual(publishedNow());
    expect(out.join('\n')).toContain('deploy the watchdog FIRST');
    // The rest of the watchdog block is untouched.
    const before = (JSON.parse(baseText()) as { watchdog: Record<string, unknown> }).watchdog;
    const { pinnedIdentityKeys: _, ...after } = (JSON.parse(text) as { watchdog: Record<string, unknown> }).watchdog;
    expect(after).toEqual(before);
  });

  it('a scheduled rotation keeps the pins equal to the published keys at every step', () => {
    run('init', '--yes');
    const first = kidOf('signingKey');
    run('next', '--yes');
    expect(pinsNow()).toEqual(publishedNow());
    expect(pinsNow()).toContain(kidOf('nextKey'));
    run('switch', '--to', 'next', '--yes');
    expect(pinsNow()).toEqual(publishedNow());
    run('retire', '--key', 'previous', '--yes');
    expect(pinsNow()).not.toContain(first);
    expect(pinsNow()).toEqual(publishedNow());
    expect(out.at(-1)).toContain('deploy the API FIRST, then gen and deploy the watchdog');
  });

  it('a retired key is never left pinned, so republishing it is an alert (compromise path)', () => {
    run('init', '--yes');
    const leaked = kidOf('signingKey');
    run('switch', '--to', 'standby', '--yes');
    run('retire', '--key', 'previous', '--yes');
    expect(pinsNow()).not.toContain(leaked);
    // Republishing the leaked key by hand without its pin is refused by the schema.
    const m = JSON.parse(text) as { identityToken: { publicKeys: { kid: string }[] } };
    const leakedEntry = { kty: 'EC', crv: 'P-256', ...JSON.parse(readFileSync(readdirSync(dir).filter((f) => f.startsWith('identity-signing-key-retired-')).map((f) => join(dir, f))[0]!, 'utf8')) };
    delete (leakedEntry as { d?: string }).d;
    m.identityToken.publicKeys.push({ ...leakedEntry, kid: leaked, use: 'sig', alg: 'ES256' } as never);
    expect(manifestSchema.safeParse(m).error?.issues.map((i) => i.message).join()).toContain(`identityToken key ${leaked} is not in watchdog.pinnedIdentityKeys`);
  });

  it('pins kept in the manifest by hand (pinned ahead) stay; next adds its own', () => {
    run('init', '--yes');
    const ahead = 'A'.repeat(43);
    const raw = JSON.parse(text) as { watchdog: { pinnedIdentityKeys: string[] } };
    raw.watchdog.pinnedIdentityKeys.push(ahead);
    text = JSON.stringify(raw, null, 2);
    run('next', '--yes');
    expect(pinsNow()).toContain(ahead);
    expect(pinsNow()).toContain(kidOf('nextKey'));
  });

  it('a manifest without a watchdog block gets no pins and the plain redeploy line', () => {
    text = unwatchedText();
    run('init', '--yes');
    expect(manifest().watchdog).toBeUndefined();
    run('next', '--yes');
    run('retire', '--key', 'standby', '--yes');
    expect(out.join('\n')).not.toContain('watchdog');
    expect(manifest().identityToken!.publicKeys).toHaveLength(2);
  });

  it('withIdentityPins edits only the pinnedIdentityKeys line of the committed manifest (L3)', () => {
    const committed = readFileSync(manifestPath('sandbox-dev'), 'utf8');
    expect(withIdentityPins(committed, [], [])).toBe(committed);
    const extra = 'C'.repeat(43);
    const added = withIdentityPins(committed, [extra], []);
    const before = committed.split('\n');
    const after = added.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i]));
    expect(changed).toHaveLength(1);
    // In place: a comma stays when another member follows (sandbox-dev's pinnedIssuerKeys).
    const comma = before[changed[0]!]!.endsWith(',') ? ',' : '';
    expect(after[changed[0]!]).toBe(`    "pinnedIdentityKeys": [${[...loadEnv('sandbox-dev').watchdog!.pinnedIdentityKeys!, extra].map((t) => JSON.stringify(t)).join(', ')}]${comma}`);
    expect(withIdentityPins(added, [], [extra])).toBe(committed);
  });

  it('withIdentityPins adds the line as the last watchdog member and removes it again, nothing else changed (L3)', () => {
    const t0 = baseText();
    const a = 'a'.repeat(43);
    const t1 = withIdentityPins(t0, [a], []);
    const lines0 = t0.split('\n');
    const lines1 = t1.split('\n');
    expect(lines1).toHaveLength(lines0.length + 1);
    // One new line, and a comma after the member before it (its line may equal another of the file's, e.g. "    },").
    const at = lines1.indexOf(`    "pinnedIdentityKeys": ["${a}"]`);
    expect(at).toBeGreaterThan(0);
    expect(lines1[at - 1]).toBe(`${lines0[at - 1]},`);
    expect([...lines1.slice(0, at - 1), ...lines1.slice(at + 1)]).toEqual([...lines0.slice(0, at - 1), ...lines0.slice(at)]);
    const w = (JSON.parse(t1) as { watchdog: Record<string, unknown> }).watchdog;
    expect(Object.keys(w).at(-1)).toBe('pinnedIdentityKeys');
    expect(withIdentityPins(t1, [], [a])).toBe(t0);
  });

  it('init and next validate the new manifest before writing any key file (L4)', () => {
    const full = JSON.parse(baseText()) as { watchdog: Record<string, unknown> };
    full.watchdog.pinnedIdentityKeys = 'abcdefgh'.split('').map((c) => c.repeat(43));
    text = `${JSON.stringify(full, null, 2)}\n`;
    // Eight pins already: the two new ones can't be added, so init refuses with no file written.
    expect(() => run('init', '--yes')).toThrow();
    expect(existsSync(dir) && readdirSync(dir).length > 0).toBe(false);
    expect(puts).toEqual([]);

    text = baseText();
    run('init', '--yes');
    const m = JSON.parse(text) as { watchdog: { pinnedIdentityKeys: string[] } };
    m.watchdog.pinnedIdentityKeys.push(...'abcdef'.split('').map((c) => c.repeat(43)));
    text = JSON.stringify(m, null, 2);
    expect(() => run('next', '--yes')).toThrow();
    expect(existsSync(file('nextKey'))).toBe(false);
  });

  it('withIdentityPins adds and removes, keeps order, validates, and leaves an unwatched manifest alone', () => {
    const a = 'a'.repeat(43);
    const b = 'b'.repeat(43);
    const t1 = withIdentityPins(baseText(), [a, b], []);
    expect((JSON.parse(t1) as { watchdog: { pinnedIdentityKeys: string[] } }).watchdog.pinnedIdentityKeys).toEqual([a, b]);
    expect((JSON.parse(withIdentityPins(t1, [a], [])) as { watchdog: { pinnedIdentityKeys: string[] } }).watchdog.pinnedIdentityKeys).toEqual([a, b]);
    const t2 = withIdentityPins(t1, [], [a, b]);
    expect((JSON.parse(t2) as { watchdog: Record<string, unknown> }).watchdog).not.toHaveProperty('pinnedIdentityKeys');
    expect(withIdentityPins(unwatchedText(), [a], [])).toBe(unwatchedText());
    expect(() => withIdentityPins(baseText(), ['short'], [])).toThrow();
  });
});

describe('manifest blocks', () => {
  it('insert refuses a key that exists, and validates the result', () => {
    const t = baseText();
    expect(() => insertManifestBlock(t, 'apiUrl', {}, 'name')).toThrow(/already has/u);
    expect(() => insertManifestBlock(t, 'identityToken', { iss: 'x' }, 'apiUrl')).toThrow();
  });

  it('replace swaps only that block and validates', () => {
    run('init', '--local', '--yes');
    const t = manifest().identityToken!;
    const changed = replaceManifestBlock(text, 'identityToken', { ...t, publicKeys: t.publicKeys.slice(0, 1) });
    expect((JSON.parse(changed) as { identityToken: { publicKeys: unknown[] } }).identityToken.publicKeys).toHaveLength(1);
    expect(changed.slice(0, changed.indexOf('"identityToken"'))).toBe(text.slice(0, text.indexOf('"identityToken"')));
    expect(() => replaceManifestBlock(text, 'identityToken', { ...t, publicKeys: [] })).toThrow();
    expect(() => replaceManifestBlock(baseText(), 'identityToken', t)).toThrow(/has no/u);
  });
});

describe('identity-key email-keys (D420, D421)', () => {
  let issuerPuts: { worker: string; name: string; value: string }[];
  /** A random source that never repeats (the shared one is deterministic: both keys would be the same bytes). */
  let counter: number;
  const emailDeps = (over: Partial<IdentityKeyDeps> = {}): IdentityKeyDeps => ({
    ...deps(),
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + counter++ * 31) % 256),
    putIssuerSecret: (m, name, value) => void issuerPuts.push({ worker: m.emailIssuer!.cloudflare.workerName, name, value }),
    ...over,
  });
  const runEmail = (...argv: string[]) => identityKey([base.name, 'email-keys', ...argv], emailDeps());
  const seal = () => readFileSync(file('sealKey'), 'utf8');
  const consent = () => readFileSync(file('emailConsentKey'), 'utf8');
  const expectNothingPrinted = () => {
    const printed = out.join('\n');
    for (const v of [...puts.map((p) => p.value), ...issuerPuts.map((p) => p.value)]) {
      expect(printed).not.toContain(v);
      expect(printed).not.toContain(v.slice(v.indexOf(':') + 1));
    }
    for (const k of ['sealKey', 'emailConsentKey'] as const) if (existsSync(file(k))) expect(printed).not.toContain(readFileSync(file(k), 'utf8').trim().replace(/^\d+:/u, ''));
  };
  beforeEach(() => {
    issuerPuts = [];
    counter = 1;
  });

  it('the file names and the seal key form (identitySealKeyId)', () => {
    expect([IDENTITY_SECRET_FILES.sealKey, IDENTITY_SECRET_FILES.emailConsentKey]).toEqual(['identity-seal-key', 'email-consent-key']);
    const b = Buffer.alloc(32, 7).toString('base64');
    expect(identitySealKeyId(`1:${b}`)).toBe(1);
    expect(identitySealKeyId(`4294967295:${b}`)).toBe(4294967295);
    for (const bad of [`0:${b}`, `4294967296:${b}`, b, `1:${Buffer.alloc(31, 7).toString('base64')}`, `1:${b} `, `01:${b}`]) expect(identitySealKeyId(bad), bad).toBeNull();
  });

  it('without --yes: a plan naming the files and both Workers; nothing written or set', () => {
    runEmail();
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(out[0]).toContain('.secrets/sandbox-idk-test/identity-seal-key');
    expect(out[0]).toContain('.secrets/sandbox-idk-test/email-consent-key');
    expect(out[0]).toContain(`API Worker ${base.cloudflare.workerName}`);
    expect(out[0]).toContain(`email issuer Worker ${base.emailIssuer!.cloudflare.workerName}`);
    expect(existsSync(dir)).toBe(false);
    expect([puts, issuerPuts]).toEqual([[], []]);
  });

  it('--yes: two 0600 files in their forms, the API gets both secrets, the issuer the seal key only; no value printed', () => {
    runEmail('--yes');
    expect(mode(file('sealKey'))).toBe(0o600);
    expect(mode(file('emailConsentKey'))).toBe(0o600);
    const s = seal().trim();
    const c = consent().trim();
    expect(s).toMatch(/^1:[A-Za-z0-9+/]{43}=$/u);
    expect(identitySealKeyId(s)).toBe(1);
    expect(Buffer.from(c, 'base64')).toHaveLength(32);
    expect(c).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(s.slice(2)).not.toBe(c);
    // The API first (so a blob the issuer seals always opens there), then the issuer.
    expect(puts).toEqual([
      { name: 'IDENTITY_SEAL_KEY', value: s },
      { name: 'EMAIL_CONSENT_KEY', value: c },
    ]);
    expect(issuerPuts).toEqual([{ worker: base.emailIssuer!.cloudflare.workerName, name: 'IDENTITY_SEAL_KEY', value: s }]);
    // Nothing else of the identity token is touched.
    expect(manifest().identityToken).toBeUndefined();
    expect(text).toBe(baseText());
    expectNothingPrinted();
  });

  it('never overwrites a file: an existing one is reused (and a missing one written), a malformed one stops it', () => {
    runEmail('--local', '--yes');
    const [s, c] = [seal(), consent()];
    runEmail('--yes');
    expect([seal(), consent()]).toEqual([s, c]);
    expect(puts.map((p) => p.value)).toEqual([s.trim(), c.trim()]);
    // Only the consent key missing: the seal key is reused, a new consent key written.
    rmSync(file('emailConsentKey'));
    out = [];
    runEmail('--yes');
    expect(out[0]).toContain('reuse .secrets/sandbox-idk-test/identity-seal-key');
    expect(seal()).toBe(s);
    expect(consent()).not.toBe(c);
    // A file others can read, or a malformed one, is refused and never replaced.
    chmodSync(file('sealKey'), 0o644);
    expect(() => runEmail('--yes')).toThrow(/0600|mode/u);
    chmodSync(file('sealKey'), 0o600);
    rmSync(file('sealKey'));
    writeFileSync(file('sealKey'), 'nope\n', { mode: 0o600 });
    expect(() => runEmail('--yes')).toThrow(/is not an IDENTITY_SEAL_KEY value/u);
    expect(seal()).toBe('nope\n');
    expect(out.join('\n')).not.toContain('nope');
    expectNothingPrinted();
  });

  it('--local writes the files and uploads nothing', () => {
    runEmail('--local', '--yes');
    expect(existsSync(file('sealKey')) && existsSync(file('emailConsentKey'))).toBe(true);
    expect([puts, issuerPuts]).toEqual([[], []]);
    expect(out.join('\n')).toContain('--local');
    expectNothingPrinted();
  });

  it('put: uploads from the files only (refused when one is missing; no --local)', () => {
    expect(() => runEmail('put', '--yes')).toThrow(/don't exist: run `identity-key sandbox-idk-test email-keys --yes` first/u);
    runEmail('--local', '--yes');
    const [s, c] = [seal().trim(), consent().trim()];
    out = [];
    runEmail('put');
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(puts).toEqual([]);
    runEmail('put', '--yes');
    expect([seal().trim(), consent().trim()]).toEqual([s, c]);
    expect(puts).toEqual([
      { name: 'IDENTITY_SEAL_KEY', value: s },
      { name: 'EMAIL_CONSENT_KEY', value: c },
    ]);
    expect(issuerPuts.map((p) => [p.name, p.value])).toEqual([['IDENTITY_SEAL_KEY', s]]);
    expect(() => runEmail('put', '--local', '--yes')).toThrow(CliError);
    expect(() => runEmail('get', '--yes')).toThrow(/Unexpected argument get/u);
    expectNothingPrinted();
  });

  it('an env without an email issuer: the API only, the issuer skipped with a line', () => {
    const raw = JSON.parse(baseText()) as Record<string, unknown>;
    delete raw.emailIssuer;
    text = `${JSON.stringify(raw, null, 2)}\n`;
    runEmail('--yes');
    expect(puts.map((p) => p.name)).toEqual(['IDENTITY_SEAL_KEY', 'EMAIL_CONSENT_KEY']);
    expect(issuerPuts).toEqual([]);
    expect(out.join('\n')).toContain('has no emailIssuer');
    expectNothingPrinted();
  });

  it('refuses the same bytes in both keys (nothing written), and a non-testnet env', () => {
    expect(() => identityKey([base.name, 'email-keys', '--yes'], emailDeps({ randomBytes: (n) => new Uint8Array(n).fill(9) }))).toThrow(/must differ/u);
    expect(existsSync(file('sealKey'))).toBe(false);
    const m = { ...manifest(), network: 'mainnet' } as unknown as Manifest;
    expect(() => identityKey([base.name, 'email-keys', '--yes'], emailDeps({ loadManifest: () => m }))).toThrow(/not a testnet env/u);
    expect(puts).toEqual([]);
  });

  it('the issuer upload goes to the manifest’s issuer Worker, the API’s to the API Worker', () => {
    expect(wranglerIssuerSecretArgv(base, 'IDENTITY_SEAL_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'IDENTITY_SEAL_KEY', '--name', base.emailIssuer!.cloudflare.workerName]);
    expect(wranglerSecretArgv(base, 'EMAIL_CONSENT_KEY')).toEqual(['exec', 'wrangler', 'secret', 'put', 'EMAIL_CONSENT_KEY', '--name', base.cloudflare.workerName]);
  });
});
