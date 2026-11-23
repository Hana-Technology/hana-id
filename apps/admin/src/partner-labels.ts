// "Partner labels" (D894; partners read "request labels"): the staff screen's backend. Partners write the words the
// approval window shows for their apps' requests; every change waits `appChangeDelayMs` after its notice email, and
// staff see each one for its whole wait. Nothing needs doing for a change to go live; staff can stop one.
//
//   GET  /api/labels                     the feed (AdminRpc.labelQueue: every change waiting, those decided lately, the
//                                        switches), the orgs' names (one StaffRpc.listOrgs) and a one-time token
//   GET  /api/labels/:changeId           one change (AdminRpc.labelDetail) and a one-time token
//   POST /api/labels/:changeId/act       "Block this change" or "Allow" {token, tool, note, seen}
//   POST /api/labels/controls            a switch {token, target, what, note, seenVersion}
//
// Each tool, as the Gas sponsorship tools (evm-relay.ts): the request is checked here with the API's own schema
// (console-core `labelStaffActInput`, `labelControlInput`); then the API is asked whether it has the partner labels at
// all (an older API: nothing done, nothing recorded); then the audit row (StaffRpc.recordStaffAction
// `labels.staff_action`, keyed by the page's one-time token: no row, no action; a re-sent form is `already_applied`);
// then the API, which acts only while the change (or the switch) is as the page saw it; then the answer's row
// (`labels.staff_result`). Nothing here retries a refused or failed call. The partner's text is passed on as the API
// gave it (its parser checked it); the SPA writes it as text only.
import { type LabelChangeView, type LabelControlInput, type LabelStaffActInput, labelControlInput, labelStaffActInput } from '@hana-id/console-core';
import { API_OUTDATED, CONSOLE_OUTDATED, missingMethod } from './evm-relay.ts';
import { errorResponse, json } from './http.ts';
import { errorName, log } from './log.ts';
import type { RouteCtx } from './routes.ts';
import { staffCtx } from './rpc.ts';

/** The one-time token a page carries for one tool use: the audit rows' and the API call's request id. */
const TOKEN = /^lblact_[A-Za-z0-9_-]{22}$/u;
export const newLabelToken = (): string => `lblact_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
const CHANGE_ID = /^lc_[A-Za-z0-9]{1,64}$/u;

// ---- the words staff read (D853, D879: plain, no protocol words; the technical code apart) ----

export const ALREADY_SENT = 'This form was already sent once. Reload the page to see what happened, then act again if it is still needed.';
export const CHANGE_MOVED = 'This change moved since you opened the page (someone may have acted, or it went live). Nothing was done. Reload the page and look again.';
export const SWITCH_MOVED = 'This switch moved since you opened the page (someone else may have changed it). Nothing was done. Reload the page and look again.';
export const NOT_RECORDED = 'The action could not be recorded, so nothing was done.';
export const NO_CLEAR_ANSWER = 'The API didn’t answer, so it isn’t clear whether this was done. Reload the page and look before you try again.';

export interface LabelWords {
  tone: 'ok' | 'warn' | 'error';
  title: string;
  text: string;
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** What a done Block or Allow did, in words. `wasLive`: the change was in force when it was blocked. */
export function actDoneWords(tool: 'block' | 'allow', change: Pick<LabelChangeView, 'state' | 'activeFrom'>, wasLive: boolean): LabelWords {
  if (tool === 'block')
    return wasLive
      ? { tone: 'ok', title: 'Blocked', text: 'Users stop seeing these words at once. The partner’s security contacts are emailed within about 5 minutes, with your note.' }
      : { tone: 'ok', title: 'Blocked', text: 'Users will never see this change. The partner’s security contacts are emailed within about 5 minutes, with your note.' };
  if (change.state === 'in_force') return { tone: 'ok', title: 'Allowed', text: 'Its time had already passed, so it is live now.' };
  return { tone: 'ok', title: 'Allowed', text: change.activeFrom ? `It goes live at its time, ${utc(change.activeFrom)}, unless someone blocks or cancels it first.` : 'It goes live at its time, unless someone blocks or cancels it first.' };
}

/** What a switch did, in words (`changed` false: it already was as asked). */
export function controlWords(target: LabelControlInput['target'], what: LabelControlInput['what'], changed: boolean): LabelWords {
  if (!changed) return { tone: 'ok', title: 'Nothing to change', text: 'It was already like that, so nothing changed.' };
  const whose = target.kind === 'all' ? 'every partner' : target.kind === 'org' ? 'this organisation' : 'this set of labels';
  switch (what) {
    case 'off':
      return { tone: 'ok', title: 'Switched off', text: target.kind === 'entry' ? 'Users of its apps now see the plain approval window, without the partner’s words.' : `Users of ${target.kind === 'all' ? 'every partner’s apps' : 'this organisation’s apps'} now see the plain approval window, without the partner’s words.` };
    case 'on':
      return { tone: 'ok', title: 'Back on', text: `The words of ${whose} that already passed their wait are shown again. Nothing that is still waiting goes live sooner.` };
    case 'review_on':
      return { tone: 'ok', title: 'Staff review is on', text: `From now on, no change of ${whose} goes live until staff press Allow. A change nobody allows lapses 7 days after its time.` };
    case 'review_off':
      return { tone: 'ok', title: 'Staff review is off', text: `Changes of ${whose} go live at their time again, unless staff block them.` };
  }
}

// ---- the routes ----

type Code = Parameters<typeof errorResponse>[0];

/** The orgs' names, one StaffRpc.listOrgs (the first 100); {} when the console doesn't answer (the page shows ids). */
async function orgNames(c: RouteCtx): Promise<Record<string, string>> {
  try {
    const r = await c.env.CONSOLE.listOrgs({ ...staffCtx(c.staff), limit: 100 });
    if (!r.ok) return {};
    return Object.fromEntries(r.orgs.map((o) => [o.id, o.name]));
  } catch {
    return {};
  }
}

/** One read RPC of the API, with an older API (no such method) said as such. */
async function read<T>(c: RouteCtx, route: string, call: () => Promise<{ ok: true } & T | { ok: false; code: string; error?: string }>): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  try {
    const r = await call();
    if (!r.ok) {
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      return { ok: false, res: errorResponse(r.code as Code, r.error) };
    }
    return { ok: true, value: r as T };
  } catch (err) {
    if (missingMethod(err)) return { ok: false, res: errorResponse('api_outdated', API_OUTDATED) };
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return { ok: false, res: errorResponse('upstream_unavailable') };
  }
}

/** `GET /api/labels`: the feed, the switches, the orgs' names and a one-time token for the switches' forms. */
export async function labelsRoute(c: RouteCtx): Promise<Response> {
  const route = 'GET /api/labels';
  const [q, names] = await Promise.all([read(c, route, () => c.env.API.labelQueue({ ...staffCtx(c.staff) })), orgNames(c)]);
  if (!q.ok) return q.res;
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', count: q.value.items.length });
  return json(200, { items: q.value.items, controls: q.value.controls, orgNames: names, token: newLabelToken() });
}

/** `GET /api/labels/:changeId`: one change with its preview and diff, its org's name, and a one-time token for its tools. */
export async function labelRoute(c: RouteCtx): Promise<Response> {
  const route = 'GET /api/labels/:changeId';
  const changeId = c.params.changeId ?? '';
  if (!CHANGE_ID.test(changeId)) return errorResponse('not_found');
  const [d, names] = await Promise.all([read(c, route, () => c.env.API.labelDetail({ ...staffCtx(c.staff), changeId })), orgNames(c)]);
  if (!d.ok) return d.res;
  log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok' });
  const orgId = d.value.item.change.orgId;
  return json(200, { item: d.value.item, orgName: names[orgId] ?? null, token: newLabelToken() });
}

/** The body's fields, or the refusal: only `allowed` keys, and the page's one-time token. */
function bodyOf(c: RouteCtx, allowed: string[]): { ok: true; token: string } | { ok: false; res: Response } {
  const extra = Object.keys(c.body).find((k) => !allowed.includes(k));
  if (extra) return { ok: false, res: errorResponse('bad_request', `body: only ${allowed.join(', ')}`) };
  if (typeof c.body.token !== 'string' || !TOKEN.test(c.body.token)) return { ok: false, res: errorResponse('bad_request', 'token: the page’s one-time token (reload the page)') };
  return { ok: true, token: c.body.token };
}

const issueOf = (e: { issues: { path: PropertyKey[]; message: string }[] }): string => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || 'body'}: ${i.message}` : 'Invalid body';
};

/**
 * The audit row before a tool runs (no row, no action), keyed by the page's token. The answer: null when recorded, or
 * the refusal to send (a re-sent form, an older console, the console down).
 */
async function recordFirst(c: RouteCtx, route: string, ctx: ReturnType<typeof staffCtx>, target: string, details: { tool: string; target: string; note: string }): Promise<Response | null> {
  try {
    const a = await c.env.CONSOLE.recordStaffAction({ ...ctx, action: 'labels.staff_action', target, details });
    if (a.ok) return null;
    log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: a.code }, 'error');
    if (a.code === 'already_applied') return errorResponse('already_applied', ALREADY_SENT);
    if (a.code === 'bad_request') return errorResponse('console_outdated', CONSOLE_OUTDATED);
    return errorResponse('internal', NOT_RECORDED);
  } catch (err) {
    if (missingMethod(err)) return errorResponse('console_outdated', CONSOLE_OUTDATED);
    log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', NOT_RECORDED);
  }
}

/** The answer's row after the tool (the API's own records have it too: a failure here is logged, not the staffer's problem). */
async function recordResult(c: RouteCtx, route: string, ctx: ReturnType<typeof staffCtx>, target: string, details: { tool: string; target: string; result: string }): Promise<void> {
  try {
    const a = await c.env.CONSOLE.recordStaffAction({ ...ctx, action: 'labels.staff_result', target, details: { ...details, result: details.result.slice(0, 64) } });
    if (!a.ok) log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: a.code }, 'error');
  } catch (err) {
    log({ event: 'audit_failed', route, requestId: c.staff.requestId, code: 'upstream_unavailable', error: errorName(err) }, 'error');
  }
}

/** Whether the API has the partner labels (asked before the audit row, so an older API records nothing). */
async function apiHasLabels(c: RouteCtx, route: string): Promise<Response | null> {
  try {
    const v = await c.env.API.labelControls({ ...staffCtx(c.staff) });
    return v.ok ? null : errorResponse(v.code as Code, v.error);
  } catch (err) {
    if (missingMethod(err)) return errorResponse('api_outdated', API_OUTDATED);
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    return errorResponse('upstream_unavailable', 'The API didn’t answer. Nothing was done.');
  }
}

/** A refusal code as the result row keeps it. */
const outcomeOf = (code: string): string => (code === 'version_conflict' ? 'stale_page' : `rpc_${/^[a-z_]{1,48}$/u.test(code) ? code : 'unknown'}`);

/** `POST /api/labels/:changeId/act` `{token, tool, note, seen}`: "Block this change" or "Allow". */
export async function labelActRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/labels/:changeId/act';
  const changeId = c.params.changeId ?? '';
  if (!CHANGE_ID.test(changeId)) return errorResponse('not_found');
  const b = bodyOf(c, ['token', 'tool', 'note', 'seen']);
  if (!b.ok) return b.res;
  const ctx = { ...staffCtx(c.staff), requestId: b.token };
  const parsed = labelStaffActInput.safeParse({ ...ctx, changeId, tool: c.body.tool, note: c.body.note, seen: c.body.seen });
  if (!parsed.success) return errorResponse('bad_request', issueOf(parsed.error));
  const input: LabelStaffActInput = parsed.data;
  const outdated = await apiHasLabels(c, route);
  if (outdated) return outdated;
  const refused = await recordFirst(c, route, ctx, changeId, { tool: input.tool, target: changeId, note: input.note });
  if (refused) return refused;
  let outcome: string;
  let res: Response;
  try {
    const r = await c.env.API.labelStaffAct(input);
    if (!r.ok) {
      outcome = outcomeOf(r.code);
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      res = r.code === 'version_conflict' ? errorResponse('version_conflict', CHANGE_MOVED) : errorResponse(r.code as Code, r.error);
    } else {
      outcome = 'done';
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', code: input.tool });
      res = json(200, { change: r.change, words: actDoneWords(input.tool, r.change, input.seen.state === 'in_force') });
    }
  } catch (err) {
    outcome = 'unknown';
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    res = errorResponse('upstream_unavailable', NO_CLEAR_ANSWER);
  }
  await recordResult(c, route, ctx, changeId, { tool: input.tool, target: changeId, result: outcome });
  return res;
}

/** The audit target of a switch: `all`, the org's id or the entry's id. */
export const controlTarget = (t: LabelControlInput['target']): string => (t.kind === 'all' ? 'all' : t.kind === 'org' ? t.orgId : t.labelId);

/** `POST /api/labels/controls` `{token, target, what, note, seenVersion}`: a switch. */
export async function labelControlRoute(c: RouteCtx): Promise<Response> {
  const route = 'POST /api/labels/controls';
  const b = bodyOf(c, ['token', 'target', 'what', 'note', 'seenVersion']);
  if (!b.ok) return b.res;
  const ctx = { ...staffCtx(c.staff), requestId: b.token };
  const parsed = labelControlInput.safeParse({ ...ctx, target: c.body.target, what: c.body.what, note: c.body.note, seenVersion: c.body.seenVersion });
  if (!parsed.success) return errorResponse('bad_request', issueOf(parsed.error));
  const input: LabelControlInput = parsed.data;
  const target = controlTarget(input.target);
  const outdated = await apiHasLabels(c, route);
  if (outdated) return outdated;
  const refused = await recordFirst(c, route, ctx, target, { tool: input.what, target, note: input.note });
  if (refused) return refused;
  let outcome: string;
  let res: Response;
  try {
    const r = await c.env.API.labelControl(input);
    if (!r.ok) {
      outcome = outcomeOf(r.code);
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'rejected', code: r.code });
      res = r.code === 'version_conflict' ? errorResponse('version_conflict', SWITCH_MOVED) : errorResponse(r.code as Code, r.error);
    } else {
      outcome = r.changed ? 'done' : 'unchanged';
      log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'ok', code: input.what });
      res = json(200, { version: r.version, changed: r.changed, words: controlWords(input.target, input.what, r.changed) });
    }
  } catch (err) {
    outcome = 'unknown';
    log({ event: 'bff', route, requestId: c.staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'error');
    res = errorResponse('upstream_unavailable', NO_CLEAR_ANSWER);
  }
  await recordResult(c, route, ctx, target, { tool: input.what, target, result: outcome });
  return res;
}
