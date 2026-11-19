-- PrintQR v12 migration (2026-11-19): admin panel (#/admin).
-- Admins are listed in public.admins. Every admin function checks is_admin() inside the database,
-- so hiding the page is not the security: a non-admin calling these functions gets 'not allowed'.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.
-- LAST LINE: put your own login email there so you become the admin.

-- ---------- who is admin ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- what admins did ----------
create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  admin_id uuid,
  action text not null,
  shop_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_log enable row level security;
revoke all on public.admin_log from anon, authenticated;

-- ---------- blocking a shop ----------
alter table public.shops add column if not exists blocked boolean not null default false;
alter table public.shops add column if not exists blocked_reason text;

-- Owners cannot change plan or block columns themselves (admin functions run as the definer, so they can).
create or replace function public.shops_guard_plan()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.plan := 'free';
      new.plan_period := null;
      new.plan_expires_at := null;
      new.razorpay_subscription_id := null;
      new.subscription_status := null;
      new.blocked := false;
      new.blocked_reason := null;
    else
      new.plan := old.plan;
      new.plan_period := old.plan_period;
      new.plan_expires_at := old.plan_expires_at;
      new.razorpay_subscription_id := old.razorpay_subscription_id;
      new.subscription_status := old.subscription_status;
      new.blocked := old.blocked;
      new.blocked_reason := old.blocked_reason;
    end if;
  end if;
  return new;
end $$;

-- A blocked shop's QR page shows "Shop not found" and takes no orders.
create or replace function public.get_shop_public(p_slug text)
returns table (id uuid, name text, address text, is_open boolean, rates jsonb, upi_id text, is_pro boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.address, s.is_open,
    case when public.is_pro(s) then jsonb_build_object('passport_sheet', 40) || s.rates
         else s.rates - 'passport_sheet' end,
    s.upi_id, public.is_pro(s)
  from public.shops s where s.slug = p_slug and not s.blocked;
$$;
grant execute on function public.get_shop_public(text) to anon, authenticated;

create or replace function public.orders_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.blocked) then
    raise exception 'Shop not found';
  end if;
  return new;
end $$;
drop trigger if exists orders_block_guard on public.orders;
create trigger orders_block_guard before insert on public.orders
  for each row execute function public.orders_block_guard();

-- ---------- admin functions ----------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'shops_total',   (select count(*) from public.shops),
    'shops_today',   (select count(*) from public.shops where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'shops_week',    (select count(*) from public.shops where created_at >= now() - interval '7 days'),
    'pro_active',    (select count(*) from public.shops s where public.is_pro(s)),
    'pro_paid',      (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null),
    'pro_monthly',   (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'monthly'),
    'pro_yearly',    (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null and s.plan_period = 'yearly'),
    'blocked',       (select count(*) from public.shops where blocked),
    'orders_today',  (select count(*) from public.orders where status <> 'uploading' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'orders_week',   (select count(*) from public.orders where status <> 'uploading' and created_at >= now() - interval '7 days'),
    'orders_total',  (select count(*) from public.orders where status <> 'uploading'),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'uploads'),
    'files_waiting', (select count(*) from public.orders where not files_deleted and status <> 'uploading')
  ) into r;
  return r;
end $$;

create or replace function public.admin_shops(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, name text, slug text, owner_email text, phone text, created_at timestamptz,
  plan text, plan_period text, plan_expires_at timestamptz, is_pro boolean, paid boolean, subscription_status text,
  blocked boolean, blocked_reason text, is_open boolean,
  counters int, orders_total int, orders_week int, last_order_at timestamptz, scans int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.slug, u.email::text, s.phone, s.created_at,
    s.plan, s.plan_period, s.plan_expires_at, public.is_pro(s), s.razorpay_subscription_id is not null, s.subscription_status,
    s.blocked, s.blocked_reason, s.is_open,
    (select count(*)::int from public.counters c where c.shop_id = s.id),
    (select count(*)::int from public.orders o where o.shop_id = s.id and o.status <> 'uploading'),
    (select count(*)::int from public.orders o where o.shop_id = s.id and o.status <> 'uploading' and o.created_at >= now() - interval '7 days'),
    (select max(o.created_at) from public.orders o where o.shop_id = s.id and o.status <> 'uploading'),
    coalesce((select sum(q.scans)::int from public.qr_links q where q.shop_id = s.id), 0)
  from public.shops s
  left join auth.users u on u.id = s.owner_id
  where coalesce(p_q, '') = ''
     or s.name ilike '%' || p_q || '%'
     or s.slug ilike '%' || p_q || '%'
     or u.email ilike '%' || p_q || '%'
     or coalesce(s.phone, '') ilike '%' || p_q || '%'
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- p_days > 0: give or extend Pro by that many days (added after the current end if still active).
-- p_days = 0: remove Pro now. Razorpay keeps billing a paid shop until it is cancelled there.
create or replace function public.admin_set_pro(p_shop uuid, p_days int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_end timestamptz;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_days is null or p_days < 0 or p_days > 3660 then raise exception 'bad days'; end if;
  select * into v_shop from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  if p_days = 0 then
    update public.shops set plan = 'free', plan_expires_at = now() where id = p_shop;
    v_end := now();
  else
    v_end := greatest(coalesce(v_shop.plan_expires_at, now()), now()) + make_interval(days => p_days);
    update public.shops set plan = 'pro', plan_expires_at = v_end where id = p_shop;
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_days = 0 then 'pro_removed' else 'pro_given' end, p_shop,
            jsonb_build_object('days', p_days, 'until', v_end, 'before', v_shop.plan_expires_at));
  return v_end;
end $$;

create or replace function public.admin_set_blocked(p_shop uuid, p_blocked boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.shops set blocked = coalesce(p_blocked, false),
    blocked_reason = case when p_blocked then left(nullif(trim(p_reason), ''), 200) else null end
  where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_blocked then 'blocked' else 'unblocked' end, p_shop, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.admin_recent_log(p_limit int default 30)
returns table (created_at timestamptz, action text, shop_id uuid, shop_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select l.created_at, l.action, l.shop_id, s.name, l.detail
  from public.admin_log l left join public.shops s on s.id = l.shop_id
  order by l.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 200);
end $$;

revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_shops(text, int, int) from public, anon;
revoke all on function public.admin_set_pro(uuid, int) from public, anon;
revoke all on function public.admin_set_blocked(uuid, boolean, text) from public, anon;
revoke all on function public.admin_recent_log(int) from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_shops(text, int, int) to authenticated;
grant execute on function public.admin_set_pro(uuid, int) to authenticated;
grant execute on function public.admin_set_blocked(uuid, boolean, text) to authenticated;
grant execute on function public.admin_recent_log(int) to authenticated;

notify pgrst, 'reload schema';

-- ---------- make yourself admin: change the email to your PrintQR login email ----------
insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('YOUR_EMAIL@gmail.com')
on conflict do nothing;
