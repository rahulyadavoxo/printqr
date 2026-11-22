-- v28: login page design per platform. login_designs = {"app":..,"mweb":..,"web":..,"desktop":..}
-- (each 'classic' or 'modern'); a missing key falls back to login_design (v27).
alter table public.app_settings add column if not exists login_designs jsonb not null default '{}'::jsonb;

create or replace function public.get_app_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', s.announcement, 'announcement_hi', s.announcement_hi,
    'maintenance', s.maintenance, 'maintenance_msg', s.maintenance_msg,
    'min_app_version', s.min_app_version, 'free_counter_limit', s.free_counter_limit,
    'login_design', s.login_design, 'login_designs', s.login_designs)
  from public.app_settings s where s.id = 1;
$$;
grant execute on function public.get_app_settings() to anon, authenticated;

create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_designs jsonb := '{}'::jsonb;
  k text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p->>'min_app_version', '') <> '' and (p->>'min_app_version') !~ '^\d+\.\d+\.\d+$' then
    raise exception 'bad version';
  end if;
  if jsonb_typeof(p->'login_designs') = 'object' then
    foreach k in array array['app', 'mweb', 'web', 'desktop'] loop
      if (p->'login_designs'->>k) in ('classic', 'modern') then
        v_designs := v_designs || jsonb_build_object(k, p->'login_designs'->>k);
      end if;
    end loop;
  end if;
  update public.app_settings set
    announcement     = left(nullif(trim(p->>'announcement'), ''), 300),
    announcement_hi  = left(nullif(trim(p->>'announcement_hi'), ''), 300),
    maintenance      = coalesce((p->>'maintenance')::boolean, false),
    maintenance_msg  = left(nullif(trim(p->>'maintenance_msg'), ''), 300),
    min_app_version  = nullif(trim(p->>'min_app_version'), ''),
    free_counter_limit = least(greatest(coalesce((p->>'free_counter_limit')::int, 0), 0), 20),
    login_design     = case when p->>'login_design' in ('classic', 'modern') then p->>'login_design' else login_design end,
    -- an older admin page sends no login_designs: keep the current ones
    login_designs    = case when jsonb_typeof(p->'login_designs') = 'object' then v_designs else login_designs end,
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;
