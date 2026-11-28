-- PrintQR v48 migration (2026-11-28): three admin roles.
--   owner   : the app owner's own login, only one (v47), cannot be changed or removed. Everything.
--   admin   : support's access + Pro / plan changes, block / unblock, shop edits, QR reset, coupons, push / reach,
--             growth, overview, password reset, disable login, delete files.
--   support : support inbox, spam, errors, read shops / users / orders (unchanged).
--   Owner only: payments (list, shop payment history, export), app settings, admin list / roles, and in
--   admin-action: add or remove admins, delete account, cancel subscription.
-- How: is_owner_admin() now means "owner or admin" (every function that checked it now lets admins in);
-- the owner-only functions are re-created below with the new is_app_owner().
-- Safe to run more than once. Needs v39, v42, v47.

-- 1. Role values
alter table public.admins drop constraint if exists admins_role_check;
alter table public.admins add constraint admins_role_check check (role in ('owner', 'admin', 'support'));

-- 2. Helpers
create or replace function public.is_app_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() and exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'owner');
$$;
revoke all on function public.is_app_owner() from public, anon;
grant execute on function public.is_app_owner() to authenticated, service_role;

-- Owner or Admin (name kept from v39 so every function that already checks it lets Admins in).
create or replace function public.is_owner_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() and exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role in ('owner', 'admin'));
$$;
revoke all on function public.is_owner_admin() from public, anon;
grant execute on function public.is_owner_admin() to authenticated, service_role;

-- 3. Roles: the Owner stays Owner; the Owner can switch others between Admin and Support.
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_app_owner() then raise exception 'not allowed'; end if;
  if p_role not in ('owner', 'admin', 'support') then raise exception 'bad role'; end if;
  select role into v_old from public.admins where user_id = p_user for update;
  if not found then raise exception 'not an admin'; end if;
  if v_old = p_role then return; end if;
  if v_old = 'owner' or p_role = 'owner' then raise exception 'owner fixed'; end if;
  update public.admins set role = p_role where user_id = p_user;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'role_changed', null, jsonb_build_object('user_id', p_user, 'role', p_role, 'before', v_old));
end $$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- 4. Owner-only functions (latest bodies, only the role check changed to is_app_owner()).

-- from 2026-11-24-v39-admin-tools.sql
create or replace function public.admin_list()
returns table (user_id uuid, email text, role text, created_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_owner() then raise exception 'not allowed'; end if;
  return query
  select a.user_id, coalesce(u.email, u.phone)::text, a.role, a.created_at, a.user_id = auth.uid()
  from public.admins a left join auth.users u on u.id = a.user_id
  order by a.created_at;
end $$;
revoke all on function public.admin_list() from public, anon;
grant execute on function public.admin_list() to authenticated;

-- from 2026-11-24-v39-admin-tools.sql
create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_app_owner() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'subs', coalesce((select jsonb_agg(x order by x.plan_expires_at desc nulls last) from (
      select s.id as shop_id, s.name, coalesce(nullif(u.email, '')::text, '+' || nullif(u.phone, '')::text) as email,
        s.plan, s.plan_period, s.subscription_status,
        s.plan_expires_at, s.razorpay_subscription_id as sub_id, public.is_pro(s) as is_pro
      from public.shops s left join auth.users u on u.id = s.owner_id
      where s.razorpay_subscription_id is not null) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.received_at desc) from (
      select event, received_at from public.billing_events order by received_at desc limit 30) e), '[]'::jsonb)
  );
end $$;

-- from 2026-11-24-v39-admin-tools.sql
create or replace function public.admin_export(p_kind text, p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_a timestamptz := coalesce((p_from::timestamp at time zone 'Asia/Kolkata'), '-infinity'::timestamptz);
  v_b timestamptz := coalesce(((p_to + 1)::timestamp at time zone 'Asia/Kolkata'), 'infinity'::timestamptz);
  v_out jsonb;
begin
  if not public.is_app_owner() then raise exception 'not allowed'; end if;
  if p_kind = 'shops' then
    select coalesce(jsonb_agg(r order by r->>'created_at'), '[]'::jsonb) into v_out from (
      select jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'owner', coalesce(u.email, u.phone), 'phone', s.phone,
        'address', s.address, 'plan', s.plan, 'is_pro', public.is_pro(s), 'plan_period', s.plan_period, 'plan_expires_at', s.plan_expires_at,
        'subscription_status', s.subscription_status, 'blocked', s.blocked, 'created_at', s.created_at,
        'orders', (select count(*) from public.orders o where o.shop_id = s.id and o.status <> 'uploading')) as r
      from public.shops s left join auth.users u on u.id = s.owner_id
      where s.created_at >= v_a and s.created_at < v_b order by s.created_at limit 20000) x;
  elsif p_kind = 'orders' then
    select coalesce(jsonb_agg(r order by r->>'created_at'), '[]'::jsonb) into v_out from (
      select jsonb_build_object('id', o.id, 'shop', s.name, 'shop_slug', s.slug, 'token', o.token, 'status', o.status, 'total', o.total,
        'counter', o.counter_name, 'files', (select count(*) from public.order_files f where f.order_id = o.id),
        'pages', (select coalesce(sum(f.pages_to_print * f.copies), 0) from public.order_files f where f.order_id = o.id),
        'paid_at', o.paid_at, 'created_at', o.created_at) as r
      from public.orders o join public.shops s on s.id = o.shop_id
      where o.status <> 'uploading' and o.created_at >= v_a and o.created_at < v_b order by o.created_at limit 20000) x;
  elsif p_kind = 'payments' then
    select coalesce(jsonb_agg(r order by r->>'paid_at'), '[]'::jsonb) into v_out from (
      select jsonb_build_object('payment_id', p.payment_id, 'shop', s.name, 'shop_slug', s.slug, 'tier', p.tier, 'period', p.period,
        'amount_rupees', round(p.amount / 100.0, 2), 'currency', p.currency, 'subscription_id', p.subscription_id,
        'period_start', p.period_start, 'period_end', p.period_end, 'paid_at', p.paid_at) as r
      from public.billing_payments p join public.shops s on s.id = p.shop_id
      where p.paid_at >= v_a and p.paid_at < v_b order by p.paid_at limit 20000) x;
  else
    raise exception 'bad kind';
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'export', null, jsonb_build_object('kind', p_kind, 'from', p_from, 'to', p_to, 'rows', jsonb_array_length(v_out)));
  return v_out;
end $$;
revoke all on function public.admin_export(text, date, date) from public, anon;
grant execute on function public.admin_export(text, date, date) to authenticated;

-- from 2026-11-24-v42-coupon-switch.sql
create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_designs jsonb := '{}'::jsonb;
  v_ok text[] := array['classic', 'modern', 'split', 'bento', 'bentofull'];
  v_land jsonb := '{}'::jsonb;
  v_land_ok text[] := array['classic', 'duo', 'bold'];
  k text;
begin
  if not public.is_app_owner() then raise exception 'not allowed'; end if;
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
    -- v42: an older admin page sends no coupon switch: keep the current one
    coupons_enabled  = case when jsonb_typeof(p->'coupons_enabled') = 'boolean' then (p->>'coupons_enabled')::boolean else coupons_enabled end,
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;
revoke all on function public.admin_set_settings(jsonb) from public, anon;
grant execute on function public.admin_set_settings(jsonb) to authenticated;

-- from 2026-11-24-v39-admin-tools.sql
create or replace function public.admin_shop_view(p_shop uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_s public.shops; v_out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into v_s from public.shops where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  v_out := jsonb_build_object(
    'shop', jsonb_build_object('id', v_s.id, 'name', v_s.name, 'slug', v_s.slug, 'address', v_s.address, 'phone', v_s.phone,
      'upi', v_s.upi_id is not null, 'is_open', v_s.is_open, 'rates', v_s.rates, 'auto_delete_hours', v_s.auto_delete_hours,
      'hours', v_s.hours, 'paper_sheets', v_s.paper_sheets, 'brand_color', v_s.brand_color, 'logo', v_s.logo_url is not null,
      'plan', v_s.plan, 'is_pro', public.is_pro(v_s), 'plan_period', v_s.plan_period, 'plan_expires_at', v_s.plan_expires_at,
      'subscription_status', v_s.subscription_status, 'blocked', v_s.blocked, 'blocked_reason', v_s.blocked_reason, 'created_at', v_s.created_at),
    'owner_email', (select coalesce(u.email, u.phone) from auth.users u where u.id = v_s.owner_id),
    'counters', coalesce((select jsonb_agg(c.name order by c.created_at) from public.counters c where c.shop_id = p_shop), '[]'::jsonb),
    'staff', (select count(*) from public.shop_staff st where st.shop_id = p_shop),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('token', o.token, 'status', o.status, 'total', o.total,
        'counter', o.counter_name, 'created_at', o.created_at, 'files_deleted', o.files_deleted,
        'files', (select count(*) from public.order_files f where f.order_id = o.id),
        'pages', (select coalesce(sum(f.pages_to_print * f.copies), 0) from public.order_files f where f.order_id = o.id)) order by o.created_at desc)
      from (select * from public.orders where shop_id = p_shop and status <> 'uploading' order by created_at desc limit 50) o), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'status', t.status, 'message', left(t.message, 200), 'created_at', t.created_at) order by t.created_at desc)
      from (select * from public.support_tickets where shop_id = p_shop order by created_at desc limit 10) t), '[]'::jsonb),
    'payments', case when public.is_app_owner() then coalesce((select jsonb_agg(jsonb_build_object('amount', bp.amount, 'tier', bp.tier,
        'period', bp.period, 'paid_at', bp.paid_at) order by bp.paid_at desc)
      from (select * from public.billing_payments where shop_id = p_shop order by paid_at desc limit 20) bp), '[]'::jsonb) else null end);
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'shop_viewed', p_shop, '{}'::jsonb);
  return v_out;
end $$;
revoke all on function public.admin_shop_view(uuid) from public, anon;
grant execute on function public.admin_shop_view(uuid) to authenticated;
