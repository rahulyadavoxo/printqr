-- PrintQR v30 (2026-11-22): health check from Supabase itself every 15 minutes (pg_cron + pg_net),
-- because GitHub's schedule runs it only a few times a day. Problems are kept in public.ops_alerts,
-- shown in the Admin panel and sent as a push notification to every admin's phones / browsers.
-- The "Health check" GitHub workflow stays as a backup (it also notices when Supabase itself is down).
-- Safe to run more than once. Needs v4 (pg_cron, pg_net, private.cron_tokens), v14 (push_tokens), v25 (ops_health).

alter table public.app_settings add column if not exists storage_limit_mb int not null default 1024;  -- Supabase Free; Pro = 102400
alter table public.app_settings add column if not exists db_limit_mb int not null default 500;         -- Supabase Free; Pro = 8192
alter table public.app_settings add column if not exists health_checked_at timestamptz;

create table if not exists public.ops_alerts (
  id bigint generated always as identity primary key,
  key text not null,
  title text not null,
  detail text not null default '',
  opened_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  notified_at timestamptz,
  closed_at timestamptz
);
create unique index if not exists ops_alerts_one_open on public.ops_alerts (key) where closed_at is null;
create index if not exists ops_alerts_time on public.ops_alerts (opened_at desc);
alter table public.ops_alerts enable row level security;  -- no policies: admins read through admin_alerts()
revoke all on public.ops_alerts from public, anon, authenticated;
grant select, insert, update, delete on public.ops_alerts to service_role;
grant select, update on public.app_settings to service_role;
grant select on public.push_tokens to service_role;
grant select on public.admins to service_role;

-- Admin panel (bell): last check time + open problems + problems fixed in the last 30 days (max 50).
create or replace function public.admin_alerts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'checked_at', (select health_checked_at from public.app_settings where id = 1),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('key', a.key, 'title', a.title, 'detail', a.detail,
        'opened_at', a.opened_at, 'last_seen', a.last_seen, 'closed_at', a.closed_at) order by a.closed_at nulls first, a.opened_at desc)
      from (select * from public.ops_alerts where closed_at is null or closed_at > now() - interval '30 days' order by closed_at nulls first, opened_at desc limit 50) a), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_alerts() from public, anon;
grant execute on function public.admin_alerts() to authenticated;

delete from public.ops_alerts where closed_at < now() - interval '60 days';

insert into private.cron_tokens (name, token)
values ('health', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'printqr-health') then
    perform cron.unschedule('printqr-health');
  end if;
end $$;

select cron.schedule(
  'printqr-health',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/health-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select token from private.cron_tokens where name = 'health')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

notify pgrst, 'reload schema';
