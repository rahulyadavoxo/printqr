-- v37: in the Android app the owner announcement opens as a popup when the app opens.
-- app_settings.announcement_secs = how many seconds the popup stays before it closes by itself (3..120, default 8).
-- Idempotent.
alter table public.app_settings add column if not exists announcement_secs int not null default 8;
alter table public.app_settings drop constraint if exists app_settings_announcement_secs_check;
alter table public.app_settings add constraint app_settings_announcement_secs_check check (announcement_secs between 3 and 120);

create or replace function public.get_app_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', s.announcement, 'announcement_hi', s.announcement_hi, 'announcement_secs', s.announcement_secs,
    'maintenance', s.maintenance, 'maintenance_msg', s.maintenance_msg,
    'min_app_version', s.min_app_version, 'free_counter_limit', s.free_counter_limit,
    'login_design', s.login_design, 'login_designs', s.login_designs,
    'landing_design', s.landing_design, 'landing_designs', s.landing_designs)
  from public.app_settings s where s.id = 1;
$$;
grant execute on function public.get_app_settings() to anon, authenticated;

create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_designs jsonb := '{}'::jsonb;
  v_ok text[] := array['classic', 'modern', 'split', 'bento', 'bentofull'];
  v_land jsonb := '{}'::jsonb;
  v_land_ok text[] := array['classic', 'duo', 'bold'];
  k text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p->>'min_app_version', '') <> '' and (p->>'min_app_version') !~ '^\d+\.\d+\.\d+$' then
    raise exception 'bad version';
  end if;
  if jsonb_typeof(p->'login_designs') = 'object' then
    foreach k in array array['app', 'mweb', 'web', 'desktop'] loop
      if (p->'login_designs'->>k) = any(v_ok) then
        v_designs := v_designs || jsonb_build_object(k, p->'login_designs'->>k);
      end if;
    end loop;
  end if;
  if jsonb_typeof(p->'landing_designs') = 'object' then
    foreach k in array array['app', 'mweb', 'web', 'desktop'] loop
      if (p->'landing_designs'->>k) = any(v_land_ok) then
        v_land := v_land || jsonb_build_object(k, p->'landing_designs'->>k);
      end if;
    end loop;
  end if;
  update public.app_settings set
    announcement     = left(nullif(trim(p->>'announcement'), ''), 300),
    announcement_hi  = left(nullif(trim(p->>'announcement_hi'), ''), 300),
    -- an older admin page sends no popup time: keep the current one
    announcement_secs = case when jsonb_typeof(p->'announcement_secs') = 'number' then least(greatest((p->>'announcement_secs')::numeric::int, 3), 120) else announcement_secs end,
    maintenance      = coalesce((p->>'maintenance')::boolean, false),
    maintenance_msg  = left(nullif(trim(p->>'maintenance_msg'), ''), 300),
    min_app_version  = nullif(trim(p->>'min_app_version'), ''),
    free_counter_limit = least(greatest(coalesce((p->>'free_counter_limit')::int, 0), 0), 20),
    login_design     = case when (p->>'login_design') = any(v_ok) then p->>'login_design' else login_design end,
    login_designs    = case when jsonb_typeof(p->'login_designs') = 'object' then v_designs else login_designs end,
    -- an older admin page sends no landing fields: keep the current ones
    landing_design   = case when (p->>'landing_design') = any(v_land_ok) then p->>'landing_design' else landing_design end,
    landing_designs  = case when jsonb_typeof(p->'landing_designs') = 'object' then v_land else landing_designs end,
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;
