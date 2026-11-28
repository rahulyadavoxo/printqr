-- Smoke test for v48 (three admin roles: owner / admin / support). Rolled back at the end.
\set ON_ERROR_STOP 1
begin;

update public.app_settings set admin_mfa_required = false where id = 1;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000048a1', 'owner-v48@example.com'),
  ('00000000-0000-0000-0000-0000000048a2', 'admin-v48@example.com'),
  ('00000000-0000-0000-0000-0000000048a3', 'shop-v48@example.com');
insert into public.admins (user_id, role) values
  ('00000000-0000-0000-0000-0000000048a1', 'owner'),
  ('00000000-0000-0000-0000-0000000048a2', 'admin');
insert into public.shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-0000000048b1', '00000000-0000-0000-0000-0000000048a3', 'V48 Test Shop', 'v48-test-shop');

-- Admin: plan / block / coupons allowed; payments, settings, admin list, roles refused
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000048a2", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ begin
  if not public.is_owner_admin() or public.is_app_owner() then raise exception 'TEST FAILED: admin role checks'; end if;
  perform public.admin_set_pro('00000000-0000-0000-0000-0000000048b1', 7, null);
  perform public.admin_coupons();
  perform public.admin_overview();
  begin perform public.admin_payments(); raise exception 'TEST FAILED: admin saw payments';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.admin_list(); raise exception 'TEST FAILED: admin saw admin list';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.admin_set_settings('{}'::jsonb); raise exception 'TEST FAILED: admin changed settings';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.admin_set_role('00000000-0000-0000-0000-0000000048a2', 'support'); raise exception 'TEST FAILED: admin changed role';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  raise notice 'admin role OK';
end $$;
reset role;

-- Owner: admin <-> support, never a second owner
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000048a1", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ begin
  if not public.is_app_owner() then raise exception 'TEST FAILED: owner check'; end if;
  perform public.admin_payments();
  perform public.admin_set_role('00000000-0000-0000-0000-0000000048a2', 'support');
  perform public.admin_set_role('00000000-0000-0000-0000-0000000048a2', 'admin');
  begin perform public.admin_set_role('00000000-0000-0000-0000-0000000048a2', 'owner'); raise exception 'TEST FAILED: second owner';
  exception when others then if sqlerrm <> 'owner fixed' then raise; end if; end;
  raise notice 'owner role OK';
end $$;
reset role;

rollback;
\echo v48 admin roles smoke test passed
