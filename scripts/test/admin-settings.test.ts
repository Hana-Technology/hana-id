// admin.ts app:settings (docs/batch-b-spec.md "Tests → Scripts", docs/batch-c-spec.md §CLI), against a real SQLite
// database with apps/api's migrations applied (0006 included), so every write also passes (or is refused by) the
// migrations' CHECKs and triggers. Raw signing and new policies are staff proposals, announced here with
// app:changes:announce (on sandbox-dev without its dashboard blocks: an env with no admin Worker).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { policyId } from '@hana-id/core/policy';
import { loadEnv } from '@hana-id/env';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppCmdDeps, appChangesAnnounce } from '../lib/admin-apps.ts';
import { openChangesSql, type ChangeRow, writeCommand } from '../lib/admin-sql.ts';
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
  describeSettings,
  formatDuration,
  IDLE_TTL_MIN_MS,
  parseDuration,
  parseSettingsArgs,
  POLICY_FILE_MAX_BYTES,
  policyInForce,
  MAINNET_DEMO_WARNING,
  planMainnetDemo,
  RAW_SIGN_WARNING,
  rawSignInForce,
  readPolicyFile,
  SESSION_TTL_MAX_MS,
  SESSION_TTL_MIN_MS,
  settingsSql,
  type SettingsRow,
} from '../lib/admin-settings.ts';
import { parseCli } from '../lib/cli.ts';
import { d1Of, newHotDb, seedHotApp, testIds } from './hot-db.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 28, 12);
const APP = 'app_settings1';
const KEY = 'pk_test_settings1abcdefgh';
const SCOPE = 's1';
const LIVE = 'app_settingslive';
const LIVE_KEY = 'pk_live_settingslive1abcd';
const LIVE_SCOPE = 's2';
const WEB = '111-web.apps.googleusercontent.com';
const IOS = '222-ios.apps.googleusercontent.com';
const WORK = '/work/dir';

/** A fresh in-memory database with every apps/api migration, a test app and a live app at the defaults. */
function newDb(): DatabaseSync {
  const db = newHotDb();
  seedHotApp(db, { id: APP, key: KEY, scope: SCOPE });
  seedHotApp(db, { id: LIVE, key: LIVE_KEY, scope: LIVE_SCOPE });
  return db;
}

const row = (db: DatabaseSync, id = APP): SettingsRow => ({ ...(db.prepare(settingsSql(id)).get() as unknown as SettingsRow) });
const changes = (db: DatabaseSync, id = APP): ChangeRow[] => db.prepare(openChangesSql(id)).all() as unknown as ChangeRow[];
const ledger = (db: DatabaseSync, id = APP) => db.prepare('SELECT kind, detail_json, actor_kind, actor_id FROM app_changes WHERE app_id = ? AND kind != ? ORDER BY seq').all(id, 'migration.baseline') as { kind: string; detail_json: string; actor_kind: string; actor_id: string }[];

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
        maxValueWei: '100000',
        maxValueWeiPerDay: '100000',
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

// Without the dashboard blocks (sandbox-dev has them since M4): an env with no admin Worker, so the CLI announces.
const { console: _console, files: _files, admin: _admin, usage: _usage, email: _email, ownerGrantDelayMs: _ownerGrant, ...sandbox } = loadEnv('sandbox-dev');
const DELAY = sandbox.appChangeDelayMs;

interface Harness {
  db: DatabaseSync;
  out: string[];
  files: Map<string, string>;
  chainReads: string[];
  clients: [string, string][] | null;
  now: number;
  apiChecks: number;
  ids: ReturnType<typeof testIds>;
  run: (argv: string[], m?: typeof sandbox) => Promise<void>;
  /** app:changes:announce <id> at the harness's time. */
  announce: (changeId: string) => Promise<void>;
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
    apiChecks: 0,
    ids: testIds(),
    run: async (argv, m = sandbox) => {
      const args = parseCli(argv, {
        strings: ['app', 'persistence', 'session-ttl', 'idle-ttl', 'raw-sign', 'google-web-client', 'auto-approve', 'mainnet-demo'],
        booleans: ['remote'],
      });
      const deps: AppSettingsDeps = {
        d1: d1Of(db),
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
        actor: { id: 'cli:tester' },
        newRequestId: state.ids.request,
        requireC3Api: async () => {
          state.apiChecks++;
        },
        newChangeId: state.ids.change,
      };
      await appSettings(m, args.positionals[0] ?? KEY, args, 'local D1 test', deps);
    },
    announce: (changeId) => {
      const deps: AppCmdDeps = { d1: d1Of(db), scopeOnChain: async () => true, now: () => state.now, log: (l) => state.out.push(l), actor: { id: 'cli:tester' }, ids: state.ids, requireC3Api: async () => undefined };
      return appChangesAnnounce(sandbox, changeId, 'local D1 test', deps);
    },
  };
  h = state;
});

const output = () => h.out.join('\n');
const set = (fields: Record<string, string | number | null>, id = APP) =>
  h.db.prepare(`UPDATE apps SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fields), id);

describe('durations', () => {
  it('parses h/m/s combinations and ms, and refuses bare numbers and junk', async () => {
    expect(parseDuration('12h', 'x')).toBe(12 * HOUR);
    expect(parseDuration('23h50m', 'x')).toBe(SESSION_TTL_MAX_MS);
    expect(parseDuration('15m', 'x')).toBe(IDLE_TTL_MIN_MS);
    expect(parseDuration('59m59s', 'x')).toBe(HOUR - 1000);
    expect(parseDuration('3600000ms', 'x')).toBe(HOUR);
    for (const bad of ['', '3600000', '1.5h', '-1h', '1d', '1h ', 'h', '1m2h']) expect(() => parseDuration(bad, 'session-ttl')).toThrow('--session-ttl must be a duration');
  });

  it('formats back exactly', async () => {
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

  it('sets --persistence (immediate, version bumped, one app_changes row), and refuses other values', async () => {
    await h.run(['--persistence', 'none']);
    expect(row(h.db)).toMatchObject({ persistence: 'none', settings_version: 1 });
    expect(output()).toContain('persistence: session → none (immediate)');
    expect(ledger(h.db)).toEqual([{ kind: 'settings.changed', detail_json: '{"persistence":"none"}', actor_kind: 'hana', actor_id: 'cli:tester' }]);
    await h.run(['--persistence', 'session']);
    expect(row(h.db)).toMatchObject({ persistence: 'session', settings_version: 2 });
    await expect(h.run(['--persistence', 'local'])).rejects.toThrow("--persistence must be 'session' or 'none'");
  });

  it('refuses the whole call when one value is bad (nothing is written)', async () => {
    await expect(h.run(['--persistence', 'none', '--session-ttl', '30m'])).rejects.toThrow('--session-ttl');
    expect(row(h.db)).toMatchObject({ persistence: 'session', settings_version: 0 });
    expect(ledger(h.db)).toEqual([]);
  });
});

describe('app:settings --mainnet-demo (D428)', () => {
  const demo = (id = APP) => Number((h.db.prepare('SELECT mainnet_demo AS m FROM apps WHERE id = ?').get(id) as { m: number }).m);

  it('on and off for a test app in a dev testnet env: immediate, a version bump and an app_changes row each, with the warning', async () => {
    await h.run(['--mainnet-demo', 'on']);
    expect(demo()).toBe(1);
    expect(h.out).toContain(MAINNET_DEMO_WARNING);
    expect(output()).toContain('mainnet demo: off → on (immediate');
    expect(row(h.db).settings_version).toBe(1);
    await h.run(['--mainnet-demo', 'on']);
    expect(output()).toContain('mainnet demo: already on');
    await h.run(['--mainnet-demo', 'off']);
    expect(demo()).toBe(0);
    expect(ledger(h.db).map((r) => r.kind)).toEqual(['mainnet_demo.on', 'mainnet_demo.off']);
    expect(ledger(h.db)[0]).toMatchObject({ actor_kind: 'hana', actor_id: 'cli:tester' });
    // Shown with the other settings.
    h.out.length = 0;
    await h.run([]);
    expect(output()).toContain('mainnet demo: off');
  });

  it('is refused for a live app, in a production env, on another network, with other flags, or with a bad value', async () => {
    await expect(h.run([LIVE, '--mainnet-demo', 'on'])).rejects.toThrow('for test apps (pk_test_) only');
    await expect(h.run(['--mainnet-demo', 'on'], { ...sandbox, name: 'testnet' })).rejects.toThrow('exists only in a dev env (local*, sandbox*) on testnet');
    await expect(h.run(['--mainnet-demo', 'on'], { ...sandbox, network: 'mainnet' } as unknown as typeof sandbox)).rejects.toThrow('exists only in a dev env');
    await expect(h.run(['--mainnet-demo', 'on', '--persistence', 'none'])).rejects.toThrow('--mainnet-demo goes alone');
    await expect(h.run(['--mainnet-demo', 'yes'])).rejects.toThrow("--mainnet-demo must be 'on' or 'off'");
    expect(demo()).toBe(0);
    expect(demo(LIVE)).toBe(0);
    expect(ledger(h.db)).toEqual([]);
  });

  it('writes only over the row it read: a concurrent change makes it write nothing', () => {
    const r = row(h.db);
    const plan = planMainnetDemo(sandbox, r, false, true, { now: NOW, requestId: 'cli_race' });
    set({ settings_version: r.settings_version + 1 });
    const result = d1Of(h.db)(writeCommand(plan.write!));
    expect(Number(result[result.length - 1]?.committed ?? 0)).toBe(0);
    expect(demo()).toBe(0);
  });
});

describe('app:settings --raw-sign', () => {
  it('approval is refused for a test app (D39: test apps never sign raw)', async () => {
    await expect(h.run(['--raw-sign', 'approval'])).rejects.toThrow('refused for a test app');
    expect(changes(h.db)).toEqual([]);
  });

  it('approval on a live app is a staff proposal: nothing in apps until it is announced, then pending for appChangeDelayMs', async () => {
    await h.run([LIVE, '--raw-sign', 'approval']);
    expect(h.out).toContain(RAW_SIGN_WARNING);
    expect(RAW_SIGN_WARNING).toContain('can authorize any transaction on that chain');
    expect(row(h.db, LIVE)).toMatchObject({ raw_sign: 'off', raw_sign_pending: null, raw_sign_effective_at: null, settings_version: 1 });
    expect(changes(h.db, LIVE)).toMatchObject([{ id: 'gc_1', kind: 'raw_sign_on', status: 'pending', proposed_by_kind: 'hana', proposed_by: 'cli:tester', notified_at: null, active_from: null }]);
    expect(output()).toContain('proposed as gc_1');
    expect(output()).toContain('app:changes:announce gc_1 (nobody is emailed)');
    expect(ledger(h.db, LIVE).map((r) => r.kind)).toEqual(['raw_sign.proposed']);
    h.now = NOW + 1000;
    await h.announce('gc_1');
    const r = row(h.db, LIVE);
    expect(r).toMatchObject({ raw_sign: 'off', raw_sign_pending: 'approval', raw_sign_effective_at: NOW + 1000 + DELAY, settings_version: 1 });
    expect(rawSignInForce(r, NOW + 1000 + DELAY - 1)).toBe('off');
    expect(rawSignInForce(r, NOW + 1000 + DELAY)).toBe('approval');
  });

  it('re-running approval does not restart the delay; approval in force is a no-op', async () => {
    await h.run([LIVE, '--raw-sign', 'approval']);
    await h.run([LIVE, '--raw-sign', 'approval']);
    expect(output()).toContain('approval already proposed as gc_1, waiting for its announcement');
    await h.announce('gc_1');
    h.now = NOW + 1000;
    await h.run([LIVE, '--raw-sign', 'approval']);
    expect(row(h.db, LIVE).raw_sign_effective_at).toBe(NOW + DELAY);
    expect(output()).toContain('approval already pending');
    h.now = NOW + DELAY;
    await h.run([LIVE, '--raw-sign', 'approval']);
    expect(output()).toContain('raw signing: already approval');
    expect(output()).toMatch(/no change/u);
    expect(changes(h.db, LIVE)).toHaveLength(1);
  });

  it('off is immediate: drops a pending approval and cancels its proposal, announced or not', async () => {
    await h.run([LIVE, '--raw-sign', 'approval']);
    await h.run([LIVE, '--raw-sign', 'off']);
    expect(h.db.prepare("SELECT status, cancelled_by FROM guarded_changes WHERE id = 'gc_1'").get()).toEqual({ status: 'cancelled', cancelled_by: 'cli:tester' });
    await h.run([LIVE, '--raw-sign', 'approval']);
    await h.announce('gc_2');
    await h.run([LIVE, '--raw-sign', 'off']);
    expect(row(h.db, LIVE)).toMatchObject({ raw_sign: 'off', raw_sign_pending: null, raw_sign_effective_at: null });
    expect(h.db.prepare("SELECT status FROM guarded_changes WHERE id = 'gc_2'").get()).toEqual({ status: 'cancelled' });
    // In force (matured, not yet recorded by the API cron): it ends rather than being cancelled.
    await h.run([LIVE, '--raw-sign', 'approval']);
    await h.announce('gc_3');
    h.now = NOW + DELAY;
    await h.run([LIVE, '--raw-sign', 'off']);
    expect(h.db.prepare("SELECT status, ended_at FROM guarded_changes WHERE id = 'gc_3'").get()).toEqual({ status: 'ended', ended_at: NOW + DELAY });
    set({ raw_sign: 'approval' }, LIVE);
    await h.run([LIVE, '--raw-sign', 'off']);
    expect(row(h.db, LIVE).raw_sign).toBe('off');
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

  it('validates the policy and proposes it, normalized; the announcement makes it pending for appChangeDelayMs', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    const id = policyId(policy());
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
    const [c] = changes(h.db);
    // Stored as the validator's canonical form (EIP-55 address), so its id is the one users consent to.
    expect(c).toMatchObject({ id: 'gc_1', kind: 'policy_set', policy_id: id, status: 'pending' });
    expect(c!.policy_json).toContain('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(policyId(JSON.parse(c!.policy_json!))).toBe(id);
    expect(output()).toContain(`policy ${id} ("Approvals") from ${WORK}/p.json, proposed as gc_1`);
    await h.announce('gc_1');
    const r = row(h.db);
    expect(r).toMatchObject({ auto_approve_policy: null, auto_approve_pending: c!.policy_json, auto_approve_effective_at: NOW + DELAY });
    // Nothing in force until the delay has passed.
    expect(policyInForce(r, NOW + DELAY - 1)).toBeNull();
    expect(policyInForce(r, NOW + DELAY)).toBe(r.auto_approve_pending);
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
    expect(changes(h.db)).toEqual([]);
  });

  it('refuses maxConsentMs over the app’s session TTL (the one in force after the call)', async () => {
    set({ session_ttl_ms: 2 * HOUR, idle_ttl_ms: HOUR });
    await expect(h.run(['--auto-approve', file('long.json', policy())])).rejects.toThrow('policy.maxConsentMs: must be between');
    await h.run(['--auto-approve', file('long.json', policy()), '--session-ttl', '12h']);
    expect(row(h.db).session_ttl_ms).toBe(12 * HOUR);
    expect(changes(h.db)).toMatchObject([{ kind: 'policy_set', status: 'pending' }]);
    // Both parts in one write: one app_changes row listing them.
    expect(ledger(h.db).map((r) => r.kind)).toEqual(['settings.changed']);
    expect(JSON.parse(ledger(h.db)[0]!.detail_json).parts.map((p: { kind: string }) => p.kind)).toEqual(['settings.changed', 'policy.proposed']);
  });

  it('refuses lowering --session-ttl under a proposed or stored policy’s maxConsentMs, unless the policy goes too', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await expect(h.run(['--session-ttl', '6h'])).rejects.toThrow('maxConsentMs over the new session TTL 6h');
    await h.announce('gc_1');
    await expect(h.run(['--session-ttl', '6h'])).rejects.toThrow('maxConsentMs over the new session TTL 6h');
    await h.run(['--session-ttl', '6h', '--auto-approve', 'off']);
    expect(row(h.db)).toMatchObject({ session_ttl_ms: 6 * HOUR, auto_approve_pending: null });
  });

  it('re-setting the proposed policy keeps its clock; re-setting the policy in force drops a pending one', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.run(['--auto-approve', 'p.json']);
    expect(output()).toContain('already proposed as gc_1');
    await h.announce('gc_1');
    h.now = NOW + 1000;
    await h.run(['--auto-approve', 'p.json']);
    expect(row(h.db).auto_approve_effective_at).toBe(NOW + DELAY);
    expect(output()).toContain('already pending as gc_1');
    // Mature it, then propose another policy, announce it, and change our mind.
    h.now = NOW + DELAY;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.announce('gc_2');
    await h.run(['--auto-approve', 'p.json']);
    const r = row(h.db);
    expect(policyId(JSON.parse(r.auto_approve_policy!))).toBe(policyId(policy()));
    expect(r).toMatchObject({ auto_approve_pending: null, auto_approve_effective_at: null });
    expect(output()).toContain('The pending policy is dropped.');
    // The dropped one is cancelled; the one in force (matured, not yet recorded by the cron) is untouched.
    expect(h.db.prepare("SELECT id, status FROM guarded_changes WHERE kind = 'policy_set' ORDER BY id").all()).toEqual([
      { id: 'gc_1', status: 'pending' },
      { id: 'gc_2', status: 'cancelled' },
    ]);
  });

  it('H1: re-setting the policy in force (matured, not yet promoted by the cron) over a pending proposal keeps it in force', async () => {
    // A stored and in force; B proposed, announced and matured, but the API cron hasn't promoted it (still pending in
    // the columns); C proposed, not announced. Re-setting B must keep B, never bring A back.
    set({ auto_approve_policy: JSON.stringify(policy('A')) });
    await h.run(['--auto-approve', file('b.json', policy('B'))]);
    await h.announce('gc_1');
    h.now = NOW + DELAY;
    await h.run(['--auto-approve', file('c.json', policy('C'))]);
    expect(policyId(JSON.parse(policyInForce(row(h.db), h.now)!))).toBe(policyId(policy('B')));
    await h.run(['--auto-approve', 'b.json']);
    const r = row(h.db);
    expect(r).toMatchObject({ auto_approve_pending: null, auto_approve_effective_at: null });
    expect(policyId(JSON.parse(r.auto_approve_policy!))).toBe(policyId(policy('B')));
    expect(policyId(JSON.parse(policyInForce(r, h.now)!))).toBe(policyId(policy('B')));
    expect(h.db.prepare("SELECT id, status FROM guarded_changes WHERE kind = 'policy_set' ORDER BY id").all()).toEqual([
      { id: 'gc_1', status: 'pending' },
      { id: 'gc_2', status: 'cancelled' },
    ]);
  });

  it('the announcement keeps a matured pending raw-signing value in force (the raw analog of H1)', async () => {
    // raw_sign approval matured in the pending columns (not promoted), and an unannounced raw_sign_on proposal.
    set({ raw_sign_pending: 'approval', raw_sign_effective_at: NOW - 1 }, LIVE);
    h.db.exec(`INSERT INTO guarded_changes (id, app_id, kind, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_raw', '${LIVE}', 'raw_sign_on', 'pending', 'hana', 't', 1, 'r_raw')`);
    await h.announce('gc_raw');
    const r = row(h.db, LIVE);
    expect(r).toMatchObject({ raw_sign: 'approval', raw_sign_pending: 'approval', raw_sign_effective_at: NOW + DELAY });
    expect(rawSignInForce(r, NOW)).toBe('approval');
  });

  it('a proposal asks that the deployed API reads the C3 schema; an immediate change doesn’t', async () => {
    await h.run(['--persistence', 'none']);
    await h.run(['--auto-approve', 'off']);
    expect(h.apiChecks).toBe(0);
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.run([LIVE, '--raw-sign', 'approval']);
    expect(h.apiChecks).toBe(2);
  });

  it('at most one pending policy per app: another proposal is refused until the first is in force or cancelled', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await expect(h.run(['--auto-approve', file('p2.json', policy('Wider'))])).rejects.toThrow('Another policy is pending (gc_1)');
    await h.announce('gc_1');
    await expect(h.run(['--auto-approve', 'p2.json'])).rejects.toThrow('Another policy is pending (gc_1)');
    h.now = NOW + DELAY;
    await h.run(['--auto-approve', 'p2.json']);
    expect(output()).toContain('proposed as gc_2');
  });

  it('a new policy after a matured one keeps the matured one in force until the new one’s time', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.announce('gc_1');
    h.now = NOW + DELAY + 5;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.announce('gc_2');
    const r = row(h.db);
    expect(policyId(JSON.parse(r.auto_approve_policy!))).toBe(policyId(policy()));
    expect(policyId(JSON.parse(r.auto_approve_pending!))).toBe(policyId(policy('Wider')));
    expect(r.auto_approve_effective_at).toBe(h.now + DELAY);
    expect(policyInForce(r, h.now)).toBe(r.auto_approve_policy);
  });

  it('off is immediate: removes the policy in force and any pending one, and closes their changes', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.announce('gc_1');
    h.now = NOW + DELAY;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.announce('gc_2');
    await h.run(['--auto-approve', 'off']);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
    expect(output()).toContain('policy removed (immediate)');
    expect(h.db.prepare("SELECT id, status FROM guarded_changes WHERE kind = 'policy_set' ORDER BY id").all()).toEqual([
      { id: 'gc_1', status: 'ended' },
      { id: 'gc_2', status: 'cancelled' },
    ]);
    await h.run(['--auto-approve', 'off']);
    expect(output()).toContain('auto-approve: already off');
  });
});

describe('app:settings writes only over the row it read', () => {
  const file = (name: string, value: unknown) => {
    h.files.set(name, JSON.stringify(value));
    return name;
  };
  const exec = (write: { statements: string[]; requestId: string } | null) => {
    const rows = d1Of(h.db)(`${[...write!.statements, `SELECT COUNT(*) AS committed FROM app_changes WHERE request_id = '${write!.requestId}'`].join(';\n')};`);
    return Number(rows[0]!.committed);
  };

  it('a stale plan (P in force, P2 pending) run after another operator’s --auto-approve off changes nothing', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.announce('gc_1');
    h.now = NOW + DELAY;
    await h.run(['--auto-approve', file('p2.json', policy('Wider'))]);
    await h.announce('gc_2');
    // This CLI reads the row: P in force, P2 pending. It plans "re-set P" (drop the pending P2).
    const stale = row(h.db);
    const plan = planSettings(stale, { autoApprove: { text: JSON.stringify(policy()), file: 'p.json' } }, { now: h.now, openChanges: changes(h.db), requestId: 'stale' });
    expect(plan.lines.join('\n')).toContain('The pending policy is dropped.');
    expect(plan.write!.statements.join('\n')).not.toMatch(/auto_approve_policy = '/u);
    // Meanwhile another operator removes every policy.
    await h.run(['--auto-approve', 'off']);
    // The stale write commits nothing: the removed policy is not put back in force.
    expect(exec(plan.write)).toBe(0);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null, auto_approve_effective_at: null });
  });

  it('appSettings refuses (and writes nothing) when the row changed between its read and its write', async () => {
    await h.run(['--auto-approve', file('p.json', policy())]);
    await h.announce('gc_1');
    h.now = NOW + DELAY;
    // A d1 that runs another operator's change right after this CLI's read.
    const real = d1Of(h.db);
    let interleaved = false;
    const deps: AppSettingsDeps = {
      d1: (statement) => {
        const rows = real(statement);
        if (/^\s*SELECT/iu.test(statement) && !interleaved) {
          interleaved = true;
          h.db.exec(`UPDATE apps SET auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL WHERE id = '${APP}'`);
        }
        return rows;
      },
      scopeClients: async () => null,
      readFile: () => JSON.stringify(policy('Wider')),
      baseDir: WORK,
      now: () => h.now,
      log: (line) => h.out.push(line),
      newRequestId: () => 'interleaved',
      newChangeId: () => 'gc_x',
    };
    const args = parseCli(['--auto-approve', 'p2.json'], { strings: ['auto-approve'] });
    await expect(appSettings(sandbox, APP, args, 'local D1 test', deps)).rejects.toThrow(SETTINGS_CHANGED);
    expect(row(h.db)).toMatchObject({ auto_approve_policy: null, auto_approve_pending: null });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM guarded_changes WHERE id = 'gc_x'").get()).toEqual({ n: 0 });
    // Every column is in the guard, so any concurrent change is caught (here: persistence).
    const before = row(h.db);
    h.db.exec(`UPDATE apps SET persistence = 'none' WHERE id = '${APP}'`);
    const p2 = planSettings(before, { sessionTtlMs: 6 * HOUR }, { now: h.now, requestId: 'p2' });
    expect(exec(p2.write)).toBe(0);
    expect(row(h.db).session_ttl_ms).toBe(12 * HOUR);
  });

  it('a version moved by another writer, even to the same number, commits nothing', async () => {
    const before = row(h.db);
    const mine = planSettings(before, { persistence: 'none' }, { now: NOW, requestId: 'mine' });
    const theirs = planSettings(before, { idleTtlMs: HOUR }, { now: NOW, requestId: 'theirs' });
    expect(exec(theirs.write)).toBe(1);
    expect(exec(mine.write)).toBe(0);
    expect(row(h.db)).toMatchObject({ persistence: 'session', idle_ttl_ms: HOUR, settings_version: 1 });
  });

  it('an unchanged row is written, once, and the guard matches NULLs', async () => {
    const before = row(h.db);
    expect(before.auto_approve_policy).toBeNull();
    const plan = planSettings(before, { persistence: 'none' }, { now: NOW, requestId: 'once' });
    expect(exec(plan.write)).toBe(1);
    expect(exec(plan.write)).toBe(1);
    expect(row(h.db).settings_version).toBe(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM app_changes WHERE request_id = 'once'").get()).toEqual({ n: 1 });
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
        d1: d1Of(h.db),
        scopeClients: async () => null,
        readFile: readPolicyFile,
        baseDir: dir,
        now: () => NOW,
        log: (line) => h.out.push(line),
      };
      await appSettings(sandbox, APP, args, 'local D1 test', deps);
      expect(output()).toContain(`from ${join(dir, 'policy.json')}, proposed as`);
      expect(changes(h.db)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app:settings app selection and on-chain clients', () => {
  it('takes the app positionally or with --app, exactly one of them', async () => {
    expect(settingsAppArg([APP], undefined)).toBe(APP);
    expect(settingsAppArg([], KEY)).toBe(KEY);
    expect(() => settingsAppArg([APP], KEY)).toThrow('not both');
    expect(() => settingsAppArg([], undefined)).toThrow('takes one app');
    expect(() => settingsAppArg([APP, 'extra'], undefined)).toThrow('Unexpected argument extra');
  });

  it('maps get_scope to the scope’s clients: null scope, missing or malformed clients, mixed providers', async () => {
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
  it('with no setting flags, shows the settings as stored and in force, and the proposals (no write)', async () => {
    set({ raw_sign_pending: 'approval', raw_sign_effective_at: NOW + HOUR, auto_approve_pending: '{"v":2}', auto_approve_effective_at: NOW + HOUR });
    h.files.set('p.json', JSON.stringify(policy()));
    await h.run(['--session-ttl', '12h']);
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
    const proposed: ChangeRow = { id: 'gc_9', app_id: APP, kind: 'policy_set', origin: null, policy_json: '{}', policy_id: 'abc', status: 'pending', proposed_by_kind: 'hana', proposed_by: 'cli', proposed_at: NOW, waiver: null, notified_at: null, active_from: null };
    expect(describeSettings(before, NOW, [proposed])).toContain('proposed: gc_9 policy abc, not announced yet');
  });

  it('logs each change with its time and app, never the policy body', async () => {
    h.files.set('p.json', JSON.stringify(policy('Secret-looking label')));
    await h.run(['--persistence', 'none', '--auto-approve', 'p.json']);
    expect(h.out[0]).toBe(`${new Date(NOW).toISOString()} app:settings ${APP} "Settings test" (scope ${SCOPE}, local D1 test)`);
    expect(output()).not.toContain('approve(address,uint256)');
  });

  it('finds the app by id or by any of its publishable keys, and refuses an unknown or deleted one', async () => {
    await h.run([APP, '--persistence', 'none']);
    expect(row(h.db).persistence).toBe('none');
    await h.run([KEY, '--persistence', 'session']);
    expect(row(h.db).persistence).toBe('session');
    await expect(h.run(['pk_test_nope', '--persistence', 'none'])).rejects.toThrow('No app pk_test_nope');
    set({ deleted_at: NOW });
    await expect(h.run([APP, '--persistence', 'none'])).rejects.toThrow('is deleted');
  });

  it('parses --auto-approve off without reading a file', async () => {
    const args = parseCli(['--auto-approve', 'off'], { strings: ['auto-approve'] });
    expect(parseSettingsArgs(args, () => {
      throw new Error('read');
    })).toEqual({ autoApprove: 'off' });
  });
});

describe('readPolicyFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hana-settings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a policy file, and refuses a missing file, a directory and an oversized file', async () => {
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
