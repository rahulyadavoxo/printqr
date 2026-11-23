-- Smoke test for v39 (admin tools: roles, support inbox, coupons, notices, growth, errors, export, devices, backups).
-- Runs in CI on a throw-away local Supabase; rolled back at the end.
\set ON_ERROR_STOP 1
begin;

update public.app_settings set admin_mfa_required = false where id = 1;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000039a1', 'owner-v39@example.com'),
  ('00000000-0000-0000-0000-0000000039a2', 'support-v39@example.com'),
  ('00000000-0000-0000-0000-0000000039a3', 'shop-v39@example.com');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000039a1');
insert into public.admins (user_id, role) values ('00000000-0000-0000-0000-0000000039a2', 'support');
insert into public.shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-0000000039b1', '00000000-0000-0000-0000-0000000039a3', 'V39 Test Shop', 'v39-test-shop');

-- 1. Existing / default admin is owner; support is not
do $$ begin
  if (select role from public.admins where user_id = '00000000-0000-0000-0000-0000000039a1') <> 'owner' then
    raise exception 'TEST FAILED: default role is not owner';
  end if;
end $$;

-- 2. Support admin: reads shops and the inbox, cannot see payments / change plans / coupons
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000039a2", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ begin
  if not public.is_admin() or public.is_owner_admin() then raise exception 'TEST FAILED: support role checks'; end if;
  perform public.admin_shops('', 5, 0);
  perform public.admin_support('all', 10);
  perform public.admin_client_errors(24);
  perform public.admin_shop_view('00000000-0000-0000-0000-0000000039b1');
  begin perform public.admin_payments(); raise exception 'TEST FAILED: support saw payments';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.admin_set_pro('00000000-0000-0000-0000-0000000039b1', 7, null); raise exception 'TEST FAILED: support gave Pro';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.admin_coupons(); raise exception 'TEST FAILED: support saw coupons';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  raise notice 'support role OK';
end $$;
reset role;

-- 3. Owner: coupon, growth, export, roles, segment count
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000039a1", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ declare j jsonb; begin
  perform public.admin_coupon_save('free30', 30, 'pro', now() + interval '10 days', 1, true, 'test');
  if jsonb_array_length(public.admin_coupons()) < 1 then raise exception 'TEST FAILED: coupon not saved'; end if;
  j := public.admin_growth(30);
  if jsonb_array_length(j) <> 30 then raise exception 'TEST FAILED: growth days = %', jsonb_array_length(j); end if;
  perform public.admin_export('shops', null, null);
  perform public.admin_export('orders', current_date - 30, current_date);
  perform public.admin_export('payments', null, null);
  perform public.admin_expiring(7);
  perform public.admin_inactive(14, 10);
  perform public.admin_segment_count('pro', null);
  perform public.admin_list();
  perform public.admin_backup_status();
  begin perform public.admin_set_role('00000000-0000-0000-0000-0000000039a1', 'support'); raise exception 'TEST FAILED: last owner demoted';
  exception when others then if sqlerrm <> 'last owner' then raise; end if; end;
  perform public.admin_set_role('00000000-0000-0000-0000-0000000039a2', 'owner');
  perform public.admin_set_role('00000000-0000-0000-0000-0000000039a2', 'support');
  -- first device: quiet; second: alert
  if public.admin_device_seen('device-aaaa-1111', 'Test UA') then raise exception 'TEST FAILED: first device alerted'; end if;
  if public.admin_device_seen('device-aaaa-1111', 'Test UA') then raise exception 'TEST FAILED: known device alerted'; end if;
  if not public.admin_device_seen('device-bbbb-2222', 'Other UA') then raise exception 'TEST FAILED: new device not reported'; end if;
  raise notice 'owner OK';
end $$;
reset role;

-- 4. Shop owner: support request, coupon (once), notices
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000039a3", "role": "authenticated", "aal": "aal1"}', true);
set local role authenticated;
do $$ declare j jsonb; v bigint; begin
  v := public.support_submit('problem', 'Printer does not print', 'web test');
  if jsonb_array_length(public.my_support()) <> 1 then raise exception 'TEST FAILED: my_support'; end if;
  j := public.redeem_coupon('FREE30');
  if not (j->>'ok')::boolean then raise exception 'TEST FAILED: redeem %', j; end if;
  j := public.redeem_coupon('free30');
  if (j->>'ok')::boolean or j->>'error' not in ('already', 'used_up') then raise exception 'TEST FAILED: second redeem %', j; end if;
  j := public.redeem_coupon('NOPE');
  if j->>'error' <> 'not_found' then raise exception 'TEST FAILED: unknown code %', j; end if;
  begin perform public.admin_support('all', 10); raise exception 'TEST FAILED: shop read inbox';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  perform public.report_client_error('web', 'Test crash', 'x.js:1', '/dashboard?x=1', '1.2.3', 'UA', 'stack line');
  raise notice 'shop OK';
end $$;
reset role;

do $$ begin
  if not exists (select 1 from public.shops where id = '00000000-0000-0000-0000-0000000039b1' and plan = 'pro' and plan_expires_at > now() + interval '29 days') then
    raise exception 'TEST FAILED: coupon did not give Pro';
  end if;
  if not exists (select 1 from public.ops_events where message like 'Test crash%' and route = '/dashboard' and app_version = '1.2.3') then
    raise exception 'TEST FAILED: client error details not saved';
  end if;
end $$;

-- 5. Support admin replies -> shop sees a notice
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000039a2", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ declare v bigint; begin
  select id into v from public.admin_support('open', 10) limit 1;
  perform public.admin_support_reply(v, 'Please restart the printer', 'solved');
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000039a3", "role": "authenticated", "aal": "aal1"}', true);
set local role authenticated;
do $$ begin
  if jsonb_array_length(public.my_notices()) <> 1 then raise exception 'TEST FAILED: notice missing'; end if;
  perform public.notice_read(null);
  if (public.my_support()->0->>'status') <> 'solved' then raise exception 'TEST FAILED: ticket not solved'; end if;
  raise notice 'support reply OK';
end $$;
reset role;

-- 6. Backup report (service role)
set local role service_role;
select public.backup_report('ok', 12345, null);
reset role;

rollback;
