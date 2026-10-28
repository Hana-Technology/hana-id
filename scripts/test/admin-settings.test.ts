// admin.ts app:settings (docs/batch-b-spec.md "Tests → Scripts"), against a real SQLite database with apps/api's
// migrations applied, so every write also passes (or is refused by) the migration's CHECKs.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { policyId } from '@hana-id/core/policy';
import { loadEnv, repoRoot } from '@hana-id/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppSettingsDeps,
  appSettings,
  googleClientIds,
  invocationDir,
  planSettings,
  resolvePolicyPath,
  scopeClientsFrom,
  SETTINGS_CHANGED,
  settingsAppArg,
  changeDelayMsFor,
  describeSettings,
  formatDuration,
  IDLE_TTL_MIN_MS,
  parseDuration,
  parseSettingsArgs,
  POLICY_FILE_MAX_BYTES,
  policyInForce,
  RAW_SIGN_DELAY_MS,
  RAW_SIGN_WARNING,
  rawSignInForce,
  readPolicyFile,
  SESSION_TTL_MAX_MS,
  SESSION_TTL_MIN_MS,
  type SettingsRow,
} from '../lib/admin-settings.ts';
import { parseCli } from '../lib/cli.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 28, 12);
const APP = 'app_settings1';
const KEY = 'pk_test_settings1';
const SCOPE = 's1';
const WEB = '111-web.apps.googleusercontent.com';
const IOS = '222-ios.apps.googleusercontent.com';
const WORK = '/work/dir';

/** A fresh in-memory database with every apps/api migration and one app at the defaults. */
function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(repoRoot, 'apps', 'api', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES (?, 'Settings test', ?, ?)").run(APP, SCOPE, KEY);
  return db;
}

const SETTINGS = 'persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id';
const row = (db: DatabaseSync): SettingsRow => ({ ...(db.prepare(`SELECT id, name, scope_id, ${SETTINGS} FROM apps WHERE id = ?`).get(APP) as unknown as SettingsRow) });

/** An AutoApprovePolicyV1: ERC-20 approve on one Base contract, under the address rule. */
const policy = (label = 'Approvals', extra: Record<string, unknown> = {}) => ({
  v: 1,
  label,
  maxConsentMs: 12 * HOUR,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: 8453,
        maxValueWei: '0',
        maxValueWeiPerDay: '0',
        maxFeeWei: '100000',
        contracts: [
          {
            address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            name: 'USDC',
            selectors: [{ selector: '0x095ea7b3', signature: 'approve(address,uint256)', addressArgs: 'self-or-listed' }],
          },
        ],
      },
    ],
  },
  ...extra,
});

const sandbox = loadEnv('sandbox-dev');
const prod = { ...sandbox, name: 'prod' };

interface Harness {
  db: DatabaseSync;
  out: string[];
  files: Map<string, string>;
  chainReads: string[];
  clients: [string, string][] | null;
  now: number;
  run: (argv: string[], m?: typeof sandbox) => Promise<void>;
}

let h: Harness;

beforeEach(() => {
  const db = newDb();
  const state: Harness = {
    db,
    out: [],
    files: new Map(),
    chainReads: [],
    clients: [
      ['google', WEB],
      ['google', IOS],
      ['apple', 'not-google.example'],
    ],
    now: NOW,
    run: async (argv, m = sandbox) => {
      const args = parseCli(argv, {
        strings: ['app', 'persistence', 'session-ttl', 'idle-ttl', 'raw-sign', 'google-web-client', 'auto-approve'],
        booleans: ['remote'],
      });
      const deps: AppSettingsDeps = {
        // Rows for a SELECT and for an UPDATE … RETURNING (as wrangler d1 execute --json gives them).
        d1: (statement) => (/^\s*SELECT|\bRETURNING\b/iu.test(statement) ? (db.prepare(statement).all() as Record<string, unknown>[]) : (db.exec(statement), [])),
        scopeClients: async (scopeId) => {
          state.chainReads.push(scopeId);
          return state.clients;
        },
        // Policy files live in WORK, the directory the command was "run" from.
        baseDir: WORK,
        readFile: (path) => {
          const text = path.startsWith(`${WORK}/`) ? state.files.get(path.slice(WORK.length + 1)) : undefined;
          if (text === undefined) throw new Error(`no file ${path}`);
          return text;
        },
        now: () => state.now,
        log: (line) => state.out.push(line),
      };
      await appSettings(m, args.positionals[0] ?? KEY, args, 'local D1 test', deps);
    },
  };
  h = state;
});

const output = () => h.out.join('\n');
const set = (fields: Record<string, string | number | null>) =>
  h.db.prepare(`UPDATE apps SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fields), APP);

describe('durations', () => {
  it('parses h/m/s combinations and ms, and refuses bare numbers and junk', () => {
    expect(parseDuration('12h', 'x')).toBe(12 * HOUR);
    expect(parseDuration('23h50m', 'x')).toBe(SESSION_TTL_MAX_MS);
    expect(parseDuration('15m', 'x')).toBe(IDLE_TTL_MIN_MS);
    expect(parseDuration('59m59s', 'x')).toBe(HOUR - 1000);
    expect(parseDuration('3600000ms', 'x')).toBe(HOUR);
    for (const bad of ['', '3600000', '1.5h', '-1h', '1d', '1h ', 'h', '1m2h']) expect(() => parseDuration(bad, 'session-ttl')).toThrow('--session-ttl must be a duration');
  });

  it('formats back exactly', () => {
    expect(formatDuration(SESSION_TTL_MAX_MS)).toBe('23h50m');
    expect(formatDuration(12 * HOUR)).toBe('12h');
    expect(formatDuration(HOUR - 1000)).toBe('59m59s');
    expect(formatDuration(HOUR + 1)).toBe('3600001ms');
  });
});

describe('app:settings ranges', () => {
  it('accepts --session-ttl at both bounds (and D1 stores them)', async () => {
    await h.run(['--session-ttl', '1h', '--idle-ttl', '15m']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: SESSION_TTL_MIN_MS, idle_ttl_ms: IDLE_TTL_MIN_MS });
    await h.run(['--session-ttl', '23h50m']);
    expect(row(h.db).session_ttl_ms).toBe(SESSION_TTL_MAX_MS);
  });

  it('refuses --session-ttl outside 1h..23h50m, and so does the migration', async () => {
    for (const v of ['59m59s', '3599999ms', '23h50m1s', '24h']) {
      await expect(h.run(['--session-ttl', v, '--idle-ttl', '15m'])).rejects.toThrow('--session-ttl must be between 1h and 23h50m');
    }
    expect(row(h.db).session_ttl_ms).toBe(12 * HOUR);
    for (const v of [SESSION_TTL_MIN_MS - 1, SESSION_TTL_MAX_MS + 1]) expect(() => set({ session_ttl_ms: v, idle_ttl_ms: IDLE_TTL_MIN_MS })).toThrow(/CHECK/u);
  });

  it('accepts --idle-ttl from 15m up to the session TTL, and refuses outside (as the migration does)', async () => {
    await h.run(['--idle-ttl', '15m']);
    expect(row(h.db).idle_ttl_ms).toBe(IDLE_TTL_MIN_MS);
    await h.run(['--idle-ttl', '12h']);
    expect(row(h.db).idle_ttl_ms).toBe(12 * HOUR);
    await expect(h.run(['--idle-ttl', '14m59s'])).rejects.toThrow('--idle-ttl must be between 15m and the session TTL 12h');
    await expect(h.run(['--idle-ttl', '12h0m1s'])).rejects.toThrow('--idle-ttl must be between 15m and the session TTL 12h');
    // Checked against the session TTL given in the same call.
    await h.run(['--session-ttl', '23h50m', '--idle-ttl', '23h50m']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: SESSION_TTL_MAX_MS, idle_ttl_ms: SESSION_TTL_MAX_MS });
    expect(() => set({ idle_ttl_ms: IDLE_TTL_MIN_MS - 1 })).toThrow(/CHECK/u);
    expect(() => set({ idle_ttl_ms: SESSION_TTL_MAX_MS + 1 })).toThrow(/CHECK/u);
  });

  it('refuses a --session-ttl below the stored idle TTL unless --idle-ttl comes with it', async () => {
    await expect(h.run(['--session-ttl', '1h'])).rejects.toThrow('The idle TTL 2h would exceed --session-ttl 1h: pass --idle-ttl too');
    expect(row(h.db).session_ttl_ms).toBe(12 * HOUR);
    await h.run(['--session-ttl', '1h', '--idle-ttl', '1h']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: HOUR, idle_ttl_ms: HOUR });
  });

  it('sets --persistence, and refuses other values', async () => {
    await h.run(['--persistence', 'none']);
    expect(row(h.db).persistence).toBe('none');
    expect(output()).toContain('persistence: session → none (immediate)');
    await h.run(['--persistence', 'session']);
    expect(row(h.db).persistence).toBe('session');
    await expect(h.run(['--persistence', 'local'])).rejects.toThrow("--persistence must be 'session' or 'none'");
  });

  it('refuses the whole call when one value is bad (nothing is written)', async () => {
    await expect(h.run(['--persistence', 'none', '--session-ttl', '30m'])).rejects.toThrow('--session-ttl');
    expect(row(h.db).persistence).toBe('session');
  });
});

describe('app:settings --raw-sign', () => {
  it('approval writes the pending value and its effective time, with the warning; the vault sees off until then', async () => {
    await h.run(['--raw-sign', 'approval']);
    const r = row(h.db);
    expect(r).toMatchObject({ raw_sign: 'off', raw_sign_pending: 'approval', raw_sign_effective_at: NOW + sandbox.changeDelayMs });
    expect(h.out).toContain(RAW_SIGN_WARNING);
    expect(RAW_SIGN_WARNING).toContain('can authorize any transaction on that chain');
    expect(rawSignInForce(r, NOW + sandbox.changeDelayMs - 1)).toBe('off');
    expect(rawSignInForce(r, NOW + sandbox.changeDelayMs)).toBe('approval');
  });

  it('uses 24 h outside local*/sandbox* envs, and the manifest changeDelayMs in them', async () => {
    expect(changeDelayMsFor(prod)).toBe(RAW_SIGN_DELAY_MS);
    expect(RAW_SIGN_DELAY_MS).toBe(24 * HOUR);
    expect(changeDelayMsFor({ name: 'local', changeDelayMs: 5 })).toBe(5);
    expect(changeDelayMsFor({ name: 'sandbox-dev', changeDelayMs: 60_000 })).toBe(60_000);
    await h.run(['--raw-sign', 'approval'], prod);
    expect(row(h.db).raw_sign_effective_at).toBe(NOW + 24 * HOUR);
  });

  it('re-running approval does not restart the delay; approval in force is a no-op', async () => {
    await h.run(['--raw-sign', 'approval']);
    h.now = NOW + 1000;
    await h.run(['--raw-sign', 'approval']);
    expect(row(h.db).raw_sign_effective_at).toBe(NOW + sandbox.changeDelayMs);
    expect(output()).toContain('approval already pending');
    h.now = NOW + sandbox.changeDelayMs;
    await h.run(['--raw-sign', 'approval']);
    expect(output()).toContain('raw signing: already approval');
    expect(output()).toMatch(/no change/u);
  });

  it('off is immediate and drops a pending approval', async () => {
    await h.run(['--raw-sign', 'approval']);
    await h.run(['--raw-sign', 'off']);
    expect(row(h.db)).toMatchObject({ raw_sign: 'off', raw_sign_pending: null, raw_sign_effective_at: null });
    set({ raw_sign: 'approval' });
    await h.run(['--raw-sign', 'off']);
    expect(row(h.db).raw_sign).toBe('off');
    expect(output()).toContain('approval → off (immediate)');
    await expect(h.run(['--raw-sign', 'app_signed'])).rejects.toThrow("--raw-sign must be 'off' or 'approval'");
  });
});

describe('app:settings --google-web-client', () => {
  it('sets one of the scope’s Google clients on chain', async () => {
    await h.run(['--google-web-client', IOS]);
    expect(row(h.db).google_web_client_id).toBe(IOS);
    expect(h.chainReads).toEqual([SCOPE]);
  });

  it('refuses a client that is not one of the scope’s Google clients (another provider’s, unknown, unregistered scope)', async () => {
    await expect(h.run(['--google-web-client', 'not-google.example'])).rejects.toThrow(`not-google.example is not one of scope ${SCOPE}'s Google clients on chain (${WEB}, ${IOS})`);
    await expect(h.run(['--google-web-client', '999-other.apps.googleusercontent.com'])).rejects.toThrow('is not one of scope');
    h.clients = [];
    await expect(h.run(['--google-web-client', WEB])).rejects.toThrow('(none)');
    h.clients = null;
    await expect(h.run(['--google-web-client', WEB])).rejects.toThrow(`Scope ${SCOPE} is not registered`);
    expect(row(h.db).google_web_client_id).toBeNull();
    await expect(h.run(['--google-web-client', 'has space'])).rejects.toThrow('Invalid --google-web-client');
  });

  it('default unpins the client without a chain read', async () => {
    set({ google_web_client_id: WEB });
    await h.run(['--google-web-client', 'default']);
    expect(row(h.db).google_web_client_id).toBeNull();
    expect(h.chainReads).toEqual([]);
  });
});

describe('app:settings --auto-approve', () => {
  const file = (name: string, value: unknown) => {
    h.files.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    return name;
  };

  it('validates the policy and writes it, normalized, as pending with its effective time', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    const r = row(h.db);
    const id = policyId(policy());
    expect(r.auto_approve_policy).toBeNull();
    expect(r.auto_approve_effective_at).toBe(NOW + sandbox.changeDelayMs);
    // Stored as the validator's canonical form (EIP-55 address), so its id is the one users consent to.
    expect(r.auto_approve_pending).toContain('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(policyId(JSON.parse(r.auto_approve_pending!))).toBe(id);
    expect(output()).toContain(`policy ${id} ("Approvals") from ${WORK}/p.json, pending until`);
    // Nothing in force until the delay has passed.
    expect(policyInForce(r, NOW + sandbox.changeDelayMs - 1)).toBeNull();
    expect(policyInForce(r, NOW + sandbox.changeDelayMs)).toBe(r.auto_approve_pending);
  });

  it('refuses an invalid policy with the validator’s problems, and writes nothing', async () => {
    const any = policy();
    any.evm.chains[0]!.contracts[0]!.selectors[0]!.addressArgs = 'any';
    await expect(h.run(['--auto-approve', file('any.json', any)])).rejects.toThrow("\"approve\" moves or approves assets and can't have addressArgs 'any'");
    await expect(h.run(['--auto-approve', file('raw.json', policy('Raw', { raw: true }))])).rejects.toThrow('unknown key "raw"');
    await expect(h.run(['--auto-approve', file('bad.json', '{"v":1,')])).rejects.toThrow('is not a valid AutoApprovePolicyV1');
    const dup = JSON.stringify(policy()).replace('"label":"Approvals"', '"label":"Approvals","label":"Other"');
    await expect(h.run(['--auto-approve', file('dup.json', dup)])).rejects.toThrow('Duplicate JSON key');
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
  });

  it('refuses maxConsentMs over the app’s session TTL (the one in force after the call)', async () => {
    set({ session_ttl_ms: 2 * HOUR, idle_ttl_ms: HOUR });
    await expect(h.run(['--auto-approve', file('long.json', policy())])).rejects.toThrow('policy.maxConsentMs: must be between');
    await h.run(['--auto-approve', file('long.json', policy()), '--session-ttl', '12h']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: 12 * HOUR, auto_approve_effective_at: NOW + sandbox.changeDelayMs });
  });

  it('refuses lowering --session-ttl under a stored policy’s maxConsentMs, unless the policy goes too', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await expect(h.run(['--session-ttl', '6h'])).rejects.toThrow('maxConsentMs over the new session TTL 6h');
    await h.run(['--session-ttl', '6h', '--auto-approve', 'off']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: 6 * HOUR, auto_approve_pending: null });
  });

  it('re-setting the pending policy keeps its clock; re-setting the policy in force drops a pending change', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    h.now = NOW + 1000;
    await h.run(['--auto-approve', 'p.json']);
    expect(row(h.db).auto_approve_effective_at).toBe(NOW + sandbox.changeDelayMs);
    expect(output()).toContain('already pending');
    // Mature it, then queue another policy and change our mind.
    h.now = NOW + sandbox.changeDelayMs;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.run(['--auto-approve', 'p.json']);
    const r = row(h.db);
    expect(policyId(JSON.parse(r.auto_approve_policy!))).toBe(policyId(policy()));
    expect(r).toMatchObject({ auto_approve_pending: null, auto_approve_effective_at: null });
    expect(output()).toContain('The pending policy is dropped.');
  });

  it('a new policy after a matured one keeps the matured one in force until the new one’s time', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    h.now = NOW + sandbox.changeDelayMs + 5;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    const r = row(h.db);
    expect(policyId(JSON.parse(r.auto_approve_policy!))).toBe(policyId(policy()));
    expect(policyId(JSON.parse(r.auto_approve_pending!))).toBe(policyId(policy('Wider')));
    expect(r.auto_approve_effective_at).toBe(h.now + sandbox.changeDelayMs);
    expect(policyInForce(r, h.now)).toBe(r.auto_approve_policy);
  });

  it('off is immediate: removes the policy in force and any pending one', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    h.now = NOW + sandbox.changeDelayMs;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.run(['--auto-approve', 'off']);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
    expect(output()).toContain('policy removed (immediate)');
    await h.run(['--auto-approve', 'off']);
    expect(output()).toContain('auto-approve: already off');
  });
});

describe('app:settings writes only over the row it read', () => {
  const file = (name: string, value: unknown) => {
    h.files.set(name, JSON.stringify(value));
    return name;
  };

  it('a stale plan (P in force, P2 pending) run after another operator’s --auto-approve off changes nothing', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    h.now = NOW + sandbox.changeDelayMs;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    // This CLI reads the row: P in force, P2 pending. It plans "re-set P" (drop the pending P2).
    const stale = row(h.db);
    expect(policyId(JSON.parse(stale.auto_approve_policy!))).toBe(policyId(policy()));
    const plan = planSettings(stale, { autoApprove: { text: JSON.stringify(policy()), file: 'p.json' } }, { now: h.now, delayMs: sandbox.changeDelayMs });
    expect(plan.lines.join('\n')).toContain('The pending policy is dropped.');
    expect(plan.sql).not.toMatch(/auto_approve_policy = '/u);
    // Meanwhile another operator removes every policy.
    await h.run(['--auto-approve', 'off']);
    // The stale write matches no row: the removed policy is not put back in force.
    expect(h.db.prepare(plan.sql!).all()).toEqual([]);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
  });

  it('appSettings refuses (and writes nothing) when the row changed between its read and its write', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    h.now = NOW + sandbox.changeDelayMs;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    // A d1 that runs another operator's change right after this CLI's read.
    const real = h.db;
    let interleaved = false;
    const deps: AppSettingsDeps = {
      d1: (statement) => {
        if (/^\s*SELECT/iu.test(statement)) {
          const rows = real.prepare(statement).all() as Record<string, unknown>[];
          if (!interleaved) {
            interleaved = true;
            real.exec(`UPDATE apps SET auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL WHERE id = '${APP}'`);
          }
          return rows;
        }
        return real.prepare(statement).all() as Record<string, unknown>[];
      },
      scopeClients: async () => null,
      readFile: () => JSON.stringify(policy()),
      baseDir: WORK,
      now: () => h.now,
      log: (line) => h.out.push(line),
    };
    const args = parseCli(['--auto-approve', 'p.json'], { strings: ['auto-approve'] });
    await expect(appSettings(sandbox, APP, args, 'local D1 test', deps)).rejects.toThrow(SETTINGS_CHANGED);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null });
    // Every column is in the guard, so any concurrent change is caught (here: persistence).
    const before = row(h.db);
    real.exec(`UPDATE apps SET persistence = 'none' WHERE id = '${APP}'`);
    const p2 = planSettings(before, { sessionTtlMs: 6 * HOUR }, { now: h.now, delayMs: 0 });
    expect(real.prepare(p2.sql!).all()).toEqual([]);
    expect(row(h.db).session_ttl_ms).toBe(12 * HOUR);
  });

  it('an unchanged row is written, once, and the guard matches NULLs', async () => {
    const before = row(h.db);
    expect(before.auto_approve_policy).toBeNull();
    const plan = planSettings(before, { persistence: 'none' }, { now: NOW, delayMs: 0 });
    expect(h.db.prepare(plan.sql!).all()).toEqual([{ id: APP }]);
    expect(h.db.prepare(plan.sql!).all()).toEqual([]);
  });
});

describe('app:settings --auto-approve path', () => {
  it('a relative path is resolved against the directory the command was run from (INIT_CWD), and logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hana-settings-cwd-'));
    try {
      writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy()));
      expect(invocationDir({ INIT_CWD: dir }, '/elsewhere')).toBe(dir);
      expect(invocationDir({}, '/elsewhere')).toBe('/elsewhere');
      expect(invocationDir({ INIT_CWD: 'relative' }, '/elsewhere')).toBe('/elsewhere');
      expect(resolvePolicyPath('./policy.json', dir)).toBe(join(dir, 'policy.json'));
      expect(resolvePolicyPath('/abs/p.json', dir)).toBe('/abs/p.json');
      const args = parseCli(['--auto-approve', './policy.json'], { strings: ['auto-approve'] });
      const change = parseSettingsArgs(args, readPolicyFile, invocationDir({ INIT_CWD: dir }, '/elsewhere'));
      expect(change.autoApprove).toEqual({ text: JSON.stringify(policy()), file: join(dir, 'policy.json') });
      // Through appSettings, with the real file reader.
      const deps: AppSettingsDeps = {
        d1: (statement) => h.db.prepare(statement).all() as Record<string, unknown>[],
        scopeClients: async () => null,
        readFile: readPolicyFile,
        baseDir: dir,
        now: () => NOW,
        log: (line) => h.out.push(line),
      };
      await appSettings(sandbox, APP, args, 'local D1 test', deps);
      expect(output()).toContain(`from ${join(dir, 'policy.json')}, pending until`);
      expect(row(h.db).auto_approve_pending).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app:settings app selection and on-chain clients', () => {
  it('takes the app positionally or with --app, exactly one of them', () => {
    expect(settingsAppArg([APP], undefined)).toBe(APP);
    expect(settingsAppArg([], KEY)).toBe(KEY);
    expect(() => settingsAppArg([APP], KEY)).toThrow('not both');
    expect(() => settingsAppArg([], undefined)).toThrow('takes one app');
    expect(() => settingsAppArg([APP, 'extra'], undefined)).toThrow('Unexpected argument extra');
  });

  it('maps get_scope to the scope’s clients: null scope, missing or malformed clients, mixed providers', () => {
    expect(scopeClientsFrom(null)).toBeNull();
    expect(scopeClientsFrom(undefined)).toBeNull();
    expect(scopeClientsFrom({})).toEqual([]);
    expect(scopeClientsFrom({ clients: 'nope' })).toEqual([]);
    expect(scopeClientsFrom([['google', WEB]])).toEqual([]);
    const clients = scopeClientsFrom({
      clients: [['google', WEB], ['google'], ['google', WEB, 'x'], ['google', 7], 'google', null, { 0: 'google', 1: IOS }, ['apple', 'a.example'], ['google', IOS]],
    });
    expect(clients).toEqual([
      ['google', WEB],
      ['apple', 'a.example'],
      ['google', IOS],
    ]);
    expect(googleClientIds(clients!)).toEqual([WEB, IOS]);
  });
});

describe('app:settings output and arguments', () => {
  it('with no setting flags, shows the settings as stored and in force (no write)', async () => {
    set({ raw_sign_pending: 'approval', raw_sign_effective_at: NOW + HOUR, auto_approve_pending: '{"v":2}', auto_approve_effective_at: NOW + HOUR });
    const before = row(h.db);
    await h.run([]);
    expect(row(h.db)).toEqual(before);
    expect(output()).toContain(`${APP} "Settings test" (scope ${SCOPE}, local D1 test)`);
    expect(output()).toContain('persistence: session');
    expect(output()).toContain('session TTL: 12h');
    expect(output()).toContain('idle TTL: 2h');
    expect(output()).toContain(`raw signing: off (approval pending until ${new Date(NOW + HOUR).toISOString()})`);
    expect(output()).toContain('auto-approve: off');
    expect(output()).toContain('pending until');
    expect(output()).toContain('INVALID, not served');
    expect(describeSettings(before, NOW + HOUR)).toContain('raw signing: approval');
  });

  it('logs each change with its time and app, never the policy body', async () => {
    h.files.set('p.json', JSON.stringify(policy('Secret-looking label')));
    await h.run(['--persistence', 'none', '--auto-approve', 'p.json']);
    expect(h.out[0]).toBe(`${new Date(NOW).toISOString()} app:settings ${APP} "Settings test" (scope ${SCOPE}, local D1 test)`);
    expect(output()).not.toContain('approve(address,uint256)');
  });

  it('finds the app by id or publishable key, and refuses an unknown one', async () => {
    await h.run([APP, '--persistence', 'none']);
    expect(row(h.db).persistence).toBe('none');
    await expect(h.run(['pk_test_nope', '--persistence', 'none'])).rejects.toThrow('No app pk_test_nope');
  });

  it('parses --auto-approve off without reading a file', () => {
    const args = parseCli(['--auto-approve', 'off'], { strings: ['auto-approve'] });
    expect(parseSettingsArgs(args, () => {
      throw new Error('read');
    })).toEqual({ autoApprove: 'off' });
  });
});

describe('readPolicyFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hana-settings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a policy file, and refuses a missing file, a directory and an oversized file', () => {
    const p = join(dir, 'p.json');
    writeFileSync(p, '{"v":1}');
    expect(readPolicyFile(p)).toBe('{"v":1}');
    expect(() => readPolicyFile(join(dir, 'missing.json'))).toThrow("Can't read --auto-approve");
    mkdirSync(join(dir, 'd'));
    expect(() => readPolicyFile(join(dir, 'd'))).toThrow('is not a file');
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(POLICY_FILE_MAX_BYTES + 1));
    expect(() => readPolicyFile(big)).toThrow(`over ${POLICY_FILE_MAX_BYTES} bytes`);
  });
});
