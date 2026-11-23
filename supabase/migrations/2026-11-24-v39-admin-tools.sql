-- PrintQR v39 (2026-11-24): Admin panel tools.
--   1. Admin roles: public.admins.role 'owner' | 'support' (existing admins = owner). is_owner_admin() helper;
--      money / settings / shop-changing admin functions are owner-only from now on.
--   2. Error viewer: client error reports keep route, app version, device (user agent) and stack (ops_events).
--   3. Growth graphs: admin_growth() daily series (new shops, orders, pages, payments) for the last 30 days.
--   4. Support inbox: shops send problems / feedback (support_tickets); admins reply and mark solved; the reply
--      reaches the shop as an in-app notice (shop_notices).
--   5. Coupon codes: free Pro days (coupons, coupon_redemptions); one redemption per shop per code.
--   6. Expiring plans + inactive shops lists; reminders / nudges (push + in-app notice) are sent by admin-action.
--   7. Targeted push: push_segment_owners() for the admin-action Edge Function (service role only).
--   8. View as shop: admin_shop_view() read-only summary.
--   9. CSV export: admin_export().
--  10. Admin login alert: admin_device_seen() records each admin device; a new device opens an alert in the bell
--      and asks the health-check function to push it at once.
--  11. Backup status: backup_report() (service role, from .github/workflows/backup.yml), admin_backup_status().
-- Safe to run more than once. Needs v30 (ops_alerts), v36 (admin 2-step login), v38 (client errors).

-- ============ 1. Admin roles ============
alter table public.admins add column if not exists role text not null default 'owner';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'admins_role_check') then
    alter table public.admins add constraint admins_role_check check (role in ('owner', 'support'));
  end if;
end $$;

-- Full admin (owner): payments, settings, coupons, push, plan / block changes.
create or replace function public.is_owner_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() and exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'owner');
$$;
revoke all on function public.is_owner_admin() from public, anon;
grant execute on function public.is_owner_admin() to authenticated, service_role;

-- admin_status() also says the role (the page hides tabs with it; every function checks again).
create or replace function public.admin_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', exists (select 1 from public.admins a where a.user_id = auth.uid()),
    'role', (select a.role from public.admins a where a.user_id = auth.uid()),
    'mfa_required', public.admin_mfa_required(),
    'aal', coalesce(auth.jwt()->>'aal', 'aal1'));
$$;
revoke all on function public.admin_status() from public, anon;
grant execute on function public.admin_status() to authenticated;

-- Owner: every admin with email and role.
create or replace function public.admin_list()
returns table (user_id uuid, email text, role text, created_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return query
  select a.user_id, coalesce(u.email, u.phone)::text, a.role, a.created_at, a.user_id = auth.uid()
  from public.admins a left join auth.users u on u.id = a.user_id
  order by a.created_at;
end $$;
revoke all on function public.admin_list() from public, anon;
grant execute on function public.admin_list() to authenticated;

-- Owner: change an admin's role. The last owner cannot be made support (nobody could change it back).
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if p_role not in ('owner', 'support') then raise exception 'bad role'; end if;
  select role into v_old from public.admins where user_id = p_user for update;
  if not found then raise exception 'not an admin'; end if;
  if v_old = p_role then return; end if;
  if v_old = 'owner' and (select count(*) from public.admins where role = 'owner') <= 1 then
    raise exception 'last owner';
  end if;
  update public.admins set role = p_role where user_id = p_user;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'role_changed', null, jsonb_build_object('user_id', p_user, 'role', p_role, 'before', v_old));
end $$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- The functions below are the latest versions (v13 .. v37) with only the first check changed to is_owner_admin():
-- support admins can read shops / users / orders / spam, but not change plans, blocks, settings or see payments.
create or replace function public.admin_set_pro(p_shop uuid, p_days int, p_tier text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_end timestamptz;
  v_tier text;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if p_days is null or p_days < 0 or p_days > 3660 then raise exception 'bad days'; end if;
  if p_tier is not null and p_tier not in ('pro', 'plus') then raise exception 'bad plan'; end if;
  select * into v_shop from public.shops where id = p_shop for update;
  if not found then raise exception 'Shop not found'; end if;
  if p_days = 0 then
    update public.shops set plan = 'free', plan_expires_at = now() where id = p_shop;
    v_end := now();
  else
    -- No plan named: keep the shop's current paid plan (Plus stays Plus), otherwise Pro.
    v_tier := coalesce(p_tier, case when public.is_pro(v_shop) and v_shop.plan in ('pro', 'plus') then v_shop.plan else 'pro' end);
    v_end := greatest(coalesce(v_shop.plan_expires_at, now()), now()) + make_interval(days => p_days);
    update public.shops set plan = v_tier, plan_expires_at = v_end where id = p_shop;
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_days = 0 then 'pro_removed' else 'pro_given' end, p_shop,
            jsonb_build_object('days', p_days, 'until', v_end, 'before', v_shop.plan_expires_at,
                               'plan', coalesce(v_tier, 'free'), 'plan_before', v_shop.plan));
  return v_end;
end $$;

create or replace function public.admin_set_blocked(p_shop uuid, p_blocked boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  update public.shops set blocked = coalesce(p_blocked, false),
    blocked_reason = case when p_blocked then left(nullif(trim(p_reason), ''), 200) else null end
  where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), case when p_blocked then 'blocked' else 'unblocked' end, p_shop, jsonb_build_object('reason', p_reason));
end $$;


create or replace function public.admin_reset_qr(p_shop uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  delete from public.qr_links where shop_id = p_shop;
  get diagnostics n = row_count;
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'qr_reset', p_shop, jsonb_build_object('codes', n));
  return n;
end $$;


create or replace function public.admin_edit_shop(p_shop uuid, p_name text default null, p_remove_logo boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  select name into v_old from public.shops where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  update public.shops set
    name = coalesce(nullif(trim(p_name), ''), name),
    logo_url = case when p_remove_logo then null else logo_url end
  where id = p_shop;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'shop_edited', p_shop, jsonb_build_object('old_name', v_old, 'new_name', nullif(trim(p_name), ''), 'logo_removed', p_remove_logo));
end $$;


create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
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

create or replace function public.admin_set_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_designs jsonb := '{}'::jsonb;
  v_ok text[] := array['classic', 'modern', 'split', 'bento', 'bentofull'];
  v_land jsonb := '{}'::jsonb;
  v_land_ok text[] := array['classic', 'duo', 'bold'];
  k text;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
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


create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
  v_cron timestamptz;
  v_cron_fail int;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'shops_total',   (select count(*) from public.shops),
    'shops_today',   (select count(*) from public.shops where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'),
    'shops_week',    (select count(*) from public.shops where created_at >= now() - interval '7 days'),
    'pro_active',    (select count(*) from public.shops s where public.is_pro(s)),
    'pro_paid',      (select count(*) from public.shops s where public.is_pro(s) and s.razorpay_subscription_id is not null),
    'pro_monthly',   (select count(*) from public.shops s where public.is_pro(s) and s.plan = 'pro' and s.razorpay_subscription_id is not null and s.plan_period = 'monthly'),
    'pro_yearly',    (select count(*) from public.shops s where public.is_pro(s) and s.plan = 'pro' and s.razorpay_subscription_id is not null and s.plan_period = 'yearly'),
    'plus_active',   (select count(*) from public.shops s where public.is_plus(s)),
    'plus_monthly',  (select count(*) from public.shops s where public.is_plus(s) and s.razorpay_subscription_id is not null and s.plan_period = 'monthly'),
    'plus_yearly',   (select count(*) from public.shops s where public.is_plus(s) and s.razorpay_subscription_id is not null and s.plan_period = 'yearly'),
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


-- ============ 2. Error viewer ============
alter table public.ops_events add column if not exists route text;
alter table public.ops_events add column if not exists app_version text;
alter table public.ops_events add column if not exists ua text;
alter table public.ops_events add column if not exists stack text;
create index if not exists ops_events_level_idx on public.ops_events (level, created_at);

-- Old 3-argument version is replaced (named-argument calls from older apps still match the new one).
drop function if exists public.report_client_error(text, text, text);
create or replace function public.report_client_error(p_source text, p_message text, p_where text default null,
  p_route text default null, p_version text default null, p_ua text default null, p_stack text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_src text := case when p_source in ('web', 'app', 'desktop') then 'client-' || p_source else 'client-web' end;
  v_msg text;
  v_stack text;
begin
  v_msg := left(regexp_replace(regexp_replace(
             coalesce(nullif(trim(p_message), ''), 'unknown error') || coalesce(' @ ' || left(nullif(trim(p_where), ''), 80), ''),
             '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
             'eyJ[A-Za-z0-9._-]{20,}', '<token>', 'g'), 300);
  v_stack := left(regexp_replace(regexp_replace(nullif(trim(p_stack), ''),
             '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g'),
             'eyJ[A-Za-z0-9._-]{20,}', '<token>', 'g'), 2000);
  -- at most 300 client reports per 10 minutes in total, and the same message once per 5 minutes
  if (select count(*) from public.ops_events where source like 'client-%' and created_at > now() - interval '10 minutes') >= 300 then return; end if;
  if exists (select 1 from public.ops_events where source = v_src and message = v_msg and created_at > now() - interval '5 minutes') then return; end if;
  insert into public.ops_events (source, level, message, route, app_version, ua, stack)
  values (v_src, 'client', v_msg,
          left(regexp_replace(nullif(trim(p_route), ''), '[?#].*$', ''), 120),
          left(nullif(trim(p_version), ''), 40), left(nullif(trim(p_ua), ''), 300), v_stack);
end $$;
revoke all on function public.report_client_error(text, text, text, text, text, text, text) from public;
grant execute on function public.report_client_error(text, text, text, text, text, text, text) to anon, authenticated;

-- Client errors of the last p_hours (max 30 days), grouped by message: count, first / last seen, newest 20 reports.
create or replace function public.admin_client_errors(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720));
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('message', g.message, 'count', g.n, 'first_seen', g.first_seen, 'last_seen', g.last_seen,
      'sources', g.sources,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('at', x.created_at, 'source', x.source, 'route', x.route,
                  'version', x.app_version, 'ua', x.ua, 'stack', x.stack) order by x.created_at desc), '[]'::jsonb)
                from (select * from public.ops_events e2 where e2.level = 'client' and e2.message = g.message and e2.created_at >= v_since
                      order by e2.created_at desc limit 20) x))
      order by g.last_seen desc)
    from (select e.message, count(*)::int as n, min(e.created_at) as first_seen, max(e.created_at) as last_seen,
                 jsonb_agg(distinct e.source) as sources
          from public.ops_events e where e.level = 'client' and e.created_at >= v_since
          group by e.message order by max(e.created_at) desc limit 200) g), '[]'::jsonb);
end $$;
revoke all on function public.admin_client_errors(int) from public, anon;
grant execute on function public.admin_client_errors(int) to authenticated;

-- ============ 3. Growth graphs ============
-- One row per India day: new shops, orders (finished uploads), pages printed (pages x copies),
-- payments (count, rupees) and upgrades (shops paying for the first time).
create or replace function public.admin_growth(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 7), 90);
  v_to date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := v_to - (v_days - 1);
  v_start timestamptz := (v_from::timestamp at time zone 'Asia/Kolkata');
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('day', d.day, 'shops', coalesce(s.n, 0), 'orders', coalesce(o.n, 0),
      'pages', coalesce(o.pages, 0), 'payments', coalesce(p.n, 0), 'amount', coalesce(p.rupees, 0), 'upgrades', coalesce(u.n, 0))
      order by d.day)
    from (select generate_series(v_from, v_to, interval '1 day')::date as day) d
    left join (select (created_at at time zone 'Asia/Kolkata')::date as day, count(*)::int as n
               from public.shops where created_at >= v_start group by 1) s on s.day = d.day
    left join (select (o.created_at at time zone 'Asia/Kolkata')::date as day, count(*)::int as n,
                      coalesce(sum((select sum(f.pages_to_print * f.copies) from public.order_files f where f.order_id = o.id)), 0)::bigint as pages
               from public.orders o where o.created_at >= v_start and o.status not in ('uploading', 'cancelled') group by 1) o on o.day = d.day
    left join (select (paid_at at time zone 'Asia/Kolkata')::date as day, count(*)::int as n, (sum(amount) / 100)::bigint as rupees
               from public.billing_payments where paid_at >= v_start group by 1) p on p.day = d.day
    left join (select (first_paid at time zone 'Asia/Kolkata')::date as day, count(*)::int as n
               from (select shop_id, min(paid_at) as first_paid from public.billing_payments group by shop_id) f
               where first_paid >= v_start group by 1) u on u.day = d.day), '[]'::jsonb);
end $$;
revoke all on function public.admin_growth(int) from public, anon;
grant execute on function public.admin_growth(int) to authenticated;

-- ============ 4. In-app notices for shops + support inbox ============
create table if not exists public.shop_notices (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  kind text not null check (kind in ('support', 'expiring', 'nudge', 'admin')),
  title text,
  body text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists shop_notices_shop_idx on public.shop_notices (shop_id, created_at desc);
alter table public.shop_notices enable row level security;  -- no policies: owners read through my_notices()
revoke all on public.shop_notices from public, anon, authenticated;
grant select, insert, update on public.shop_notices to service_role;

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  topic text not null default 'problem' check (topic in ('problem', 'feedback', 'billing', 'other')),
  message text not null check (char_length(message) between 3 and 2000),
  app text,
  status text not null default 'open' check (status in ('open', 'solved')),
  reply text,
  replied_at timestamptz,
  replied_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_shop_idx on public.support_tickets (shop_id, created_at desc);
alter table public.support_tickets enable row level security;  -- no policies: only through the functions below
revoke all on public.support_tickets from public, anon, authenticated;

-- The caller's own shop (owner only; staff and admins viewing do not count).
create or replace function public.my_shop_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.shops where owner_id = auth.uid() limit 1;
$$;
revoke all on function public.my_shop_id() from public, anon;
grant execute on function public.my_shop_id() to authenticated;

-- Shop owner: unread notices + the last 30 days (max 20).
create or replace function public.my_notices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_shop uuid := public.my_shop_id();
begin
  if v_shop is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'data', n.data,
      'created_at', n.created_at, 'read_at', n.read_at) order by n.created_at desc)
    from (select * from public.shop_notices where shop_id = v_shop and (read_at is null or created_at > now() - interval '30 days')
          order by created_at desc limit 20) n), '[]'::jsonb);
end $$;
revoke all on function public.my_notices() from public, anon;
grant execute on function public.my_notices() to authenticated;

-- Shop owner: mark one notice (or all, p_id null) as read.
create or replace function public.notice_read(p_id bigint default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_shop uuid := public.my_shop_id();
begin
  if v_shop is null then return; end if;
  update public.shop_notices set read_at = now() where shop_id = v_shop and read_at is null and (p_id is null or id = p_id);
end $$;
revoke all on function public.notice_read(bigint) from public, anon;
grant execute on function public.notice_read(bigint) to authenticated;

-- Shop owner: send a problem / feedback to the PrintQR team (max 5 a day per shop).
create or replace function public.support_submit(p_topic text, p_message text, p_app text default null)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v_shop uuid := public.my_shop_id(); v_id bigint;
begin
  if v_shop is null then raise exception 'not allowed'; end if;
  if char_length(trim(coalesce(p_message, ''))) < 3 then raise exception 'message too short'; end if;
  if (select count(*) from public.support_tickets where shop_id = v_shop and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too many requests';
  end if;
  insert into public.support_tickets (shop_id, user_id, topic, message, app)
  values (v_shop, auth.uid(), case when p_topic in ('problem', 'feedback', 'billing', 'other') then p_topic else 'other' end,
          left(trim(p_message), 2000), left(nullif(trim(p_app), ''), 120))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.support_submit(text, text, text) from public, anon;
grant execute on function public.support_submit(text, text, text) to authenticated;

-- Shop owner: own requests with the team's reply (last 20).
create or replace function public.my_support()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_shop uuid := public.my_shop_id();
begin
  if v_shop is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'topic', t.topic, 'message', t.message, 'status', t.status,
      'reply', t.reply, 'replied_at', t.replied_at, 'created_at', t.created_at) order by t.created_at desc)
    from (select * from public.support_tickets where shop_id = v_shop order by created_at desc limit 20) t), '[]'::jsonb);
end $$;
revoke all on function public.my_support() from public, anon;
grant execute on function public.my_support() to authenticated;

-- Admin (owner or support): the inbox. p_status 'open' | 'solved' | 'all'.
create or replace function public.admin_support(p_status text default 'open', p_limit int default 100)
returns table (id bigint, shop_id uuid, shop_name text, slug text, owner_email text, phone text, topic text, message text, app text,
  status text, reply text, replied_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select t.id, t.shop_id, s.name, s.slug, coalesce(u.email, u.phone)::text, s.phone, t.topic, t.message, t.app,
    t.status, t.reply, t.replied_at, t.created_at
  from public.support_tickets t join public.shops s on s.id = t.shop_id left join auth.users u on u.id = s.owner_id
  where coalesce(p_status, 'open') = 'all' or t.status = p_status
  order by t.status = 'open' desc, t.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 300);
end $$;
revoke all on function public.admin_support(text, int) from public, anon;
grant execute on function public.admin_support(text, int) to authenticated;

-- Admin (owner or support): reply (shown to the shop as a notice) and / or mark open / solved.
create or replace function public.admin_support_reply(p_id bigint, p_reply text default null, p_status text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_t public.support_tickets; v_reply text := left(nullif(trim(p_reply), ''), 2000);
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_status is not null and p_status not in ('open', 'solved') then raise exception 'bad status'; end if;
  select * into v_t from public.support_tickets where id = p_id for update;
  if not found then raise exception 'not found'; end if;
  update public.support_tickets set
    reply = coalesce(v_reply, reply),
    replied_at = case when v_reply is not null then now() else replied_at end,
    replied_by = case when v_reply is not null then auth.uid() else replied_by end,
    status = coalesce(p_status, status),
    updated_at = now()
  where id = p_id;
  if v_reply is not null then
    insert into public.shop_notices (shop_id, kind, title, body, data, created_by)
    values (v_t.shop_id, 'support', null, v_reply, jsonb_build_object('ticket', p_id, 'question', left(v_t.message, 200)), auth.uid());
  end if;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'support_reply', v_t.shop_id, jsonb_build_object('ticket', p_id, 'replied', v_reply is not null, 'status', coalesce(p_status, v_t.status)));
end $$;
revoke all on function public.admin_support_reply(bigint, text, text) from public, anon;
grant execute on function public.admin_support_reply(bigint, text, text) to authenticated;

-- ============ 5. Coupon codes (free Pro / Plus days) ============
create table if not exists public.coupons (
  code text primary key check (code ~ '^[A-Z0-9_-]{3,30}$'),
  kind text not null default 'days' check (kind in ('days')),
  days int not null check (days between 1 and 366),
  tier text not null default 'pro' check (tier in ('pro', 'plus')),
  expires_at timestamptz,
  max_uses int check (max_uses is null or max_uses >= 1),
  uses int not null default 0,
  active boolean not null default true,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.coupons enable row level security;
revoke all on public.coupons from public, anon, authenticated;

create table if not exists public.coupon_redemptions (
  code text not null references public.coupons(code) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid,
  days int not null,
  until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (code, shop_id)
);
alter table public.coupon_redemptions enable row level security;
revoke all on public.coupon_redemptions from public, anon, authenticated;

-- Wrong codes per shop (brute-force guard: 10 wrong tries an hour).
create table if not exists public.coupon_tries (
  id bigint generated always as identity primary key,
  shop_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists coupon_tries_shop_idx on public.coupon_tries (shop_id, created_at);
alter table public.coupon_tries enable row level security;
revoke all on public.coupon_tries from public, anon, authenticated;

create or replace function public.admin_coupons()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind, 'days', c.days, 'tier', c.tier,
      'expires_at', c.expires_at, 'max_uses', c.max_uses, 'uses', c.uses, 'active', c.active, 'note', c.note, 'created_at', c.created_at)
      order by c.created_at desc) from public.coupons c), '[]'::jsonb);
end $$;
revoke all on function public.admin_coupons() from public, anon;
grant execute on function public.admin_coupons() to authenticated;

-- Owner: create or change a code (code is saved in capitals).
create or replace function public.admin_coupon_save(p_code text, p_days int, p_tier text default 'pro', p_expires_at timestamptz default null,
  p_max_uses int default null, p_active boolean default true, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_code text := upper(trim(coalesce(p_code, '')));
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'bad code'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'bad days'; end if;
  if coalesce(p_tier, 'pro') not in ('pro', 'plus') then raise exception 'bad plan'; end if;
  insert into public.coupons (code, days, tier, expires_at, max_uses, active, note, created_by)
  values (v_code, p_days, coalesce(p_tier, 'pro'), p_expires_at, nullif(p_max_uses, 0), coalesce(p_active, true), left(nullif(trim(p_note), ''), 200), auth.uid())
  on conflict (code) do update set days = excluded.days, tier = excluded.tier, expires_at = excluded.expires_at,
    max_uses = excluded.max_uses, active = excluded.active, note = excluded.note;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'coupon_saved', null, jsonb_build_object('code', v_code, 'days', p_days, 'tier', coalesce(p_tier, 'pro'),
            'active', coalesce(p_active, true), 'max_uses', p_max_uses, 'expires_at', p_expires_at));
end $$;
revoke all on function public.admin_coupon_save(text, int, text, timestamptz, int, boolean, text) from public, anon;
grant execute on function public.admin_coupon_save(text, int, text, timestamptz, int, boolean, text) to authenticated;

-- Shop owner: redeem a code. Adds the free days on top of the current plan end (Plus stays Plus).
-- Returns {ok, until, days, plan} or {ok:false, error:'not_found'|'expired'|'used_up'|'already'|'too_many'}.
create or replace function public.redeem_coupon(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_c public.coupons;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_tier text;
  v_end timestamptz;
  v_err text;
begin
  select * into v_shop from public.shops where owner_id = auth.uid() for update;
  if not found then raise exception 'not allowed'; end if;
  if v_shop.blocked then raise exception 'not allowed'; end if;
  if (select count(*) from public.coupon_tries where shop_id = v_shop.id and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into v_c from public.coupons where code = v_code for update;
  if not found or not v_c.active then v_err := 'not_found';
  elsif v_c.expires_at is not null and v_c.expires_at <= now() then v_err := 'expired';
  elsif v_c.max_uses is not null and v_c.uses >= v_c.max_uses then v_err := 'used_up';
  elsif exists (select 1 from public.coupon_redemptions r where r.code = v_code and r.shop_id = v_shop.id) then v_err := 'already';
  end if;
  if v_err is not null then
    insert into public.coupon_tries (shop_id) values (v_shop.id);
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  v_tier := case when public.is_plus(v_shop) or v_c.tier = 'plus' then 'plus' else 'pro' end;
  v_end := greatest(coalesce(v_shop.plan_expires_at, now()), now()) + make_interval(days => v_c.days);
  update public.shops set plan = v_tier, plan_expires_at = v_end where id = v_shop.id;
  update public.coupons set uses = uses + 1 where code = v_code;
  insert into public.coupon_redemptions (code, shop_id, user_id, days, until) values (v_code, v_shop.id, auth.uid(), v_c.days, v_end);
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (null, 'coupon_redeemed', v_shop.id, jsonb_build_object('code', v_code, 'days', v_c.days, 'until', v_end,
            'before', v_shop.plan_expires_at, 'plan', v_tier, 'plan_before', v_shop.plan));
  return jsonb_build_object('ok', true, 'until', v_end, 'days', v_c.days, 'plan', v_tier);
end $$;
revoke all on function public.redeem_coupon(text) from public, anon;
grant execute on function public.redeem_coupon(text) to authenticated;

-- ============ 6. Expiring plans, inactive shops ============
create or replace function public.admin_expiring(p_days int default 7)
returns table (id uuid, name text, slug text, owner_email text, phone text, plan text, plan_expires_at timestamptz,
  paid boolean, subscription_status text, last_reminded timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.slug, coalesce(u.email, u.phone)::text, s.phone, s.plan, s.plan_expires_at,
    s.razorpay_subscription_id is not null, s.subscription_status,
    (select max(n.created_at) from public.shop_notices n where n.shop_id = s.id and n.kind = 'expiring')
  from public.shops s left join auth.users u on u.id = s.owner_id
  where s.plan in ('pro', 'plus') and not s.blocked
    and s.plan_expires_at > now() and s.plan_expires_at <= now() + make_interval(days => least(greatest(coalesce(p_days, 7), 1), 60))
  order by s.plan_expires_at;
end $$;
revoke all on function public.admin_expiring(int) from public, anon;
grant execute on function public.admin_expiring(int) to authenticated;

-- Shops with no finished order for p_days days that joined at least p_days days ago (they had time to start).
create or replace function public.admin_inactive(p_days int default 14, p_limit int default 100)
returns table (id uuid, name text, slug text, owner_email text, phone text, created_at timestamptz, is_pro boolean,
  orders_total int, last_order_at timestamptz, last_nudged timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 365));
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return query
  select x.id, x.name, x.slug, x.email, x.phone, x.created_at, x.pro, x.total, x.last_at,
    (select max(n.created_at) from public.shop_notices n where n.shop_id = x.id and n.kind = 'nudge')
  from (
    select s.id, s.name, s.slug, coalesce(u.email, u.phone)::text as email, s.phone, s.created_at, public.is_pro(s) as pro,
      (select count(*)::int from public.orders o where o.shop_id = s.id and o.status <> 'uploading') as total,
      (select max(o.created_at) from public.orders o where o.shop_id = s.id and o.status <> 'uploading') as last_at
    from public.shops s left join auth.users u on u.id = s.owner_id
    where not s.blocked and s.created_at < v_since
  ) x
  where x.last_at is null or x.last_at < v_since
  order by x.last_at desc nulls last, x.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
revoke all on function public.admin_inactive(int, int) from public, anon;
grant execute on function public.admin_inactive(int, int) to authenticated;

-- ============ 7. Targeted push ============
-- Segment: 'all' | 'pro' (Pro or Plus now) | 'free' | 'city' (address contains p_city). Blocked shops never.
create or replace function public.push_segment_owners(p_segment text, p_city text default null)
returns table (shop_id uuid, owner_id uuid)
language sql stable security definer set search_path = public as $$
  select s.id, s.owner_id from public.shops s
  where not s.blocked and case coalesce(p_segment, '')
    when 'all' then true
    when 'pro' then public.is_pro(s)
    when 'free' then not public.is_pro(s)
    when 'city' then char_length(trim(coalesce(p_city, ''))) >= 2 and coalesce(s.address, '') ilike '%' || trim(p_city) || '%'
    else false end;
$$;
revoke all on function public.push_segment_owners(text, text) from public, anon, authenticated;
grant execute on function public.push_segment_owners(text, text) to service_role;

-- Owner: how many shops / devices a segment reaches (preview before sending).
create or replace function public.admin_segment_count(p_segment text, p_city text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return (select jsonb_build_object('shops', count(distinct g.shop_id),
      'devices', (select count(*) from public.push_tokens t where t.owner_id in (select g2.owner_id from public.push_segment_owners(p_segment, p_city) g2)))
    from public.push_segment_owners(p_segment, p_city) g);
end $$;
revoke all on function public.admin_segment_count(text, text) from public, anon;
grant execute on function public.admin_segment_count(text, text) to authenticated;

-- ============ 8. View as shop (read-only) ============
-- No customer names or file names (same privacy rule as the Orders tab). Payments only for owner admins.
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
    'payments', case when public.is_owner_admin() then coalesce((select jsonb_agg(jsonb_build_object('amount', bp.amount, 'tier', bp.tier,
        'period', bp.period, 'paid_at', bp.paid_at) order by bp.paid_at desc)
      from (select * from public.billing_payments where shop_id = p_shop order by paid_at desc limit 20) bp), '[]'::jsonb) else null end);
  insert into public.admin_log (admin_id, action, shop_id, detail) values (auth.uid(), 'shop_viewed', p_shop, '{}'::jsonb);
  return v_out;
end $$;
revoke all on function public.admin_shop_view(uuid) from public, anon;
grant execute on function public.admin_shop_view(uuid) to authenticated;

-- ============ 9. CSV export ============
-- Owner: rows for 'shops' | 'orders' | 'payments' created between p_from and p_to (India dates, both optional). Max 20000 rows.
create or replace function public.admin_export(p_kind text, p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_a timestamptz := coalesce((p_from::timestamp at time zone 'Asia/Kolkata'), '-infinity'::timestamptz);
  v_b timestamptz := coalesce(((p_to + 1)::timestamp at time zone 'Asia/Kolkata'), 'infinity'::timestamptz);
  v_out jsonb;
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
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

-- ============ 10. Admin login from a new device ============
create table if not exists public.admin_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 8 and 64),
  ua text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.admin_devices enable row level security;  -- no policies
revoke all on public.admin_devices from public, anon, authenticated;

-- Called by the Admin page right after sign-in, also before the 2-step code (a password-only sign-in on a new
-- device is exactly what should be reported). The first device an admin ever records is saved quietly.
-- A new device opens an ops alert (bell) and asks the health-check function to push it to every admin now.
create or replace function public.admin_device_seen(p_device text, p_ua text default null)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_first boolean; v_email text; v_key text; v_tok text;
begin
  if v_uid is null or not exists (select 1 from public.admins where user_id = v_uid) then raise exception 'not allowed'; end if;
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'bad device'; end if;
  update public.admin_devices set last_seen = now(), ua = coalesce(left(nullif(trim(p_ua), ''), 300), ua)
    where user_id = v_uid and device_id = p_device;
  if found then return false; end if;
  if (select count(*) from public.admin_devices where user_id = v_uid and first_seen > now() - interval '1 day') >= 20 then return false; end if;
  v_first := not exists (select 1 from public.admin_devices where user_id = v_uid);
  insert into public.admin_devices (user_id, device_id, ua) values (v_uid, p_device, left(nullif(trim(p_ua), ''), 300))
    on conflict do nothing;
  if v_first then return false; end if;
  select coalesce(email, phone) into v_email from auth.users where id = v_uid;
  v_key := 'admin_login_' || left(md5(v_uid::text || p_device), 12);
  insert into public.ops_alerts (key, title, detail)
  values (v_key, 'Admin login from new device',
          left(coalesce(v_email, v_uid::text) || ' signed in on a new device ('
               || to_char(now() at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST): ' || coalesce(left(p_ua, 200), 'unknown device')
               || '. Not you? Change the password and remove the device in Supabase Auth.', 500))
  on conflict do nothing;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (v_uid, 'admin_new_device', null, jsonb_build_object('ua', left(p_ua, 200)));
  -- push at once (health-check in push-only mode); without pg_net / token the 15-minute run sends it
  begin
    select token into v_tok from private.cron_tokens where name = 'health';
    if v_tok is not null then
      perform net.http_post(
        url := 'https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/health-check',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_tok),
        body := '{"mode":"push"}'::jsonb,
        timeout_milliseconds := 30000);
    end if;
  exception when others then null;
  end;
  return true;
end $$;
revoke all on function public.admin_device_seen(text, text) from public, anon;
grant execute on function public.admin_device_seen(text, text) to authenticated;

-- ============ 11. Backup status ============
create table if not exists public.backup_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'failed', 'skipped')),
  size_bytes bigint,
  detail text
);
create index if not exists backup_runs_ran_idx on public.backup_runs (ran_at desc);
alter table public.backup_runs enable row level security;  -- no policies
revoke all on public.backup_runs from public, anon, authenticated;
grant select on public.backup_runs to service_role;

-- GitHub backup workflow (service role, same key as alerts.yml) records each run.
create or replace function public.backup_report(p_status text, p_size bigint default null, p_detail text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if p_status not in ('ok', 'failed', 'skipped') then raise exception 'bad status'; end if;
  insert into public.backup_runs (status, size_bytes, detail)
  values (p_status, case when p_size >= 0 then p_size end, left(nullif(trim(p_detail), ''), 300));
  delete from public.backup_runs where ran_at < now() - interval '180 days';
end $$;
revoke all on function public.backup_report(text, bigint, text) from public, anon, authenticated;
grant execute on function public.backup_report(text, bigint, text) to service_role;

create or replace function public.admin_backup_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'last', (select jsonb_build_object('ran_at', ran_at, 'status', status, 'size_bytes', size_bytes, 'detail', detail)
             from public.backup_runs order by ran_at desc limit 1),
    'last_ok', (select jsonb_build_object('ran_at', ran_at, 'size_bytes', size_bytes)
                from public.backup_runs where status = 'ok' order by ran_at desc limit 1));
end $$;
revoke all on function public.admin_backup_status() from public, anon;
grant execute on function public.admin_backup_status() to authenticated;

-- service role (Edge Functions): shop owners' push tokens and notices
grant select on public.push_tokens to service_role;
grant select on public.shops to service_role;
