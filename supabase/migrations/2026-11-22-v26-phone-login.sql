-- PrintQR v26 migration (2026-11-22): mobile-number (OTP) logins in the admin panel. Safe to run more than once. Needs v25.
--
-- Accounts made with "Continue with mobile" have no email, only auth.users.phone ("919876543210").
-- admin_users and admin_payments now show "+919876543210" where the email would be, admin_users can be
-- searched by number, and a phone-confirmed account no longer shows as "unconfirmed".
-- Same function signatures as before (create or replace), so nothing else changes.

create or replace function public.admin_users(p_q text default '', p_limit int default 50, p_offset int default 0)
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  confirmed boolean, banned boolean, shop_id uuid, shop_name text, is_admin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
  select u.id, coalesce(nullif(u.email, '')::text, '+' || nullif(u.phone, '')::text), u.created_at, u.last_sign_in_at,
    (u.email_confirmed_at is not null or u.phone_confirmed_at is not null), coalesce(u.banned_until > now(), false),
    s.id, s.name, exists (select 1 from public.admins a where a.user_id = u.id)
  from auth.users u left join public.shops s on s.owner_id = u.id
  where coalesce(p_q, '') = '' or u.email ilike '%' || p_q || '%' or coalesce(s.name, '') ilike '%' || p_q || '%'
    or (length(regexp_replace(p_q, '\D', '', 'g')) >= 4 and coalesce(u.phone, '') like '%' || regexp_replace(p_q, '\D', '', 'g') || '%')
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;
revoke all on function public.admin_users(text, int, int) from public, anon;
grant execute on function public.admin_users(text, int, int) to authenticated;

create or replace function public.admin_payments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
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
revoke all on function public.admin_payments() from public, anon;
grant execute on function public.admin_payments() to authenticated;

notify pgrst, 'reload schema';
