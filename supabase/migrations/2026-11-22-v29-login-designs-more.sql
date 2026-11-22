-- v29: three more login designs for computers: split (lime side panel), bento (card + tiles), bentofull (full-screen tiles).
alter table public.app_settings drop constraint if exists app_settings_login_design_check;
alter table public.app_settings add constraint app_settings_login_design_check
  check (login_design in ('classic', 'modern', 'split', 'bento', 'bentofull'));

create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_designs jsonb := '{}'::jsonb;
  v_ok text[] := array['classic', 'modern', 'split', 'bento', 'bentofull'];
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
  update public.app_settings set
    announcement     = left(nullif(trim(p->>'announcement'), ''), 300),
    announcement_hi  = left(nullif(trim(p->>'announcement_hi'), ''), 300),
    maintenance      = coalesce((p->>'maintenance')::boolean, false),
    maintenance_msg  = left(nullif(trim(p->>'maintenance_msg'), ''), 300),
    min_app_version  = nullif(trim(p->>'min_app_version'), ''),
    free_counter_limit = least(greatest(coalesce((p->>'free_counter_limit')::int, 0), 0), 20),
    login_design     = case when (p->>'login_design') = any(v_ok) then p->>'login_design' else login_design end,
    login_designs    = case when jsonb_typeof(p->'login_designs') = 'object' then v_designs else login_designs end,
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;
