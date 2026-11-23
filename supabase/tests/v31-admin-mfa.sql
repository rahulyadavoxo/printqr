-- Smoke test for v31 (admin 2-step login). Runs in CI on a throw-away local Supabase; rolled back at the end.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000031a1', 'admin-mfa-test@example.com');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000031a1');

-- 1. Admin with a password-only login (aal1): not an admin for data, but admin_status says "admin, needs code"
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000031a1", "role": "authenticated", "aal": "aal1"}', true);
set local role authenticated;
do $$ declare s jsonb; begin
  if public.is_admin() then raise exception 'TEST FAILED: is_admin() true at aal1'; end if;
  s := public.admin_status();
  if not (s->>'admin')::boolean or not (s->>'mfa_required')::boolean or s->>'aal' <> 'aal1' then
    raise exception 'TEST FAILED: admin_status at aal1 = %', s;
  end if;
  begin
    perform public.admin_recent_log(5);
    raise exception 'TEST FAILED: admin_recent_log worked at aal1';
  exception when others then
    if sqlerrm <> 'not allowed' then raise; end if;
  end;
  raise notice 'aal1 refused OK';
end $$;
reset role;

-- 2. Same admin after the 6-digit code (aal2): allowed
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000031a1", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ begin
  if not public.is_admin() then raise exception 'TEST FAILED: is_admin() false at aal2'; end if;
  perform public.admin_recent_log(5);
  raise notice 'aal2 allowed OK';
end $$;
reset role;

-- 3. Emergency switch off: aal1 works again
update public.app_settings set admin_mfa_required = false where id = 1;
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000031a1", "role": "authenticated", "aal": "aal1"}', true);
set local role authenticated;
do $$ begin
  if not public.is_admin() then raise exception 'TEST FAILED: is_admin() false at aal1 with admin_mfa_required = false'; end if;
  raise notice 'emergency switch OK';
end $$;
reset role;

-- 4. A non-admin at aal2 is still not an admin
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000031b2", "role": "authenticated", "aal": "aal2"}', true);
set local role authenticated;
do $$ begin
  if public.is_admin() then raise exception 'TEST FAILED: non-admin is_admin() true'; end if;
  if (public.admin_status()->>'admin')::boolean then raise exception 'TEST FAILED: non-admin admin_status admin'; end if;
  raise notice 'non-admin OK';
end $$;
reset role;

rollback;
