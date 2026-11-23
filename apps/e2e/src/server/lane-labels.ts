// Partner labels (D894) in an admin lane (admin-lane-worker.ts): a partner org of the lane's own whose on-chain owner
// proposes request labels, so the staff portal's feed, its Block and Allow and the switches have something real to act
// on, and a test can follow a version from its proposal to `GET /v1/app`. Everything goes through apps/api's own code:
//
//   PROPOSE   ConsoleRpc.proposeLabels, exactly as the partner console calls it, with a console step-up the API
//             verifies itself (changes/step-up.ts): an RS256 ID token for the label-change layout over this exact
//             change (console-core `labelChangeDigest`), signed by a Google key of the lane's own (google-backend.ts,
//             whose JWKS this thread's `fetch` answers), for a console audience the lane's chain lists in force
//             (`get_config.console_audiences`), from a `sub` the chain lists as an `Owner::Oidc` of the scope. The
//             token is the API's only proof: a wrong nonce, sub or audience is refused as it is on testnet. It is never
//             logged, stored or answered.
//   ANNOUNCE  what the admin Worker's notice step does once every email was accepted (apps/admin src/notices.ts):
//             AdminRpc.labelNotices, then AdminRpc.ackLabelNotice as the system actor with sha256 of the cancel link's
//             token (HMAC of the lane's CANCEL_LINK_KEY, console-core `linkToken`), which starts the 24 h. The lane has
//             no EMAIL_API_KEY, so no email is sent: the answer names who it would have gone to.
//   CRON      the API's hourly job's share for labels: labelsMaintenance and detectLabelDrift at the lane's clock.
//   APP       `GET /v1/app` through apps/api's Worker as the vault reads it (Origin = VAULT_ORIGIN, the app's key and
//             parent origin): what a user's window would get.
//   STAFF     AdminRpc.labelStaffAct / labelControl as the stack's staff member (no audit row: the admin Worker writes
//             that before its own call; the portal's buttons go through it). For tests and the hand test's setup.
//
// Each reset makes a new org (`org_e2elabels…`, with a security contact), scope (`stafflabelsN`) and app, and first
// ends the last one's through the product: its owner removes its entries (the same step-up, `labels_remove`) and the
// switches it set are turned back. So a scenario starts clean and the feed's waiting list is the scenario's own.
// Partner labels are on (PARTNER_LABELS = "on") in the lanes' API env (the local e2e stack's staff portal) and in the main stack's API (D896: /__e2e/labels).
import { createHash } from 'node:crypto';
import { base58 } from '@scure/base';
import { API_URL, E2E_ENV, STAMPS_ORIGIN, VAULT_ORIGIN } from '../stack.ts';
import { ACCESS_SUBS, E2E_STAFF } from './access.ts';
import type { MockApi } from './api.ts';
import type { ApiModules } from './api-modules.ts';
import type { Chain } from './chain.ts';
import type { D1Shim } from './d1.ts';
import { GoogleBackend } from './google-backend.ts';
import { laneClockFrozen, laneClockOffset } from './lane-clock.ts';
import { ExecContext } from './workers.ts';

const SRC = (app: string, path: string): string => new URL(`../../../${app}/src/${path}`, import.meta.url).href;
const CONSOLE_CORE = new URL('../../../../packages/console-core/src/index.ts', import.meta.url).href;

interface ConsoleCore {
  labelChangeDigest(i: { signer: string; scopeId: string; kind: 'labels_set' | 'labels_remove'; labelId: string; docSha256?: string; appIds: readonly string[]; labelsVersion: number }): Promise<Uint8Array>;
  nonceOf(d: Uint8Array): string;
  linkToken(kind: 'cancelLink', key: Uint8Array, id: string): Promise<Uint8Array>;
  linkTokenHash(token: Uint8Array): Promise<Uint8Array>;
  b64url(bytes: Uint8Array): string;
}
const core = (await import(CONSOLE_CORE)) as ConsoleCore;
const { labelsMaintenance } = (await import(SRC('api', 'labels/cron.ts'))) as { labelsMaintenance(env: unknown, now: number): Promise<{ activated: number; lapsed: number }> };
const { detectLabelDrift } = (await import(SRC('api', 'labels/drift.ts'))) as { detectLabelDrift(env: unknown, now: number): Promise<{ found: number; recorded: number }> };
/** The admin Worker's own cron context (its system actor, a fresh request id per call). */
const { systemCtx } = (await import(SRC('admin', 'rpc.ts'))) as { systemCtx(): { actor: { kind: 'system'; id: string }; requestId: string; clientIp: string } };

/** The console audience the lane's chain has in force, and the scope owner's Google `sub` (lane-only test values). */
export const LANE_CONSOLE_AUD = 'e2e-lane-console.apps.googleusercontent.com';
export const LANE_OWNER_SUB = 'e2e-labels-owner';
/** The labels org's security contact (the notice's recipient, with the security alias). */
export const LANE_LABELS_CONTACT = 'security@stamp-rally.e2e.invalid';
/** The partner's contract the documents describe: a stamps-like NEAR testnet contract, not one Journear reads itself. */
export const LANE_LABELS_ACCOUNT = 'stamp-rally.testnet';
export const LANE_LABELS_APP = 'Stamp Rally';
const STAFF_NOTE = 'Local stack: set up by the staff demo';

/** An RPC answer: `{ok: true, …}` or a refusal. */
type Answer = { ok: true } & Record<string, unknown>;
type Rpc = Record<string, (c: unknown) => Promise<unknown>>;

export interface LabelsLaneDeps {
  api: MockApi;
  d1: D1Shim;
  chain: Chain;
  modules: ApiModules;
  /** The lane's AdminRpc and ConsoleRpc, as service bindings (structured clones each way). */
  adminRpc: Rpc;
  consoleRpc: Rpc;
  /** The admin Worker's CANCEL_LINK_KEY (base64 of 32 bytes) and SECURITY_ALIAS. */
  cancelLinkKey: string;
  securityAlias: string;
  /** Moves the lane's clock forward (and empties the status page's cache). */
  advance(ms: number): void;
  delayMs: number;
}

/** One version as the controls answer it (the staff view's fields; never a token). */
export interface LaneLabelVersion {
  changeId: string;
  labelId: string;
  state: string;
  sha256: string;
  bytes: number;
  proposedAt: number;
  notifiedAt: number | null;
  activeFrom: number | null;
  lapsesAt: number | null;
  reviewRequired: boolean;
  allowedAt: number | null;
  blockedAt: number | null;
  blockNote: string | null;
  endReason: string | null;
  off: string | null;
  served: boolean;
}

export interface LaneLabelsState {
  orgId: string;
  scopeId: string;
  appId: string;
  appName: string;
  labelId: string | null;
  labelsVersion: number;
  versions: LaneLabelVersion[];
  controls: { all: { labelsOff: boolean; reviewRequired: boolean }; org: { labelsOff: boolean; reviewRequired: boolean } };
  nowMs: number;
  clockOffsetMs: number;
  clockFrozen: boolean;
}

interface LabelsOrg {
  orgId: string;
  scopeId: string;
  appId: string;
  pk: string;
  /** The entry this org's proposals change (the first one's), once proposed. */
  labelId: string | null;
  /** Documents proposed so far (the next one's number). */
  documents: number;
}

export const LABEL_SCENARIOS = ['labels-waiting', 'labels-review', 'labels-live', 'labels-update', 'labels-off'] as const;
export type LabelScenario = (typeof LABEL_SCENARIOS)[number];

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const rid = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

/**
 * Document `n` of the lane's contract (`codeHash`: the build it describes): `collect` a stamp, its enum with "Fare
 * paid". From the second on, the contract was rebuilt (a new code hash) and the enum has one more stamp, so the feed
 * shows a diff.
 */
export function laneLabelDocument(n: number, codeHash: string): string {
  const stamp: Record<string, string> = { arrival: 'Arrival', sponsored: 'Fare paid', ...(n >= 2 ? { summit: 'Summit' } : {}) };
  return JSON.stringify(
    {
      schema: 'journear-labels/1',
      context: { near: { network: 'testnet', account: LANE_LABELS_ACCOUNT, codeHash } },
      metadata: { enums: { stamp } },
      display: {
        formats: {
          collect: {
            call: { gasAtMost: '30000000000000', args: { stamp: { type: 'string' } }, otherArgs: 'refuse' },
            intent: { verb: 'collect', object: 'the stamp' },
            sentence: ['verb', 'object', { field: 'args.stamp' }],
            fields: [{ path: 'args.stamp', label: 'Stamp', format: 'enum', params: { enum: 'stamp' } }],
          },
        },
      },
    },
    null,
    2,
  );
}

/** A fresh build's code hash: base58 of 32 random bytes, as NEAR shows a contract's. */
const freshCodeHash = (): string => base58.encode(crypto.getRandomValues(new Uint8Array(32)));

async function ok<T = Answer>(p: Promise<unknown>, what: string): Promise<T & Answer> {
  const r = (await p) as { ok: boolean; code?: string; error?: string };
  if (!r.ok) throw new Error(`${what} was refused: ${r.code ?? 'error'}${r.error ? ` (${r.error})` : ''}`);
  return r as T & Answer;
}

export class LabelsLane {
  private google: GoogleBackend | null = null;
  private org: LabelsOrg | null = null;
  private orgs = 0;
  private jti = 0;
  private readonly exec = new ExecContext();

  constructor(private readonly d: LabelsLaneDeps) {
    d.chain.consoleAudiences = [['google', LANE_CONSOLE_AUD]];
  }

  /**
   * Makes the lane's Google key (per lane thread and run, in memory only) and answers Google's endpoints in this thread
   * from then on. Called when the lane starts, before any request: apps/api's JWKS cache in this thread (the step-up's
   * check, and the governance read System status shows) then only ever holds this key, never Google's real one.
   */
  async start(): Promise<void> {
    if (this.google) return;
    this.google = await GoogleBackend.create();
    this.google.install();
  }

  private async key(): Promise<GoogleBackend> {
    await this.start();
    return this.google!;
  }

  private member() {
    return {
      actor: { kind: 'member' as const, id: 'usr_e2elabelsowner', sub: LANE_OWNER_SUB, email: 'owner@stamp-rally.e2e.invalid', sessionHash: core.b64url(createHash('sha256').update('e2e lane console session').digest()) },
      requestId: rid('console'),
      clientIp: '127.0.0.1',
    };
  }

  private staff() {
    return { actor: { kind: 'hana' as const, id: ACCESS_SUBS[E2E_STAFF]!, email: E2E_STAFF }, requestId: rid('admin'), clientIp: '127.0.0.1' };
  }

  /** The console step-up for `nonce`: openid only (no email or hd), issued now on the lane's clock, five minutes long. */
  private async stepUp(nonce: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    this.jti += 1;
    return (await this.key()).sign({ iss: 'https://accounts.google.com', aud: LANE_CONSOLE_AUD, azp: LANE_CONSOLE_AUD, sub: LANE_OWNER_SUB, nonce, iat: now, exp: now + 300, jti: `e2e-lane-${this.jti}-${crypto.randomUUID()}` });
  }

  private async current(): Promise<LabelsOrg> {
    return this.org ?? (await this.reset());
  }

  private version(scopeId: string): number {
    return Number((this.d.d1.db.prepare('SELECT labels_version AS v FROM scopes WHERE scope_id = ?').get(scopeId) as { v: number }).v);
  }

  /** A switch's version (what a change of it must have seen): the org's or everyone's row, or the entry's. */
  private switchVersion(target: { kind: 'all' } | { kind: 'org'; orgId: string } | { kind: 'entry'; labelId: string }): number {
    if (target.kind === 'entry') return Number((this.d.d1.db.prepare('SELECT off_version AS v FROM partner_labels WHERE id = ?').get(target.labelId) as { v: number } | undefined)?.v ?? 0);
    const row = this.d.d1.db.prepare('SELECT version AS v FROM label_controls WHERE target = ?').get(target.kind === 'all' ? '*' : target.orgId) as { v: number } | undefined;
    return Number(row?.v ?? 0);
  }

  private controlRow(target: string): { labelsOff: boolean; reviewRequired: boolean } {
    const r = this.d.d1.db.prepare('SELECT labels_off AS off, review_required AS review FROM label_controls WHERE target = ?').get(target) as { off: number; review: number } | undefined;
    return { labelsOff: !!r?.off, reviewRequired: !!r?.review };
  }

  /**
   * A new labels org, scope and app (the last one's entries removed by its owner, its switches and everyone's turned
   * back first). The scope is moved out of org_legacy as an assignment does (ConsoleRpc refuses org_legacy), long enough
   * ago that nothing holds a new org's changes back.
   */
  async reset(): Promise<LabelsOrg> {
    const old = this.org;
    if (old) {
      const list = await ok<{ labelsVersion: number; entries: { id: string }[] }>(this.d.consoleRpc.listLabels!({ ...this.member(), orgId: old.orgId, scopeId: old.scopeId }), 'listLabels');
      let version = list.labelsVersion;
      for (const e of list.entries) {
        const nonce = core.nonceOf(await core.labelChangeDigest({ signer: E2E_ENV.signer, scopeId: old.scopeId, kind: 'labels_remove', labelId: e.id, appIds: [], labelsVersion: version }));
        await ok(this.d.consoleRpc.removeLabels!({ ...this.member(), orgId: old.orgId, scopeId: old.scopeId, labelId: e.id, expectedVersion: version, stepUpJwt: await this.stepUp(nonce) }), 'removeLabels');
        version += 1;
      }
      await this.unswitch({ kind: 'org', orgId: old.orgId });
    }
    await this.unswitch({ kind: 'all' });
    this.orgs += 1;
    const suffix = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');
    const orgId = `org_e2elabels${this.orgs}x${suffix}`;
    const scopeId = `stafflabels${this.orgs}`;
    const app = this.d.api.createApp({ name: LANE_LABELS_APP, scopeId, origins: [STAMPS_ORIGIN], settings: { persistence: 'none' } });
    const now = Date.now();
    this.d.d1.db.prepare('UPDATE scopes SET org_id = ?, assigned_at = ? WHERE scope_id = ?').run(orgId, now - 2 * this.d.delayMs, scopeId);
    this.d.d1.db.prepare("INSERT OR IGNORE INTO org_security_contacts (org_id, email, added_by, added_at) VALUES (?, ?, 'e2e', ?)").run(orgId, LANE_LABELS_CONTACT, now);
    this.d.chain.scopeOwners.set(scopeId, [{ Near: { account_id: 'stamp-rally-owner.testnet' } }, { Oidc: { provider: 'google', sub: LANE_OWNER_SUB } }]);
    this.org = { orgId, scopeId, appId: app.appId, pk: app.pk, labelId: null, documents: 0 };
    return this.org;
  }

  /** Every switch of `target` back: labels on, review off. */
  private async unswitch(target: { kind: 'all' } | { kind: 'org'; orgId: string }): Promise<void> {
    const row = this.controlRow(target.kind === 'all' ? '*' : target.orgId);
    if (row.labelsOff) await this.switch(target, 'on');
    if (row.reviewRequired) await this.switch(target, 'review_off');
  }

  /**
   * The owner proposes a document through ConsoleRpc: the first version of the lane's entry, or (`next`) a new version
   * of it (the contract rebuilt, one more stamp). The API refuses what it refuses for a partner (a version already
   * waiting, a second entry for the same contract): the control answers 409 with its message.
   */
  async propose(o: { next?: boolean } = {}): Promise<{ changeId: string; labelId: string; sha256: string; document: number }> {
    const s = await this.current();
    if (o.next && !s.labelId) throw new Error('propose next: the lane has no entry yet (propose its first version first)');
    const labelId = o.next ? s.labelId! : undefined;
    const n = s.documents + 1;
    const document = laneLabelDocument(n, freshCodeHash());
    const list = await ok<{ labelsVersion: number }>(this.d.consoleRpc.listLabels!({ ...this.member(), orgId: s.orgId, scopeId: s.scopeId }), 'listLabels');
    const expectedVersion = list.labelsVersion;
    const nonce = core.nonceOf(
      await core.labelChangeDigest({ signer: E2E_ENV.signer, scopeId: s.scopeId, kind: 'labels_set', labelId: labelId ?? '', docSha256: sha256Hex(document), appIds: [s.appId], labelsVersion: expectedVersion }),
    );
    const r = await ok<{ change: { id: string; labelId: string; sha256: string } | null }>(
      this.d.consoleRpc.proposeLabels!({ ...this.member(), orgId: s.orgId, scopeId: s.scopeId, ...(labelId ? { labelId } : {}), document, appIds: [s.appId], expectedVersion, stepUpJwt: await this.stepUp(nonce) }),
      'proposeLabels',
    );
    if (!r.change) throw new Error('proposeLabels: the same document is already in force');
    s.documents = n;
    s.labelId ??= r.change.labelId;
    return { changeId: r.change.id, labelId: r.change.labelId, sha256: r.change.sha256, document: n };
  }

  /** The admin Worker's notice, acked as it acks once every email is accepted (none is sent here): the 24 h start. */
  async announce(changeId?: string): Promise<{ changeId: string; activeFrom: number; wouldEmail: string[] }[]> {
    const s = await this.current();
    const page = await ok<{ notices: { change: { id: string; orgId: string }; contacts: string[] }[] }>(this.d.adminRpc.labelNotices!({ ...systemCtx(), limit: 100 }), 'labelNotices');
    const notices = page.notices.filter((n) => n.change.orgId === s.orgId && (changeId === undefined || n.change.id === changeId));
    if (notices.length === 0) throw new Error(`announce: ${changeId ? `${changeId} is not waiting for its notice` : 'nothing the lane proposed is waiting for its notice'}`);
    const key = Buffer.from(this.d.cancelLinkKey, 'base64');
    if (key.length !== 32) throw new Error('announce: the lane has no cancel link key');
    const out: { changeId: string; activeFrom: number; wouldEmail: string[] }[] = [];
    for (const n of notices) {
      const token = await core.linkToken('cancelLink', new Uint8Array(key), n.change.id);
      const ack = await ok<{ change: { id: string; activeFrom: number } }>(
        this.d.adminRpc.ackLabelNotice!({ ...systemCtx(), changeId: n.change.id, cancelTokenHash: core.b64url(await core.linkTokenHash(token)) }),
        'ackLabelNotice',
      );
      out.push({ changeId: ack.change.id, activeFrom: ack.change.activeFrom, wouldEmail: [this.d.securityAlias, ...n.contacts] });
    }
    return out;
  }

  /** The API's hourly job for labels, at the lane's clock: activations and lapses recorded, then drift. */
  async cron(): Promise<{ activated: number; lapsed: number; drift: { found: number; recorded: number } }> {
    const now = Date.now();
    const run = await labelsMaintenance(this.d.api.env, now);
    const drift = await detectLabelDrift(this.d.api.env, now);
    return { ...run, drift };
  }

  /** `GET /v1/app` as the vault reads it for the lane's app: `partnerLabels` null when the answer has no such field. */
  async app(): Promise<{ status: number; partnerLabels: { id: string; changeId: string; version: string; sha256: string; text: string; effectiveSince: number; previousEffectiveSince: number | null }[] | null }> {
    const s = await this.current();
    const req = new Request(`${API_URL}/v1/app`, { headers: { origin: VAULT_ORIGIN, 'x-hana-key': s.pk, 'x-hana-parent-origin': STAMPS_ORIGIN } });
    const res = await this.d.modules.worker.fetch(req, this.d.api.env, this.exec);
    const body = (await res.json()) as { partnerLabels?: unknown };
    return { status: res.status, partnerLabels: Array.isArray(body.partnerLabels) ? (body.partnerLabels as never) : null };
  }

  /** The newest version the lane proposed (the default target of block and allow). */
  private async newest(): Promise<string> {
    const v = (await this.state()).versions.at(-1);
    if (!v) throw new Error('the lane has proposed nothing yet');
    return v.changeId;
  }

  /** A staff tool on a version (default the newest), as the page saw it: AdminRpc.labelDetail, then labelStaffAct. */
  async staffAct(tool: 'block' | 'allow', changeId?: string, note?: string): Promise<{ changeId: string; state: string }> {
    const id = changeId ?? (await this.newest());
    const d = await ok<{ item: { labelsVersion: number; change: { state: string } } }>(this.d.adminRpc.labelDetail!({ ...this.staff(), changeId: id }), 'labelDetail');
    const r = await ok<{ change: { id: string; state: string } }>(
      this.d.adminRpc.labelStaffAct!({ ...this.staff(), changeId: id, tool, note: note ?? (tool === 'block' ? 'Local stack: blocked by a lane control' : 'Local stack: allowed by a lane control'), seen: { labelsVersion: d.item.labelsVersion, state: d.item.change.state } }),
      `labelStaffAct ${tool}`,
    );
    return { changeId: r.change.id, state: r.change.state };
  }

  /** A switch (AdminRpc.labelControl): the lane org's, everyone's, or the lane's entry's. */
  async switch(target: { kind: 'all' } | { kind: 'org'; orgId: string } | { kind: 'entry'; labelId: string }, what: 'off' | 'on' | 'review_on' | 'review_off', note = STAFF_NOTE): Promise<void> {
    await ok(this.d.adminRpc.labelControl!({ ...this.staff(), target, what, note, seenVersion: this.switchVersion(target) }), `labelControl ${what}`);
  }

  /** `switch` by the control's names: `all`, `org` (the lane's), `entry` (the lane's). */
  async switchNamed(target: string, what: string, note?: string): Promise<void> {
    if (what !== 'off' && what !== 'on' && what !== 'review_on' && what !== 'review_off') throw new Error('switch: what is off, on, review_on or review_off');
    const s = await this.current();
    if (target === 'all') return this.switch({ kind: 'all' }, what, note);
    if (target === 'org') return this.switch({ kind: 'org', orgId: s.orgId }, what, note);
    if (target === 'entry') {
      if (!s.labelId) throw new Error('switch entry: the lane has no entry yet');
      return this.switch({ kind: 'entry', labelId: s.labelId }, what, note);
    }
    throw new Error('switch: target is all, org or entry');
  }

  /** The lane org's versions (oldest first) as staff see them, its switches and the lane's clock. */
  async state(): Promise<LaneLabelsState> {
    const s = await this.current();
    const q = await ok<{ items: { change: LaneLabelVersion & { id: string; orgId: string; blockNote?: string | null } }[] }>(this.d.adminRpc.labelQueue!({ ...this.staff(), days: 90 }), 'labelQueue');
    const versions = q.items
      .filter((i) => i.change.orgId === s.orgId)
      .map(({ change: c }) => ({
        changeId: c.id,
        labelId: c.labelId,
        state: c.state,
        sha256: c.sha256,
        bytes: c.bytes,
        proposedAt: c.proposedAt,
        notifiedAt: c.notifiedAt,
        activeFrom: c.activeFrom,
        lapsesAt: c.lapsesAt,
        reviewRequired: c.reviewRequired,
        allowedAt: c.allowedAt,
        blockedAt: c.blockedAt,
        blockNote: c.blockNote ?? null,
        endReason: c.endReason,
        off: c.off,
        served: c.served,
      }))
      .sort((a, b) => a.proposedAt - b.proposedAt || a.changeId.localeCompare(b.changeId));
    return {
      orgId: s.orgId,
      scopeId: s.scopeId,
      appId: s.appId,
      appName: LANE_LABELS_APP,
      labelId: s.labelId,
      labelsVersion: this.version(s.scopeId),
      versions,
      controls: { all: this.controlRow('*'), org: this.controlRow(s.orgId) },
      nowMs: Date.now(),
      clockOffsetMs: laneClockOffset(),
      clockFrozen: laneClockFrozen(),
    };
  }

  /**
   * The hand test's states (staff-demo.ts), each from a reset:
   *   labels-waiting  proposed and announced: goes live in 24 h (Block it in the feed)
   *   labels-review   review required for the org; its 24 h passed: waiting for Allow (or Block)
   *   labels-live     in force (the hourly job recorded it): Block takes it off at once
   *   labels-update   one in force, and a second version (rebuilt contract, one more stamp) announced: the diff
   *   labels-off      one in force, and every partner label switched off (the status page's indicator)
   */
  async scenario(name: string): Promise<void> {
    switch (name as LabelScenario) {
      case 'labels-waiting':
        await this.reset();
        await this.propose();
        await this.announce();
        break;
      case 'labels-review': {
        const s = await this.reset();
        await this.switch({ kind: 'org', orgId: s.orgId }, 'review_on');
        await this.propose();
        await this.announce();
        this.d.advance(this.d.delayMs + 1_000);
        await this.cron();
        break;
      }
      case 'labels-live':
        await this.reset();
        await this.propose();
        await this.announce();
        this.d.advance(this.d.delayMs + 1_000);
        await this.cron();
        break;
      case 'labels-update':
        await this.scenario('labels-live');
        await this.propose({ next: true });
        await this.announce();
        break;
      case 'labels-off':
        await this.scenario('labels-live');
        await this.switch({ kind: 'all' }, 'off');
        break;
      default:
        throw new Error(`unknown labels scenario ${JSON.stringify(name)}: ${LABEL_SCENARIOS.join(', ')}`);
    }
  }
}
