-- PrintQR v4 migration (2026-11-17): run auto-delete from Supabase itself (pg_cron + pg_net),
-- every 15 minutes, instead of relying on GitHub Actions' unreliable hourly schedule.
-- Safe to run more than once. Run AFTER the cleanup-files Edge Function is deployed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- A random token only the cron job and the Edge Function know. Never exposed to the API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.cron_tokens (
  name text primary key,
  token text not null
);
revoke all on private.cron_tokens from public, anon, authenticated;
insert into private.cron_tokens (name, token)
values ('cleanup', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- The Edge Function (service role) asks: is this the right token?
create or replace function public.check_cron_token(p_name text, p_token text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.cron_tokens where name = p_name and token = p_token);
$$;
revoke all on function public.check_cron_token(text, text) from public, anon, authenticated;
grant execute on function public.check_cron_token(text, text) to service_role;

-- (Re)create the schedule: every 15 minutes.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'printqr-cleanup') then
    perform cron.unschedule('printqr-cleanup');
  end if;
end $$;

select cron.schedule(
  'printqr-cleanup',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/cleanup-files',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select token from private.cron_tokens where name = 'cleanup')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

notify pgrst, 'reload schema';

-- Check it is working (after ~15 min):
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'printqr-cleanup') order by start_time desc limit 5;
--   select id, status_code, content from net._http_response order by created desc limit 5;
