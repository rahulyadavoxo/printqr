-- PrintQR v42 (2026-11-24): admin switch for coupon codes.
-- app_settings.coupons_enabled (default true). Off = the Plan tab hides "Have a coupon code?" and the server refuses
-- codes (redeem_coupon and coupon_check answer error 'disabled'). Codes already paid / redeemed are not touched.
-- Idempotent. Needs v39 (admin roles) and v40 (percent coupons).
alter table public.app_settings add column if not exists coupons_enabled boolean not null default true;

create or replace function public.get_app_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', s.announcement, 'announcement_hi', s.announcement_hi, 'announcement_secs', s.announcement_secs,
    'maintenance', s.maintenance, 'maintenance_msg', s.maintenance_msg,
    'min_app_version', s.min_app_version, 'free_counter_limit', s.free_counter_limit,
    'login_design', s.login_design, 'login_designs', s.login_designs,
    'landing_design', s.landing_design, 'landing_designs', s.landing_designs,
    'coupons_enabled', s.coupons_enabled)
  from public.app_settings s where s.id = 1;
$$;
grant execute on function public.get_app_settings() to anon, authenticated;

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
    -- v42: an older admin page sends no coupon switch: keep the current one
    coupons_enabled  = case when jsonb_typeof(p->'coupons_enabled') = 'boolean' then (p->>'coupons_enabled')::boolean else coupons_enabled end,
    updated_at = now()
  where id = 1;
  insert into public.admin_log (admin_id, action, detail) values (auth.uid(), 'settings', p);
  return public.get_app_settings();
end $$;
revoke all on function public.admin_set_settings(jsonb) from public, anon;
grant execute on function public.admin_set_settings(jsonb) to authenticated;

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
  if not coalesce((select coupons_enabled from public.app_settings where id = 1), true) then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;
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
  if not coalesce((select coupons_enabled from public.app_settings where id = 1), true) then
    return jsonb_build_object('ok', false, 'error', 'disabled');
  end if;
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
