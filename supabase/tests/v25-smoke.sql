-- Smoke test for v25 (runs in CI on a throw-away local Supabase, never on the live database).
-- Everything happens in one transaction that is rolled back at the end.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner-test@example.com');
insert into public.shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Test Shop', 'test-shop-v25');

-- Customer requests come from one network
select set_config('request.headers', '{"x-real-ip": "203.0.113.7"}', true);
set local role anon;

do $$
declare r record; i int; v_first uuid;
begin
  -- 1. Three normal orders: no bot check
  for i in 1..3 loop
    select * into r from public.create_order('test-shop-v25', 'A', null,
      '[{"name":"a.pdf","mime":"application/pdf","size":1000,"pages_to_print":2,"total_pages":2}]'::jsonb);
    if i = 1 then v_first := r.order_id; end if;
  end loop;
  -- 2. The 4th from the same network in 10 minutes needs a pass
  begin
    perform public.create_order('test-shop-v25', 'A', null,
      '[{"name":"a.pdf","mime":"application/pdf","size":1000,"pages_to_print":2,"total_pages":2}]'::jsonb);
    raise exception 'TEST FAILED: 4th order did not ask for the bot check';
  exception when others then
    if sqlerrm <> 'captcha_required' then raise; end if;
  end;
  -- 3. Storage budget: 140 MB more is over the Free shop's 150 MB? (3 x 1000 bytes live) -> 200 MB order is refused
  --    by the plan size first; check the shop budget with a smaller cap instead
  perform set_config('pq.first_order', v_first::text, true);
  raise notice 'create_order + adaptive bot check OK';
end $$;

reset role;

-- 4. Shop budget: lower the Free cap to 0 MB, then an order (with a pass) is refused for space
update public.app_settings set shop_storage_free_mb = 0 where id = 1;
insert into public.upload_pass (id) values ('00000000-0000-0000-0000-0000000000c1');
set local role anon;
do $$ begin
  perform public.create_order('test-shop-v25', 'A', null,
    '[{"name":"a.pdf","mime":"application/pdf","size":1000,"pages_to_print":2,"total_pages":2}]'::jsonb, null,
    '00000000-0000-0000-0000-0000000000c1');
  raise exception 'TEST FAILED: order over the shop storage budget was accepted';
exception when others then
  if sqlerrm not like 'This shop''s file space is full%' then raise; end if;
  raise notice 'shop storage budget OK';
end $$;
reset role;
update public.app_settings set shop_storage_free_mb = 150 where id = 1;

-- 5. Block sender as the owner: the network's open orders are cancelled and new ones refused
update public.orders set status = 'received' where shop_id = '00000000-0000-0000-0000-0000000000b1';
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
set local role authenticated;
do $$ declare n int; begin
  n := public.block_order_sender(current_setting('pq.first_order')::uuid);
  if n <> 3 then raise exception 'TEST FAILED: block_order_sender cancelled % orders, expected 3', n; end if;
  if public.blocked_sender_count('00000000-0000-0000-0000-0000000000b1') <> 1 then raise exception 'TEST FAILED: blocked count'; end if;
  raise notice 'block sender OK';
end $$;
reset role;
set local role anon;
do $$ begin
  perform public.create_order('test-shop-v25', 'A', null,
    '[{"name":"a.pdf","mime":"application/pdf","size":1000,"pages_to_print":2,"total_pages":2}]'::jsonb);
  raise exception 'TEST FAILED: blocked network could still order';
exception when others then
  if sqlerrm not like 'This shop is not accepting orders from your network%' then raise; end if;
  raise notice 'blocked network refused OK';
end $$;
reset role;

-- 6. Retention: a Received order 30 hours old keeps its files; a Done one is cleaned up (Free = 3 hours)
update public.orders set created_at = now() - interval '30 hours', status = 'received', files_deleted = false
  where id = current_setting('pq.first_order')::uuid;
do $$ begin
  if exists (select 1 from public.cleanup_candidates() c where c.order_id = current_setting('pq.first_order')::uuid) then
    raise exception 'TEST FAILED: unprinted order would lose its files';
  end if;
  update public.orders set status = 'done' where id = current_setting('pq.first_order')::uuid;
  if not exists (select 1 from public.cleanup_candidates() c where c.order_id = current_setting('pq.first_order')::uuid) then
    raise exception 'TEST FAILED: finished old order is not cleaned up';
  end if;
  raise notice 'retention OK';
end $$;

-- 7. finalize_begin counts attempts; ops_health answers
do $$ declare v_id uuid; v_key uuid; n int; h jsonb; begin
  select o.id, o.access_key into v_id, v_key from public.orders o where o.shop_id = '00000000-0000-0000-0000-0000000000b1' limit 1;
  update public.orders set status = 'uploading', created_at = now() where id = v_id;
  n := public.finalize_begin(v_id, v_key);
  n := public.finalize_begin(v_id, v_key);
  if n <> 2 then raise exception 'TEST FAILED: finalize_begin returned %', n; end if;
  h := public.ops_health(20);
  if h ? 'storage_bytes' is not true then raise exception 'TEST FAILED: ops_health'; end if;
  raise notice 'finalize_begin + ops_health OK';
end $$;

rollback;
\echo 'v25 smoke test passed'
