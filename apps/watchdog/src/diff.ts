// Step 6: get_config / get_governance against the last run. Alert only, never an action (D82, D84, D85).
//   critical: an upgrade proposal (and its cancel or execution), owner or pending owner, withdrawal, watchdog,
//             updater-key, delay or console-audience change, pause and unpause (also one between two runs:
//             unpaused_at_ms), the session floor; also mpc, ckd_domain_id and state_version, which only an upgrade
//             can change; and the owner account's code or policy (the council DAO's members and vote rules, D81).
//             Also the owner's immediate issuer actions, which leave no pending state: `set_issuer` (the watched
//             issuer created, dropped or its iss values changed: field `issuer`) and `remove_issuer_key` (an active
//             kid gone without a pending removal of it leaving the queue: field `issuer_keys`); the same for the email
//             issuer (`email_issuer`, `email_issuer_keys`), and its signer policy (`email_signer_policy`: marked
//             self-issued, or signers or required changed by an upgrade's migrate). `unrecorded_wallets` (contract v3,
//             D135): the owner's accept_unrecorded_wallets, or an upgrade that set it.
//   warning:  shared clients, sponsors, public registration.
//   matured:  a scheduled delay decrease or audience addition coming into force as scheduled (info).
import type { ChainSnapshot, ConfigView, GovernanceView, IssuerView, KeyChange, OwnerAccount, PendingClient, SelfIssuedView } from './chain.ts';
import { EMAIL_PROVIDER } from './pins.ts';

export interface StoredSnapshot {
  at: number;
  config: ConfigView;
  governance: GovernanceView;
  keyChanges: KeyChange[];
  /** Absent in a snapshot stored before the watchdog read the owner account: that run's owner becomes the baseline. */
  owner?: OwnerAccount | null;
  /** The watched issuer (Google) as `get_issuer` showed it. Absent in older snapshots: that run's issuer is the baseline. */
  issuer?: IssuerView | null;
  /** The email issuer and its signer policy. Absent in snapshots stored before the email checks: that run's is the baseline. */
  email?: { issuer: IssuerView | null; selfIssued: SelfIssuedView | null };
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ChainDiff {
  critical: FieldChange[];
  warning: FieldChange[];
  matured: FieldChange[];
}

const CRITICAL_CONFIG = [
  'owner',
  'mpc',
  'ckd_domain_id',
  'paused',
  'console_audiences',
  'pending_console_audiences',
  'change_delay_ms',
  'pending_change_delay',
  'issuer_key_delay_ms',
  'pending_issuer_key_delay',
  'governance_delay_ms',
  'pending_governance_delay',
  'unpaused_at_ms',
  'sessions_valid_from_ms',
  'unrecorded_wallets',
] as const;
/** The owner account's code and DAO policy (D81). */
const CRITICAL_OWNER = [
  ['owner_code_hash', (o: OwnerAccount | null) => o?.code_hash ?? null],
  ['owner_policy', (o: OwnerAccount | null) => o?.policy ?? null],
] as const;
const WARNING_CONFIG = ['sponsors', 'shared_clients', 'pending_shared_clients', 'public_registration'] as const;
const CRITICAL_GOVERNANCE = ['state_version', 'watchdogs', 'keys_slow_until_ms', 'updater_keys', 'updater_methods', 'pending_upgrade', 'pending_owner', 'pending_withdrawal'] as const;

/** Delay value / pending decrease pairs. */
const DELAYS = [
  ['change_delay_ms', 'pending_change_delay'],
  ['issuer_key_delay_ms', 'pending_issuer_key_delay'],
  ['governance_delay_ms', 'pending_governance_delay'],
] as const;
/** In-force list / pending additions pairs. */
const LISTS = [
  ['console_audiences', 'pending_console_audiences'],
  ['shared_clients', 'pending_shared_clients'],
] as const;

/** JSON with sorted object keys, so equal values compare equal. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const sortedSet = (pairs: unknown[]) => stable([...new Set(pairs.map(stable))].sort());

/** What a first run (no previous snapshot) alerts on: anything already pending, or a paused contract. */
function emptyBaseline(cur: ChainSnapshot): StoredSnapshot {
  return {
    at: 0,
    config: { ...cur.config, paused: false, pending_change_delay: null, pending_issuer_key_delay: null, pending_governance_delay: null, pending_console_audiences: [] },
    governance: { ...cur.governance, pending_upgrade: null, pending_owner: null, pending_withdrawal: null },
    keyChanges: [],
    owner: cur.owner,
    issuer: cur.issuer,
    email: { issuer: cur.email.issuer, selfIssued: cur.email.selfIssued },
  };
}

/**
 * Issuer changes the owner makes at once, without a pending state the watchdog would otherwise see: `set_issuer`
 * (provider and iss values) and `remove_issuer_key` (active kids that disappeared although no pending removal of them
 * left the queue since the last run; a removal that executed or was confirmed is reported by the queue check).
 */
function issuerChanges(field: string, provider: string, before: IssuerView | null, after: IssuerView | null, prev: StoredSnapshot, cur: ChainSnapshot): FieldChange[] {
  const out: FieldChange[] = [];
  const shape = (i: IssuerView | null | undefined) => (i ? { provider: i.provider, iss_values: i.iss_values } : null);
  if (!same(shape(before), shape(after))) out.push({ field, before: shape(before), after: shape(after) });
  const now = new Set(after?.kids ?? []);
  const stillQueued = new Set(cur.keyChanges.map((c) => c.id));
  const explained = new Set(prev.keyChanges.filter((c) => c.op === 'Remove' && c.provider === provider && !stillQueued.has(c.id)).map((c) => c.kid));
  const removed = (before?.kids ?? []).filter((k) => !now.has(k) && !explained.has(k));
  if (after && removed.length) out.push({ field: `${field}_keys`, before: before?.kids ?? [], after: after.kids });
  return out;
}

/** The signer policy without its kids (they change as keys execute, which the queue check reports). */
const policyShape = (si: SelfIssuedView | null | undefined) => (si ? { signers: si.signers.map((s) => s.id), required: si.required } : null);

export function diffChain(prevIn: StoredSnapshot | null, cur: ChainSnapshot, now: number, self: { paused: boolean; deletedUpdaterKeys: string[] }): ChainDiff {
  const prev = prevIn ?? emptyBaseline(cur);
  const out: ChainDiff = { critical: [], warning: [], matured: [] };
  const handled = new Set<string>();
  const pc = prev.config as unknown as Record<string, unknown>;
  const cc = cur.config as unknown as Record<string, unknown>;

  // Scheduled changes coming into force as scheduled are info, not alarms.
  for (const [value, pending] of DELAYS) {
    const p = prev.config[pending];
    if (p && p.effective_at_ms <= now && cur.config[value] === p.change_delay_ms && cur.config[pending] === null && prev.config[value] !== cur.config[value]) {
      out.matured.push({ field: value, before: prev.config[value], after: cur.config[value] });
      handled.add(value).add(pending);
    }
  }
  for (const [list, pending] of LISTS) {
    const before = prev.config[list];
    const pend: PendingClient[] = prev.config[pending];
    const matured = pend.filter((p) => p.effective_at_ms <= now);
    if (matured.length === 0) continue;
    const expectedList = sortedSet([...before, ...matured.map((p) => [p.provider, p.aud])]);
    const expectedPending = sortedSet(pend.filter((p) => p.effective_at_ms > now));
    if (sortedSet(cur.config[list]) === expectedList && sortedSet(cur.config[pending]) === expectedPending) {
      out.matured.push({ field: list, before, after: cur.config[list] });
      handled.add(list).add(pending);
    }
  }

  // The watchdog's own pause and updater-key deletions were alerted when it made them.
  if (self.paused && prev.config.paused === false && cur.config.paused === true) handled.add('paused');
  const expectedKeys = prev.governance.updater_keys.filter((k) => !self.deletedUpdaterKeys.includes(k));
  if (self.deletedUpdaterKeys.length && same([...expectedKeys].sort(), [...cur.governance.updater_keys].sort())) handled.add('updater_keys');

  for (const f of CRITICAL_CONFIG) if (!handled.has(f) && !same(pc[f], cc[f])) out.critical.push({ field: f, before: pc[f], after: cc[f] });
  const pg = prev.governance as unknown as Record<string, unknown>;
  const cg = cur.governance as unknown as Record<string, unknown>;
  for (const f of CRITICAL_GOVERNANCE) if (!handled.has(f) && !same(pg[f], cg[f])) out.critical.push({ field: f, before: pg[f], after: cg[f] });
  // A ChangePolicy, AddMember or RemoveMember on the council DAO (or new DAO code) changes who acts as the owner.
  if (prev.owner !== undefined) {
    for (const [field, pick] of CRITICAL_OWNER) {
      const before = pick(prev.owner);
      const after = pick(cur.owner);
      if (!same(before, after)) out.critical.push({ field, before, after });
    }
  }
  if (prev.issuer !== undefined) out.critical.push(...issuerChanges('issuer', prev.issuer?.provider ?? cur.issuer?.provider ?? 'google', prev.issuer, cur.issuer, prev, cur));
  if (prev.email !== undefined) {
    out.critical.push(...issuerChanges('email_issuer', EMAIL_PROVIDER, prev.email.issuer, cur.email.issuer, prev, cur));
    const before = policyShape(prev.email.selfIssued);
    const after = policyShape(cur.email.selfIssued);
    if (!same(before, after)) out.critical.push({ field: 'email_signer_policy', before, after });
  }
  for (const f of WARNING_CONFIG) if (!handled.has(f) && !same(pc[f], cc[f])) out.warning.push({ field: f, before: pc[f], after: cc[f] });
  return out;
}
