-- v16: third plan "Plus" (Rs 99/month, Rs 999/year): everything in Pro + no ads for the owner + unlimited counters.
-- Pro (Rs 49/month, Rs 539/year): dynamic QR, no ads for customers, passport sheet, up to 2 new counters.
-- Safe to run more than once.

alter table public.shops drop constraint if exists shops_plan_check;
alter table public.shops add constraint shops_plan_check check (plan in ('free', 'pro', 'plus'));

-- is_pro = any paid plan (Pro or Plus) and not expired. Everything gated on Pro keeps working for Plus.
create or replace function public.is_pro(s public.shops)
returns boolean language sql stable set search_path = public as $$
  select s.plan in ('pro', 'plus') and s.plan_expires_at is not null and s.plan_expires_at > now();
$$;

create or replace function public.is_plus(s public.shops)
returns boolean language sql stable set search_path = public as $$
  select s.plan = 'plus' and s.plan_expires_at is not null and s.plan_expires_at > now();
$$;
grant execute on function public.is_plus(public.shops) to anon, authenticated, service_role;

-- New counters a Pro shop may add (Plus: unlimited). Counters made earlier keep working.
create or replace function public.pro_counter_limit()
returns int language sql immutable as $$ select 2 $$;
grant execute on function public.pro_counter_limit() to anon, authenticated, service_role;

create or replace function public.counters_plan_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_shop public.shops;
  v_count int;
begin
  select * into v_shop from public.shops where id = new.shop_id for update;
  if not found then raise exception 'Shop not found'; end if;
  if public.is_plus(v_shop) then return new; end if;
  select count(*) into v_count from public.counters where shop_id = new.shop_id;
  if public.is_pro(v_shop) then
    if v_count >= public.pro_counter_limit() then
      raise exception 'More counters need the Plus plan';
    end if;
    return new;
  end if;
  if v_count >= public.free_counter_limit() then
    raise exception 'More counters need the Pro plan';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

-- Check: select plan, count(*) from public.shops group by plan;
