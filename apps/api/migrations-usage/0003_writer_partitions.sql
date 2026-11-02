-- Usage ledger, batch C4 review (M1): monthly partitions no longer wait for the admin Worker (batch C8/C12). Without a
-- partition for the month an event fails (`usage_write_failed` `pg_23514`), and 0001 created only the current month
-- and the next 3. From here the API's hourly cron keeps USAGE_PARTITION_MONTHS (12) months ahead as the writer
-- (apps/api/src/usage/partitions.ts), and this file creates them now.
--
-- `usage.ensure_partitions` is the owner's SECURITY DEFINER function from 0001: bounded (0..24 months ahead), only
-- creates missing `usage.events_YYYY_MM` partitions, never drops or changes one. The writer may now execute it; it
-- still has no table privilege.

GRANT EXECUTE ON FUNCTION usage.ensure_partitions(integer) TO usage_writer;

SELECT usage.ensure_partitions(12);
