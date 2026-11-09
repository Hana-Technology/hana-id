-- The admin console's System status page (D425): the console's hourly cron records its last run here, one row per
-- job, so staff can see it ran and whether a step failed (`StaffRpc.health`). Counts and step names only: no user data.
-- The cron writes it after its steps; a console deployed before this migration keeps running (the write fails, is
-- logged and changes nothing else), and `StaffRpc.health` reports the table missing.
CREATE TABLE cron_runs (
  job          TEXT PRIMARY KEY,                 -- 'hourly'
  at_ms        INTEGER NOT NULL,                 -- the run's start (unix ms)
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  failed_steps TEXT                              -- comma-separated step names of a run with a failed step, else NULL
);
