-- Apply after schema.sql in Supabase SQL Editor. Supabase Cron / pg_cron must be enabled.
-- UTC cron ticks every five minutes; the database function interprets each schedule
-- in its group's IANA time zone, including Asia/Qyzylorda. No external HTTP call.
create extension if not exists pg_cron;
select cron.schedule(
  'queue-for-defence-schedules',
  '*/5 * * * *',
  $$select private.generate_sessions();$$
);
-- Same job name updates an existing job instead of creating another.
select private.generate_sessions();
