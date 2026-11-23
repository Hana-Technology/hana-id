// Partner labels' predicates (D894), written once and spliced into every read and write that needs them, so the
// delivery in `GET /v1/app`, the hourly job, drift detection and the staff views agree on what "in force" means.
//
// A VERSION (`label_changes` row `c`) is in force at `now` when the hourly job recorded it (`active`), or when it is
// pending, was announced, its time has passed and no staff review holds it (review is required for its org or for
// everyone, and no staff member allowed it). An ENTRY's document is its newest version in force. An entry is SERVED
// when it isn't removed, staff didn't switch it off, and no switch is off for its org or for everyone.
import { type Q, q, raw } from '../changes/sql.ts';

/** A partner label version's id: the cancel paths take one as they take a guarded change's. */
export const isLabelChange = (id: string): boolean => id.startsWith('lc_');

/** The partner-labels switch (manifest `partnerLabels.enabled` → var PARTNER_LABELS = "on"). */
export const labelsOn = (env: { PARTNER_LABELS?: string }): boolean => env.PARTNER_LABELS === 'on';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A version not announced within this long of its proposal lapses; so does one held for review this long after its time. */
export const LABEL_LAPSE_MS = 7 * DAY_MS;

/** Review is required for the org of version `c` (its org's switch or everyone's) and no staff member allowed it. */
export const REVIEW_HELD = (c: string): Q =>
  raw(`(${c}.allowed_at IS NULL AND EXISTS (SELECT 1 FROM label_controls rr WHERE rr.target IN ('*', ${c}.org_id) AND rr.review_required = 1))`);

/** Version `c` is in force at `now`. */
export const IN_FORCE = (c: string, now: number): Q =>
  q`(${raw(c)}.status = 'active' OR (${raw(c)}.status = 'pending' AND ${raw(c)}.notified_at IS NOT NULL AND ${raw(c)}.active_from IS NOT NULL AND ${raw(c)}.active_from <= ${now} AND NOT ${REVIEW_HELD(c)}))`;

/** Version `c` is still waiting (pending and not in force): what a cancel or a block can stop, one per entry at most. */
export const WAITING = (c: string, now: number): Q => q`(${raw(c)}.status = 'pending' AND NOT ${IN_FORCE(c, now)})`;

/** The id of entry `l`'s version in force (its newest), or NULL. */
export const CURRENT = (l: string, now: number): Q =>
  q`(SELECT cc.id FROM label_changes cc WHERE cc.label_id = ${raw(l)}.id AND ${IN_FORCE('cc', now)} ORDER BY cc.active_from DESC, cc.id DESC LIMIT 1)`;

/** The id of entry `l`'s waiting version, or NULL. */
export const OPEN = (l: string, now: number): Q => q`(SELECT wc.id FROM label_changes wc WHERE wc.label_id = ${raw(l)}.id AND ${WAITING('wc', now)} ORDER BY wc.proposed_at DESC, wc.id DESC LIMIT 1)`;

/** Which switch keeps entry `l` off: 'entry', 'org', 'all', or NULL (served, if it has a version in force). */
export const OFF_BY = (l: string): Q =>
  raw(`(CASE WHEN ${l}.off_at IS NOT NULL THEN 'entry'
             WHEN EXISTS (SELECT 1 FROM label_controls ko WHERE ko.target = ${l}.org_id AND ko.labels_off = 1) THEN 'org'
             WHEN EXISTS (SELECT 1 FROM label_controls ka WHERE ka.target = '*' AND ka.labels_off = 1) THEN 'all' END)`);
