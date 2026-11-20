-- PrintQR v19 (2026-11-20): admin panel knows the Plus plan.
--  * admin_set_pro: giving days keeps a Plus shop on Plus (before: it became Pro). Optional p_tier ('pro' | 'plus')
--    lets the admin choose the plan. Old callers with 2 arguments keep working.
--  * admin_overview: pro_monthly / pro_yearly count only Pro; new plus_active, plus_monthly, plus_yearly.
--  * admin_payments: each subscription also returns its plan.
-- Safe to run more than once. Paste the whole file in Supabase -> SQL Editor -> New query -> Run.

drop function if exists public.admin_set_pro(uuid, int);

create or replace function public.admin_set_pro(p_shop uuid, p_days int, p_tier text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_end timestamptz;
  v_tier text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
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
revoke all on function public.admin_set_pro(uuid, int, text) from public, anon;
grant execute on function public.admin_set_pro(uuid, int, text) to authenticated;

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
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'subs', coalesce((select jsonb_agg(x order by x.plan_expires_at desc nulls last) from (
      select s.id as shop_id, s.name, u.email::text as email, s.plan, s.plan_period, s.subscription_status,
        s.plan_expires_at, s.razorpay_subscription_id as sub_id, public.is_pro(s) as is_pro
      from public.shops s left join auth.users u on u.id = s.owner_id
      where s.razorpay_subscription_id is not null) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.received_at desc) from (
      select event, received_at from public.billing_events order by received_at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_payments() from public, anon;
grant execute on function public.admin_payments() to authenticated;

notify pgrst, 'reload schema';
