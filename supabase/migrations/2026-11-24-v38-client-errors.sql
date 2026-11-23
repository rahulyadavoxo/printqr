-- PrintQR v38 (2026-11-24): every production problem reaches the Admin bell.
--   1. report_client_error(): the website / Android app / Windows app report their own crashes and
--      failed server calls into public.ops_events (level 'client'). The 15-minute health check turns them
--      into the "Errors on website / app" alert. Capped so a broken page can't flood the table.
--   2. ops_alert_set(): GitHub workflows (deploy, migrations, functions, backup, app builds ...) open or
--      close their own alert when a run fails / passes (service role only, from .github/workflows/alerts.yml).
-- Safe to run more than once. Needs v25 (ops_events) and v30 (ops_alerts).

create index if not exists ops_events_source_idx on public.ops_events (source, created_at);

create or replace function public.report_client_error(p_source text, p_message text, p_where text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_src text := case when p_source in ('web', 'app', 'desktop') then 'client-' || p_source else 'client-web' end;
  v_msg text;
begin
  v_msg := left(regexp_replace(regexp_replace(
             coalesce(nullif(trim(p_message), ''), 'unknown error') || coalesce(' @ ' || left(nullif(trim(p_where), ''), 80), ''),
             '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
             'eyJ[A-Za-z0-9._-]{20,}', '<token>', 'g'), 300);
  -- at most 300 client reports per 10 minutes in total, and the same message once per 5 minutes
  if (select count(*) from public.ops_events where source like 'client-%' and created_at > now() - interval '10 minutes') >= 300 then return; end if;
  if exists (select 1 from public.ops_events where source = v_src and message = v_msg and created_at > now() - interval '5 minutes') then return; end if;
  insert into public.ops_events (source, level, message) values (v_src, 'client', v_msg);
end $$;
revoke all on function public.report_client_error(text, text, text) from public;
grant execute on function public.report_client_error(text, text, text) to anon, authenticated;

create or replace function public.ops_alert_set(p_key text, p_title text, p_detail text, p_bad boolean)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint;
begin
  select id into v_id from public.ops_alerts where key = p_key and closed_at is null;
  if p_bad then
    if v_id is null then
      insert into public.ops_alerts (key, title, detail) values (left(p_key, 60), left(p_title, 120), left(coalesce(p_detail, ''), 500));
      return 'opened';
    end if;
    update public.ops_alerts set last_seen = now(), detail = left(coalesce(p_detail, ''), 500) where id = v_id;
    return 'still';
  elsif v_id is not null then
    update public.ops_alerts set closed_at = now() where id = v_id;
    return 'closed';
  end if;
  return 'ok';
end $$;
revoke all on function public.ops_alert_set(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.ops_alert_set(text, text, text, boolean) to service_role;
