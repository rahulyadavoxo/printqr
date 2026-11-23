-- Smoke test for v35 (runs in CI on a throw-away local Supabase, never on the live database).
-- Everything happens in one transaction that is rolled back at the end.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000032a1', 'sess-owner@example.com'),
  ('00000000-0000-0000-0000-0000000032a2', 'sess-other@example.com');
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip) values
  ('00000000-0000-0000-0000-0000000032c1', '00000000-0000-0000-0000-0000000032a1', now() - interval '2 days', now(), 'This PC', '203.0.113.7'),
  ('00000000-0000-0000-0000-0000000032c2', '00000000-0000-0000-0000-0000000032a1', now() - interval '5 days', now() - interval '1 day', 'Old phone', '2001:db8:1234::1'),
  ('00000000-0000-0000-0000-0000000032c3', '00000000-0000-0000-0000-0000000032a2', now(), now(), 'Someone else', '198.51.100.1');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000032a1","role":"authenticated","session_id":"00000000-0000-0000-0000-0000000032c1"}', true);
set local role authenticated;

do $$
declare n int; r record;
begin
  select count(*) into n from public.my_sessions();
  if n <> 2 then raise exception 'TEST FAILED: expected 2 own sessions, got %', n; end if;
  select * into r from public.my_sessions() limit 1;
  if not r.is_current or r.id <> '00000000-0000-0000-0000-0000000032c1' then raise exception 'TEST FAILED: current session not first'; end if;
  if r.ip <> '203.0.x.x' then raise exception 'TEST FAILED: IPv4 not masked: %', r.ip; end if;
  select * into r from public.my_sessions() where not is_current;
  if r.ip <> '2001:db8:x:x' then raise exception 'TEST FAILED: IPv6 not masked: %', r.ip; end if;

  -- the current session is refused
  begin
    perform public.end_my_session('00000000-0000-0000-0000-0000000032c1');
    raise exception 'TEST FAILED: current session was ended';
  exception when others then
    if sqlerrm <> 'use log out for this device' then raise; end if;
  end;
  -- someone else's session is not touched
  if public.end_my_session('00000000-0000-0000-0000-0000000032c3') then raise exception 'TEST FAILED: ended another user''s session'; end if;
  -- an own other device is logged out
  if not public.end_my_session('00000000-0000-0000-0000-0000000032c2') then raise exception 'TEST FAILED: own other session not ended'; end if;
  select count(*) into n from public.my_sessions();
  if n <> 1 then raise exception 'TEST FAILED: expected 1 session left, got %', n; end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$
begin
  perform public.my_sessions();
  raise exception 'TEST FAILED: anon could call my_sessions';
exception when insufficient_privilege then null;
end $$;

reset role;
do $$ begin
  if not exists (select 1 from auth.sessions where id = '00000000-0000-0000-0000-0000000032c3') then
    raise exception 'TEST FAILED: other user session missing';
  end if;
end $$;
rollback;
\echo 'v35 sessions smoke test OK'
