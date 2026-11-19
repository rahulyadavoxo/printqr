-- PrintQR v13 migration (2026-11-19): full admin panel.
--  * App settings (announcement, maintenance mode, minimum app version, free counter limit).
--  * Users, Orders, Payments, Spam watch (top shops / networks, blocked networks, customer reports).
--  * Shop tools: reset QR codes, change name, remove photo.
-- Needs v12 first. Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

-- ---------- app settings (one row) ----------
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  announcement text,
  announcement_hi text,
  maintenance boolean not null default false,
  maintenance_msg text,
  min_app_version text,
  free_counter_limit int not null default 0 check (free_counter_limit between 0 and 20),
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.get_app_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', s.announcement, 'announcement_hi', s.announcement_hi,
    'maintenance', s.maintenance, 'maintenance_msg', s.maintenance_msg,
    'min_app_version', s.min_app_version, 'free_counter_limit', s.free_counter_limit)
  from public.app_settings s where s.id = 1;
$$;
grant execute on function public.get_app_settings() to anon, authenticated;

-- The free counter limit now comes from settings (was a fixed 0).
create or replace function public.free_counter_limit()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select free_counter_limit from public.app_settings where id = 1), 0)
$$;
grant execute on function public.free_counter_limit() to anon, authenticated, service_role;

-- ---------- blocked networks + customer reports ----------
create table if not exists public.blocked_ips (
  ip_hash text primary key,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.blocked_ips enable row level security;
revoke all on public.blocked_ips from anon, authenticated;

create table if not exists public.shop_reports (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  reason text not null,
  ip_hash text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists shop_reports_open on public.shop_reports (resolved, created_at desc);
alter table public.shop_reports enable row level security;
revoke all on public.shop_reports from anon, authenticated;

-- Customer reports a shop from its upload page. At most 5 reports a day per network.
create or replace function public.report_shop(p_slug text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_ip text := coalesce(public.request_ip_hash(), 'unknown');
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  if char_length(v_reason) < 3 then raise exception 'Please write what is wrong'; end if;
  select id into v_shop from public.shops where slug = p_slug;
  if v_shop is null then raise exception 'Shop not found'; end if;
  if (select count(*) from public.shop_reports where ip_hash = v_ip and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many reports. Please try again tomorrow.';
  end if;
  insert into public.shop_reports (shop_id, reason, ip_hash) values (v_shop, v_reason, v_ip);
end $$;
grant execute on function public.report_shop(text, text) to anon, authenticated;

-- New orders stop for blocked shops, blocked networks and maintenance mode.
create or replace function public.orders_block_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.blocked) then
    raise exception 'Shop not found';
  end if;
  if coalesce((select maintenance from public.app_settings where id = 1), false) then
    raise exception 'New orders are paused for a short while. Please try again later.';
  end if;
  if exists (select 1 from public.blocked_ips b where b.ip_hash = public.request_ip_hash()) then
    raise exception 'Too many orders from this network. Please wait a few minutes and try again.';
  end if;
  return new;
end $$;
drop trigger if exists orders_block_guard on public.orders;
create trigger orders_block_guard before insert on public.orders
  for each row execute function public.orders_block_guard();

-- ---------- overview (adds payments, cleanup, reports, stuck orders) ----------
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
  v_cron timestamptz;
  v_cron_fail int;
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
    'pay_failed',    (select count(*) from public.shops where subscription_status in ('halted', 'pending')),
    'blocked',       (select count(*) from public.shops where blocked),
    'orders_today',  (select count(*) from public.orders where status <> 'uploading' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'orders_week',   (select count(*) from public.orders where status <> 'uploading' and created_at >= now() - interval '7 days'),
    'orders_total',  (select count(*) from public.orders where status <> 'uploading'),
    'orders_stuck',  (select count(*) from public.orders where not files_deleted and
                        ((status = 'uploading' and created_at < now() - interval '1 hour')
                         or (status in ('received', 'printing') and created_at < now() - interval '1 day'))),
    'storage_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = 'uploads'),
    'files_waiting', (select count(*) from public.orders where not files_deleted and status <> 'uploading'),
    'reports_open',  (select count(*) from public.shop_reports where not resolved),
    'users_total',   (select count(*) from auth.users)
  ) into r;
  begin
    select max(d.end_time) filter (where d.status = 'succeeded'),
           count(*) filter (where d.status = 'failed' and d.start_time > now() - interval '1 day')
      into v_cron, v_cron_fail
    from cron.job_run_details d where d.start_time > now() - interval '7 days';
    r := r || jsonb_build_object('cleanup_last', v_cron, 'cleanup_failed_day', v_cron_fail);
  exception when others then
    r := r || jsonb_build_object('cleanup_last', null, 'cleanup_failed_day', null);
  end;
  return r;
end $$;

-- ---------- users ----------
create or replace function public.admin_users(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  confirmed boolean, banned boolean, shop_id uuid, shop_name text, is_admin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select u.id, u.email::text, u.created_at, u.last_sign_in_at,
    u.email_confirmed_at is not null, coalesce(u.banned_until > now(), false),
    s.id, s.name, exists (select 1 from public.admins a where a.user_id = u.id)
  from auth.users u left join public.shops s on s.owner_id = u.id
  where coalesce(p_q, '') = '' or u.email ilike '%' || p_q || '%' or coalesce(s.name, '') ilike '%' || p_q || '%'
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------- orders (details only; files are never opened here) ----------
-- p_filter: 'all' | 'stuck' | 'files' (files still stored)
create or replace function public.admin_orders(p_q text default '', p_filter text default 'all', p_limit int default 50, p_offset int default 0)
returns table (id uuid, token int, shop_id uuid, shop_name text, status text, total numeric, files int, bytes bigint,
  files_deleted boolean, counter_name text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select o.id, o.token, o.shop_id, s.name, o.status, o.total,
    (select count(*)::int from public.order_files f where f.order_id = o.id),
    (select coalesce(sum(f.size_bytes), 0)::bigint from public.order_files f where f.order_id = o.id),
    o.files_deleted, o.counter_name, o.created_at, o.updated_at
  from public.orders o join public.shops s on s.id = o.shop_id
  where (coalesce(p_q, '') = '' or s.name ilike '%' || p_q || '%' or s.slug ilike '%' || p_q || '%' or o.token::text = trim(p_q))
    and (coalesce(p_filter, 'all') = 'all'
      or (p_filter = 'files' and not o.files_deleted and o.status <> 'uploading')
      or (p_filter = 'stuck' and not o.files_deleted and
          ((o.status = 'uploading' and o.created_at < now() - interval '1 hour')
           or (o.status in ('received', 'printing') and o.created_at < now() - interval '1 day'))))
  order by o.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---------- payments ----------
create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'subs', coalesce((select jsonb_agg(x order by x.plan_expires_at desc nulls last) from (
      select s.id as shop_id, s.name, u.email::text as email, s.plan_period, s.subscription_status,
        s.plan_expires_at, s.razorpay_subscription_id as sub_id, public.is_pro(s) as is_pro
      from public.shops s left join auth.users u on u.id = s.owner_id
      where s.razorpay_subscription_id is not null) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.received_at desc) from (
      select event, received_at from public.billing_events order by received_at desc limit 30) e), '[]'::jsonb)
  );
end $$;

-- ---------- spam watch ----------
create or replace function public.admin_spam()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'shops', coalesce((select jsonb_agg(x) from (
      select s.id as shop_id, s.name, s.created_at, s.blocked, count(o.id) as orders_day
      from public.orders o join public.shops s on s.id = o.shop_id
      where o.created_at > now() - interval '1 day'
      group by s.id order by count(o.id) desc limit 10) x), '[]'::jsonb),
    'networks', coalesce((select jsonb_agg(x) from (
      select r.ip_hash, count(*) as orders_day, max(r.created_at) as last_at,
        exists (select 1 from public.blocked_ips b where b.ip_hash = r.ip_hash) as blocked
      from public.order_rate r where r.created_at > now() - interval '1 day'
      group by r.ip_hash order by count(*) desc limit 10) x), '[]'::jsonb),
    'blocked_ips', coalesce((select jsonb_agg(b order by b.created_at desc) from public.blocked_ips b), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(x order by x.created_at desc) from (
      select r.id, r.shop_id, s.name, s.slug, r.reason, r.created_at, r.resolved
      from public.shop_reports r join public.shops s on s.id = r.shop_id
      order by r.resolved, r.created_at desc limit 50) x), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_block_ip(p_hash text, p_block boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p_hash, '') !~ '^[0-9a-f]{32}$' then raise exception 'bad network id'; end if;
  if p_block then
    insert into public.blocked_ips (ip_hash, reason) values (p_hash, left(nullif(trim(p_reason), ''), 200))
    on conflict (ip_hash) do update set reason = excluded.reason;
  else
    delete from public.blocked_ips where ip_hash = p_hash;
  end if;
  insert into public.admin_log (admin_id, action, detail)
    values (auth.uid(), case when p_block then 'ip_blocked' else 'ip_unblocked' end, jsonb_build_object('ip', left(p_hash, 10), 'reason', p_reason));
end $$;

create or replace function public.admin_resolve_report(p_id bigint, p_resolved boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.shop_reports set resolved = coalesce(p_resolved, true) where id = p_id returning shop_id into v_shop;
  if v_shop is null then raise exception 'Report not found'; end if;
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'report_resolved', v_shop, jsonb_build_object('report', p_id));
end $$;

-- ---------- shop tools ----------
-- Old QR codes stop working; the owner's QR tab makes fresh ones (posters must be re-printed).
create or replace function public.admin_reset_qr(p_shop uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  delete from public.qr_links where shop_id = p_shop;
  get diagnostics n = row_count;
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'qr_reset', p_shop, jsonb_build_object('codes', n));
  return n;
end $$;

create or replace function public.admin_edit_shop(p_shop uuid, p_name text default null, p_remove_logo boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select name into v_old from public.shops where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set
    name = coalesce(nullif(trim(p_name), ''), name),
    logo_url = case when p_remove_logo then null else logo_url end
  where id = p_shop;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'shop_edited', p_shop, jsonb_build_object('old_name', v_old, 'new_name', nullif(trim(p_name), ''), 'logo_removed', p_remove_logo));
end $$;

-- ---------- settings ----------
create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if coalesce(p->>'min_app_version', '') <> '' and (p->>'min_app_version') !~ '^\d+\.\d+\.\d+$' then
    raise exception 'bad version';
  end if;
  update public.app_settings set
    announcement     = left(nullif(trim(p->>'announcement'), ''), 300),
    announcement_hi  = left(nullif(trim(p->>'announcement_hi'), ''), 300),
    maintenance      = coalesce((p->>'maintenance')::boolean, false),
    maintenance_msg  = left(nullif(trim(p->>'maintenance_msg'), ''), 300),
    min_app_version  = nullif(trim(p->>'min_app_version'), ''),
    free_counter_limit = least(greatest(coalesce((p->>'free_counter_limit')::int, 0), 0), 20),
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;

-- Log rows also show actions with no shop (settings, networks).
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

-- service role (admin-action Edge Function) writes its own log rows
grant insert on public.admin_log to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_users(text, int, int)', 'admin_orders(text, text, int, int)', 'admin_payments()', 'admin_spam()',
    'admin_block_ip(text, boolean, text)', 'admin_resolve_report(bigint, boolean)', 'admin_reset_qr(uuid)',
    'admin_edit_shop(uuid, text, boolean)', 'admin_set_settings(jsonb)', 'admin_overview()', 'admin_recent_log(int)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
