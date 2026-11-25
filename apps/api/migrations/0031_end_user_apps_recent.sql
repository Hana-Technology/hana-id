-- D925 after PR 153's review: one index, so the linking view's per-person list of apps (`directory/link.ts`
-- `linkStatement`) and the staff Support ID lookup's (`directory/support.ts` `userAppsStatement`) read a person's apps
-- newest first and stop at their cap (100 apps), instead of reading every row of a person on more apps and sorting
-- them. Additive: no table is rebuilt, no trigger or view touched (0031's test compares them by `sqlite_schema`), no row
-- written. The API works without it (slower for a person on many apps), so it may be applied before or after the API
-- that reads it; in name order after 0030 (it indexes 0030's table). Applied by the Tech Lead with the others.
CREATE INDEX end_user_apps_user_recent ON end_user_apps (user_id, last_seen_at DESC, app_id);
