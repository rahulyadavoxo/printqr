-- PrintQR v40 (2026-11-24): percent-off coupon codes, applied by Razorpay.
--   1. coupons.kind 'percent' next to 'days': percent (1-90), tiers (pro / plus), periods (monthly / yearly), mode:
--        'auto'  - every billing cycle is discounted: the create-subscription Edge Function makes (once) a discounted
--                  Razorpay plan per tier + period + percent and caches it in billing_plans_discount (never in
--                  billing_plans, so normal checkout can never get a discounted plan).
--        'offer' - the subscription is made on the normal plan with a Razorpay offer_id (offer made in the Razorpay
--                  Dashboard and linked to the PrintQR plans, e.g. first 3 months off).
--   2. coupon_checkouts: one row per subscription made with a code (service role). The code counts as used only
--      after payment: coupon_paid() (verify-payment / webhook) writes coupon_redemptions once, idempotently.
--   3. coupon_check(): service-role validation (active, not expired, uses left incl. checkouts in progress,
--      one per shop, 10 wrong tries an hour like redeem_coupon).
--   4. redeem_coupon() (free days) answers 'checkout' for a % code instead of redeeming it.
--   5. Admin (owner only): admin_coupons() shows the new fields, admin_coupon_save_percent() creates / edits % codes.
-- Safe to run more than once. Needs v39 (coupons, is_owner_admin).

-- ============ 1. coupons: percent kind ============
alter table public.coupons add column if not exists percent int;
alter table public.coupons add column if not exists tiers text[];
alter table public.coupons add column if not exists periods text[];
alter table public.coupons add column if not exists mode text;
alter table public.coupons add column if not exists offer_id text;
alter table public.coupons alter column days drop not null;
alter table public.coupons drop constraint if exists coupons_kind_check;
alter table public.coupons drop constraint if exists coupons_days_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'coupons_kind_v40_check') then
    alter table public.coupons add constraint coupons_kind_v40_check check (kind in ('days', 'percent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'coupons_shape_v40_check') then
    alter table public.coupons add constraint coupons_shape_v40_check check (
      (kind = 'days' and days between 1 and 366)
      or (kind = 'percent'
        and mode in ('auto', 'offer')
        and (percent between 1 and 90 or (mode = 'offer' and percent is null))
        and coalesce(array_length(tiers, 1), 0) >= 1 and tiers <@ array['pro', 'plus']::text[]
        and coalesce(array_length(periods, 1), 0) >= 1 and periods <@ array['monthly', 'yearly']::text[]
        and (mode = 'auto' or offer_id ~ '^offer_[A-Za-z0-9]{6,40}$')));
  end if;
end $$;

-- Redemptions of % codes have no days / end date; they point at the paid subscription instead.
alter table public.coupon_redemptions alter column days drop not null;
alter table public.coupon_redemptions alter column until drop not null;
alter table public.coupon_redemptions add column if not exists kind text not null default 'days';
alter table public.coupon_redemptions add column if not exists percent int;
alter table public.coupon_redemptions add column if not exists subscription_id text;

-- ============ 2. Discounted Razorpay plans (separate from billing_plans) ============
create table if not exists public.billing_plans_discount (
  tier text not null check (tier in ('pro', 'plus')),
  period text not null check (period in ('monthly', 'yearly')),
  percent int not null check (percent between 1 and 90),
  base_amount int not null,
  amount int not null check (amount >= 100),
  razorpay_plan_id text not null unique,
  created_at timestamptz not null default now(),
  primary key (tier, period, percent, base_amount)
);
alter table public.billing_plans_discount enable row level security;
revoke all on public.billing_plans_discount from public, anon, authenticated;
grant all on public.billing_plans_discount to service_role;

-- Subscriptions made with a code (written by create-subscription, service role).
create table if not exists public.coupon_checkouts (
  subscription_id text primary key,
  code text not null references public.coupons(code) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  tier text not null check (tier in ('pro', 'plus')),
  period text not null check (period in ('monthly', 'yearly')),
  mode text not null check (mode in ('auto', 'offer')),
  percent int,
  amount int,
  offer_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists coupon_checkouts_code_idx on public.coupon_checkouts (code, created_at);
alter table public.coupon_checkouts enable row level security;
revoke all on public.coupon_checkouts from public, anon, authenticated;
grant all on public.coupon_checkouts to service_role;

-- ============ 3. Validation (service role, from create-subscription) ============
-- Returns {ok:true, kind, code, percent, mode, offer_id, tiers, periods, days, tier}
--      or {ok:false, error:'not_found'|'expired'|'used_up'|'already'|'too_many'|'blocked'}.
-- Uses left counts checkouts started by other shops in the last 30 minutes and not paid yet.
create or replace function public.coupon_check(p_shop uuid, p_code text, p_log boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_c public.coupons;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_pending int;
  v_err text;
  v_blocked boolean;
  v_found boolean;
begin
  select s.blocked into v_blocked from public.shops s where s.id = p_shop;
  if not found or coalesce(v_blocked, false) then return jsonb_build_object('ok', false, 'error', 'blocked'); end if;
  if (select count(*) from public.coupon_tries where shop_id = p_shop and created_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into v_c from public.coupons where code = v_code;
  v_found := found;
  if v_found then
    select count(distinct k.shop_id) into v_pending from public.coupon_checkouts k
      where k.code = v_code and k.paid_at is null and k.shop_id <> p_shop and k.created_at > now() - interval '30 minutes';
  end if;
  if not v_found or not v_c.active then v_err := 'not_found';
  elsif v_c.expires_at is not null and v_c.expires_at <= now() then v_err := 'expired';
  elsif v_c.max_uses is not null and v_c.uses + coalesce(v_pending, 0) >= v_c.max_uses then v_err := 'used_up';
  elsif exists (select 1 from public.coupon_redemptions r where r.code = v_code and r.shop_id = p_shop) then v_err := 'already';
  end if;
  if v_err is not null then
    if coalesce(p_log, true) then insert into public.coupon_tries (shop_id) values (p_shop); end if;
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return jsonb_build_object('ok', true, 'kind', v_c.kind, 'code', v_c.code, 'percent', v_c.percent, 'mode', v_c.mode,
    'offer_id', v_c.offer_id, 'tiers', to_jsonb(v_c.tiers), 'periods', to_jsonb(v_c.periods), 'days', v_c.days, 'tier', v_c.tier,
    'expires_at', v_c.expires_at);
end $$;
revoke all on function public.coupon_check(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.coupon_check(uuid, text, boolean) to service_role;

-- Payment went through for a subscription made with a code: record the redemption once (repeats do nothing).
create or replace function public.coupon_paid(p_sub text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_k public.coupon_checkouts;
  v_n int;
begin
  select * into v_k from public.coupon_checkouts where subscription_id = p_sub for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_checkout'); end if;
  if v_k.paid_at is not null then return jsonb_build_object('ok', true, 'repeat', true); end if;
  update public.coupon_checkouts set paid_at = now() where subscription_id = p_sub;
  insert into public.coupon_redemptions (code, shop_id, user_id, days, until, kind, percent, subscription_id)
    values (v_k.code, v_k.shop_id, null, null, null, 'percent', v_k.percent, p_sub)
    on conflict (code, shop_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    update public.coupons set uses = uses + 1 where code = v_k.code;
    insert into public.admin_log (admin_id, action, shop_id, detail)
      values (null, 'coupon_redeemed', v_k.shop_id, jsonb_build_object('code', v_k.code, 'percent', v_k.percent, 'mode', v_k.mode,
              'tier', v_k.tier, 'period', v_k.period, 'amount', v_k.amount, 'subscription_id', p_sub));
  end if;
  return jsonb_build_object('ok', true, 'counted', v_n > 0);
end $$;
revoke all on function public.coupon_paid(text) from public, anon, authenticated;
grant execute on function public.coupon_paid(text) to service_role;

-- ============ 4. Free-days redeem: a % code is used at checkout instead ============
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
  -- % code: nothing is redeemed here; the Plan tab checks it through create-subscription and applies it at payment.
  if found and v_c.active and v_c.kind = 'percent' then
    return jsonb_build_object('ok', false, 'error', 'checkout', 'code', v_code);
  end if;
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

-- ============ 5. Admin (owner only) ============
create or replace function public.admin_coupons()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind, 'days', c.days, 'tier', c.tier,
      'percent', c.percent, 'mode', c.mode, 'offer_id', c.offer_id, 'tiers', to_jsonb(c.tiers), 'periods', to_jsonb(c.periods),
      'expires_at', c.expires_at, 'max_uses', c.max_uses, 'uses', c.uses, 'active', c.active, 'note', c.note, 'created_at', c.created_at,
      'pending', (select count(*) from public.coupon_checkouts k where k.code = c.code and k.paid_at is null
                    and k.created_at > now() - interval '30 minutes'))
      order by c.created_at desc) from public.coupons c), '[]'::jsonb);
end $$;
revoke all on function public.admin_coupons() from public, anon;
grant execute on function public.admin_coupons() to authenticated;

-- Free-days codes: same as v39, but will not turn an existing % code into a days code.
create or replace function public.admin_coupon_save(p_code text, p_days int, p_tier text default 'pro', p_expires_at timestamptz default null,
  p_max_uses int default null, p_active boolean default true, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_code text := upper(trim(coalesce(p_code, '')));
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'bad code'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'bad days'; end if;
  if coalesce(p_tier, 'pro') not in ('pro', 'plus') then raise exception 'bad plan'; end if;
  if exists (select 1 from public.coupons where code = v_code and kind <> 'days') then raise exception 'code already used for a percent-off code'; end if;
  insert into public.coupons (code, kind, days, tier, expires_at, max_uses, active, note, created_by)
  values (v_code, 'days', p_days, coalesce(p_tier, 'pro'), p_expires_at, nullif(p_max_uses, 0), coalesce(p_active, true), left(nullif(trim(p_note), ''), 200), auth.uid())
  on conflict (code) do update set days = excluded.days, tier = excluded.tier, expires_at = excluded.expires_at,
    max_uses = excluded.max_uses, active = excluded.active, note = excluded.note;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'coupon_saved', null, jsonb_build_object('code', v_code, 'days', p_days, 'tier', coalesce(p_tier, 'pro'),
            'active', coalesce(p_active, true), 'max_uses', p_max_uses, 'expires_at', p_expires_at));
end $$;
revoke all on function public.admin_coupon_save(text, int, text, timestamptz, int, boolean, text) from public, anon;
grant execute on function public.admin_coupon_save(text, int, text, timestamptz, int, boolean, text) to authenticated;

-- % codes: create or change (code is saved in capitals). A days code cannot be turned into a % code.
create or replace function public.admin_coupon_save_percent(p_code text, p_percent int, p_tiers text[], p_periods text[],
  p_mode text default 'auto', p_offer_id text default null, p_expires_at timestamptz default null,
  p_max_uses int default null, p_active boolean default true, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_mode text := coalesce(p_mode, 'auto');
  v_offer text := nullif(trim(coalesce(p_offer_id, '')), '');
  v_tiers text[] := (select array_agg(distinct x order by x) from unnest(coalesce(p_tiers, '{}'::text[])) x);
  v_periods text[] := (select array_agg(distinct x order by x) from unnest(coalesce(p_periods, '{}'::text[])) x);
begin
  if not public.is_owner_admin() then raise exception 'not allowed'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,30}$' then raise exception 'bad code'; end if;
  if v_mode not in ('auto', 'offer') then raise exception 'bad mode'; end if;
  if v_mode = 'auto' and (p_percent is null or p_percent < 1 or p_percent > 90) then raise exception 'percent must be 1 to 90'; end if;
  if v_mode = 'offer' and p_percent is not null and (p_percent < 1 or p_percent > 90) then raise exception 'percent must be 1 to 90'; end if;
  if v_tiers is null or not (v_tiers <@ array['pro', 'plus']::text[]) then raise exception 'bad plan'; end if;
  if v_periods is null or not (v_periods <@ array['monthly', 'yearly']::text[]) then raise exception 'bad period'; end if;
  if v_mode = 'offer' and (v_offer is null or v_offer !~ '^offer_[A-Za-z0-9]{6,40}$') then raise exception 'bad Razorpay offer id'; end if;
  if v_mode = 'auto' then v_offer := null; end if;
  if exists (select 1 from public.coupons where code = v_code and kind <> 'percent') then raise exception 'code already used for a free-days code'; end if;
  insert into public.coupons (code, kind, days, tier, percent, tiers, periods, mode, offer_id, expires_at, max_uses, active, note, created_by)
  values (v_code, 'percent', null, case when 'pro' = any(v_tiers) then 'pro' else 'plus' end, p_percent, v_tiers, v_periods, v_mode, v_offer, p_expires_at, nullif(p_max_uses, 0),
          coalesce(p_active, true), left(nullif(trim(p_note), ''), 200), auth.uid())
  on conflict (code) do update set percent = excluded.percent, tiers = excluded.tiers, periods = excluded.periods, tier = excluded.tier,
    mode = excluded.mode, offer_id = excluded.offer_id, expires_at = excluded.expires_at, max_uses = excluded.max_uses,
    active = excluded.active, note = excluded.note;
  insert into public.admin_log (admin_id, action, shop_id, detail)
    values (auth.uid(), 'coupon_saved', null, jsonb_build_object('code', v_code, 'percent', p_percent, 'mode', v_mode, 'tiers', to_jsonb(v_tiers),
            'periods', to_jsonb(v_periods), 'active', coalesce(p_active, true), 'max_uses', p_max_uses, 'expires_at', p_expires_at,
            'offer', v_offer is not null));
end $$;
revoke all on function public.admin_coupon_save_percent(text, int, text[], text[], text, text, timestamptz, int, boolean, text) from public, anon;
grant execute on function public.admin_coupon_save_percent(text, int, text[], text[], text, text, timestamptz, int, boolean, text) to authenticated;
