// The Partner labels screen's preview data (D894; test-spa/preview.ts): a small set of label changes in every state,
// answered through the Worker's own routes (src/partner-labels.ts) over a fake API and console, so the page shows
// exactly what the Worker would answer. A Block, an Allow or a switch changes the set in memory (until the preview
// restarts, or `resetPreviewLabels`). Every id, name and address is made up.
//
//   lc_previewannounced   Lumen's first labels for "Stamps Club": announced, goes live in 20 hours (two lines, every one new)
//   lc_previewreview      Harbour's change to "Harbour Pay": its time passed, held for a staff Allow (review is on for Harbour)
//   lc_previewproposed    Lumen's change to "Stamps Club": waiting for its notice email
//   lc_previewlive        Harbour's labels in force
//   lc_previewblocked     a change staff blocked, with the note
//   lc_previewcancelled   a change the partner cancelled
//
// The switches: review required for Harbour; one set of Lumen's labels switched off on its own.
import type { LabelChangeView, LabelControls, LabelDiffLine, LabelFeedItem, LabelPreview } from '@hana-id/console-core';
import type { Env } from '../src/env.ts';
import { labelActRoute, labelControlRoute, labelRoute, labelsRoute } from '../src/partner-labels.ts';
import type { RouteCtx } from '../src/routes.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LUMEN = 'org_01jdzlumen';
const HARBOUR = 'org_01jdzharbour';
const ORG_NAMES: Record<string, string> = { [LUMEN]: 'Lumen Labs', [HARBOUR]: 'Harbour Pay Ltd' };
const STAMPS = { id: 'app_01jdzstamps', name: 'Stamps Club' };
const PAY = { id: 'app_01jdzharbourpay', name: 'Harbour Pay' };

const stampsPreview = (stamp: string, verb = 'collect'): LabelPreview => ({
  appName: STAMPS.name,
  context: 'NEAR test network, stamps-club.testnet',
  examples: true,
  formats: [
    { key: 'collect', line: `${STAMPS.name} says: ${verb} the stamp “${stamp}”`, sentence: `${verb} the stamp “${stamp}”`, parts: [{ kind: 'verb', text: verb }, { kind: 'object', text: 'the stamp' }, { kind: 'value', text: `“${stamp}”` }], fields: [{ label: 'Stamp', value: `“${stamp}”` }] },
    { key: 'redeem', line: `${STAMPS.name} says: redeem 3 stamps for a free coffee`, sentence: 'redeem 3 stamps for a free coffee', parts: [{ kind: 'verb', text: 'redeem' }, { kind: 'value', text: '3' }, { kind: 'object', text: 'stamps for a free coffee' }], fields: [{ label: 'Stamps', value: '3' }, { label: 'Reward', value: 'Free coffee' }] },
  ],
  accounts: [],
});
/** Harbour Pay's two tills (random public keys no one has the secret key of). */
export const HARBOUR_TILL = 'GDGXQACKG7AOXXIO4JFXPVAOUHWB2VBNI62EQ6HHYWWVCRDQX3OEH5GS';
export const HARBOUR_KIOSK = 'GCVFJJYF75734IR7PQB2IOI3C3RDQ66D6OMVMJG2DRO4VBN66ODCE76B';
/** A classic payment's preview, as the API answers it (core's plain form; its accounts in the address book's order). */
const payPreview = (verb = 'pay', kiosk = 'Harbour kiosk'): LabelPreview => ({
  appName: PAY.name,
  context: 'Stellar test network, payments',
  examples: true,
  formats: [{ key: 'payment', line: `${PAY.name} says: ${verb} for order “1042” to “Harbour till” (${HARBOUR_TILL})`, sentence: `${verb} for order “1042” to “Harbour till” (${HARBOUR_TILL})`, parts: [{ kind: 'verb', text: verb }, { kind: 'word', text: 'for' }, { kind: 'object', text: 'order' }, { kind: 'value', text: '“1042”' }, { kind: 'word', text: 'to' }, { kind: 'value', text: `“Harbour till” (${HARBOUR_TILL})` }], fields: [{ label: 'Order', value: '“1042”' }] }],
  accounts: [`Account “Harbour till” (${HARBOUR_TILL})`, `Account “${kiosk}” (${HARBOUR_KIOSK})`],
});

/** The API's diff (apps/api/src/labels/document.ts `diffOf`): what it describes first, then each line with its rows. */
const textOf = (f: LabelPreview['formats'][number]): string => [f.line, ...f.fields.map((x) => `${x.label}: ${x.value}`)].join(' · ');
function diffOf(before: LabelPreview | null, after: LabelPreview): LabelDiffLine[] {
  // Each account by its account (the text after the name), as the API keys them.
  const acc = (p: LabelPreview): [string, string][] => p.accounts.map((x) => [`(account) ${x.slice(x.lastIndexOf('(') + 1, -1)}`, x]);
  const b = new Map<string, string>(before ? [['(contract)', before.context], ...acc(before), ...before.formats.map((f): [string, string] => [f.key, textOf(f)])] : []);
  const a = new Map<string, string>([['(contract)', after.context], ...acc(after), ...after.formats.map((f): [string, string] => [f.key, textOf(f)])]);
  return [...new Set([...b.keys(), ...a.keys()])].map((key) => {
    const x = b.get(key) ?? null;
    const y = a.get(key) ?? null;
    return { key, before: x, after: y, change: x === null ? 'added' : y === null ? 'removed' : x === y ? 'same' : 'changed' };
  });
}

function view(now: number, id: string, over: Partial<LabelChangeView>): LabelChangeView {
  return {
    id,
    labelId: 'pl_01jdzstamps',
    orgId: LUMEN,
    scopeId: 's01jdzlumen',
    environment: 'test',
    apps: [STAMPS],
    schema: 'journear-labels/1',
    sha256: 'ab'.repeat(32),
    bytes: 1840,
    state: 'announced',
    proposedAt: now - 4 * HOUR,
    notifiedAt: now - 4 * HOUR + 5 * MIN,
    activeFrom: now + 20 * HOUR,
    lapsesAt: null,
    reviewRequired: false,
    allowedAt: null,
    blockedAt: null,
    blockNote: null,
    endedAt: null,
    endReason: null,
    previousId: null,
    off: null,
    served: false,
    ...over,
  };
}

function initial(now: number): Map<string, LabelFeedItem> {
  const items: LabelFeedItem[] = [
    { change: view(now, 'lc_previewannounced', {}), labelsVersion: 3, entryVersion: 0, preview: stampsPreview('Arrival'), diff: diffOf(null, stampsPreview('Arrival')) },
    {
      change: view(now, 'lc_previewreview', { labelId: 'pl_01jdzharbour', orgId: HARBOUR, scopeId: 's01jdzharbour', apps: [PAY], state: 'waiting_review', proposedAt: now - 26 * HOUR, notifiedAt: now - 26 * HOUR + 4 * MIN, activeFrom: now - 2 * HOUR, lapsesAt: now - 2 * HOUR + 7 * DAY, reviewRequired: true, previousId: 'lc_previewlive' }),
      labelsVersion: 7,
      entryVersion: 0,
      preview: payPreview('pay', 'Harbour stall'),
      diff: diffOf(payPreview('send'), payPreview('pay', 'Harbour stall')),
    },
    {
      change: view(now, 'lc_previewproposed', { labelId: 'pl_01jdzstamps2', state: 'proposed', proposedAt: now - 3 * MIN, notifiedAt: null, activeFrom: null, lapsesAt: now - 3 * MIN + 7 * DAY, previousId: 'lc_previewold' }),
      labelsVersion: 4,
      entryVersion: 0,
      preview: stampsPreview('Fare paid', 'claim'),
      diff: diffOf(stampsPreview('Fare paid'), stampsPreview('Fare paid', 'claim')),
    },
    {
      change: view(now, 'lc_previewlive', { labelId: 'pl_01jdzharbour', orgId: HARBOUR, scopeId: 's01jdzharbour', apps: [PAY], state: 'in_force', proposedAt: now - 9 * DAY, notifiedAt: now - 9 * DAY + 5 * MIN, activeFrom: now - 8 * DAY, served: true }),
      labelsVersion: 7,
      entryVersion: 0,
      preview: payPreview('send'),
      diff: diffOf(null, payPreview('send')),
    },
    {
      change: view(now, 'lc_previewblocked', { labelId: 'pl_01jdzstamps3', state: 'blocked', proposedAt: now - 3 * DAY, notifiedAt: now - 3 * DAY + 5 * MIN, activeFrom: now - 2 * DAY, blockedAt: now - 2 * DAY - 3 * HOUR, blockNote: 'The line says “collect a stamp” but the call sends 5 NEAR', endedAt: now - 2 * DAY - 3 * HOUR }),
      labelsVersion: 2,
      entryVersion: 0,
      preview: stampsPreview('Bonus'),
      diff: diffOf(null, stampsPreview('Bonus')),
    },
    {
      change: view(now, 'lc_previewcancelled', { labelId: 'pl_01jdzstamps3', state: 'cancelled', proposedAt: now - 5 * DAY, notifiedAt: now - 5 * DAY + 5 * MIN, activeFrom: now - 4 * DAY, endedAt: now - 5 * DAY + HOUR, endReason: 'link' }),
      labelsVersion: 2,
      entryVersion: 0,
      preview: stampsPreview('Welcome'),
      diff: diffOf(null, stampsPreview('Welcome')),
    },
  ];
  return new Map(items.map((i) => [i.change.id, i]));
}

let items: Map<string, LabelFeedItem> | null = null;
let controls: LabelControls | null = null;
const initialControls = (now: number): LabelControls => ({
  all: { labelsOff: false, reviewRequired: false, version: 0, updatedAt: null, updatedBy: null, note: null },
  orgs: [{ orgId: HARBOUR, labelsOff: false, reviewRequired: true, version: 1, updatedAt: now - 3 * DAY, updatedBy: 'tze@hana.example', note: 'New partner: every change reviewed for the first month' }],
  entries: [{ labelId: 'pl_01jdzstamps4', orgId: LUMEN, scopeId: 's01jdzlumen', offAt: now - 6 * HOUR, offBy: 'tze@hana.example', note: 'Reported by a user as confusing; asked the partner', version: 1 }],
});

/** Back to the set above (a test's or a preview restart's start). */
export function resetPreviewLabels(now = Date.now()): void {
  items = initial(now);
  controls = initialControls(now);
}
const store = () => {
  if (!items || !controls) resetPreviewLabels();
  return { items: items!, controls: controls! };
};

const WAITING = new Set(['proposed', 'announced', 'waiting_review']);

/** The fake API and console the routes call: the set above, changed by Block, Allow and the switches. */
function fakeEnv(now: number): Env {
  const s = store();
  const queue = () => [...s.items.values()].sort((a, b) => Number(WAITING.has(b.change.state)) - Number(WAITING.has(a.change.state)) || (WAITING.has(a.change.state) ? (a.change.activeFrom ?? Infinity) - (b.change.activeFrom ?? Infinity) : b.change.proposedAt - a.change.proposedAt));
  return {
    CONSOLE: {
      listOrgs: async () => ({ ok: true, orgs: Object.entries(ORG_NAMES).map(([id, name]) => ({ id, name })) }),
      recordStaffAction: async () => ({ ok: true }),
    },
    API: {
      labelQueue: async () => ({ ok: true, items: queue(), controls: s.controls }),
      labelDetail: async (c: { changeId: string }) => (s.items.has(c.changeId) ? { ok: true, item: s.items.get(c.changeId) } : { ok: false, code: 'not_found', error: 'No such change' }),
      labelControls: async () => ({ ok: true, controls: s.controls }),
      labelStaffAct: async (c: { changeId: string; tool: 'block' | 'allow'; note: string; seen: { labelsVersion: number; state: string } }) => {
        const it = s.items.get(c.changeId);
        if (!it) return { ok: false, code: 'not_found', error: 'No such change' };
        if (it.labelsVersion !== c.seen.labelsVersion || it.change.state !== c.seen.state) return { ok: false, code: 'version_conflict', error: 'This change moved since the page was read: read it again' };
        const change: LabelChangeView =
          c.tool === 'block'
            ? { ...it.change, state: 'blocked', blockedAt: now, blockNote: c.note, endedAt: now, served: false }
            : { ...it.change, allowedAt: now, state: it.change.activeFrom !== null && it.change.activeFrom <= now ? 'in_force' : it.change.state, served: it.change.activeFrom !== null && it.change.activeFrom <= now };
        s.items.set(c.changeId, { ...it, change, labelsVersion: it.labelsVersion + 1 });
        return { ok: true, change };
      },
      labelControl: async (c: { target: { kind: string; orgId?: string; labelId?: string }; what: string; note: string; seenVersion: number }) => {
        if (c.target.kind === 'all') {
          if (c.seenVersion !== s.controls.all.version) return { ok: false, code: 'version_conflict', error: 'This switch moved since the page was read: read it again' };
          const a = { ...s.controls.all };
          if (c.what === 'off') a.labelsOff = true;
          else if (c.what === 'on') a.labelsOff = false;
          else a.reviewRequired = c.what === 'review_on';
          s.controls.all = { ...a, version: a.version + 1, updatedAt: now, updatedBy: 'tze@hana.example', note: c.note };
          return { ok: true, version: s.controls.all.version, changed: true };
        }
        if (c.target.kind === 'org') {
          const o = s.controls.orgs.find((x) => x.orgId === c.target.orgId) ?? { orgId: c.target.orgId!, labelsOff: false, reviewRequired: false, version: 0, updatedAt: now, updatedBy: 'tze@hana.example', note: null };
          if (c.seenVersion !== o.version) return { ok: false, code: 'version_conflict', error: 'This switch moved since the page was read: read it again' };
          const next = { ...o, labelsOff: c.what === 'off' ? true : c.what === 'on' ? false : o.labelsOff, reviewRequired: c.what === 'review_on' ? true : c.what === 'review_off' ? false : o.reviewRequired, version: o.version + 1, updatedAt: now, note: c.note };
          s.controls.orgs = [...s.controls.orgs.filter((x) => x.orgId !== o.orgId), ...(next.labelsOff || next.reviewRequired ? [next] : [])];
          return { ok: true, version: next.version, changed: true };
        }
        const e = s.controls.entries.find((x) => x.labelId === c.target.labelId);
        if (c.what === 'on' && e) s.controls.entries = s.controls.entries.filter((x) => x !== e);
        return { ok: true, version: (e?.version ?? 0) + 1, changed: !!e };
      },
    },
  } as unknown as Env;
}

const previewStaff = { actor: { kind: 'hana' as const, id: 'access-sub-1', email: 'tze@hana.example' }, requestId: 'req_preview_labels', clientIp: '127.0.0.1' };
type Fake = { status: number; body: unknown };
const ctx = (now: number, params: Record<string, string>, body: Record<string, unknown> = {}): RouteCtx => ({ env: fakeEnv(now), staff: previewStaff, params, body }) as unknown as RouteCtx;
const out = async (res: Response): Promise<Fake> => ({ status: res.status, body: await res.json() });

/** `GET /api/labels`. */
export const previewLabels = async (now = Date.now()): Promise<Fake> => out(await labelsRoute(ctx(now, {})));
/** `GET /api/labels/:changeId`. */
export const previewLabel = async (changeId: string, now = Date.now()): Promise<Fake> => out(await labelRoute(ctx(now, { changeId })));
/** `POST /api/labels/:changeId/act`. */
export const previewLabelAct = async (changeId: string, body: Record<string, unknown>, now = Date.now()): Promise<Fake> => out(await labelActRoute(ctx(now, { changeId }, body)));
/** `POST /api/labels/controls`. */
export const previewLabelControl = async (body: Record<string, unknown>, now = Date.now()): Promise<Fake> => out(await labelControlRoute(ctx(now, {}, body)));
