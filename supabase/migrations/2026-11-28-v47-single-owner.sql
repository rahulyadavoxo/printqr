-- PrintQR v47 migration (2026-11-28): only ONE Owner admin (the app owner's own login). Every other admin is Support.
--   1. If more than one Owner exists, the oldest Owner (first admin) stays Owner; the rest become Support.
--   2. A unique index makes a second Owner impossible, whatever path tries it.
--   3. New admins default to 'support'.
--   4. admin_set_role(): nobody can be made Owner and the Owner's role cannot be changed; only Support stays.
--      (Remove admin in admin-action also refuses the Owner.)
-- Safe to run more than once. Needs v39 (admins.role, admin_set_role, admin_log).

-- 1. Keep exactly one Owner.
do $$
declare v_keep uuid;
begin
  if (select count(*) from public.admins where role = 'owner') > 1 then
    select user_id into v_keep from public.admins where role = 'owner' order by created_at, user_id limit 1;
    insert into public.admin_log (admin_id, action, shop_id, detail)
      select v_keep, 'role_changed', null, jsonb_build_object('user_id', a.user_id, 'role', 'support', 'before', 'owner', 'reason', 'single_owner_v47')
      from public.admins a where a.role = 'owner' and a.user_id <> v_keep;
    update public.admins set role = 'support' where role = 'owner' and user_id <> v_keep;
  end if;
end $$;

-- 2. At most one Owner row, ever.
create unique index if not exists admins_single_owner on public.admins ((role)) where role = 'owner';

-- 3. A new admin is Support unless said otherwise (and the index above blocks a second Owner anyway).
alter table public.admins alter column role set default 'support';

-- 4. Roles are fixed: the Owner stays Owner, nobody else can become Owner.
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if p_role not in ('owner', 'support') then raise exception 'bad role'; end if;
  select role into v_old from public.admins where user_id = p_user for update;
  if not found then raise exception 'not an admin'; end if;
  if v_old = p_role then return; end if;
  raise exception 'owner fixed';
end $$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
